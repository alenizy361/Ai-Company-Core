# SIRA local TTS service — Chatterbox Multilingual V3 behind a small FastAPI
# app. Deployed to ~/chatterbox-service by scripts/install-chatterbox.sh and
# run as the systemd user unit `chatterbox-tts` (127.0.0.1 only — the SIRA
# backend relays to it; browsers never reach it directly).
#
# Engineering rules (from the integration spec, non-negotiable):
#   - the model loads exactly ONCE at startup and stays in memory
#   - one uvicorn worker, one inference lock (CPU box, 16 GB RAM)
#   - sentence-level requests only (<= 400 chars), never whole essays
#   - honest cancellation: queued/late results are discarded; a CPU inference
#     already running cannot be safely killed and we never claim otherwise
from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import psutil
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator

from chatterbox.mtl_tts import ChatterboxMultilingualTTS


APP_DIR = Path(
    os.getenv("CHATTERBOX_SERVICE_DIR", str(Path.home() / "chatterbox-service"))
).resolve()

VOICE_DIR = (APP_DIR / "voices").resolve()
# The single production reference voice. Optional: without it the model's
# built-in conditionals are used (still one consistent voice).
DEFAULT_VOICE_PATH = (VOICE_DIR / "sira.wav").resolve()

DEVICE = "cpu"
MODEL_NAME = "chatterbox-multilingual-v3"
MODEL_VERSION = os.getenv("CHATTERBOX_T3_MODEL", "v3")

MAX_TEXT_LENGTH = int(os.getenv("CHATTERBOX_MAX_TEXT_LENGTH", "400"))
MAX_QUEUE_DEPTH = int(os.getenv("CHATTERBOX_MAX_QUEUE_DEPTH", "3"))

CPU_COUNT = os.cpu_count() or 4
TORCH_THREADS = max(1, int(os.getenv("CHATTERBOX_TORCH_THREADS", str(CPU_COUNT - 1))))

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

logger = logging.getLogger("chatterbox-service")

model: ChatterboxMultilingualTTS | None = None
model_ready = False
model_error: str | None = None

inference_lock = asyncio.Lock()
queue_guard = asyncio.Lock()
waiting_requests = 0
cancelled_requests: set[str] = set()


class SpeechRequest(BaseModel):
    model: str = MODEL_NAME
    input: str = Field(min_length=1, max_length=MAX_TEXT_LENGTH)
    voice: str = "default"
    language: str = "ar"
    response_format: str = "wav"

    exaggeration: float = Field(default=0.45, ge=0.0, le=1.5)
    cfg_weight: float = Field(default=0.35, ge=0.0, le=1.0)
    temperature: float = Field(default=0.8, ge=0.1, le=1.5)
    repetition_penalty: float = Field(default=1.2, ge=1.0, le=2.0)
    min_p: float = Field(default=0.05, ge=0.0, le=1.0)
    top_p: float = Field(default=1.0, ge=0.1, le=1.0)

    request_id: str | None = Field(default=None, max_length=120)

    @field_validator("input")
    @classmethod
    def clean_input(cls, value: str) -> str:
        value = value.replace("\x00", "")
        value = re.sub(r"\s+", " ", value).strip()
        if not value:
            raise ValueError("Input text is empty after normalization")
        if any(ord(char) < 32 and char not in "\n\t" for char in value):
            raise ValueError("Input contains unsupported control characters")
        return value

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        if value != MODEL_NAME:
            raise ValueError(f"Only {MODEL_NAME} is available")
        return value

    @field_validator("voice")
    @classmethod
    def validate_voice(cls, value: str) -> str:
        # One production voice; both names map to the conditionals prepared
        # at startup. Never accept filesystem paths from clients.
        if value not in {"sira", "default"}:
            raise ValueError("Supported voices: sira, default")
        return value

    @field_validator("response_format")
    @classmethod
    def validate_format(cls, value: str) -> str:
        if value.lower() != "wav":
            raise ValueError("Only WAV output is supported")
        return "wav"


def normalize_spoken_text(text: str, language: str) -> str:
    text = text.strip()
    text = re.sub(r"\s+", " ", text)

    # Remove visual Markdown that should not be spoken.
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)

    # Avoid reading raw URLs as long strings.
    text = re.sub(
        r"https?://\S+",
        "الرابط موجود على الشاشة" if language == "ar" else "the link is on screen",
        text,
    )

    # Remove repeated punctuation while preserving natural pauses.
    text = re.sub(r"[.]{3,}", "، " if language == "ar" else ", ", text)
    text = re.sub(r"[!?]{2,}", "!", text)
    text = re.sub(r"\s+([،,.!?؟])", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()

    return text


def validate_language(language: str) -> str:
    if model is None:
        raise RuntimeError("Model is not loaded")
    supported = model.get_supported_languages()
    normalized = language.lower().strip()
    if normalized not in supported:
        raise ValueError(
            f"Unsupported language '{language}'. "
            f"Supported: {', '.join(sorted(supported))}"
        )
    return normalized


def synthesize_sync(request: SpeechRequest) -> tuple[bytes, dict[str, Any]]:
    if model is None:
        raise RuntimeError("Model is not loaded")

    language = validate_language(request.language)
    text = normalize_spoken_text(request.input, language)
    if not text:
        raise ValueError("Nothing remains to synthesize")

    started = time.perf_counter()

    with torch.inference_mode():
        wav = model.generate(
            text,
            language_id=language,
            exaggeration=request.exaggeration,
            cfg_weight=request.cfg_weight,
            temperature=request.temperature,
            repetition_penalty=request.repetition_penalty,
            min_p=request.min_p,
            top_p=request.top_p,
        )

    samples = wav.squeeze(0).detach().cpu().numpy()
    sample_rate = int(model.sr)

    output = io.BytesIO()
    sf.write(output, samples, sample_rate, format="WAV", subtype="PCM_16")

    generation_ms = round((time.perf_counter() - started) * 1000)
    audio_duration_ms = round((len(samples) / sample_rate) * 1000)
    real_time_factor = (
        round(generation_ms / audio_duration_ms, 3) if audio_duration_ms > 0 else None
    )

    return output.getvalue(), {
        "generation_ms": generation_ms,
        "audio_duration_ms": audio_duration_ms,
        "real_time_factor": real_time_factor,
        "sample_rate": sample_rate,
        "characters": len(text),
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model, model_ready, model_error

    try:
        torch.set_num_threads(TORCH_THREADS)
        torch.set_num_interop_threads(1)

        logger.info(
            "Loading %s on %s with %s Torch threads", MODEL_NAME, DEVICE, TORCH_THREADS
        )
        load_started = time.perf_counter()

        model = ChatterboxMultilingualTTS.from_pretrained(
            device=DEVICE,
            t3_model=MODEL_VERSION,
        )

        if DEFAULT_VOICE_PATH.is_file():
            logger.info("Preparing voice conditionals from %s", DEFAULT_VOICE_PATH)
            model.prepare_conditionals(str(DEFAULT_VOICE_PATH), exaggeration=0.45)
        elif model.conds is None:
            raise FileNotFoundError(
                f"No custom voice at {DEFAULT_VOICE_PATH}, "
                "and the model has no built-in conditionals"
            )
        else:
            logger.warning("Custom voice is missing; using built-in conditionals")

        model_ready = True
        logger.info("Model ready in %.2f seconds", time.perf_counter() - load_started)

    except Exception as exc:
        model_error = f"{type(exc).__name__}: {exc}"
        model_ready = False
        logger.exception("Model startup failed")
        raise

    yield

    model_ready = False
    model = None


app = FastAPI(title="SIRA Local Chatterbox TTS", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    process = psutil.Process()
    return {
        "status": "ok" if model_ready else "starting_or_failed",
        "ready": model_ready,
        "model": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "device": DEVICE,
        "default_language": "ar",
        "queue_depth": waiting_requests,
        "max_queue_depth": MAX_QUEUE_DEPTH,
        "torch_threads": TORCH_THREADS,
        "rss_mb": round(process.memory_info().rss / 1024 / 1024, 1),
        "error": model_error,
    }


@app.get("/ready")
async def ready() -> dict[str, bool]:
    if not model_ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=model_error or "Model is not ready",
        )
    return {"ready": True}


@app.get("/v1/languages")
async def languages() -> dict[str, str]:
    if model is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model is not ready",
        )
    return model.get_supported_languages()


@app.post("/v1/cancel/{request_id}")
async def cancel_request(request_id: str) -> dict[str, Any]:
    cancelled_requests.add(request_id)
    return {
        "request_id": request_id,
        "cancelled": True,
        "note": (
            "Queued or late results will be discarded. "
            "A CPU inference already running may continue internally."
        ),
    }


@app.post("/v1/audio/speech")
async def create_speech(request: SpeechRequest) -> Response:
    global waiting_requests

    if not model_ready or model is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=model_error or "Model is not ready",
        )

    request_id = request.request_id or str(uuid.uuid4())

    if request_id in cancelled_requests:
        raise HTTPException(status_code=499, detail="Request was cancelled before synthesis")

    async with queue_guard:
        if waiting_requests >= MAX_QUEUE_DEPTH:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="TTS queue is full",
                headers={"Retry-After": "2"},
            )
        waiting_requests += 1

    try:
        async with inference_lock:
            if request_id in cancelled_requests:
                raise HTTPException(status_code=499, detail="Request was cancelled while queued")

            queue_started = time.perf_counter()

            try:
                audio_bytes, metrics = await asyncio.to_thread(synthesize_sync, request)
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
                ) from exc
            except HTTPException:
                raise
            except Exception as exc:
                logger.exception("Synthesis failed for %s", request_id)
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"TTS synthesis failed: {type(exc).__name__}",
                ) from exc

            queue_and_generation_ms = round((time.perf_counter() - queue_started) * 1000)

            if request_id in cancelled_requests:
                raise HTTPException(
                    status_code=499, detail="Result discarded because request was cancelled"
                )

            headers = {
                "X-Request-ID": request_id,
                "X-Model": MODEL_NAME,
                "X-Language": request.language,
                "X-Sample-Rate": str(metrics["sample_rate"]),
                "X-Generation-MS": str(metrics["generation_ms"]),
                "X-Total-Processing-MS": str(queue_and_generation_ms),
                "X-Audio-Duration-MS": str(metrics["audio_duration_ms"]),
                "X-Real-Time-Factor": str(metrics["real_time_factor"]),
            }

            return Response(content=audio_bytes, media_type="audio/wav", headers=headers)

    finally:
        async with queue_guard:
            waiting_requests = max(0, waiting_requests - 1)
        cancelled_requests.discard(request_id)

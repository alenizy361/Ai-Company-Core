// ULID generator (Crockford base32, 48-bit time + 80-bit randomness),
// monotonic within a process so same-millisecond IDs still sort by creation.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  for (let i = 9; i >= 0; i--) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function randomPart(): number[] {
  const bytes = randomBytes(16);
  const chars: number[] = [];
  for (let i = 0; i < 16; i++) chars.push(bytes[i] % 32);
  return chars;
}

function incrementRandom(chars: number[]): number[] {
  const next = chars.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 31) {
      next[i]++;
      return next;
    }
    next[i] = 0;
  }
  return next; // overflow wraps; practically unreachable
}

export function ulid(prefix = ''): string {
  const now = Date.now();
  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomPart();
  }
  const rand = lastRandom.map((c) => ALPHABET[c]).join('');
  const id = encodeTime(now) + rand;
  return prefix ? `${prefix}_${id}` : id;
}

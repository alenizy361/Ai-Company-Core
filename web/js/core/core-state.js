// Composite SIRA Core display state. Voice-session states win; otherwise the
// execution phase derives from REAL signals only (snapshot + event ring).
// Every non-ready result carries its source: a voice state, a live seq, or a
// snapshot fact. Pure module — unit-tested in tests/unit/core-state.test.ts.

/** Latest ring seq of a type matching pred, or 0. */
function lastSeq(ring, pred) {
  for (let i = ring.length - 1; i >= 0; i--) {
    if (pred(ring[i])) return ring[i].seq ?? 0;
  }
  return 0;
}

/**
 * Agent-SDK activity derived from persisted sira.* events. Pure: replays the
 * ring in seq order. A sira.execution.completed clears the board (the parent
 * turn ended); entries older than the freshness window are dropped so a
 * server killed mid-turn cannot pin activity forever.
 * @returns Map<agentKey, { status: 'running'|'using_tool', seq: number, at: number }>
 */
export function deriveSdkActivity(ring, now) {
  const active = new Map();
  for (const ev of ring) {
    if (ev.type === 'sira.execution.completed') {
      active.clear();
      continue;
    }
    const key = ev.agentKey;
    if (!key || key === 'sira') continue;
    if (ev.type === 'sira.agent.started') {
      active.set(key, { status: 'running', seq: ev.seq ?? 0, at: ev.at ?? now });
    } else if (ev.type === 'sira.agent.completed' || ev.type === 'sira.agent.failed') {
      active.delete(key);
    } else if (ev.type === 'sira.tool.started' && active.has(key)) {
      const cur = active.get(key);
      cur.status = 'using_tool';
      cur.seq = ev.seq ?? cur.seq;
    } else if (ev.type === 'sira.tool.completed' && active.get(key)?.status === 'using_tool') {
      active.get(key).status = 'running';
    }
  }
  for (const [key, entry] of active) {
    if (now - entry.at > 600000) active.delete(key);
  }
  return active;
}

/**
 * @param input {{
 *   voiceState: string,
 *   connected: boolean, reconnecting: boolean,
 *   workerFresh: boolean, runningExecutions: number, pendingApprovals: number,
 *   ring: Array<{seq:number,type:string,payload?:object,at:number}>,
 *   snapshot: object|null,
 *   now: number,
 * }}
 * @returns {{ state: string, source: string, seq?: number }}
 */
export function deriveCoreState(input) {
  const { voiceState, ring } = input;

  // 1. Voice-session states always win while the session is mid-interaction.
  if (voiceState && voiceState !== 'ready') {
    return { state: voiceState, source: `voice:${voiceState}` };
  }

  // 2. Transport honesty before anything execution-flavored.
  if (!input.connected) {
    return input.reconnecting
      ? { state: 'reconnecting', source: 'sse:reconnecting' }
      : { state: 'sync_lost', source: 'sse:disconnected' };
  }

  // 3. Agent-SDK activity (the SIRA parent session runs in the API process —
  //    deliberately NOT gated on worker freshness). Tool use is the finer
  //    state; delegated agents otherwise read as executing.
  const sdkToolStart = lastSeq(ring, (e) => e.type === 'sira.tool.started');
  const sdkToolEnd = lastSeq(ring, (e) => e.type === 'sira.tool.completed' || e.type === 'sira.execution.completed');
  if (sdkToolStart > 0 && sdkToolStart > sdkToolEnd) {
    const at = ring.find((e) => e.seq === sdkToolStart)?.at ?? 0;
    if (input.now - at < 300000) return { state: 'using_tool', source: 'event', seq: sdkToolStart };
  }
  const sdkActivity = deriveSdkActivity(ring, input.now);
  if (sdkActivity.size > 0) {
    const newest = Math.max(...[...sdkActivity.values()].map((entry) => entry.seq));
    return { state: 'executing', source: 'event', seq: newest };
  }

  // 4. Worker staleness suppresses the WORKER's execution states.
  if (!input.workerFresh) {
    return { state: 'ready', source: 'worker:stale' };
  }

  // 4. Execution phase, precedence order, each tied to a live seq.
  const failSeq = lastSeq(ring, (e) =>
    (e.type === 'execution.finished' && e.payload?.status === 'failed' && e.payload?.willRetry === false)
    || e.type === 'planning.exhausted');
  const successSeq = lastSeq(ring, (e) =>
    (e.type === 'execution.finished' && e.payload?.status === 'completed')
    || (e.type === 'objective.finished' && e.payload?.status === 'completed'));
  if (failSeq > 0 && failSeq > successSeq && failSeq > lastSeq(ring, (e) => e.type === 'task.status' && e.payload?.source === 'owner_retry')) {
    // A terminal failure newer than any success: surface until acted on,
    // but only briefly at the core (cards carry the durable signal).
    const failedAt = ring.find((e) => e.seq === failSeq)?.at ?? 0;
    if (input.now - failedAt < 15000) return { state: 'failed', source: 'event', seq: failSeq };
  }

  if (input.pendingApprovals > 0) {
    return { state: 'waiting_for_approval', source: 'snapshot:pendingApprovals' };
  }

  const verifyingSeq = lastSeq(ring, (e) => e.type === 'execution.verifying');
  const verifyDoneSeq = lastSeq(ring, (e) => e.type === 'verification.result' || e.type === 'execution.finished');
  if (verifyingSeq > 0 && verifyingSeq > verifyDoneSeq) {
    return { state: 'verifying', source: 'event', seq: verifyingSeq };
  }

  const toolStartSeq = lastSeq(ring, (e) => e.type === 'tool.started');
  const toolEndSeq = lastSeq(ring, (e) => ['tool.succeeded', 'tool.failed', 'tool.denied'].includes(e.type));
  if (toolStartSeq > 0 && toolStartSeq > toolEndSeq) {
    return { state: 'using_tool', source: 'event', seq: toolStartSeq };
  }

  const handoffSeq = lastSeq(ring, (e) => e.type === 'handoff.created');
  if (handoffSeq > 0) {
    const handoffAt = ring.find((e) => e.seq === handoffSeq)?.at ?? 0;
    if (input.now - handoffAt < 1500) {
      return { state: 'receiving_handoff', source: 'event', seq: handoffSeq };
    }
  }

  const confirmSeq = lastSeq(ring, (e) => e.type === 'plan.confirmed');
  const firstClaimAfterConfirm = lastSeq(ring, (e) =>
    e.type === 'task.status' && e.payload?.source === 'worker_claim' && (e.seq ?? 0) > confirmSeq);
  if (confirmSeq > 0 && firstClaimAfterConfirm === 0 && input.runningExecutions === 0) {
    const confirmedAt = ring.find((e) => e.seq === confirmSeq)?.at ?? 0;
    if (input.now - confirmedAt < 30000) {
      return { state: 'connecting_agents', source: 'event', seq: confirmSeq };
    }
  }

  if (input.runningExecutions > 0) {
    return { state: 'executing', source: 'snapshot:runningExecutions' };
  }

  const planningSeq = lastSeq(ring, (e) => e.type === 'planning.started');
  const planningDoneSeq = lastSeq(ring, (e) =>
    ['plan.proposed', 'planning.exhausted', 'planning.adapter_error'].includes(e.type));
  const planningObjective = (input.snapshot?.objectives ?? []).some((o) => o.status === 'planning');
  if (planningSeq > planningDoneSeq && planningObjective) {
    return { state: 'creating_plan', source: 'event', seq: planningSeq };
  }

  return { state: 'ready', source: 'idle' };
}

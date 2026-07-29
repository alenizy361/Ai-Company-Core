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

  // 3. Worker staleness suppresses ALL execution states.
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

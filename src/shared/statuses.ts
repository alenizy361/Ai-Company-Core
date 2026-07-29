// Task and execution status machines. Every status change in the system must
// go through assertTransition — the API never exposes an arbitrary status write.

export const TASK_STATUSES = [
  'queued',
  'waiting_for_dependency',
  'blocked',
  'running',
  'waiting_for_tool',
  'waiting_for_approval',
  'verifying',
  'failed',
  'cancelled',
  'completed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// Board-visible agent states are a superset (they add derived-only states).
export const AGENT_VISIBLE_STATES = [
  'not_configured',
  'offline',
  'idle',
  ...TASK_STATUSES,
] as const;

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['running', 'blocked', 'cancelled'],
  waiting_for_dependency: ['queued', 'running', 'blocked', 'cancelled'],
  blocked: ['queued', 'failed', 'cancelled'],
  running: ['waiting_for_tool', 'waiting_for_approval', 'verifying', 'failed', 'cancelled', 'queued'],
  waiting_for_tool: ['running', 'failed', 'cancelled', 'queued'],
  waiting_for_approval: ['running', 'failed', 'cancelled', 'queued'],
  verifying: ['completed', 'running', 'failed', 'cancelled', 'queued'],
  failed: ['queued'],
  cancelled: [],
  completed: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionTask(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`illegal task transition: ${from} -> ${to}`);
  }
}

export const EXECUTION_STATUSES = [
  'running',
  'waiting_for_tool',
  'waiting_for_approval',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'abandoned',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

const EXECUTION_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  running: ['waiting_for_tool', 'waiting_for_approval', 'verifying', 'completed', 'failed', 'cancelled', 'abandoned'],
  waiting_for_tool: ['running', 'failed', 'cancelled', 'abandoned'],
  waiting_for_approval: ['running', 'failed', 'cancelled', 'abandoned'],
  verifying: ['running', 'completed', 'failed', 'cancelled', 'abandoned'],
  completed: [],
  failed: [],
  cancelled: [],
  abandoned: [],
};

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!canTransitionExecution(from, to)) {
    throw new Error(`illegal execution transition: ${from} -> ${to}`);
  }
}

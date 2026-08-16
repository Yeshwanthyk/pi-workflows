import * as os from "node:os";

export const DEFAULT_WORKFLOW_CONCURRENCY = 4;
export const MAX_HOST_CAPACITY = 16;

/**
 * Protective defaults applied to budget groups the author omits entirely.
 * Real-world failures cluster on hand-guessed budgets far below these, so
 * omitted budgets are generous rather than unbounded: agents stay protected
 * from runaway turns/output while authors who need more simply raise them.
 */
export const DEFAULT_TOTAL_TURNS = 400;
export const DEFAULT_TOTAL_OUTPUT_TOKENS = 200_000;
export const DEFAULT_AGENT_WALL_MS = 30 * 60_000;
export const DEFAULT_WORKFLOW_WALL_MS = 2 * 60 * 60_000;

export interface WorkflowLimits {
  concurrency?: number;
  workflow?: { wallMs?: number; idleMs?: number };
  agent?: { wallMs?: number; idleMs?: number };
  total?: { turns?: number; outputTokens?: number; costUsd?: number };
}

export interface EffectiveWorkflowLimits extends WorkflowLimits {
  concurrency: number;
  hardCapacity: number;
}

export interface MonotonicClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const systemMonotonicClock: MonotonicClock = {
  now: () => performance.now(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

export function hostCapacity(available = os.availableParallelism()): number {
  return Math.min(MAX_HOST_CAPACITY, Math.max(1, available - 2));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new Error(`${path}.${key} is not supported`);
  }
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return value;
}

type NumericKind =
  "positiveInteger" | "nonNegativeInteger" | "nonNegativeFinite";

function optionalGroup(
  value: unknown,
  path: string,
  fields: Readonly<Record<string, NumericKind>>,
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertKeys(value, Object.keys(fields), path);
  const parsed: Record<string, number> = {};
  for (const [key, kind] of Object.entries(fields)) {
    if (value[key] === undefined) continue;
    const fieldPath = `${path}.${key}`;
    parsed[key] =
      kind === "positiveInteger"
        ? positiveInteger(value[key], fieldPath)
        : kind === "nonNegativeInteger"
          ? nonNegativeInteger(value[key], fieldPath)
          : nonNegativeFinite(value[key], fieldPath);
  }
  return parsed;
}

/** Validate the closed, literal-decoded `meta.limits` schema. */
export function parseWorkflowLimits(value: unknown): WorkflowLimits {
  if (!isRecord(value)) throw new Error("meta.limits must be an object");
  assertKeys(
    value,
    ["concurrency", "workflow", "agent", "total"],
    "meta.limits",
  );
  const workflow = optionalGroup(value.workflow, "meta.limits.workflow", {
    wallMs: "positiveInteger",
    idleMs: "positiveInteger",
  });
  const agent = optionalGroup(value.agent, "meta.limits.agent", {
    wallMs: "positiveInteger",
    idleMs: "positiveInteger",
  });
  const total = optionalGroup(value.total, "meta.limits.total", {
    turns: "nonNegativeInteger",
    outputTokens: "nonNegativeInteger",
    costUsd: "nonNegativeFinite",
  });
  return {
    ...(value.concurrency === undefined
      ? {}
      : {
          concurrency: positiveInteger(
            value.concurrency,
            "meta.limits.concurrency",
          ),
        }),
    ...(workflow ? { workflow } : {}),
    ...(agent ? { agent } : {}),
    ...(total ? { total } : {}),
  };
}

export function resolveWorkflowLimits(
  requested: WorkflowLimits | undefined,
  capacity: number,
): EffectiveWorkflowLimits {
  const hardCapacity = positiveInteger(capacity, "host capacity");
  const total = {
    turns: DEFAULT_TOTAL_TURNS,
    outputTokens: DEFAULT_TOTAL_OUTPUT_TOKENS,
    ...(requested?.total ?? {}),
  };
  const agent = {
    wallMs: DEFAULT_AGENT_WALL_MS,
    ...(requested?.agent ?? {}),
  };
  const workflow = {
    wallMs: DEFAULT_WORKFLOW_WALL_MS,
    ...(requested?.workflow ?? {}),
  };
  return {
    ...(requested ?? {}),
    total,
    agent,
    workflow,
    concurrency: Math.min(
      hardCapacity,
      requested?.concurrency ?? DEFAULT_WORKFLOW_CONCURRENCY,
    ),
    hardCapacity,
  };
}

/** Lenient persisted-artifact boundary; metadata parsing remains closed. */
export function normalizeEffectiveWorkflowLimits(
  value: unknown,
): EffectiveWorkflowLimits | undefined {
  if (!isRecord(value)) return undefined;
  try {
    assertKeys(
      value,
      ["concurrency", "hardCapacity", "workflow", "agent", "total"],
      "limits",
    );
    const concurrency = positiveInteger(
      value.concurrency,
      "limits.concurrency",
    );
    const hardCapacity =
      value.hardCapacity === undefined
        ? concurrency
        : positiveInteger(value.hardCapacity, "limits.hardCapacity");
    const requested = parseWorkflowLimits({
      concurrency,
      ...(value.workflow === undefined ? {} : { workflow: value.workflow }),
      ...(value.agent === undefined ? {} : { agent: value.agent }),
      ...(value.total === undefined ? {} : { total: value.total }),
    });
    return resolveWorkflowLimits(requested, hardCapacity);
  } catch {
    return undefined;
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow was aborted", { cause: signal.reason });
}

interface Waiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

/** Process-local FIFO capacity. Aborting a waiter removes only that waiter. */
export class CapacityPool {
  readonly capacity: number;
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(capacity: number) {
    positiveInteger(capacity, "capacity");
    this.capacity = capacity;
  }

  get activeCount() {
    return this.active;
  }

  get queuedCount() {
    return this.waiters.length;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.capacity) return Promise.resolve(this.take());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(abortError(signal));
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private take(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain() {
    while (this.active < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      waiter.resolve(this.take());
    }
  }
}

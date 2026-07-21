import {
  CapacityPool,
  systemMonotonicClock,
  type EffectiveWorkflowLimits,
  type MonotonicClock,
} from "./limits.ts";
import type {
  AgentUsage,
  WorkflowBudgetTelemetry,
  WorkflowStatus,
  WorkflowTerminationCode,
  WorkflowTerminationRecord,
} from "./model.ts";

export const MAX_AGENT_CALLS = 32;
export const RUN_SHUTDOWN_TIMEOUT_MS = 8_000;

export type TerminationCode = WorkflowTerminationCode;

export class WorkflowTerminationError extends Error {
  readonly code: TerminationCode;
  readonly outcome: "failed" | "aborted";

  constructor(
    code: TerminationCode,
    message: string,
    outcome: "failed" | "aborted",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowTerminationError";
    this.code = code;
    this.outcome = outcome;
  }
}

export class AgentBudgetError extends Error {
  readonly code: "agent_wall" | "agent_idle";

  constructor(code: "agent_wall" | "agent_idle", message: string) {
    super(message);
    this.name = "AgentBudgetError";
    this.code = code;
  }
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow was aborted", { cause: signal.reason });
}

export interface AgentRuntime {
  activity(): void;
  reserveTurn(): void;
  reportUsage(usage: AgentUsage): void;
}

export interface ScheduleOptions {
  invocationSignal?: AbortSignal;
  usageKey?: string | number;
  onStarted?: () => void;
  onFinished?: () => void;
}

export interface RunControllerOptions {
  parentSignal?: AbortSignal;
  limits: EffectiveWorkflowLimits;
  sharedCapacity: CapacityPool;
  clock?: MonotonicClock;
}

interface UsageHighWater {
  output: number;
  cost: number;
  outputComplete: boolean;
  costComplete: boolean;
}

/** Pure typed status reconciliation for sandbox/controller races. */
export function reconcileWorkflowStatus(options: {
  sandboxSucceeded: boolean;
  termination?: Pick<WorkflowTerminationError, "outcome">;
  settled: boolean;
}): Exclude<WorkflowStatus, "running"> {
  if (options.termination) return options.termination.outcome;
  return options.sandboxSucceeded && options.settled ? "completed" : "failed";
}

/** Owns admission, capacity, timers, usage budgets, abort, and settlement. */
export class RunController {
  private readonly abortController = new AbortController();
  private readonly runCapacity: CapacityPool;
  private readonly sharedCapacity: CapacityPool;
  private readonly limits: EffectiveWorkflowLimits;
  private readonly clock: MonotonicClock;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly usageHighWater = new Map<string | number, UsageHighWater>();
  private workflowWallTimer?: unknown;
  private workflowWallDeadline?: number;
  private workflowWallGeneration = 0;
  private workflowIdleTimer?: unknown;
  private workflowIdleDeadline?: number;
  private workflowIdleGeneration = 0;
  private callCount = 0;
  private reservedTurns = 0;
  private totalOutput = 0;
  private totalCost = 0;
  private outputComplete = true;
  private costComplete = true;
  private accountingFrozen = false;
  private sealed = false;
  private taskFinalizationClosed = false;
  private settlePromise?: Promise<boolean>;
  private parentAbort?: () => void;
  private parentSignal?: AbortSignal;
  private firstTermination?: WorkflowTerminationError;
  private firstTerminationRecord?: WorkflowTerminationRecord;

  constructor(options: RunControllerOptions) {
    this.limits = options.limits;
    this.sharedCapacity = options.sharedCapacity;
    this.runCapacity = new CapacityPool(options.limits.concurrency);
    this.clock = options.clock ?? systemMonotonicClock;
    this.armWorkflowTimers();
    if (options.parentSignal) {
      this.parentSignal = options.parentSignal;
      this.parentAbort = () => {
        const cause = options.parentSignal?.reason;
        this.terminate(
          new WorkflowTerminationError(
            "parent_cancelled",
            cause instanceof Error
              ? cause.message
              : "Parent operation was aborted",
            "aborted",
            { cause },
          ),
        );
      };
      if (options.parentSignal.aborted) this.parentAbort();
      else
        options.parentSignal.addEventListener("abort", this.parentAbort, {
          once: true,
        });
    }
  }

  get signal() {
    return this.abortController.signal;
  }

  get calls() {
    return this.callCount;
  }

  get termination() {
    return this.firstTermination;
  }

  get terminationRecord() {
    return this.firstTerminationRecord;
  }

  telemetry(): WorkflowBudgetTelemetry {
    return {
      turns: this.reservedTurns,
      outputTokens: this.totalOutput,
      costUsd: this.totalCost,
      outputComplete: this.outputComplete,
      costComplete: this.costComplete,
    };
  }

  /** Meaningful run activity; persistence/UI updates must not call this. */
  activity() {
    if (this.firstTermination || this.sealed) return;
    const idleMs = this.limits.workflow?.idleMs;
    if (idleMs === undefined) return;
    const generation = ++this.workflowIdleGeneration;
    const deadline = this.clock.now() + idleMs;
    this.workflowIdleDeadline = deadline;
    if (this.workflowIdleTimer !== undefined)
      this.clock.clearTimeout(this.workflowIdleTimer);
    this.workflowIdleTimer = this.clock.setTimeout(() => {
      if (
        generation !== this.workflowIdleGeneration ||
        this.firstTermination ||
        this.sealed ||
        this.workflowIdleDeadline !== deadline ||
        this.clock.now() < deadline
      ) {
        return;
      }
      this.terminate(
        new WorkflowTerminationError(
          "workflow_idle",
          `Workflow idle limit of ${idleMs} ms exceeded`,
          "failed",
        ),
      );
    }, idleMs);
  }

  schedule<T>(
    task: (signal: AbortSignal, runtime: AgentRuntime) => Promise<T>,
    options: ScheduleOptions | AbortSignal = {},
  ): Promise<T> {
    const scheduleOptions: ScheduleOptions =
      options instanceof AbortSignal ? { invocationSignal: options } : options;
    if (this.sealed) return Promise.reject(new Error("Workflow is settling"));
    if (this.signal.aborted) return Promise.reject(abortError(this.signal));
    if (this.callCount >= MAX_AGENT_CALLS) {
      return Promise.reject(
        new Error(
          `Workflow exceeded the limit of ${MAX_AGENT_CALLS} agent calls`,
        ),
      );
    }
    this.callCount++;
    this.activity();
    const reservedCall = this.callCount;

    const running = this.runTask(task, {
      ...scheduleOptions,
      usageKey: scheduleOptions.usageKey ?? reservedCall,
    });
    this.tasks.add(running);
    void running.finally(() => this.tasks.delete(running)).catch(() => {});
    return running;
  }

  abort(reason: string | WorkflowTerminationError = "Workflow was aborted") {
    this.terminate(
      reason instanceof WorkflowTerminationError
        ? reason
        : new WorkflowTerminationError("manual_abort", reason, "aborted"),
    );
  }

  failScript(message = "Workflow script failed") {
    this.terminate(
      new WorkflowTerminationError("script_failure", message, "failed"),
    );
  }

  /** Apply a live-run update only while terminalization has not begun. */
  commit(update: () => void) {
    if (this.sealed || this.firstTermination) return false;
    update();
    return true;
  }

  /**
   * Task-owned projection updates remain open during orderly teardown, but are
   * permanently closed before settle() returns (including timeout). This lets
   * final usage/transcript persist without permitting post-terminal writes.
   */
  taskUpdate(update: () => void) {
    if (this.taskFinalizationClosed) return false;
    update();
    return true;
  }

  /** Seal admission and share one bounded settlement result across all callers. */
  settle(options: { abort?: boolean; timeoutMs?: number } = {}) {
    // Abort is an upgradeable side effect even after another caller owns the
    // shared settlement promise. terminate() preserves the typed first reason.
    if (options.abort && !this.signal.aborted) this.abort();
    return (this.settlePromise ??= this.settleOnce(options));
  }

  private async settleOnce(options: { abort?: boolean; timeoutMs?: number }) {
    this.sealed = true;
    this.clearWorkflowTimers();
    const tasks = [...this.tasks];
    if (tasks.length === 0) {
      this.accountingFrozen = true;
      this.taskFinalizationClosed = true;
      this.detachParent();
      return true;
    }

    let timer: unknown;
    const timeout = new Promise<false>((resolve) => {
      timer = this.clock.setTimeout(() => {
        this.terminate(
          new WorkflowTerminationError(
            "shutdown_timeout",
            "Agent shutdown deadline exceeded",
            "failed",
          ),
        );
        resolve(false);
      }, options.timeoutMs ?? RUN_SHUTDOWN_TIMEOUT_MS);
    });
    const settled = Promise.allSettled(tasks).then(() => true as const);
    const completed = await Promise.race([settled, timeout]);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.accountingFrozen = true;
    this.taskFinalizationClosed = true;
    this.detachParent();
    return completed;
  }

  private async runTask<T>(
    task: (signal: AbortSignal, runtime: AgentRuntime) => Promise<T>,
    options: ScheduleOptions,
  ) {
    const taskAbort = new AbortController();
    const onRunAbort = () => taskAbort.abort(this.signal.reason);
    const onInvocationAbort = () =>
      taskAbort.abort(options.invocationSignal?.reason);
    this.signal.addEventListener("abort", onRunAbort, { once: true });
    options.invocationSignal?.addEventListener("abort", onInvocationAbort, {
      once: true,
    });
    if (this.signal.aborted) onRunAbort();
    else if (options.invocationSignal?.aborted) onInvocationAbort();

    let releaseRun: (() => void) | undefined;
    let releaseShared: (() => void) | undefined;
    let agentWallTimer: unknown;
    let agentWallDeadline: number | undefined;
    let agentWallGeneration = 0;
    let agentIdleTimer: unknown;
    let agentIdleDeadline: number | undefined;
    let agentIdleGeneration = 0;
    let agentActive = false;
    const resetAgentIdle = () => {
      const idleMs = this.limits.agent?.idleMs;
      if (
        idleMs === undefined ||
        !agentActive ||
        taskAbort.signal.aborted ||
        this.firstTermination ||
        this.sealed
      ) {
        return;
      }
      const generation = ++agentIdleGeneration;
      const deadline = this.clock.now() + idleMs;
      agentIdleDeadline = deadline;
      if (agentIdleTimer !== undefined) this.clock.clearTimeout(agentIdleTimer);
      agentIdleTimer = this.clock.setTimeout(() => {
        if (
          !agentActive ||
          generation !== agentIdleGeneration ||
          taskAbort.signal.aborted ||
          this.firstTermination ||
          this.sealed ||
          agentIdleDeadline !== deadline ||
          this.clock.now() < deadline
        ) {
          return;
        }
        taskAbort.abort(
          new AgentBudgetError(
            "agent_idle",
            `Agent idle limit of ${idleMs} ms exceeded`,
          ),
        );
      }, idleMs);
    };
    try {
      releaseRun = await this.runCapacity.acquire(taskAbort.signal);
      releaseShared = await this.sharedCapacity.acquire(taskAbort.signal);
      if (taskAbort.signal.aborted) throw abortError(taskAbort.signal);
      agentActive = true;
      options.onStarted?.();
      this.activity();
      const wallMs = this.limits.agent?.wallMs;
      if (wallMs !== undefined) {
        const generation = ++agentWallGeneration;
        const deadline = this.clock.now() + wallMs;
        agentWallDeadline = deadline;
        agentWallTimer = this.clock.setTimeout(() => {
          if (
            !agentActive ||
            generation !== agentWallGeneration ||
            taskAbort.signal.aborted ||
            this.firstTermination ||
            this.sealed ||
            agentWallDeadline !== deadline ||
            this.clock.now() < deadline
          ) {
            return;
          }
          taskAbort.abort(
            new AgentBudgetError(
              "agent_wall",
              `Agent wall limit of ${wallMs} ms exceeded`,
            ),
          );
        }, wallMs);
      }
      resetAgentIdle();
      const usageKey = options.usageKey;
      if (usageKey === undefined) {
        throw new Error("Agent usage key was not reserved");
      }
      const runtime: AgentRuntime = {
        activity: () => {
          this.activity();
          resetAgentIdle();
        },
        reserveTurn: () => this.reserveTurn(),
        reportUsage: (usage) => this.reportUsage(usageKey, usage),
      };
      const result = await task(taskAbort.signal, runtime);
      if (options.invocationSignal?.aborted)
        throw abortError(options.invocationSignal);
      return result;
    } finally {
      agentActive = false;
      agentWallGeneration++;
      agentIdleGeneration++;
      if (agentWallTimer !== undefined) this.clock.clearTimeout(agentWallTimer);
      if (agentIdleTimer !== undefined) this.clock.clearTimeout(agentIdleTimer);
      this.signal.removeEventListener("abort", onRunAbort);
      options.invocationSignal?.removeEventListener("abort", onInvocationAbort);
      try {
        options.onFinished?.();
      } finally {
        releaseShared?.();
        releaseRun?.();
      }
    }
  }

  private reserveTurn() {
    if (this.firstTermination) throw this.firstTermination;
    if (this.sealed || this.accountingFrozen)
      throw new Error("Workflow is settling");
    const limit = this.limits.total?.turns;
    if (limit !== undefined && this.reservedTurns >= limit) {
      const error = new WorkflowTerminationError(
        "turns",
        `Workflow turn limit of ${limit} exceeded`,
        "failed",
      );
      this.terminate(error);
      throw error;
    }
    this.reservedTurns++;
    this.activity();
  }

  private reportUsage(key: string | number, usage: AgentUsage) {
    if (this.firstTermination || this.sealed || this.accountingFrozen) return;
    const previous = this.usageHighWater.get(key) ?? {
      output: 0,
      cost: 0,
      outputComplete: true,
      costComplete: true,
    };
    const reportedOutputKnown =
      typeof usage.output === "number" &&
      Number.isFinite(usage.output) &&
      usage.output >= 0 &&
      usage.outputComplete !== false;
    const reportedCostKnown =
      typeof usage.cost === "number" &&
      Number.isFinite(usage.cost) &&
      usage.cost >= 0 &&
      usage.costComplete !== false;
    const output = reportedOutputKnown
      ? Math.max(previous.output, usage.output)
      : previous.output;
    const cost = reportedCostKnown
      ? Math.max(previous.cost, usage.cost)
      : previous.cost;
    this.totalOutput += output - previous.output;
    this.totalCost += cost - previous.cost;
    const outputComplete = previous.outputComplete && reportedOutputKnown;
    const costComplete = previous.costComplete && reportedCostKnown;
    this.outputComplete = this.outputComplete && outputComplete;
    this.costComplete = this.costComplete && costComplete;
    this.usageHighWater.set(key, {
      output,
      cost,
      outputComplete,
      costComplete,
    });

    const outputLimit = this.limits.total?.outputTokens;
    if (outputLimit !== undefined && !outputComplete) {
      this.terminate(
        new WorkflowTerminationError(
          "output_tokens",
          "Workflow output budget cannot be enforced because finalized usage omitted finite output tokens",
          "failed",
        ),
      );
      return;
    }
    if (outputLimit !== undefined && this.totalOutput > outputLimit) {
      this.terminate(
        new WorkflowTerminationError(
          "output_tokens",
          `Workflow output token limit of ${outputLimit} exceeded`,
          "failed",
        ),
      );
      return;
    }
    const costLimit = this.limits.total?.costUsd;
    if (costLimit === undefined) return;
    if (!costComplete) {
      this.terminate(
        new WorkflowTerminationError(
          "cost_usd",
          "Workflow cost budget cannot be enforced because finalized usage omitted a finite cost",
          "failed",
        ),
      );
    } else if (this.totalCost > costLimit) {
      this.terminate(
        new WorkflowTerminationError(
          "cost_usd",
          `Workflow cost limit of $${costLimit} exceeded`,
          "failed",
        ),
      );
    }
  }

  private armWorkflowTimers() {
    const wallMs = this.limits.workflow?.wallMs;
    if (wallMs !== undefined) {
      const generation = ++this.workflowWallGeneration;
      const deadline = this.clock.now() + wallMs;
      this.workflowWallDeadline = deadline;
      this.workflowWallTimer = this.clock.setTimeout(() => {
        if (
          generation !== this.workflowWallGeneration ||
          this.firstTermination ||
          this.sealed ||
          this.workflowWallDeadline !== deadline ||
          this.clock.now() < deadline
        ) {
          return;
        }
        this.terminate(
          new WorkflowTerminationError(
            "workflow_wall",
            `Workflow wall limit of ${wallMs} ms exceeded`,
            "failed",
          ),
        );
      }, wallMs);
    }
    this.activity();
  }

  private terminate(reason: WorkflowTerminationError) {
    if (this.firstTermination) return false;
    this.firstTermination = reason;
    const budget = this.telemetry();
    this.firstTerminationRecord = Object.freeze({
      code: reason.code,
      message: reason.message,
      outcome: reason.outcome,
      at: Date.now(),
      budget: Object.freeze({ ...budget }),
    });
    this.accountingFrozen = true;
    this.clearWorkflowTimers();
    this.abortController.abort(reason);
    return true;
  }

  private clearWorkflowTimers() {
    this.workflowWallGeneration++;
    this.workflowIdleGeneration++;
    if (this.workflowWallTimer !== undefined)
      this.clock.clearTimeout(this.workflowWallTimer);
    if (this.workflowIdleTimer !== undefined)
      this.clock.clearTimeout(this.workflowIdleTimer);
    this.workflowWallTimer = undefined;
    this.workflowWallDeadline = undefined;
    this.workflowIdleTimer = undefined;
    this.workflowIdleDeadline = undefined;
  }

  private detachParent() {
    if (this.parentAbort)
      this.parentSignal?.removeEventListener("abort", this.parentAbort);
    this.parentAbort = undefined;
    this.parentSignal = undefined;
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_AGENT_CALLS,
  reconcileWorkflowStatus,
  RunController,
} from "./controller.ts";
import {
  CapacityPool,
  resolveWorkflowLimits,
  type MonotonicClock,
  type WorkflowLimits,
} from "./limits.ts";
import { emptyUsage } from "./model.ts";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

class FakeClock implements MonotonicClock {
  private current = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now() {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number) {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(timer: unknown) {
    this.timers.delete(timer as number);
  }

  callbacks() {
    return [...this.timers.values()].map((timer) => timer.callback);
  }

  advance(milliseconds: number) {
    const target = this.current + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      this.current = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.current = target;
  }
}

function controller(
  concurrency = 4,
  sharedCapacity = new CapacityPool(16),
  parentSignal?: AbortSignal,
  limits: WorkflowLimits = {},
  clock?: MonotonicClock,
) {
  return new RunController({
    parentSignal,
    limits: resolveWorkflowLimits(
      { ...limits, concurrency },
      sharedCapacity.capacity,
    ),
    sharedCapacity,
    clock,
  });
}

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("RunController reserves calls synchronously and caps per-run fanout", async () => {
  const run = controller(4);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, (_, index) =>
    run.schedule(async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return index;
    }),
  );
  assert.deepEqual(
    await Promise.all(tasks),
    Array.from({ length: 12 }, (_, i) => i),
  );
  assert.equal(peak, 4);
  assert.equal(await run.settle(), true);
});

test("two controllers share process-global capacity", async () => {
  const shared = new CapacityPool(3);
  const first = controller(3, shared);
  const second = controller(3, shared);
  let active = 0;
  let peak = 0;
  const invoke = (run: RunController) =>
    run.schedule(async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
    });
  await Promise.all([
    ...Array.from({ length: 6 }, () => invoke(first)),
    ...Array.from({ length: 6 }, () => invoke(second)),
  ]);
  assert.equal(peak, 3);
  await Promise.all([first.settle(), second.settle()]);
});

test("run-local cancellation does not abort another run's shared waiter", async () => {
  const shared = new CapacityPool(1);
  const first = controller(1, shared);
  const second = controller(1, shared);
  let releaseFirst: (() => void) | undefined;
  const blocker = first.schedule(
    () => new Promise<void>((resolve) => (releaseFirst = resolve)),
  );
  await delay(0);
  const cancelled = first.schedule(async () => "never");
  const other = second.schedule(async () => "other completed");
  first.abort("first run cancelled");
  releaseFirst?.();
  await blocker;
  await assert.rejects(cancelled, /first run cancelled/);
  assert.equal(await other, "other completed");
  await Promise.all([first.settle(), second.settle()]);
});

test("parent cancellation is typed, aborted, and preserves its cause", () => {
  const parent = new AbortController();
  const run = controller(1, new CapacityPool(1), parent.signal);
  const reason = new Error("parent fixture");
  parent.abort(reason);

  assert.equal(run.termination?.code, "parent_cancelled");
  assert.equal(run.termination?.outcome, "aborted");
  assert.equal(run.termination?.cause, reason);
});

test("RunController propagates invocation cancellation without aborting the run", async () => {
  const run = controller(1);
  const invocation = new AbortController();
  const pending = run.schedule(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("stopped"), {
          once: true,
        });
      }),
    invocation.signal,
  );

  invocation.abort(new Error("Workflow agent request was cancelled"));
  await assert.rejects(pending, /request was cancelled/);
  assert.equal(run.signal.aborted, false);
  assert.equal(await run.schedule(async () => "recovered"), "recovered");
  assert.equal(await run.settle(), true);
});

test("RunController seals commits when bounded settlement begins", async () => {
  const run = controller();
  let value = "live";
  assert.equal(
    run.commit(() => {
      value = "updated";
    }),
    true,
  );
  void run.schedule(() => new Promise<void>(() => {}));

  const keepAlive = setInterval(() => {}, 1_000);
  assert.equal(await run.settle({ timeoutMs: 10 }), false);
  clearInterval(keepAlive);
  assert.equal(
    run.commit(() => {
      value = "late";
    }),
    false,
  );
  assert.equal(value, "updated");
  await assert.rejects(
    run.schedule(async () => "late task"),
    /settling/,
  );
});

test("workflow wall and idle timers are monotonic and first-reason-wins", () => {
  const wallClock = new FakeClock();
  const wall = controller(
    1,
    new CapacityPool(1),
    undefined,
    {
      workflow: { wallMs: 10 },
    },
    wallClock,
  );
  wallClock.advance(10);
  assert.equal(wall.termination?.code, "workflow_wall");
  wall.abort("later cancellation");
  assert.equal(wall.termination?.code, "workflow_wall");
  assert.equal(wall.termination?.outcome, "failed");

  const idleClock = new FakeClock();
  const idle = controller(
    1,
    new CapacityPool(1),
    undefined,
    {
      workflow: { idleMs: 10 },
    },
    idleClock,
  );
  idleClock.advance(9);
  idle.activity();
  idleClock.advance(9);
  assert.equal(idle.signal.aborted, false);
  idleClock.advance(1);
  assert.equal(idle.termination?.code, "workflow_idle");
});

test("agent wall and idle timers arm only after acquisition", async () => {
  for (const kind of ["wallMs", "idleMs"] as const) {
    const clock = new FakeClock();
    const shared = new CapacityPool(1);
    const holderAbort = new AbortController();
    const releaseHolder = await shared.acquire(holderAbort.signal);
    const run = controller(
      1,
      shared,
      undefined,
      {
        agent: { [kind]: 10 },
      },
      clock,
    );
    let started = false;
    let activity: (() => void) | undefined;
    const pending = run.schedule(
      (signal, runtime) => {
        activity = runtime.activity;
        return new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
      { onStarted: () => (started = true) },
    );
    await flushTasks();
    clock.advance(20);
    assert.equal(started, false);
    assert.equal(run.signal.aborted, false);

    releaseHolder();
    await flushTasks();
    assert.equal(started, true);
    if (kind === "idleMs") {
      clock.advance(9);
      activity?.();
      clock.advance(1);
      assert.equal(started, true);
      clock.advance(9);
    } else {
      clock.advance(10);
    }
    await assert.rejects(
      pending,
      new RegExp(`Agent ${kind === "wallMs" ? "wall" : "idle"} limit`),
    );
    assert.equal(run.signal.aborted, false);
    assert.equal(await run.settle(), true);
  }
});

test("turn, output, and cost budgets use reservations and cumulative high-water deltas", async () => {
  const turns = controller(1, new CapacityPool(1), undefined, {
    total: { turns: 1 },
  });
  await assert.rejects(
    turns.schedule(async (_signal, runtime) => {
      runtime.reserveTurn();
      runtime.reserveTurn();
    }),
    /turn limit/,
  );
  assert.equal(turns.termination?.code, "turns");

  const usage = controller(1, new CapacityPool(1), undefined, {
    total: { outputTokens: 10, costUsd: 2 },
  });
  await usage.schedule(async (_signal, runtime) => {
    const cumulative = emptyUsage();
    cumulative.output = 6;
    cumulative.cost = 1;
    runtime.reportUsage(cumulative);
    runtime.reportUsage(cumulative);
    assert.equal(usage.signal.aborted, false);
    cumulative.output = 11;
    runtime.reportUsage(cumulative);
  });
  assert.equal(usage.termination?.code, "output_tokens");

  const overCost = controller(1, new CapacityPool(1), undefined, {
    total: { costUsd: 1 },
  });
  await overCost.schedule(async (_signal, runtime) => {
    const cumulative = emptyUsage();
    cumulative.cost = 1.01;
    runtime.reportUsage(cumulative);
  });
  assert.equal(overCost.termination?.code, "cost_usd");

  const missingCost = controller(1, new CapacityPool(1), undefined, {
    total: { costUsd: 1 },
  });
  await missingCost.schedule(async (_signal, runtime) => {
    const cumulative = emptyUsage();
    cumulative.costComplete = false;
    runtime.reportUsage(cumulative);
  });
  assert.equal(missingCost.termination?.code, "cost_usd");
  assert.match(missingCost.termination?.message ?? "", /omitted a finite cost/);

  const incompleteUnbounded = controller();
  await incompleteUnbounded.schedule(async (_signal, runtime) => {
    const cumulative = emptyUsage();
    cumulative.costComplete = false;
    runtime.reportUsage(cumulative);
  });
  assert.equal(incompleteUnbounded.signal.aborted, false);
  await incompleteUnbounded.settle();
});

test("queued/running transitions follow both permits and settlement retains capacity", async () => {
  const shared = new CapacityPool(1);
  const holderAbort = new AbortController();
  const releaseHolder = await shared.acquire(holderAbort.signal);
  const run = controller(1, shared);
  const transitions = ["queued"];
  let finish: (() => void) | undefined;
  const task = run.schedule(
    () => new Promise<void>((resolve) => (finish = resolve)),
    { onStarted: () => transitions.push("running") },
  );
  await flushTasks();
  assert.deepEqual(transitions, ["queued"]);
  releaseHolder();
  await flushTasks();
  assert.deepEqual(transitions, ["queued", "running"]);
  assert.equal(shared.activeCount, 1);
  finish?.();
  await task;
  assert.equal(shared.activeCount, 0);
  assert.equal(await run.settle(), true);

  const timeoutClock = new FakeClock();
  const retained = new CapacityPool(1);
  const settling = controller(1, retained, undefined, {}, timeoutClock);
  let releaseTask: (() => void) | undefined;
  void settling.schedule(
    () => new Promise<void>((resolve) => (releaseTask = resolve)),
  );
  await flushTasks();
  const settlement = settling.settle({ timeoutMs: 10 });
  timeoutClock.advance(10);
  assert.equal(await settlement, false);
  assert.equal(retained.activeCount, 1);
  releaseTask?.();
  await flushTasks();
  assert.equal(retained.activeCount, 0);
});

test("settle is shared and a concurrent abort request upgrades it immediately", async () => {
  const clock = new FakeClock();
  const run = controller(1, new CapacityPool(1), undefined, {}, clock);
  let aborts = 0;
  void run.schedule(
    (signal) =>
      new Promise<void>(() => {
        signal.addEventListener("abort", () => aborts++, { once: true });
      }),
  );
  await flushTasks();

  const first = run.settle({ timeoutMs: 10, abort: false });
  const second = run.settle({ timeoutMs: 999, abort: true });
  const third = run.settle({ abort: true });
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(run.signal.aborted, true, "abort upgrade is synchronous");
  assert.equal(aborts, 1);
  assert.equal(run.termination?.code, "manual_abort");
  assert.equal(run.termination?.outcome, "aborted");

  clock.advance(10);
  assert.equal(await first, false);
  assert.equal(run.termination?.code, "manual_abort");
  assert.equal(run.terminationRecord?.code, "manual_abort");
});

test("stale and early workflow timer callbacks cannot terminate", async () => {
  const clock = new FakeClock();
  const run = controller(
    1,
    new CapacityPool(1),
    undefined,
    { workflow: { wallMs: 20, idleMs: 10 } },
    clock,
  );
  const [wallCallback, staleIdleCallback] = clock.callbacks();
  wallCallback?.();
  assert.equal(run.termination, undefined, "deadline must be rechecked");

  clock.advance(5);
  run.activity();
  staleIdleCallback?.();
  assert.equal(run.termination, undefined, "stale generation must be rejected");

  const callbacksBeforeSettle = clock.callbacks();
  assert.equal(await run.settle(), true);
  for (const callback of callbacksBeforeSettle) callback();
  assert.equal(
    run.termination,
    undefined,
    "settled lifecycle rejects callbacks",
  );
});

test("stale agent idle callback cannot win after lifecycle activity", async () => {
  const clock = new FakeClock();
  const run = controller(
    1,
    new CapacityPool(1),
    undefined,
    { agent: { idleMs: 10 } },
    clock,
  );
  let activity: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const task = run.schedule(async (_signal, runtime) => {
    activity = runtime.activity;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await flushTasks();
  const stale = clock.callbacks()[0];
  clock.advance(5);
  activity?.();
  stale?.();
  assert.equal(run.signal.aborted, false);
  finish?.();
  await task;
  assert.equal(await run.settle(), true);
});

test("terminalization freezes accounting and ignores late activity/usage", async () => {
  const run = controller(1, new CapacityPool(1), undefined, {
    total: { outputTokens: 100 },
  });
  await run.schedule(async (_signal, runtime) => {
    runtime.reserveTurn();
    const usage = emptyUsage();
    usage.output = 4;
    runtime.reportUsage(usage);
    run.abort("fixture terminal");
    runtime.activity();
    usage.output = 50;
    runtime.reportUsage(usage);
    assert.throws(() => runtime.reserveTurn(), /fixture terminal/);
  });
  assert.deepEqual(run.telemetry(), {
    turns: 1,
    outputTokens: 4,
    costUsd: 0,
    outputComplete: true,
    costComplete: true,
  });
  assert.deepEqual(run.terminationRecord?.budget, run.telemetry());
  assert.equal(Object.isFrozen(run.terminationRecord), true);
  assert.equal(Object.isFrozen(run.terminationRecord?.budget), true);
});

test("configured output budget fails closed on incomplete usage", async () => {
  const run = controller(1, new CapacityPool(1), undefined, {
    total: { outputTokens: 100 },
  });
  await run.schedule(async (_signal, runtime) => {
    const usage = emptyUsage();
    usage.outputComplete = false;
    runtime.reportUsage(usage);
  });
  assert.equal(run.termination?.code, "output_tokens");
  assert.match(run.termination?.message ?? "", /omitted finite output/i);
});

test("lifecycle callback failure still releases both permits", async () => {
  const shared = new CapacityPool(1);
  const run = controller(1, shared);
  await assert.rejects(
    run.schedule(async () => undefined, {
      onFinished: () => {
        throw new Error("finish callback failed");
      },
    }),
    /finish callback failed/,
  );
  assert.equal(shared.activeCount, 0);
  assert.equal(await run.schedule(async () => "next"), "next");
});

test("task finalization updates survive orderly abort but close at persistence boundary", async () => {
  const run = controller(1);
  let projection = "running";
  const task = run.schedule(
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            assert.equal(
              run.taskUpdate(() => {
                projection = "final";
              }),
              true,
            );
            resolve();
          },
          { once: true },
        );
      }),
  );
  await flushTasks();
  run.abort("orderly stop");
  await task;
  assert.equal(await run.settle({ abort: true }), true);
  assert.equal(projection, "final");
  assert.equal(
    run.taskUpdate(() => {
      projection = "late";
    }),
    false,
  );
  assert.equal(projection, "final");
});

test("typed status reconciliation gives controller termination precedence", () => {
  assert.equal(
    reconcileWorkflowStatus({
      sandboxSucceeded: true,
      termination: { outcome: "aborted" },
      settled: true,
    }),
    "aborted",
  );
  assert.equal(
    reconcileWorkflowStatus({
      sandboxSucceeded: true,
      termination: { outcome: "failed" },
      settled: true,
    }),
    "failed",
  );
  assert.equal(
    reconcileWorkflowStatus({ sandboxSucceeded: true, settled: true }),
    "completed",
  );
});

test("RunController enforces call budget and aborts queued tasks", async () => {
  const run = controller(1);
  const blocker = run.schedule(
    (signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  const queued = Array.from({ length: MAX_AGENT_CALLS - 1 }, () =>
    run.schedule(async () => "queued"),
  );
  await assert.rejects(
    run.schedule(async () => "too many"),
    /exceeded the limit/,
  );
  run.abort();
  await blocker;
  const results = await Promise.allSettled(queued);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(await run.settle({ abort: true }), true);
});

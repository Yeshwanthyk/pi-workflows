import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CapacityPool,
  hostCapacity,
  parseWorkflowLimits,
  resolveWorkflowLimits,
} from "./limits.ts";

for (const [available, expected] of [
  [1, 1],
  [2, 1],
  [6, 4],
  [12, 10],
  [18, 16],
  [64, 16],
] as const) {
  test(`host capacity maps ${available} to ${expected}`, () => {
    assert.equal(hostCapacity(available), expected);
  });
}

test("static limits accept the closed schema and resolve once", () => {
  const limits = parseWorkflowLimits({
    concurrency: 12,
    workflow: { wallMs: 1_000, idleMs: 500 },
    agent: { wallMs: 400, idleMs: 200 },
    total: { turns: 9, outputTokens: 10_000, costUsd: 1.25 },
  });
  assert.deepEqual(resolveWorkflowLimits(limits, 10), {
    ...limits,
    concurrency: 10,
    hardCapacity: 10,
  });
  assert.deepEqual(resolveWorkflowLimits(undefined, 16), {
    concurrency: 4,
    hardCapacity: 16,
  });
});

test("static limits reject malformed, unknown, non-finite, and invalid values", () => {
  for (const value of [
    null,
    [],
    { unknown: 1 },
    { concurrency: 0 },
    { concurrency: 1.5 },
    { workflow: null },
    { workflow: { wallMs: Infinity } },
    { workflow: { idleMs: -1 } },
    { agent: { unknown: 1 } },
    { total: { turns: -1 } },
    { total: { outputTokens: NaN } },
    { total: { costUsd: -0.01 } },
  ]) {
    assert.throws(() => parseWorkflowLimits(value));
  }
  assert.deepEqual(
    parseWorkflowLimits({
      total: { turns: 0, outputTokens: 0, costUsd: 0 },
    }),
    {
      total: { turns: 0, outputTokens: 0, costUsd: 0 },
    },
  );
});

test("aborting one shared-pool waiter does not clear another run's waiter", async () => {
  const pool = new CapacityPool(1);
  const holderAbort = new AbortController();
  const release = await pool.acquire(holderAbort.signal);
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = pool.acquire(firstAbort.signal);
  const second = pool.acquire(secondAbort.signal);

  firstAbort.abort(new Error("first run cancelled"));
  await assert.rejects(first, /first run cancelled/);
  release();
  const releaseSecond = await second;
  assert.equal(pool.activeCount, 1);
  releaseSecond();
  assert.equal(pool.activeCount, 0);
});

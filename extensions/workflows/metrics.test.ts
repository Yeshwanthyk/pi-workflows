import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WorkflowMetricsRecorder,
  measureWorkflow,
  measureWorkflowSync,
} from "./metrics.ts";

test("workflow metrics aggregate bounded stage summaries and counters", async () => {
  const recorder = new WorkflowMetricsRecorder();
  recorder.observe("agent.execute", 10);
  recorder.observe("agent.execute", 30);
  recorder.observe("agent.execute", Number.NaN);
  recorder.increment("agents.started");
  recorder.increment("agents.started", 2);

  assert.equal(
    measureWorkflowSync(recorder, "limits.resolve", () => "resolved"),
    "resolved",
  );
  assert.equal(
    await measureWorkflow(recorder, "sandbox.total", async () => "done"),
    "done",
  );

  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.stages["agent.execute"], {
    count: 2,
    minMs: 10,
    medianMs: 10,
    p90Ms: 30,
    p95Ms: 30,
    maxMs: 30,
    totalMs: 40,
  });
  assert.equal(snapshot.stages["limits.resolve"]?.count, 1);
  assert.equal(snapshot.stages["sandbox.total"]?.count, 1);
  assert.equal(snapshot.counters["agents.started"], 3);
});

test("workflow measurement helpers preserve thrown failures", async () => {
  const recorder = new WorkflowMetricsRecorder();
  assert.throws(
    () =>
      measureWorkflowSync(recorder, "persistence.initial", () => {
        throw new Error("sync failure");
      }),
    /sync failure/,
  );
  await assert.rejects(
    measureWorkflow(recorder, "persistence.final", async () => {
      throw new Error("async failure");
    }),
    /async failure/,
  );
  assert.equal(recorder.snapshot().stages["persistence.initial"]?.count, 1);
  assert.equal(recorder.snapshot().stages["persistence.final"]?.count, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelActiveWorkflowRun } from "./cancellation.ts";
import { reconcileWorkflowStatus, RunController } from "./controller.ts";
import { CapacityPool, resolveWorkflowLimits } from "./limits.ts";
import type { WorkflowDetails } from "./model.ts";

function fixture() {
  const sharedCapacity = new CapacityPool(1);
  const controller = new RunController({
    limits: resolveWorkflowLimits({ concurrency: 1 }, sharedCapacity.capacity),
    sharedCapacity,
  });
  const details: WorkflowDetails = {
    runId: "wf_fixture",
    status: "running",
    background: true,
    startedAt: Date.now(),
    limits: resolveWorkflowLimits({ concurrency: 1 }, sharedCapacity.capacity),
    budget: {
      turns: 0,
      outputTokens: 0,
      costUsd: 0,
      outputComplete: true,
      costComplete: true,
    },
    phases: [],
    agents: [],
  };
  return { controller, details };
}

test("clean cancellation waits for run completion and reports aborted", async () => {
  const { controller, details } = fixture();
  let release: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    release = () => {
      details.status = reconcileWorkflowStatus({
        sandboxSucceeded: false,
        termination: controller.termination,
        settled: true,
      });
      resolve();
    };
  });
  const active = new Map([
    [details.runId, { controller, details, completion }],
  ]);

  let finished = false;
  const cancelling = cancelActiveWorkflowRun(active, details.runId).then(
    (result) => {
      finished = true;
      return result;
    },
  );
  await Promise.resolve();
  assert.equal(controller.termination?.code, "manual_abort");
  assert.equal(finished, false, "cancellation must wait for final projection");

  release?.();
  const result = await cancelling;
  assert.equal(result.status, "aborted");
});

test("clean cancellation rejects inactive runs", async () => {
  await assert.rejects(
    cancelActiveWorkflowRun(new Map(), "wf_missing"),
    /not active/,
  );
});

test("a prior failure remains authoritative during cancellation", async () => {
  const { controller, details } = fixture();
  controller.failScript("failed first");
  const completion = Promise.resolve().then(() => {
    details.status = reconcileWorkflowStatus({
      sandboxSucceeded: false,
      termination: controller.termination,
      settled: true,
    });
  });
  const active = new Map([
    [details.runId, { controller, details, completion }],
  ]);

  const result = await cancelActiveWorkflowRun(active, details.runId);
  assert.equal(result.status, "failed");
  assert.equal(controller.termination?.code, "script_failure");
});

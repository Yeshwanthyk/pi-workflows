import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { createWorkflowRun, type WorkflowRunOptions } from "./execution.ts";
import { CapacityPool } from "./limits.ts";
import { WorkflowMetricsRecorder } from "./metrics.ts";
import { emptyUsage } from "./model.ts";

function options(
  workflowsDir: string,
  overrides: Partial<WorkflowRunOptions> = {},
): WorkflowRunOptions {
  return {
    workflowsDir,
    script: "export const meta = { name: 'fixture' }\nreturn true;",
    source: "return true;",
    args: undefined,
    argsText: '{"value":1}',
    meta: { name: "fixture", phases: [{ title: "Start" }] },
    sessionId: "session-fixture",
    cwd: process.cwd(),
    background: false,
    sharedCapacity: new CapacityPool(4),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    projectTrusted: false,
    getThinkingLevel: () => "medium",
    runSandbox: async () => true,
    ...overrides,
  };
}

function tempWorkflowsDir() {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-execution-"));
  const workflowsDir = join(root, "workflows");
  mkdirSync(workflowsDir);
  return { root, workflowsDir };
}

function fakeResources(cwd: string) {
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
  });
  return { loader, settingsManager };
}

test("workflow execution starts through its handle and persists the final result", async () => {
  const { root, workflowsDir } = tempWorkflowsDir();
  try {
    const observed = { sandboxSignal: undefined as AbortSignal | undefined };
    const progress: string[] = [];
    const metrics = new WorkflowMetricsRecorder();
    const run = createWorkflowRun(
      options(workflowsDir, {
        background: true,
        metrics,
        onProgress: (details) => progress.push(details.status),
        runSandbox: async ({ signal, onPhase }) => {
          observed.sandboxSignal = signal;
          onPhase("Start");
          return { ok: true };
        },
      }),
    );

    assert.equal(run.details.status, "running");
    assert.equal(observed.sandboxSignal, undefined);
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(workflowsDir, run.details.runId, "workflow.json"),
          "utf8",
        ),
      ).status,
      "running",
    );

    const completion = run.handle();
    assert.equal(run.handle(), completion);
    await completion;

    assert.equal(observed.sandboxSignal !== undefined, true);
    assert.equal(run.details.status, "completed");
    assert.deepEqual(run.details.result, { ok: true });
    assert.ok(progress.includes("completed"));
    assert.equal(
      readFileSync(join(workflowsDir, run.details.runId, "script.js"), "utf8"),
      "export const meta = { name: 'fixture' }\nreturn true;",
    );
    assert.equal(
      readFileSync(join(workflowsDir, run.details.runId, "args.json"), "utf8"),
      '{"value":1}',
    );
    const persisted = JSON.parse(
      readFileSync(
        join(workflowsDir, run.details.runId, "workflow.json"),
        "utf8",
      ),
    ) as { status: string; result: string; resultArtifact: string };
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.result, "[stored in result.json]");
    assert.equal(persisted.resultArtifact, "result.json");
    const metricSnapshot = metrics.snapshot();
    assert.equal(metricSnapshot.stages["run.total"]?.count, 1);
    assert.equal(metricSnapshot.stages["sandbox.total"]?.count, 1);
    assert.equal(metricSnapshot.stages["persistence.initial"]?.count, 1);
    assert.equal(metricSnapshot.stages["persistence.final"]?.count, 1);
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(workflowsDir, run.details.runId, "result.json"),
          "utf8",
        ),
      ),
      { ok: true },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow execution projects agents and preserves budget termination", async () => {
  const { root, workflowsDir } = tempWorkflowsDir();
  try {
    const run = createWorkflowRun(
      options(workflowsDir, {
        meta: {
          name: "budgeted",
          phases: [],
          limits: { total: { outputTokens: 4 } },
        },
        createResources: async (cwd, _variant, _projectTrusted) =>
          fakeResources(cwd),
        runSandbox: async ({ onAgent }) => ({
          agent: await onAgent(
            "inspect",
            { label: "worker", effort: "low" },
            new AbortController().signal,
          ),
        }),
        runAgent: async (input) => {
          input.onTurnStart?.();
          input.onUsage?.({
            ...emptyUsage(),
            output: 5,
            cost: 0.25,
            turns: 1,
          });
          return {
            ok: true,
            output: "completed despite budget race",
            aborted: false,
            usage: { ...emptyUsage(), output: 5, cost: 0.25, turns: 1 },
            transcript: [],
          };
        },
      }),
    );

    await run.handle();

    assert.equal(run.details.status, "failed");
    assert.equal(run.controller.termination?.code, "output_tokens");
    assert.equal(run.details.agents.length, 1);
    assert.equal(run.details.agents[0]?.label, "worker");
    assert.equal(run.details.agents[0]?.state, "done");
    assert.equal(run.details.budget?.outputTokens, 5);
    assert.match(run.details.error ?? "", /output budget|output token/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow execution preserves typed parent cancellation", async () => {
  const { root, workflowsDir } = tempWorkflowsDir();
  try {
    const parent = new AbortController();
    let sandboxStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      sandboxStarted = resolve;
    });
    const run = createWorkflowRun(
      options(workflowsDir, {
        parentSignal: parent.signal,
        runSandbox: ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            sandboxStarted?.();
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      }),
    );

    const completion = run.handle();
    await started;
    const reason = new Error("parent fixture");
    parent.abort(reason);
    await completion;

    assert.equal(run.details.status, "aborted");
    assert.equal(run.controller.termination?.code, "parent_cancelled");
    assert.equal(run.controller.termination?.cause, reason);
    assert.match(run.details.error ?? "", /parent fixture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow execution bounds progress logs and persists them", async () => {
  const { root, workflowsDir } = tempWorkflowsDir();
  try {
    const run = createWorkflowRun(
      options(workflowsDir, {
        runSandbox: async ({ onLog }) => {
          for (let index = 0; index < 140; index++) {
            onLog?.(`${index}:` + "ø".repeat(5_000));
          }
          return true;
        },
      }),
    );

    await run.handle();

    assert.ok((run.details.logs?.length ?? 0) < 128);
    assert.ok(
      (run.details.logs ?? []).every(
        (entry) => Buffer.byteLength(entry.message, "utf8") <= 4 * 1024,
      ),
    );
    assert.ok(
      Buffer.byteLength(
        (run.details.logs ?? []).map((entry) => entry.message).join(""),
        "utf8",
      ) <=
        64 * 1024,
    );
    const persisted = JSON.parse(
      readFileSync(
        join(workflowsDir, run.details.runId, "workflow.json"),
        "utf8",
      ),
    ) as { logs: unknown[] };
    assert.equal(persisted.logs.length, run.details.logs?.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow execution caps log event count", async () => {
  const { root, workflowsDir } = tempWorkflowsDir();
  try {
    const run = createWorkflowRun(
      options(workflowsDir, {
        runSandbox: async ({ onLog }) => {
          for (let index = 0; index < 140; index++) onLog?.(`entry-${index}`);
          return true;
        },
      }),
    );

    await run.handle();
    assert.equal(run.details.logs?.length, 128);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

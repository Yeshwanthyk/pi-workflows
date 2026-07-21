import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildReport,
  loadStoredRunDetails,
  normalizeDetails,
} from "./dashboard.ts";

test("historical dashboard hydration normalizes usage and resolved governance", () => {
  const details = normalizeDetails("wf_fixture", {
    status: "running",
    startedAt: 1,
    limits: {
      concurrency: 4,
      hardCapacity: 10,
      total: { turns: 0, outputTokens: 0, costUsd: 0 },
    },
    budget: {
      turns: "poison",
      outputTokens: Number.NaN,
      costUsd: -1,
      outputComplete: false,
      costComplete: false,
    },
    termination: {
      code: "output_tokens",
      message: "unknown output",
      outcome: "failed",
      at: 5,
      budget: {
        turns: 1,
        outputTokens: 0,
        costUsd: 0,
        outputComplete: false,
        costComplete: true,
      },
    },
    agents: [
      {
        index: 1,
        label: "legacy",
        state: "running",
        startedAt: 2,
        usage: {
          input: "100",
          output: Number.NaN,
          cacheRead: -2,
          cacheWrite: 3,
          cost: "bad",
          turns: Infinity,
          outputComplete: false,
        },
      },
    ],
  });

  assert.ok(details);
  assert.deepEqual(details.limits, {
    concurrency: 4,
    hardCapacity: 10,
    total: { turns: 0, outputTokens: 0, costUsd: 0 },
  });
  assert.deepEqual(details.agents[0]?.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 3,
    cost: 0,
    outputComplete: false,
    costComplete: false,
    turns: 0,
  });
  assert.deepEqual(details.budget, {
    turns: 0,
    outputTokens: 0,
    costUsd: 0,
    outputComplete: false,
    costComplete: false,
  });
  assert.equal(details.termination?.code, "output_tokens");
});

test("stored run loading recovers stale running detail", (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-stale-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(runDir, "workflow.json"),
    JSON.stringify({
      runId: "wf_stale",
      status: "running",
      startedAt: 1,
      agents: [
        { index: 1, label: "active", state: "running", startedAt: 2 },
        { index: 2, label: "queued", state: "queued", queuedAt: 2 },
        { index: 3, label: "done", state: "done", finishedAt: 3 },
      ],
    }),
  );

  const details = loadStoredRunDetails("wf_stale", runDir, 10);

  assert.ok(details);
  assert.equal(details.status, "aborted");
  assert.equal(details.finishedAt, 10);
  assert.equal(details.error, "Recovered stale run that was not active");
  assert.deepEqual(
    details.agents.map(({ state, finishedAt }) => ({ state, finishedAt })),
    [
      { state: "error", finishedAt: 10 },
      { state: "error", finishedAt: 10 },
      { state: "done", finishedAt: 3 },
    ],
  );
});

test("report exposes queued/running counts and effective capacity", () => {
  const details = normalizeDetails("wf_fixture", {
    name: "fixture",
    status: "running",
    startedAt: Date.now(),
    limits: { concurrency: 3, hardCapacity: 10 },
    agents: [
      { index: 1, label: "queued", state: "queued", queuedAt: 1 },
      {
        index: 2,
        label: "running",
        state: "running",
        queuedAt: 1,
        startedAt: 2,
      },
    ],
  });
  assert.ok(details);
  const report = buildReport(details);
  assert.match(report, /1 running, 1 queued/);
  assert.match(report, /concurrency 3, host hard capacity 10/);
});

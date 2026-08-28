import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildReport,
  loadStoredRunDetails,
  normalizeDetails,
  WorkflowRunCatalog,
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
    agent: { wallMs: 1_800_000 },
    workflow: { wallMs: 7_200_000 },
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

test("normalized agents carry provider, model name, and thinking preview", () => {
  const details = normalizeDetails("wf_fixture", {
    status: "completed",
    startedAt: 1,
    agents: [
      {
        index: 1,
        label: "modern",
        state: "done",
        startedAt: 2,
        finishedAt: 3,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        modelName: "Claude Sonnet 4.5",
        thinkingLevel: "high",
        thinkingPreview:
          "The seam must close within 2 px.\nRe-observe the card.",
      },
      {
        index: 2,
        label: "legacy",
        state: "done",
        startedAt: 2,
        finishedAt: 3,
        provider: 42,
        modelName: ["bad"],
        thinkingPreview: { not: "a string" },
      },
    ],
  });

  assert.ok(details);
  assert.deepEqual(details.agents[0], {
    index: 1,
    label: "modern",
    phase: undefined,
    state: "done",
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    modelName: "Claude Sonnet 4.5",
    thinkingPreview: "The seam must close within 2 px.\nRe-observe the card.",
    thinkingLevel: "high",
    contextWindow: undefined,
    queuedAt: 2,
    startedAt: 2,
    finishedAt: 3,
    error: undefined,
    preview: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      outputComplete: false,
      costComplete: false,
      turns: 0,
    },
    transcript: [],
  });
  assert.equal(details.agents[1]?.provider, undefined);
  assert.equal(details.agents[1]?.modelName, undefined);
  assert.equal(details.agents[1]?.thinkingPreview, undefined);
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

function writeCatalogRun(
  root: string,
  runId: string,
  sessionId: string,
  startedAt: number,
) {
  const directory = path.join(root, runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "workflow.json"),
    JSON.stringify({
      runId,
      sessionId,
      status: "completed",
      startedAt,
      phases: [],
      agents: [
        {
          index: 1,
          label: "worker",
          state: "done",
          preview: "done",
          usage: {},
          transcript: [],
        },
      ],
      transcriptArtifact: "transcripts.json",
    }),
  );
  fs.writeFileSync(
    path.join(directory, "transcripts.json"),
    JSON.stringify({ 1: [{ role: "assistant", text: `detail:${runId}` }] }),
  );
}

test("workflow catalog scans once, filters from memory, and hydrates sidecars lazily", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-catalog-"));
  try {
    writeCatalogRun(root, "wf_a", "session-a", 3);
    writeCatalogRun(root, "wf_b", "session-b", 2);
    const catalog = new WorkflowRunCatalog(root);
    assert.deepEqual(catalog.stats, {
      scans: 1,
      compactReads: 2,
      sidecarHydrations: 0,
    });

    const entries = catalog.entries(new Map(), "session-a", new Set());
    assert.deepEqual(
      entries.map((entry) => entry.runId),
      ["wf_a"],
    );
    assert.equal(entries[0]?.details.agents[0]?.transcript.length, 0);

    // Repeated idle refreshes are pure in-memory projections.
    catalog.entries(new Map(), "session-a", new Set());
    catalog.entries(new Map(), "session-a", new Set());
    assert.equal(catalog.stats.scans, 1);
    assert.equal(catalog.stats.compactReads, 2);
    assert.equal(catalog.stats.sidecarHydrations, 0);

    const live = normalizeDetails("wf_live", {
      sessionId: "session-a",
      status: "running",
      startedAt: 4,
      phases: [],
      agents: [],
    })!;
    catalog.entries(new Map([["wf_live", live]]), "session-a", new Set());
    live.status = "completed";
    assert.ok(
      catalog
        .entries(new Map(), "session-a", new Set())
        .some((entry) => entry.runId === "wf_live"),
    );

    const hydrated = catalog.hydrate(entries[0]!);
    assert.equal(
      hydrated.details.agents[0]?.transcript[0]?.text,
      "detail:wf_a",
    );
    assert.equal(catalog.stats.sidecarHydrations, 1);
    catalog.hydrate(entries[0]!);
    assert.equal(catalog.stats.sidecarHydrations, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

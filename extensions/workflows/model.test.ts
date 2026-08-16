import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateUsage,
  countStates,
  emptyUsage,
  formatAgentLifecycle,
  formatUsage,
  isWorkflowThinkingLevel,
  modelBadge,
  modelLabel,
  normalizeAgentUsage,
  normalizeBudgetTelemetry,
  statusColorFor,
  statusWordFor,
  type WorkflowDetails,
} from "./model.ts";

test("derived status flags agent failures even when the script completed", () => {
  const base = {
    runId: "wf_x",
    background: false,
    startedAt: 1,
    finishedAt: 2,
    phases: [],
  } as unknown as WorkflowDetails;
  const agent = (state: "done" | "error") => ({
    index: 1,
    label: "a",
    state,
    queuedAt: 1,
    preview: "",
    usage: emptyUsage(),
    transcript: [],
  });

  assert.equal(
    statusWordFor({ ...base, status: "completed", agents: [agent("done")] }),
    "done",
  );
  assert.equal(
    statusColorFor({ ...base, status: "completed", agents: [agent("done")] }),
    "success",
  );
  assert.equal(
    statusWordFor({
      ...base,
      status: "completed",
      agents: [agent("done"), agent("error")],
    }),
    "done, 1 failed",
  );
  assert.equal(
    statusColorFor({
      ...base,
      status: "completed",
      agents: [agent("done"), agent("error")],
    }),
    "warning",
  );
  assert.equal(
    statusWordFor({ ...base, status: "running", agents: [] }),
    "running",
  );
});

test("model badges combine provider and model id", () => {
  assert.equal(
    modelBadge({ provider: "anthropic", model: "claude-sonnet-4-5" }),
    "anthropic/claude-sonnet-4-5",
  );
  assert.equal(modelBadge({ model: "gpt-5" }), "gpt-5");
  assert.equal(modelBadge({}), undefined);
  assert.equal(
    modelLabel({ provider: "openai", model: "gpt-5" }),
    "openai/gpt-5",
  );
  assert.equal(modelLabel({}), "unknown model");
});

test("workflow thinking levels validate and render with agent usage", () => {
  assert.equal(isWorkflowThinkingLevel("medium"), true);
  assert.equal(isWorkflowThinkingLevel("turbo"), false);

  const usage = emptyUsage();
  usage.turns = 1;
  usage.input = 12_000;
  usage.output = 800;
  usage.cost = 0.25;

  assert.equal(
    formatUsage(usage, "gpt-5.6-sol", "medium"),
    "1 turn · 12k in · 800 out · $0.2500 · gpt-5.6-sol · think:medium",
  );
});

test("queued agents count separately and incomplete cost accounting aggregates", () => {
  const usage = emptyUsage();
  usage.costComplete = false;
  const agent = {
    index: 1,
    label: "queued",
    state: "queued" as const,
    queuedAt: 1,
    preview: "",
    usage,
    transcript: [],
  };
  const details: WorkflowDetails = {
    runId: "wf_fixture",
    background: false,
    status: "running",
    startedAt: 1,
    phases: [],
    agents: [agent],
  };

  assert.deepEqual(countStates(details), {
    done: 0,
    failed: 0,
    running: 0,
    queued: 1,
  });
  assert.equal(aggregateUsage(details.agents).costComplete, false);
  assert.equal(formatAgentLifecycle(details), "0/1 agents · 1 queued");
});

test("malformed historical usage cannot poison aggregation or rendering", () => {
  const normalized = normalizeAgentUsage({
    input: "12",
    output: Number.NaN,
    cacheRead: Infinity,
    cacheWrite: -1,
    cost: "0.4",
    turns: 2,
  });
  assert.deepEqual(normalized, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    outputComplete: false,
    costComplete: false,
    turns: 2,
  });
  assert.doesNotThrow(() => formatUsage(normalized));

  assert.deepEqual(
    normalizeAgentUsage({
      output: 1,
      cost: 1,
      outputComplete: "false",
      costComplete: 0,
    }),
    {
      input: 0,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 1,
      outputComplete: false,
      costComplete: false,
      turns: 0,
    },
  );

  assert.deepEqual(
    normalizeBudgetTelemetry({
      turns: 2,
      outputTokens: "bad",
      costUsd: Infinity,
      outputComplete: true,
      costComplete: true,
    }),
    {
      turns: 2,
      outputTokens: 0,
      costUsd: 0,
      outputComplete: false,
      costComplete: false,
    },
  );

  assert.deepEqual(
    normalizeBudgetTelemetry({
      turns: 1,
      outputTokens: 1,
      costUsd: 1,
      outputComplete: "true",
      costComplete: 1,
    }),
    {
      turns: 1,
      outputTokens: 1,
      costUsd: 1,
      outputComplete: false,
      costComplete: false,
    },
  );
});

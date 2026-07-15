import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, formatUsage, isWorkflowThinkingLevel } from "./model.ts";

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

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetAdvisory,
  buildWorkflowAgentPrompt,
  buildWorkflowDraftMessage,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";

test("workflow children execute their assigned outcome without replanning", () => {
  const prompt = buildWorkflowAgentPrompt(
    "Inspect only src/parser.ts and return the parsing seam.",
  );

  assert.match(prompt, /workflow already owns decomposition and coordination/i);
  assert.match(prompt, /assigned outcome and its focused proof/i);
  assert.match(prompt, /without creating another plan/i);
  assert.match(prompt, /consult referenced reports or artifacts/i);
  assert.match(prompt, /Reuse existing project patterns/);
  assert.match(prompt, /avoid duplicating other agents/);
  assert.match(prompt, /do not expand into later roadmap work/);
  assert.match(prompt, /Assigned workflow step:\nInspect only src\/parser\.ts/);
});

test("budget advisory flags tight shared budgets and stays quiet on defaults", () => {
  assert.equal(
    budgetAdvisory({ total: { turns: 30, outputTokens: 10_000 } }),
    "\nBudget advisory: total.turns:30 may be tight — the pool is shared across all agents (default 400); total.outputTokens:10000 may be tight — shared across agents, includes reads/bash (default 200k).",
  );
  assert.equal(
    budgetAdvisory({ agent: { wallMs: 5 * 60_000 } }),
    "\nBudget advisory: agent.wallMs:300000 may be tight for implementation agents (default 30m).",
  );
  assert.equal(
    budgetAdvisory({
      total: { turns: 120, outputTokens: 50_000 },
      agent: { wallMs: 15 * 60_000 },
    }),
    undefined,
  );
  assert.equal(budgetAdvisory(undefined), undefined);
});

test("workflow authoring guidance favors complete outcomes in fresh agents", () => {
  const guidance = WORKFLOW_PROMPT_GUIDELINES.join("\n");

  assert.match(guidance, /workflow draft owns decomposition/i);
  assert.match(guidance, /one agent for a naturally bounded outcome/i);
  assert.match(guidance, /few sequential fresh agents/i);
  assert.match(guidance, /parallel branches only for independent bounded/);
  assert.match(guidance, /avoid concurrent writes/);
  assert.match(guidance, /complete outcome with focused proof/i);
  assert.match(guidance, /relevant report or artifact paths/i);
  assert.match(
    guidance,
    /instead of packing the whole change into one writer/i,
  );
  assert.match(guidance, /one integration\/proof agent/i);
  assert.match(guidance, /checks the complete result/i);
  assert.match(guidance, /emit the preview before the script/);
  assert.match(
    guidance,
    /do not repeat the preview as separate assistant prose/,
  );
  assert.match(guidance, /quoted string literals for static agent prompts/);
  assert.match(guidance, /escape.*backticks.*template literals/i);
  assert.match(guidance, /never reduce.*bare draft ID/i);
  assert.match(guidance, /Independent approved drafts may run concurrently/);
});

test("workflow tool contract describes deterministic draft execution", () => {
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /starts no agents/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /newer response/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /with only the draftId/);
});

test("prepared draft output exposes the free-form preview without running", () => {
  const message = buildWorkflowDraftMessage({
    draftId: "draft_123456789abc",
    preview: "Scan parser and runner in parallel; one writer integrates.",
    meta: {
      name: "bounded-change",
      phases: [
        { title: "Scan", detail: "two independent read-only lanes" },
        { title: "Implement" },
      ],
      limits: { concurrency: 2, total: { outputTokens: 10_000 } },
    },
    artifactPath: "/tmp/draft/draft_123456789abc/draft.json",
  });

  assert.match(message, /no agents started/);
  assert.match(message, /\/workflow-draft draft_123456789abc/);
  assert.match(message, /exact immutable source/);
  assert.match(message, /draft\.json/);
  assert.match(message, /Scan parser and runner in parallel/);
  assert.match(message, /Scan — two independent read-only lanes/);
  assert.match(message, /outputTokens/);
  assert.match(message, /newer, explicit user response/);
});

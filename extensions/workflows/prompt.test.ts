import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWorkflowAgentPrompt,
  buildWorkflowDraftMessage,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";

test("workflow children receive shared scope guidance before their assignment", () => {
  const prompt = buildWorkflowAgentPrompt(
    "Inspect only src/parser.ts and return the parsing seam.",
  );

  assert.match(prompt, /Own only the assigned workflow lane/);
  assert.match(prompt, /Reuse existing project patterns/);
  assert.match(prompt, /avoid duplicating other agents/);
  assert.match(prompt, /do not expand into later roadmap work/);
  assert.match(prompt, /Assigned workflow step:\nInspect only src\/parser\.ts/);
});

test("workflow authoring guidance favors bounded non-overlapping parallelism", () => {
  const guidance = WORKFLOW_PROMPT_GUIDELINES.join("\n");

  assert.match(guidance, /parallel branches only for independent bounded/);
  assert.match(guidance, /avoid overlapping writes/);
  assert.match(guidance, /emit the preview before the script/);
  assert.match(
    guidance,
    /do not repeat the preview as separate assistant prose/,
  );
  assert.match(guidance, /quoted string literals for static agent prompts/);
  assert.match(guidance, /escape.*backticks.*template literals/i);
  assert.match(guidance, /never reduce.*bare draft ID/i);
  assert.match(guidance, /one writer/);
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
  assert.match(message, /Ctrl\+O.*exact immutable script/);
  assert.match(message, /draft\.json/);
  assert.match(message, /Scan parser and runner in parallel/);
  assert.match(message, /Scan — two independent read-only lanes/);
  assert.match(message, /outputTokens/);
  assert.match(message, /newer, explicit user response/);
});

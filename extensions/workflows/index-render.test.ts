import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initTheme,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import workflows from "./index.ts";

initTheme("dark");

interface CapturedTool {
  name: string;
  renderCall?: (
    args: Record<string, unknown>,
    theme: Theme,
    context: Record<string, unknown>,
  ) => Component;
  renderResult?: (
    result: Record<string, unknown>,
    options: { expanded: boolean },
    theme: Theme,
  ) => Component;
}

function captureWorkflowTool(): CapturedTool {
  const tools: CapturedTool[] = [];
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: unknown) {
      tools.push(tool as CapturedTool);
    },
  } as unknown as ExtensionAPI;

  workflows(pi);
  const tool = tools.find((candidate) => candidate.name === "workflow");
  assert.ok(tool?.renderCall);
  assert.ok(tool.renderResult);
  return tool;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function rendered(component: Component) {
  return component.render(240).join("\n");
}

test("streaming workflow drafts expose preview and save boundary", () => {
  const tool = captureWorkflowTool();
  const script =
    "export const meta = { name: 'streamed-draft', phases: [{ title: 'Scan' }] }\nphase('Scan')";
  const component = tool.renderCall!(
    {
      preview: "Scan two independent seams, then use one writer.",
      script,
      background: true,
    },
    theme,
    { argsComplete: false },
  );
  const output = rendered(component);

  assert.match(output, /workflow draft streamed-draft \(background\)/);
  assert.match(output, /Preparing immutable script/);
  assert.match(output, new RegExp(`${script.length} chars received`));
  assert.match(output, /draft saves when complete/);
  assert.match(output, /Preview/);
  assert.match(output, /Scan two independent seams/);
});

test("saved draft results route exact-source review to the draft inspector", () => {
  const tool = captureWorkflowTool();
  const script = "phase('Scan')\nreturn { ok: true }";
  const result = {
    content: [{ type: "text", text: "prepared" }],
    details: {
      kind: "draft",
      draftId: "draft_123456789abc",
      name: "reviewable-draft",
      preview: "Scan safely, then report.",
      script,
      artifactPath: "/tmp/workflows/drafts/draft_123456789abc/draft.json",
      background: true,
      phases: [{ title: "Scan", detail: "read-only" }],
      limits: { concurrency: 2 },
    },
  };

  const collapsed = rendered(
    tool.renderResult!(result, { expanded: false }, theme),
  );
  assert.match(collapsed, /workflow draft reviewable-draft/);
  assert.match(collapsed, /no agents started/i);
  assert.match(collapsed, /\/workflow-draft draft_123456789abc/);
  assert.match(collapsed, /inspect plan and exact source/);

  const expanded = rendered(
    tool.renderResult!(result, { expanded: true }, theme),
  );
  assert.match(expanded, /Scan safely, then report/);
  assert.match(expanded, /read-only/);
  assert.match(expanded, /draft\.json/);
  assert.match(expanded, /Review inspector/);
  assert.match(expanded, /\/workflow-draft draft_123456789abc/);
  assert.doesNotMatch(expanded, /phase\('Scan'\)/);
  assert.doesNotMatch(expanded, /return \{ ok: true \}/);
});

test("completed workflow calls leave the preview to the prepared result", () => {
  const tool = captureWorkflowTool();
  const component = tool.renderCall!(
    {
      preview: "This appears in the tool result after persistence.",
      script:
        "export const meta = { name: 'saved-draft', phases: [{ title: 'Save' }] }",
    },
    theme,
    { argsComplete: true },
  );
  const output = rendered(component);

  assert.match(output, /workflow draft saved-draft/);
  assert.doesNotMatch(output, /Preparing immutable script/);
  assert.doesNotMatch(output, /This appears in the tool result/);
});

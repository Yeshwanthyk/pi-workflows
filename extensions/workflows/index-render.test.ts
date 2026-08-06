import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import workflows from "./index.ts";

interface CapturedTool {
  name: string;
  renderCall?: (
    args: Record<string, unknown>,
    theme: Theme,
    context: Record<string, unknown>,
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

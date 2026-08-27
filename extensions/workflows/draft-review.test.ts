import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  showWorkflowDraftReview,
  showWorkflowDraftReviewFallback,
  workflowDraftReviewText,
  WorkflowDraftReview,
} from "./draft-review.ts";
import type { WorkflowDraft } from "./drafts.ts";
import type { WorkflowMeta } from "./meta.ts";

const draft: WorkflowDraft = {
  version: 1,
  draftId: "draft_123456789abc",
  createdAt: 1,
  sessionId: "session",
  cwd: "/project",
  preparedAtUserInput: 1,
  preview: "Implement a bounded workflow draft review.",
  script:
    "phase('Implement')\nconst result = await agent('Implement and prove the review')\nreturn result",
  background: false,
};

const meta: WorkflowMeta = {
  name: "draft-review",
  description: "Implement a bounded workflow draft review.",
  phases: [
    { title: "Implement", detail: "Build the review surface" },
    { title: "Verify", detail: "Prove rendering and approval handoff" },
  ],
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const keybindings = {
  matches(data: string, action: string) {
    const expected: Record<string, string[]> = {
      "tui.select.cancel": ["escape"],
      "tui.editor.cursorLeft": ["left"],
      "tui.editor.cursorRight": ["right"],
      "tui.select.up": ["up"],
      "tui.select.down": ["down"],
      "tui.select.pageUp": ["pageUp"],
      "tui.select.pageDown": ["pageDown"],
    };
    return expected[action]?.includes(data) ?? false;
  },
} as KeybindingsManager;

function makeTui(rows = 28) {
  let renders = 0;
  const tui = {
    terminal: { rows },
    requestRender() {
      renders += 1;
    },
  } as TUI;
  return { tui, renders: () => renders };
}

test("draft inspector separates review context from exact source", () => {
  const { tui, renders } = makeTui();
  let action: string | undefined;
  const component = new WorkflowDraftReview(
    tui,
    theme,
    keybindings,
    draft,
    meta,
    "/tmp/workflows/drafts/draft_123456789abc/draft.json",
    (next) => {
      action = next;
    },
  );

  const lines = component.render(132);
  const output = lines.join("\n");

  assert.match(output, /Draft inspector draft-review/);
  assert.match(output, /OUTCOME/);
  assert.match(output, /Build the review surface/);
  assert.match(output, /Exact source/);
  assert.match(output, /phase\('Implement'\)/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 132));

  component.handleInput("l");
  component.handleInput("G");
  assert.equal(renders(), 2);
  component.handleInput("a");
  assert.equal(action, "approve");
});

test("approval action only prefills a newer explicit user response", async () => {
  const { tui } = makeTui();
  let editorText = "";
  let notification = "";
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (action: "close" | "approve") => void,
        ) => WorkflowDraftReview,
      ) =>
        new Promise<"close" | "approve">((resolve) => {
          const component = factory(tui, theme, keybindings, resolve);
          component.handleInput("a");
        }),
      setEditorText(text: string) {
        editorText = text;
      },
      notify(text: string) {
        notification = text;
      },
    },
  } as unknown as ExtensionCommandContext;

  await showWorkflowDraftReview(
    ctx,
    draft,
    meta,
    "/tmp/workflows/drafts/draft_123456789abc/draft.json",
  );

  assert.equal(editorText, "Approve workflow draft draft_123456789abc.");
  assert.match(notification, /Submit it to execute/);
});

test("RPC draft review uses standard editor and confirmation without custom UI", async () => {
  const calls: string[] = [];
  let editorPrefill = "";
  let editorText = "";
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      async editor(title: string, prefill?: string) {
        calls.push(`editor:${title}`);
        editorPrefill = prefill ?? "";
        return prefill;
      },
      async confirm(title: string, message: string) {
        calls.push(`confirm:${title}:${message}`);
        return true;
      },
      setEditorText(text: string) {
        editorText = text;
      },
      notify(text: string) {
        calls.push(`notify:${text}`);
      },
    },
  } as unknown as ExtensionCommandContext;

  await showWorkflowDraftReview(
    ctx,
    draft,
    meta,
    "/tmp/workflows/drafts/draft_123456789abc/draft.json",
  );

  assert.match(editorPrefill, /Implement a bounded workflow draft review/);
  assert.match(editorPrefill, /Exact source/);
  assert.match(editorPrefill, /phase\('Implement'\)/);
  assert.equal(editorText, "Approve workflow draft draft_123456789abc.");
  assert.equal(calls.filter((call) => call.startsWith("editor:")).length, 1);
  assert.equal(calls.filter((call) => call.startsWith("confirm:")).length, 1);
  assert.equal(calls.filter((call) => call.startsWith("notify:")).length, 1);
});

test("RPC draft review does not prefill when the review is cancelled or declined", async () => {
  let setEditorTextCalls = 0;
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      async editor() {
        return undefined;
      },
      async confirm() {
        return false;
      },
      setEditorText() {
        setEditorTextCalls += 1;
      },
      notify() {},
    },
  } as unknown as ExtensionCommandContext;

  await showWorkflowDraftReviewFallback(ctx, draft, meta, "/tmp/draft.json");
  assert.equal(setEditorTextCalls, 0);

  const confirmedCtx = {
    ...ctx,
    ui: {
      ...ctx.ui,
      async editor() {
        return workflowDraftReviewText(draft, meta, "/tmp/draft.json");
      },
    },
  } as unknown as ExtensionCommandContext;
  await showWorkflowDraftReviewFallback(
    confirmedCtx,
    draft,
    meta,
    "/tmp/draft.json",
  );
  assert.equal(setEditorTextCalls, 0);
});

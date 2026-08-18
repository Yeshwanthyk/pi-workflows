import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyUsage, type WorkflowDetails } from "./model.ts";
import {
  hasRecentWorkflowTerminalFlash,
  renderWorkflowFlow,
  workflowFlowSignature,
} from "./flow-view.ts";

initTheme("dark");

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function details(overrides: Partial<WorkflowDetails> = {}): WorkflowDetails {
  return {
    runId: "wf_flow",
    sessionId: "session-a",
    name: "Release train",
    background: true,
    status: "running",
    startedAt: 1_000,
    phases: [{ title: "Inspect" }, { title: "Build" }, { title: "Report" }],
    currentPhase: "Build",
    agents: [
      {
        index: 1,
        label: "inspector",
        phase: "Inspect",
        state: "done",
        queuedAt: 1_000,
        startedAt: 1_100,
        finishedAt: 2_000,
        lastActivityAt: 2_000,
        currentTools: [],
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
      {
        index: 2,
        label: "builder",
        phase: "Build",
        state: "running",
        queuedAt: 2_000,
        startedAt: 2_100,
        lastActivityAt: 5_000,
        currentTools: [
          {
            toolCallId: "tool-1",
            name: "write_file",
            argsPreview: "extensions/workflows/flow-view.ts",
            startedAt: 4_000,
            updatedAt: 5_000,
          },
        ],
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
      {
        index: 3,
        label: "reporter",
        phase: "Report",
        state: "queued",
        queuedAt: 3_000,
        lastActivityAt: 3_000,
        currentTools: [],
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
    ],
    ...overrides,
  };
}

test("flow uses one compact run summary and one lead agent line", () => {
  const lines = renderWorkflowFlow(
    { active: [details()], finished: [], sessionId: "session-a" },
    theme,
    { now: 6_000 },
  );
  const output = lines.join("\n");

  assert.equal(lines.length, 3);
  assert.match(output, /workflows · 1 active/);
  assert.match(output, /workflow Release train · Build/);
  assert.match(
    output,
    /builder · write_file extensions\/workflows\/flow-view\.ts/,
  );
  assert.doesNotMatch(
    output,
    /✓ Inspect|· Report|reporter · queued|more agent/,
  );
});

test("flow has stable generic activity and stays within its width bound", () => {
  const quiet = details({
    agents: [
      {
        ...details().agents[1]!,
        currentTools: [],
        lastActivityAt: 1_000,
      },
    ],
  });
  const lines = renderWorkflowFlow(
    { active: [quiet], finished: [], sessionId: "session-a" },
    theme,
    { now: 40_000, maxLines: 10, maxWidth: 48 },
  );

  assert.match(lines.join("\n"), /builder · working/);
  assert.doesNotMatch(lines.join("\n"), /quiet|idle/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 48));
  assert.ok(lines.length <= 10);
});

test("flow output is byte-stable across elapsed refresh ticks", () => {
  const first = renderWorkflowFlow(
    { active: [details()], finished: [], sessionId: "session-a" },
    theme,
    { now: 6_000 },
  );
  const later = renderWorkflowFlow(
    { active: [details()], finished: [], sessionId: "session-a" },
    theme,
    { now: 36_000 },
  );

  assert.deepEqual(later, first);
  assert.equal(workflowFlowSignature(later), workflowFlowSignature(first));
});

test("terminal flashes are session-scoped and expire after the short TTL", () => {
  const completed = details({
    status: "completed",
    finishedAt: 10_000,
    currentPhase: undefined,
  });
  const failed = details({
    runId: "wf_other",
    sessionId: "session-b",
    status: "failed",
    finishedAt: 10_000,
  });

  const visible = renderWorkflowFlow(
    { active: [], finished: [completed, failed], sessionId: "session-a" },
    theme,
    { now: 12_000 },
  );
  assert.match(visible.join("\n"), /Release train.*completed/);
  assert.doesNotMatch(visible.join("\n"), /wf_other|failed/);
  assert.equal(
    hasRecentWorkflowTerminalFlash([completed], "session-a", 14_000),
    false,
  );
  assert.deepEqual(
    renderWorkflowFlow(
      { active: [], finished: [completed], sessionId: "session-a" },
      theme,
      { now: 14_000 },
    ),
    [],
  );
});

test("flow never exceeds ten lines even with many active runs and flashes", () => {
  const active = Array.from({ length: 4 }, (_, index) =>
    details({ runId: `wf_${index}`, name: `workflow-${index}` }),
  );
  const finished = Array.from({ length: 4 }, (_, index) =>
    details({
      runId: `done_${index}`,
      name: `done-${index}`,
      status: "aborted",
      finishedAt: 9_500,
    }),
  );

  const lines = renderWorkflowFlow(
    { active, finished, sessionId: "session-a" },
    theme,
    { now: 10_000 },
  );
  assert.ok(lines.length <= 10);
});

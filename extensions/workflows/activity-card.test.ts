import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { workflowActiveWorkItem } from "./activity-protocol.ts";
import { renderWorkflowActivityCard } from "./activity-card.ts";
import { emptyUsage, type WorkflowDetails } from "./model.ts";

initTheme("dark");

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function details(): WorkflowDetails {
  return {
    runId: "wf_test",
    name: "Verify Ziggy",
    background: true,
    status: "running",
    startedAt: 1_000,
    phases: [
      { title: "Gather" },
      { title: "Verification" },
      { title: "Report" },
    ],
    currentPhase: "Verification",
    agents: [
      {
        index: 1,
        label: "gather",
        phase: "Gather",
        state: "done",
        queuedAt: 1_000,
        startedAt: 1_100,
        finishedAt: 2_000,
        lastActivityAt: 2_000,
        currentTools: [],
        completedOperations: 1,
        preview: "done",
        usage: emptyUsage(),
        transcript: [],
      },
      {
        index: 2,
        label: "final-check",
        phase: "Verification",
        state: "running",
        queuedAt: 2_000,
        startedAt: 2_100,
        lastActivityAt: 5_000,
        currentTools: [
          {
            toolCallId: "tool-1",
            name: "observe_ui",
            argsPreview: "Ziggy Profile",
            startedAt: 4_000,
            updatedAt: 5_000,
          },
        ],
        completedOperations: 2,
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
      {
        index: 3,
        label: "report",
        phase: "Report",
        state: "queued",
        queuedAt: 3_000,
        lastActivityAt: 3_000,
        currentTools: [],
        completedOperations: 0,
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
    ],
  };
}

test("workflow activity card is phase-first and shows active tool work", () => {
  const text = renderWorkflowActivityCard(details(), theme, { now: 6_000 });
  assert.match(
    text,
    /workflow Verify Ziggy 1\/3 · 5s · running \(background\)/,
  );
  assert.match(text, /Gather ✓ → Verification 0\/1 → Report/);
  assert.match(text, /final-check · observe_ui Ziggy Profile · 2s/);
  assert.match(text, /report · queued/);
  assert.doesNotMatch(text, /gather ·/);
});

test("workflow activity protocol publishes phase and current operation", () => {
  const item = workflowActiveWorkItem(details(), 6_000);
  assert.ok(item);
  assert.equal(item.key, "workflow:wf_test");
  assert.match(item.summary, /Verification · observe_ui Ziggy Profile/);
  assert.equal(item.lastActivityAt, 5_000);
  assert.equal(item.runningProcesses, 0);
});

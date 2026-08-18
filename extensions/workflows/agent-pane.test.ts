import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Theme, WorkflowDetails } from "./model.ts";
import {
  WorkflowAgentPane,
  cycleAgentSelection,
  findSelectedAgent,
  renderAgentPaneHeaderLines,
  transcriptViewport,
} from "./agent-pane.ts";
import { normalizeDetails } from "./dashboard.ts";
import { sanitizeText } from "./transcript.ts";

const theme = {
  fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[39m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
} as unknown as Theme;

function fixture(): WorkflowDetails {
  const details = normalizeDetails("wf_stable", {
    name: "release workflow",
    status: "running",
    startedAt: 1_000,
    currentPhase: "verify",
    agents: [
      {
        index: 20,
        label: "verifier",
        phase: "verify",
        state: "running",
        provider: "anthropic",
        model: "claude-sonnet",
        thinkingLevel: "xhigh",
        contextWindow: 100_000,
        startedAt: 2_000,
        transcript: [{ role: "assistant", text: "tail" }],
      },
      {
        index: 4,
        label: "builder",
        phase: "build",
        state: "done",
        startedAt: 2_000,
        finishedAt: 4_000,
      },
    ],
  });
  assert.ok(details);
  return details;
}

test("agent pane selection follows runId and agent.index, not display order", () => {
  const details = fixture();
  const selected = { runId: details.runId, agentIndex: 4 };
  assert.equal(findSelectedAgent(details, selected)?.label, "builder");
  assert.deepEqual(cycleAgentSelection(details, selected, 1), {
    runId: details.runId,
    agentIndex: 20,
  });
  assert.deepEqual(cycleAgentSelection(details, selected, -1), {
    runId: details.runId,
    agentIndex: 20,
  });
});

test("agent pane keeps a live tail pinned and scrolls back from the tail", () => {
  const rows = ["one", "two", "three", "four", "five"];
  const tail = transcriptViewport(rows, 2, 0);
  assert.deepEqual(tail.visible, ["four", "five"]);
  assert.equal(tail.pinned, true);
  const back = transcriptViewport(rows, 2, 2);
  assert.deepEqual(back.visible, ["two", "three"]);
  assert.equal(back.pinned, false);
  assert.equal(
    transcriptViewport([...rows, "six"], 2, 0).visible.at(-1),
    "six",
  );
});

test("agent pane header stays width-safe and exposes responsive runtime metadata", () => {
  const details = fixture();
  const agent = details.agents[0]!;
  const wide = renderAgentPaneHeaderLines(details, agent, 100, theme);
  const compact = renderAgentPaneHeaderLines(details, agent, 40, theme);
  assert.match(wide.map(sanitizeText).join("\n"), /release workflow/);
  assert.match(wide.map(sanitizeText).join("\n"), /anthropic\/claude-sonnet/);
  assert.match(wide.map(sanitizeText).join("\n"), /think:xhigh/);
  assert.match(compact.map(sanitizeText).join("\n"), /ctx/);
  assert.match(compact.map(sanitizeText).join("\n"), /xhigh/);
  for (const line of wide) assert.ok(visibleWidth(line) <= 100);
  for (const line of compact) assert.ok(visibleWidth(line) <= 40);
});

test("agent pane component renders a bounded overlay and refreshes active details", () => {
  const details = fixture();
  const liveDetails = fixture();
  liveDetails.agents[0]!.transcript = [
    { role: "assistant", text: "live refresh" },
  ];
  const active = new Map([[liveDetails.runId, liveDetails]]);
  const tui = {
    terminal: { rows: 20 },
    requestRender() {},
  } as unknown as TUI;
  const keybindings = {
    matches: () => false,
    getKeys: () => [],
  } as unknown as KeybindingsManager;
  let closed = 0;
  const pane = new WorkflowAgentPane(
    tui,
    theme,
    keybindings,
    { runId: details.runId, agentIndex: 20 },
    details,
    () => active,
    () => {
      closed += 1;
    },
    () => true,
  );
  const lines = pane.render(40);
  assert.ok(lines.some((line) => sanitizeText(line).includes("live refresh")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
  pane.dispose();
  assert.equal(closed, 0);
});

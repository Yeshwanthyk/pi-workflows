import {
  keyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  countStates,
  formatElapsed,
  phaseGroups,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";

type Theme = ExtensionContext["ui"]["theme"];

function singleLine(text: string) {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bounded(text: string, maxLength = 140) {
  const value = singleLine(text);
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function phaseProgress(details: WorkflowDetails) {
  const groups = new Map(
    phaseGroups(details, true).map((group) => [group.title, group.agents]),
  );
  return details.phases
    .map((phase) => {
      const agents = groups.get(phase.title) ?? [];
      const settled = agents.filter(
        (agent) => agent.state === "done" || agent.state === "error",
      ).length;
      if (phase.title === details.currentPhase) {
        return `${phase.title}${agents.length ? ` ${settled}/${agents.length}` : ""}`;
      }
      if (agents.length > 0 && settled === agents.length)
        return `${phase.title} ✓`;
      return phase.title;
    })
    .join(" → ");
}

function currentOperation(agent: AgentRecord, now: number) {
  const tool = agent.currentTools?.[0];
  if (!tool) return undefined;
  return `${bounded(`${tool.name}${tool.argsPreview ? ` ${tool.argsPreview}` : ""}`)} · ${formatElapsed(tool.startedAt, now)}`;
}

export function renderWorkflowActivityCard(
  details: WorkflowDetails,
  theme: Theme,
  options: { expanded?: boolean; now?: number } = {},
) {
  const now = options.now ?? Date.now();
  const { done, failed, running, queued } = countStates(details);
  const settled = done + failed;
  let text =
    `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
    `${theme.fg("accent", details.name ?? details.runId)} ` +
    theme.fg(
      "dim",
      `${settled}/${details.agents.length} · ${formatElapsed(details.startedAt, details.finishedAt ?? now)} · `,
    ) +
    theme.fg(statusColor(details.status), statusWord(details.status));
  if (failed) text += theme.fg("error", ` · ${failed} failed`);
  if (details.background) text += theme.fg("dim", " (background)");

  const phases = phaseProgress(details);
  if (phases) text += `\n  ${theme.fg("muted", phases)}`;

  const visibleAgents = details.agents.filter(
    (agent) =>
      agent.state === "running" ||
      agent.state === "queued" ||
      (options.expanded && agent.phase === details.currentPhase),
  );
  for (const agent of visibleAgents.slice(0, options.expanded ? 12 : 5)) {
    const operation = currentOperation(agent, now);
    const state = stateSquare(agent.state, theme);
    text += `\n  ${state} ${theme.fg("accent", agent.label)}`;
    if (operation) text += theme.fg("toolTitle", ` · ${operation}`);
    else if (agent.state === "queued") {
      text += theme.fg("dim", " · queued");
    } else {
      const lastActivity =
        agent.lastActivityAt ?? agent.startedAt ?? agent.queuedAt;
      text += theme.fg(
        "dim",
        ` · model working · activity ${formatElapsed(lastActivity, now)} ago`,
      );
    }
  }
  if (visibleAgents.length > (options.expanded ? 12 : 5)) {
    text += `\n  ${theme.fg("dim", `+${visibleAgents.length - (options.expanded ? 12 : 5)} more agents`)}`;
  }

  if (running === 0 && queued === 0 && details.agents.length > 0) {
    text += `\n  ${theme.fg("dim", `${settled} agents settled`)}`;
  }
  if (details.error)
    text += `\n  ${theme.fg("error", bounded(details.error, 240))}`;
  if (!options.expanded) {
    text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "for details")})`)}`;
  }
  return text;
}

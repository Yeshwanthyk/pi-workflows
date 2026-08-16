import {
  keyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  countStates,
  dominantModel,
  formatElapsed,
  modelBadge,
  phaseGroups,
  stateSquare,
  statusColor,
  statusColorFor,
  statusWord,
  statusWordFor,
  thinkingColor,
  thinkingExcerpt,
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

/** "provider/model" chip colored with the provider accent. */
function modelChip(agent: AgentRecord, theme: Theme): string {
  const badge = modelBadge(agent);
  if (!badge) return "";
  const colored =
    agent.provider && agent.model
      ? theme.fg("accent", agent.provider) +
        theme.fg("dim", "/") +
        theme.fg("text", agent.model)
      : theme.fg("text", badge);
  return ` ${colored}`;
}

/** "think:level" chip tinted with the level's theme color. */
function thinkingChip(agent: AgentRecord, theme: Theme): string {
  if (!agent.thinkingLevel || agent.thinkingLevel === "off") return "";
  return (
    ` ${theme.fg("dim", "think:")}` +
    theme.fg(thinkingColor(agent.thinkingLevel), agent.thinkingLevel)
  );
}

/** Live reasoning excerpt line, tinted by the agent's thinking level. */
function thinkingLine(agent: AgentRecord, theme: Theme): string {
  const excerpt = thinkingExcerpt(agent, 120);
  if (!excerpt) return "";
  const color = agent.thinkingLevel
    ? thinkingColor(agent.thinkingLevel)
    : "thinkingText";
  return `\n  ${theme.fg("dim", "⟡")} ${theme.fg(color, excerpt)}`;
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
    `${theme.fg(statusColorFor(details), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
    `${theme.fg("accent", details.name ?? details.runId)} ` +
    theme.fg(
      "dim",
      `${settled}/${details.agents.length} · ${formatElapsed(details.startedAt, details.finishedAt ?? now)} · `,
    ) +
    theme.fg(statusColorFor(details), statusWordFor(details));
  if (failed) text += theme.fg("error", ` · ${failed} failed`);
  if (details.background) text += theme.fg("dim", " (background)");
  const dominant = dominantModel(details);
  if (dominant) text += theme.fg("dim", ` · ${dominant}`);

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
    text += modelChip(agent, theme) + thinkingChip(agent, theme);
    if (agent.state === "running") text += thinkingLine(agent, theme);
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

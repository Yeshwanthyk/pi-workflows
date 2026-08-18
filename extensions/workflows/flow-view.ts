import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  countStates,
  formatElapsed,
  SQUARE,
  stateSquare,
  statusColorFor,
  statusWordFor,
  type Theme,
  type WorkflowDetails,
} from "./model.ts";

export const WORKFLOW_FLOW_FLASH_TTL_MS = 4_000;
const QUIET_AFTER_MS = 30_000;
const DEFAULT_MAX_LINES = 10;
const DEFAULT_MAX_WIDTH = 120;
const MAX_AGENTS_PER_RUN = 3;

export interface WorkflowFlowData {
  active: Iterable<WorkflowDetails>;
  finished: Iterable<WorkflowDetails>;
  sessionId: string;
}

export interface WorkflowFlowOptions {
  now?: number;
  maxLines?: number;
  maxWidth?: number;
  flashTtlMs?: number;
}

function singleLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bounded(value: string, maxLength: number): string {
  const text = singleLine(value);
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function lastActivity(details: WorkflowDetails): number {
  return Math.max(
    details.startedAt,
    ...details.agents.map(
      (agent) => agent.lastActivityAt ?? agent.startedAt ?? agent.queuedAt,
    ),
  );
}

function phasePipeline(details: WorkflowDetails, theme: Theme): string {
  if (details.phases.length === 0) {
    return details.currentPhase
      ? theme.fg("muted", `› ${bounded(details.currentPhase, 42)}`)
      : "";
  }

  const currentIndex = details.currentPhase
    ? details.phases.findIndex((phase) => phase.title === details.currentPhase)
    : -1;
  return details.phases
    .map((phase, index) => {
      const marker =
        details.status === "completed" ||
        (currentIndex >= 0 && index < currentIndex)
          ? theme.fg("success", "✓")
          : index === currentIndex
            ? theme.fg("accent", "›")
            : theme.fg("dim", "·");
      return `${marker} ${bounded(phase.title, 28)}`;
    })
    .join(theme.fg("dim", " → "));
}

function terminalFlash(details: WorkflowDetails, theme: Theme): string {
  const status =
    details.status === "completed"
      ? "completed"
      : details.status === "failed"
        ? "failed"
        : "aborted";
  const color = statusColorFor(details);
  return `${theme.fg(color, SQUARE)} ${theme.bold("workflow")} ${theme.fg("accent", bounded(details.name ?? details.runId, 42))} ${theme.fg("dim", "·")} ${theme.fg(color, status)}`;
}

function activeRunLines(
  details: WorkflowDetails,
  theme: Theme,
  now: number,
): string[] {
  const { done, failed, running, queued } = countStates(details);
  const settled = done + failed;
  const status =
    details.status === "running" ? "running" : statusWordFor(details);
  const header =
    `${theme.fg(statusColorFor(details), SQUARE)} ${theme.bold("workflow")} ` +
    `${theme.fg("accent", bounded(details.name ?? details.runId, 42))} ` +
    theme.fg(
      "dim",
      `· ${settled}/${details.agents.length} agents${running ? ` · ${running} running` : ""}${queued ? ` · ${queued} queued` : ""} · `,
    ) +
    theme.fg(statusColorFor(details), status);

  const lines = [header];
  const pipeline = phasePipeline(details, theme);
  if (pipeline) lines.push(`  ${pipeline}`);

  const visibleAgents = details.agents
    .filter((agent) => agent.state === "running" || agent.state === "queued")
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === "running" ? -1 : 1;
      return a.index - b.index;
    });
  const quiet = running === 0 || now - lastActivity(details) >= QUIET_AFTER_MS;
  for (const agent of visibleAgents.slice(0, MAX_AGENTS_PER_RUN)) {
    const tool = agent.currentTools?.[0];
    let activity = agent.state === "queued" ? "queued" : "working";
    if (tool) {
      const args = tool.argsPreview ? ` ${bounded(tool.argsPreview, 56)}` : "";
      activity = `${bounded(`${tool.name}${args}`, 82)} · ${formatElapsed(tool.startedAt, now)}`;
    } else if (agent.state === "running" && quiet) {
      activity = `quiet · ${formatElapsed(agent.lastActivityAt ?? agent.startedAt, now)} idle`;
    }
    lines.push(
      `  ${stateSquare(agent.state, theme)} ${theme.fg("accent", bounded(agent.label, 30))} ${theme.fg("dim", `· ${activity}`)}`,
    );
  }
  if (visibleAgents.length > MAX_AGENTS_PER_RUN) {
    lines.push(
      `  ${theme.fg("dim", `+${visibleAgents.length - MAX_AGENTS_PER_RUN} more agent${visibleAgents.length - MAX_AGENTS_PER_RUN === 1 ? "" : "s"}`)}`,
    );
  }
  if (visibleAgents.length === 0 && details.status === "running") {
    lines.push(
      `  ${theme.fg("dim", quiet ? "quiet · between phases" : "starting agents")}`,
    );
  }
  return lines;
}

function isRecentTerminal(
  details: WorkflowDetails,
  sessionId: string,
  now: number,
  ttlMs: number,
): boolean {
  return (
    details.sessionId === sessionId &&
    details.status !== "running" &&
    details.finishedAt !== undefined &&
    now >= details.finishedAt &&
    now - details.finishedAt < ttlMs
  );
}

/**
 * Render the workflow-owned, below-editor flow projection.
 *
 * This is intentionally a pure projection: callers own live and settled run
 * state and decide when to refresh it. Historical details never cross the
 * active UI session boundary.
 */
export function renderWorkflowFlow(
  data: WorkflowFlowData,
  theme: Theme,
  options: WorkflowFlowOptions = {},
): string[] {
  const now = options.now ?? Date.now();
  const maxLines = Math.max(
    1,
    Math.min(DEFAULT_MAX_LINES, options.maxLines ?? DEFAULT_MAX_LINES),
  );
  const maxWidth = Math.max(12, options.maxWidth ?? DEFAULT_MAX_WIDTH);
  const flashTtlMs = Math.max(
    0,
    options.flashTtlMs ?? WORKFLOW_FLOW_FLASH_TTL_MS,
  );
  const active = [...data.active]
    .filter(
      (details) =>
        details.sessionId === data.sessionId && details.status === "running",
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  const activeIds = new Set(active.map((details) => details.runId));
  const finished = [...data.finished]
    .filter(
      (details) =>
        !activeIds.has(details.runId) &&
        isRecentTerminal(details, data.sessionId, now, flashTtlMs),
    )
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));

  if (active.length === 0 && finished.length === 0) return [];

  const lines: string[] = [
    truncateToWidth(
      theme.fg(
        "muted",
        `${SQUARE} workflows · ${active.length} active${finished.length ? ` · ${finished.length} recent` : ""}`,
      ),
      maxWidth,
      "…",
    ),
  ];
  const append = (line: string) => {
    if (lines.length < maxLines)
      lines.push(truncateToWidth(line, maxWidth, "…"));
  };

  for (const details of active) {
    for (const line of activeRunLines(details, theme, now)) {
      append(line);
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  for (const details of finished) {
    if (lines.length >= maxLines) break;
    append(terminalFlash(details, theme));
  }
  return lines
    .slice(0, maxLines)
    .map((line) => truncateToWidth(line, maxWidth, "…"));
}

/** Small projection helper used by the owning extension's refresh tick. */
export function hasRecentWorkflowTerminalFlash(
  finished: Iterable<WorkflowDetails>,
  sessionId: string,
  now = Date.now(),
  ttlMs = WORKFLOW_FLOW_FLASH_TTL_MS,
): boolean {
  return [...finished].some((details) =>
    isRecentTerminal(details, sessionId, now, ttlMs),
  );
}

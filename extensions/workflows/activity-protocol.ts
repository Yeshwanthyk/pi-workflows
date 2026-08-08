import { countStates, type WorkflowDetails } from "./model.ts";

export const ACTIVE_WORK_CHANNELS = {
  update: "agent-activity:update:v1",
  remove: "agent-activity:remove:v1",
} as const;

export interface ActiveWorkItem {
  readonly version: 1;
  readonly key: `workflow:${string}`;
  readonly kind: "workflow";
  readonly label: string;
  readonly status: "running" | "quiet";
  readonly summary: string;
  readonly currentOperation?: string;
  readonly runningProcesses: number;
  readonly startedAt: number;
  readonly lastActivityAt: number;
}

function singleLine(text: string) {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bounded(text: string, maxLength = 120) {
  const value = singleLine(text);
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

export function workflowActiveWorkItem(
  details: WorkflowDetails,
  now = Date.now(),
): ActiveWorkItem | undefined {
  if (details.status !== "running") return undefined;
  const activeAgents = details.agents.filter(
    (agent) => agent.state === "running",
  );
  const currentTool = activeAgents.flatMap(
    (agent) => agent.currentTools ?? [],
  )[0];
  const lastActivityAt = Math.max(
    details.startedAt,
    ...details.agents.map(
      (agent) => agent.lastActivityAt ?? agent.startedAt ?? agent.queuedAt,
    ),
  );
  const quiet = now - lastActivityAt >= 30_000;
  const counts = countStates(details);
  const phase = details.currentPhase ?? "starting";
  const operation = currentTool
    ? bounded(
        `${currentTool.name}${currentTool.argsPreview ? ` ${currentTool.argsPreview}` : ""}`,
      )
    : undefined;
  return {
    version: 1,
    key: `workflow:${details.runId}`,
    kind: "workflow",
    label: `workflow ${bounded(details.name ?? details.runId, 72)}`,
    status: quiet ? "quiet" : "running",
    summary: operation
      ? `${phase} · ${operation}`
      : `${phase} · ${counts.running} running${counts.queued ? ` · ${counts.queued} queued` : ""}`,
    ...(operation ? { currentOperation: operation } : {}),
    runningProcesses: 0,
    startedAt: details.startedAt,
    lastActivityAt,
  };
}

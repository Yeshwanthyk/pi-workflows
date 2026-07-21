/**
 * Shared workflow run model + formatting helpers, used by the tool renderers
 * (index.ts) and the /workflows dashboard (dashboard.ts).
 */

import * as os from "node:os";
import {
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import type { EffectiveWorkflowLimits } from "./limits.ts";
import { safeStringify } from "./serialization.ts";

export type Theme = ExtensionContext["ui"]["theme"];
export type WorkflowThinkingLevel = ReturnType<
  ExtensionAPI["getThinkingLevel"]
>;

export const WORKFLOW_THINKING_LEVELS: readonly WorkflowThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isWorkflowThinkingLevel(
  value: unknown,
): value is WorkflowThinkingLevel {
  return (
    typeof value === "string" &&
    (WORKFLOW_THINKING_LEVELS as readonly string[]).includes(value)
  );
}

export const RESULT_JSON_MAX_BYTES = 24 * 1024;
export const RESULT_JSON_MAX_LINES = 600;

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** False when at least one finalized assistant message omitted finite output. */
  outputComplete?: boolean;
  /** False when at least one finalized assistant message omitted finite cost. */
  costComplete?: boolean;
  /** Latest compaction-aware conversation occupancy, not cumulative billing. */
  contextTokens?: number;
  turns: number;
}

export interface WorkflowBudgetTelemetry {
  turns: number;
  outputTokens: number;
  costUsd: number;
  outputComplete: boolean;
  costComplete: boolean;
}

export type WorkflowTerminationCode =
  | "parent_cancelled"
  | "session_cancelled"
  | "workflow_wall"
  | "workflow_idle"
  | "turns"
  | "output_tokens"
  | "cost_usd"
  | "script_failure"
  | "shutdown_timeout"
  | "manual_abort";

export interface WorkflowTerminationRecord {
  readonly code: WorkflowTerminationCode;
  readonly message: string;
  readonly outcome: "failed" | "aborted";
  readonly at: number;
  /** Immutable accounting state when the first termination latched. */
  readonly budget: Readonly<WorkflowBudgetTelemetry>;
}

export function emptyUsage(): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    outputComplete: true,
    costComplete: true,
    turns: 0,
  };
}

export type AgentState = "queued" | "running" | "done" | "error";
export type WorkflowStatus = "running" | "completed" | "failed" | "aborted";

export type TranscriptRole =
  "user" | "assistant" | "thinking" | "tool" | "toolResult";

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  /** Tool name for tool calls/results. */
  name?: string;
  /** Stable tool-call identifier used to pair calls, results, and timings. */
  toolCallId?: string;
  isError?: boolean;
  /** Original message timestamp, when provided by the model/session. */
  timestamp?: number;
  /** Tool execution lifecycle timestamps, measured by the child session. */
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentRecord {
  index: number;
  label: string;
  phase?: string;
  state: AgentState;
  model?: string;
  /** Resolved Pi thinking level used by this agent. */
  thinkingLevel?: WorkflowThinkingLevel;
  /** Context capacity of the active model used for this agent. */
  contextWindow?: number;
  queuedAt: number;
  /** Set only after per-run and process-global capacity are acquired. */
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  preview: string;
  usage: AgentUsage;
  /** Normalized, serializable subagent conversation shown by /workflows. */
  transcript: TranscriptEntry[];
}

export interface WorkflowDetails {
  runId: string;
  /** Pi session that launched this run. */
  sessionId?: string;
  name?: string;
  description?: string;
  background: boolean;
  status: WorkflowStatus;
  startedAt: number;
  /** Resolved once at creation and used by both parent and sandbox runtime. */
  limits?: EffectiveWorkflowLimits;
  /** Controller-owned authoritative totals, independent of agent projections. */
  budget?: WorkflowBudgetTelemetry;
  /** Typed first-reason-wins terminal record. */
  termination?: WorkflowTerminationRecord;
  finishedAt?: number;
  phases: { title: string; detail?: string }[];
  currentPhase?: string;
  agents: AgentRecord[];
  result?: unknown;
  resultArtifact?: string;
  transcriptArtifact?: string;
  error?: string;
}

/** Colored square state indicator (no emojis/glyphs). */
export const SQUARE = "■";

export function stateSquare(state: AgentState, theme: Theme): string {
  if (state === "done") return theme.fg("success", SQUARE);
  if (state === "error") return theme.fg("error", SQUARE);
  return theme.fg("warning", SQUARE);
}

export function statusSquare(status: WorkflowStatus, theme: Theme): string {
  if (status === "completed") return theme.fg("success", SQUARE);
  if (status === "running") return theme.fg("warning", SQUARE);
  return theme.fg("error", SQUARE);
}

export function statusWord(status: WorkflowStatus): string {
  return status === "completed" ? "done" : status;
}

export function statusColor(
  status: WorkflowStatus,
): "success" | "warning" | "error" {
  if (status === "completed") return "success";
  if (status === "running") return "warning";
  return "error";
}

export function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(
  usage: AgentUsage,
  model?: string,
  thinkingLevel?: WorkflowThinkingLevel,
): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`${formatTokens(usage.input)} in`);
  if (usage.output) parts.push(`${formatTokens(usage.output)} out`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  if (thinkingLevel) parts.push(`think:${thinkingLevel}`);
  return parts.join(" · ");
}

/** Current per-agent context-window utilization, e.g. "7%/372k". */
export function agentContext(agent: AgentRecord): string {
  return formatContextUtilization({
    tokens: agent.usage.contextTokens,
    contextWindow: agent.contextWindow,
  });
}

export function formatElapsed(
  startedAt: number | undefined,
  finishedAt?: number,
): string {
  if (startedAt === undefined) return "queued";
  const totalSeconds = Math.max(
    0,
    Math.round(((finishedAt ?? Date.now()) - startedAt) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeCompletenessFlag(value: unknown): boolean {
  return value === undefined || value === true;
}

/** Strictly normalize untrusted historical usage before rendering/aggregation. */
export function normalizeAgentUsage(value: unknown): AgentUsage {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const contextTokens = finiteNonNegative(record.contextTokens);
  const outputKnown = isFiniteNonNegative(record.output);
  const costKnown = isFiniteNonNegative(record.cost);
  return {
    input: finiteNonNegative(record.input),
    output: finiteNonNegative(record.output),
    cacheRead: finiteNonNegative(record.cacheRead),
    cacheWrite: finiteNonNegative(record.cacheWrite),
    cost: finiteNonNegative(record.cost),
    outputComplete:
      outputKnown && normalizeCompletenessFlag(record.outputComplete),
    costComplete: costKnown && normalizeCompletenessFlag(record.costComplete),
    ...(contextTokens > 0 ? { contextTokens } : {}),
    turns: finiteNonNegative(record.turns),
  };
}

export function normalizeBudgetTelemetry(
  value: unknown,
): WorkflowBudgetTelemetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const outputKnown = isFiniteNonNegative(record.outputTokens);
  const costKnown = isFiniteNonNegative(record.costUsd);
  return {
    turns: finiteNonNegative(record.turns),
    outputTokens: finiteNonNegative(record.outputTokens),
    costUsd: finiteNonNegative(record.costUsd),
    outputComplete:
      outputKnown && normalizeCompletenessFlag(record.outputComplete),
    costComplete: costKnown && normalizeCompletenessFlag(record.costComplete),
  };
}

export function normalizeTerminationRecord(
  value: unknown,
): WorkflowTerminationRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const codes: readonly WorkflowTerminationCode[] = [
    "parent_cancelled",
    "session_cancelled",
    "workflow_wall",
    "workflow_idle",
    "turns",
    "output_tokens",
    "cost_usd",
    "script_failure",
    "shutdown_timeout",
    "manual_abort",
  ];
  if (
    typeof record.code !== "string" ||
    !codes.includes(record.code as WorkflowTerminationCode) ||
    typeof record.message !== "string" ||
    (record.outcome !== "failed" && record.outcome !== "aborted") ||
    typeof record.at !== "number" ||
    !Number.isFinite(record.at)
  ) {
    return undefined;
  }
  return {
    code: record.code as WorkflowTerminationCode,
    message: record.message,
    outcome: record.outcome,
    at: record.at,
    budget: normalizeBudgetTelemetry(record.budget) ?? {
      turns: 0,
      outputTokens: 0,
      costUsd: 0,
      outputComplete: false,
      costComplete: false,
    },
  };
}

export function aggregateUsage(agents: AgentRecord[]): AgentUsage {
  const total = emptyUsage();
  for (const agent of agents) {
    const usage = normalizeAgentUsage(agent.usage);
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.cost += usage.cost;
    total.outputComplete =
      total.outputComplete !== false && usage.outputComplete !== false;
    total.costComplete =
      total.costComplete !== false && usage.costComplete !== false;
    total.turns += usage.turns;
  }
  return total;
}

export function countStates(details: WorkflowDetails) {
  let done = 0;
  let failed = 0;
  let running = 0;
  let queued = 0;
  for (const agent of details.agents) {
    if (agent.state === "done") done++;
    else if (agent.state === "error") failed++;
    else if (agent.state === "queued") queued++;
    else running++;
  }
  return { done, failed, running, queued };
}

export function formatAgentLifecycle(details: WorkflowDetails): string {
  const { done, failed, running, queued } = countStates(details);
  const settled = done + failed;
  return `${settled}/${details.agents.length} agents${running ? ` · ${running} running` : ""}${queued ? ` · ${queued} queued` : ""}`;
}

export interface PhaseGroup {
  title: string;
  agents: AgentRecord[];
}

/**
 * Group agents by phase in declared phase order. With `includeEmpty`, phases
 * that have no agents yet are still listed (used by the dashboard sidebar).
 */
export function phaseGroups(
  details: WorkflowDetails,
  includeEmpty = false,
): PhaseGroup[] {
  const byPhase = new Map<string, AgentRecord[]>();
  for (const agent of details.agents) {
    const key = agent.phase ?? "(unphased)";
    const list = byPhase.get(key) ?? [];
    list.push(agent);
    byPhase.set(key, list);
  }
  const groups: PhaseGroup[] = [];
  for (const phase of details.phases) {
    const agents = byPhase.get(phase.title);
    if (agents || includeEmpty)
      groups.push({ title: phase.title, agents: agents ?? [] });
    byPhase.delete(phase.title);
  }
  for (const [title, agents] of byPhase) groups.push({ title, agents });
  return groups;
}

export function resultJson(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : safeStringify(value, {
          maxBytes: RESULT_JSON_MAX_BYTES * 2,
          maxDepth: 16,
          maxNodes: 10_000,
        });
  const truncation = truncateHead(text ?? "", {
    maxLines: RESULT_JSON_MAX_LINES,
    maxBytes: RESULT_JSON_MAX_BYTES,
  });
  return truncation.truncated
    ? `${truncation.content}\n…[result truncated; bounded result artifact in result.json]`
    : truncation.content;
}

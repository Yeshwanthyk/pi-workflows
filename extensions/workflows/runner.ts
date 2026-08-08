/**
 * Workflow subagent runner.
 *
 * Each `agent()` call in a workflow script becomes one isolated in-process
 * AgentSession created here: in-memory session, normal trust-aware resources
 * and extensions, recursive orchestration/user-prompt tools denied, and an
 * optional one-shot `structured_output` tool when a schema is supplied.
 *
 * `runAgent()` never throws: every failure mode (session creation, provider
 * errors, aborts, missing structured output) settles into an `AgentOutcome`.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import {
  emptyUsage,
  type AgentToolActivity,
  type AgentUsage,
  type TranscriptEntry,
} from "./model.ts";
import {
  buildWorkflowAgentPrompt,
  STRUCTURED_OUTPUT_RECOVERY_PROMPT,
  STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { safeStringify, truncateUtf8 } from "./serialization.ts";

const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;
export const FIRST_RESPONSE_TIMEOUT_MS = 45_000;
const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1024;
const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 200;

export type WorkflowModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type AgentMessage = AgentSession["messages"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolTimingEvent = Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_end" }
>;

export interface ToolExecutionTiming {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentOutcome {
  ok: boolean;
  /** Final assistant text (may be empty when only structured output was produced). */
  output: string;
  /** Captured structured_output payload when a schema was supplied. */
  structured?: unknown;
  error?: string;
  aborted: boolean;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface AgentProgress {
  preview: string;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
  lastActivityAt: number;
  currentTools: AgentToolActivity[];
  completedOperations: number;
}

type AgentSessionFactory = (
  options: Parameters<typeof createAgentSession>[0],
) => Promise<{ session: AgentSession }>;

export interface RunAgentOptions {
  prompt: string;
  schema?: unknown;
  model?: WorkflowModel;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  modelRegistry: ExtensionContext["modelRegistry"];
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  /** Meaningful child lifecycle activity for workflow/agent idle budgets. */
  onActivity?: () => void;
  /** Called synchronously before every provider prompt, including recovery. */
  onTurnStart?: () => void;
  /** Idempotent cumulative finalized usage. */
  onUsage?: (usage: AgentUsage) => void;
  /** Test-only override for the per-tool execution timeout. */
  toolCallTimeoutMs?: number;
  /** Test-only override for the first assistant response-event timeout. */
  firstResponseTimeoutMs?: number;
  /** Test-only session factory for direct runner lifecycle coverage. */
  createSession?: AgentSessionFactory;
}

/** Build a fresh extension runtime for each concurrent workflow child. */
export function createWorkflowResources(
  cwd: string,
  variant: "plain" | "structured",
  projectTrusted: boolean,
) {
  return createChildResources({
    cwd,
    projectTrusted,
    ...(variant === "structured"
      ? { appendSystemPrompt: [STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION] }
      : {}),
  });
}

interface WorkflowToolSession {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
  subscribe(listener: AgentSessionEventListener): () => void;
}

/** Guard current tools and tools registered by extensions at later agent starts. */
export function guardWorkflowChildTools(
  session: WorkflowToolSession,
  timeoutMs?: number,
) {
  const guard = createToolCallTimeoutGuard(timeoutMs);
  guard.apply(session);
  return session.subscribe((event) => {
    if (event.type === "agent_start") guard.apply(session);
  });
}

function isJsonSchema(value: unknown): value is TSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const validate = (current: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 24) return false;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return true;
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (Array.isArray(current)) {
      return current.every((item) => validate(item, depth + 1));
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    return Object.keys(current).every((key) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return false;
      }
      return validate((current as Record<string, unknown>)[key], depth + 1);
    });
  };
  return validate(value, 0);
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
function jsonSchemaToTypebox(schema: unknown): TSchema {
  if (!isJsonSchema(schema)) {
    throw new Error("structured output schema must be a bounded JSON object");
  }
  return Type.Unsafe(schema);
}

/**
 * One-shot terminating tool injected when a schema is supplied: the subagent
 * calls it as its final action and we capture the validated object.
 */
function makeStructuredOutputTool(
  schema: unknown,
  capture: (value: unknown) => void,
): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    parameters: jsonSchemaToTypebox(schema),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: "Recorded structured result." }],
        details: params,
        terminate: true,
      };
    },
  });
}

function finalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string {
  return safeStringify(value, {
    maxBytes: TRANSCRIPT_ENTRY_MAX_BYTES,
    maxDepth: 12,
    maxNodes: 2_000,
  });
}

/** Record lifecycle timings without inferring completion from message timestamps. */
export function recordToolExecutionTiming(
  timings: Map<string, ToolExecutionTiming>,
  event: ToolTimingEvent,
  observedAt = Date.now(),
) {
  const previous = timings.get(event.toolCallId);
  if (event.type === "tool_execution_start") {
    if (previous?.startedAt !== undefined) return;
    timings.set(event.toolCallId, { ...previous, startedAt: observedAt });
    return;
  }
  if (previous?.finishedAt !== undefined) return;
  const durationMs =
    previous?.startedAt === undefined
      ? undefined
      : Math.max(0, observedAt - previous.startedAt);
  timings.set(event.toolCallId, {
    ...previous,
    finishedAt: observedAt,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function toolMetadata(
  toolCallId: string,
  timings: ReadonlyMap<string, ToolExecutionTiming>,
) {
  const timing = timings.get(toolCallId);
  return {
    toolCallId: truncateUtf8(toolCallId, 1024),
    ...(timing?.startedAt === undefined ? {} : { startedAt: timing.startedAt }),
    ...(timing?.finishedAt === undefined
      ? {}
      : { finishedAt: timing.finishedAt }),
    ...(timing?.durationMs === undefined
      ? {}
      : { durationMs: timing.durationMs }),
  };
}

/** Convert pi messages into a compact, serializable transcript for the UI. */
export function transcriptFromMessages(
  messages: AgentMessage[],
  toolTimings: ReadonlyMap<string, ToolExecutionTiming> = new Map(),
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) =>
                part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
              )
              .join("\n");
      if (text.trim()) {
        entries.push({ role: "user", text, timestamp: message.timestamp });
      }
      continue;
    }

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) {
          entries.push({
            role: "assistant",
            text: part.text,
            timestamp: message.timestamp,
          });
        } else if (part.type === "thinking" && part.thinking.trim()) {
          entries.push({
            role: "thinking",
            text: part.thinking,
            timestamp: message.timestamp,
          });
        } else if (part.type === "toolCall") {
          entries.push({
            role: "tool",
            name: part.name,
            text: safeJson(part.arguments),
            timestamp: message.timestamp,
            ...toolMetadata(part.id, toolTimings),
          });
        }
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const text = message.content
      .map((part) =>
        part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
      )
      .join("\n");
    entries.push({
      role: "toolResult",
      name: message.toolName,
      text,
      isError: message.isError,
      timestamp: message.timestamp,
      ...toolMetadata(message.toolCallId, toolTimings),
    });
  }
  const selected =
    entries.length <= TRANSCRIPT_MAX_ENTRIES
      ? entries
      : [entries[0], ...entries.slice(-(TRANSCRIPT_MAX_ENTRIES - 1))];
  const bounded: TranscriptEntry[] = [];
  let totalBytes = 0;
  for (const entry of selected) {
    const remaining = TRANSCRIPT_TOTAL_MAX_BYTES - totalBytes;
    if (remaining <= 0) break;
    const text = truncateUtf8(
      entry.text,
      Math.min(TRANSCRIPT_ENTRY_MAX_BYTES, remaining),
    );
    totalBytes += Buffer.byteLength(text, "utf8");
    bounded.push({
      ...entry,
      text:
        text === entry.text ? text : `${text}\n[transcript entry truncated]`,
    });
  }
  if (bounded.length < entries.length) {
    bounded.push({
      role: "toolResult",
      name: "transcript",
      text: `[transcript truncated: retained ${bounded.length} of ${entries.length} entries]`,
    });
  }
  return bounded;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/** Full canonical serialization: no truncation and no digest collisions. */
function finalizedMessageKey(message: AssistantMessage): string {
  const seen = new Map<object, number>();
  const encode = (value: unknown): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return `string:${JSON.stringify(value)}`;
    if (typeof value === "boolean") return `boolean:${value}`;
    if (typeof value === "number") {
      if (Number.isNaN(value)) return "number:NaN";
      if (value === Infinity) return "number:Infinity";
      if (value === -Infinity) return "number:-Infinity";
      if (Object.is(value, -0)) return "number:-0";
      return `number:${value}`;
    }
    if (typeof value === "bigint") return `bigint:${value}`;
    if (typeof value === "symbol")
      return `symbol:${JSON.stringify(value.description)}`;
    if (typeof value === "function")
      return `function:${JSON.stringify(value.name)}`;

    const prior = seen.get(value);
    if (prior !== undefined) return `reference:${prior}`;
    seen.set(value, seen.size);
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    if (value instanceof Date) return `date:${value.toISOString()}`;

    const fields = Object.keys(value).sort();
    return `{${fields
      .map(
        (field) =>
          `${JSON.stringify(field)}:${encode((value as Record<string, unknown>)[field])}`,
      )
      .join(",")}}`;
  };

  return encode({
    timestamp: message.timestamp,
    api: message.api,
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    usage: message.usage,
    content: message.content,
  });
}

/** Charge each finalized assistant snapshot position exactly once. */
export function createFinalizedUsageAccumulator(
  onUsage?: (usage: AgentUsage) => void,
) {
  const usage = emptyUsage();
  // Counts grow with actual finalized turns. Eviction would corrupt rescans.
  const finalizedCounts = new Map<string, number>();
  // A session may emit the same message_end object more than once. Identity
  // rejects that event replay without conflating distinct byte-identical turns.
  const finalizedObjects = new WeakSet<AssistantMessage>();
  const charge = (message: AssistantMessage, key: string) => {
    finalizedCounts.set(key, (finalizedCounts.get(key) ?? 0) + 1);
    usage.turns++;
    const reported = message.usage;
    usage.input += finiteNonNegative(reported?.input);
    const output = reported?.output;
    if (typeof output === "number" && Number.isFinite(output) && output >= 0) {
      usage.output += output;
    } else {
      usage.outputComplete = false;
    }
    usage.cacheRead += finiteNonNegative(reported?.cacheRead);
    usage.cacheWrite += finiteNonNegative(reported?.cacheWrite);
    const cost = reported?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      usage.cost += cost;
    } else {
      usage.costComplete = false;
    }
    onUsage?.({ ...usage });
    return true;
  };
  const add = (message: AgentMessage) => {
    if (message.role !== "assistant") return false;
    const key = finalizedMessageKey(message);
    if ((finalizedCounts.get(key) ?? 0) > 0) return false;
    finalizedObjects.add(message);
    return charge(message, key);
  };
  // message_end is the authoritative identity boundary for a new turn. This
  // remains correct when compaction removes an older byte-identical message.
  const addFinalizedTurn = (message: AgentMessage) => {
    if (message.role !== "assistant" || finalizedObjects.has(message))
      return false;
    finalizedObjects.add(message);
    return charge(message, finalizedMessageKey(message));
  };
  const addMessages = (messages: AgentMessage[]) => {
    const occurrences = new Map<string, number>();
    let added = 0;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      finalizedObjects.add(message);
      const key = finalizedMessageKey(message);
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      if ((finalizedCounts.get(key) ?? 0) >= occurrence) continue;
      charge(message, key);
      added++;
    }
    return added;
  };
  return { usage, add, addFinalizedTurn, addMessages };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function formatTimeout(timeoutMs: number) {
  return timeoutMs % 1_000 === 0
    ? `${timeoutMs / 1_000} seconds`
    : `${timeoutMs} ms`;
}

/** Abort a provider call that opens but never emits its first assistant event. */
export function createFirstResponseWatchdog(
  onTimeout: () => Promise<unknown>,
  options: { timeoutMs?: number; model?: string } = {},
) {
  const timeoutMs = options.timeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      timedOut = true;
      void (async () => {
        try {
          await onTimeout();
        } catch {
          // Teardown is best-effort; the watchdog error remains authoritative.
        }
        const model = options.model ? ` for ${options.model}` : "";
        reject(
          new Error(
            `Agent received no assistant response event${model} within ${formatTimeout(timeoutMs)}; the provider request may be stalled. Retry the workflow.`,
          ),
        );
      })();
    }, timeoutMs);
  });

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    markResponse: cancel,
    async waitFor<T>(operation: Promise<T>) {
      try {
        const result = await Promise.race([operation, timeout]);
        return timedOut ? await timeout : result;
      } finally {
        cancel();
      }
    },
  };
}

function isMeaningfulRunnerActivity(event: AgentSessionEvent) {
  return (
    event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "agent_settled" ||
    event.type === "turn_start" ||
    event.type === "turn_end" ||
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end" ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end" ||
    event.type === "compaction_start" ||
    event.type === "compaction_end" ||
    event.type === "auto_retry_start" ||
    event.type === "auto_retry_end"
  );
}

function isAssistantResponseEvent(event: AgentSessionEvent) {
  return (
    (event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end") &&
    event.message.role === "assistant"
  );
}

export async function runAgent(
  options: RunAgentOptions,
): Promise<AgentOutcome> {
  let structured: unknown;
  let customTools: ToolDefinition[] | undefined;
  let session: AgentSession | undefined;
  let unsubscribeToolTimeout: (() => void) | undefined;
  try {
    options.onActivity?.();
    customTools =
      options.schema !== undefined
        ? [
            makeStructuredOutputTool(options.schema, (value) => {
              structured = value;
            }),
          ]
        : undefined;
    ({ session } = await (options.createSession ?? createAgentSession)({
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel
        ? { thinkingLevel: options.thinkingLevel }
        : {}),
      modelRegistry: options.modelRegistry,
      resourceLoader: options.loader,
      settingsManager: options.settingsManager,
      sessionManager: SessionManager.inMemory(options.cwd),
      ...(customTools ? { customTools } : {}),
      ...childToolPolicy(),
    }));
    options.onActivity?.();
    await bindChildSessionExtensions(session);
    options.onActivity?.();
    unsubscribeToolTimeout = guardWorkflowChildTools(
      session,
      options.toolCallTimeoutMs,
    );
    options.onActivity?.();
  } catch (error) {
    unsubscribeToolTimeout?.();
    if (session) await shutdownAndDisposeChildSession(session);
    return {
      ok: false,
      output: "",
      error: `Failed to create agent session: ${errorText(error)}`,
      aborted: false,
      usage: emptyUsage(),
      model: options.model?.id,
      contextWindow: options.model?.contextWindow,
      transcript: [],
    };
  }

  const childSession = session;
  const teardown = (abort = false) =>
    shutdownAndDisposeChildSession(childSession, { abort });
  const usageAccumulator = createFinalizedUsageAccumulator(options.onUsage);
  let usage = usageAccumulator.usage;
  let modelId = childSession.model?.id ?? options.model?.id;
  let contextWindow = childSession.model?.contextWindow;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  const toolTimings = new Map<string, ToolExecutionTiming>();
  const currentToolMap = new Map<string, AgentToolActivity>();
  let completedOperations = 0;
  let lastActivityAt = Date.now();

  const progressSnapshot = (): AgentProgress => ({
    preview: finalOutput(childSession.messages),
    usage: { ...usage },
    model: modelId,
    contextWindow,
    transcript: transcriptFromMessages(childSession.messages, toolTimings),
    lastActivityAt,
    currentTools: [...currentToolMap.values()],
    completedOperations,
  });

  const sync = () => {
    const messages = childSession.messages;

    const sessionModel = childSession.model;
    modelId = sessionModel?.id ?? modelId;
    contextWindow = sessionModel?.contextWindow ?? contextWindow;
    const context = childSession.getContextUsage();
    if (
      typeof context?.tokens === "number" &&
      Number.isFinite(context.tokens) &&
      context.tokens >= 0
    ) {
      usage.contextTokens = context.tokens;
    }
    if (
      typeof context?.contextWindow === "number" &&
      Number.isFinite(context.contextWindow) &&
      context.contextWindow > 0
    ) {
      contextWindow = context.contextWindow;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      // Some gateways report a concrete fallback model. Prefer its registry
      // metadata when available so capacity tracks the model that served the
      // latest response rather than a hardcoded/configured guess.
      const responseMatchesSession =
        !sessionModel ||
        (msg.provider === sessionModel.provider &&
          msg.model === sessionModel.id);
      const reportedId = msg.responseModel ?? msg.model;
      const reportedModel = responseMatchesSession
        ? options.modelRegistry.find(msg.provider, reportedId)
        : undefined;
      if (reportedModel) {
        modelId = reportedModel.id;
        contextWindow = reportedModel.contextWindow;
      }
      if (msg.stopReason) stopReason = msg.stopReason;
      if (msg.errorMessage) errorMessage = msg.errorMessage;
      break;
    }
  };

  let markFirstResponse = () => {};
  let promptTurnReserved = false;
  const unsubscribe = childSession.subscribe((event) => {
    const observedAt = Date.now();
    if (isMeaningfulRunnerActivity(event)) {
      lastActivityAt = observedAt;
      options.onActivity?.();
    }
    if (event.type === "turn_start") {
      if (promptTurnReserved) promptTurnReserved = false;
      else options.onTurnStart?.();
    }
    if (isAssistantResponseEvent(event)) markFirstResponse();
    if (event.type === "message_end" && event.message.role === "assistant") {
      usageAccumulator.addFinalizedTurn(event.message);
    }
    if (event.type === "tool_execution_start") {
      recordToolExecutionTiming(toolTimings, event, observedAt);
      currentToolMap.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        name: event.toolName,
        argsPreview: truncateUtf8(safeJson(event.args), 512),
        startedAt: observedAt,
        updatedAt: observedAt,
      });
    } else if (event.type === "tool_execution_update") {
      const current = currentToolMap.get(event.toolCallId);
      if (current) {
        currentToolMap.set(event.toolCallId, {
          ...current,
          outputPreview: truncateUtf8(safeJson(event.partialResult), 512),
          updatedAt: observedAt,
        });
      }
    } else if (event.type === "tool_execution_end") {
      recordToolExecutionTiming(toolTimings, event, observedAt);
      currentToolMap.delete(event.toolCallId);
      completedOperations += 1;
    } else if (
      event.type !== "message_end" &&
      event.type !== "compaction_end"
    ) {
      return;
    }
    sync();
    options.onProgress?.(progressSnapshot());
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void teardown(true);
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const promptWithWatchdog = async (prompt: string) => {
    options.onTurnStart?.();
    promptTurnReserved = true;
    options.onActivity?.();
    const watchdog = createFirstResponseWatchdog(() => teardown(true), {
      timeoutMs: options.firstResponseTimeoutMs,
      model: modelId,
    });
    markFirstResponse = watchdog.markResponse;
    await watchdog.waitFor(childSession.prompt(prompt));
  };

  let output = "";
  let transcript: TranscriptEntry[] = [];
  try {
    if (!aborted) {
      await promptWithWatchdog(buildWorkflowAgentPrompt(options.prompt));
      sync();
      // A fresh prompt gives AgentSession its normal pre-prompt compaction check
      // and one bounded chance to repair a model that returned prose/JSON or
      // otherwise settled without invoking the terminating result tool.
      if (
        options.schema !== undefined &&
        structured === undefined &&
        stopReason !== "error" &&
        stopReason !== "aborted" &&
        errorMessage === undefined
      ) {
        await promptWithWatchdog(STRUCTURED_OUTPUT_RECOVERY_PROMPT);
      }
    }
  } catch (error) {
    errorMessage = errorMessage ?? errorText(error);
    stopReason = stopReason ?? "error";
  } finally {
    // Finalize accounting while the abort listener is still attached: a
    // fail-closed cost/output budget discovered here must abort this outcome.
    usageAccumulator.addMessages(childSession.messages);
    sync();
    output = truncateUtf8(
      finalOutput(childSession.messages),
      AGENT_OUTPUT_MAX_BYTES,
    );
    transcript = transcriptFromMessages(childSession.messages, toolTimings);
    options.onProgress?.({
      ...progressSnapshot(),
      preview: output,
      transcript,
    });
    unsubscribe();
    unsubscribeToolTimeout?.();
    // Keep cancellation wired through orderly teardown. A late abort upgrades
    // the helper's shared teardown and must govern the returned outcome.
    await teardown();
    if (options.signal?.aborted) {
      aborted = true;
      await teardown(true);
    }
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (aborted || stopReason === "aborted") {
    return {
      ok: false,
      output,
      error: options.signal?.aborted
        ? errorText(options.signal.reason)
        : "Agent was aborted",
      aborted: true,
      usage: { ...usage },
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  const failed = stopReason === "error" || errorMessage !== undefined;
  if (failed) {
    return {
      ok: false,
      output,
      error: errorMessage ?? "Agent failed",
      aborted: false,
      usage: { ...usage },
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  if (options.schema !== undefined && structured === undefined) {
    return {
      ok: false,
      output,
      error:
        "Agent finished without calling structured_output; no structured result matching the schema was produced.",
      aborted: false,
      usage: { ...usage },
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  return {
    ok: true,
    output,
    structured,
    aborted: false,
    usage: { ...usage },
    model: modelId,
    contextWindow,
    transcript,
  };
}

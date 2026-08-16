/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a follow-up message when
 * the run finishes. Run artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; result and bounded
 * transcripts use separate artifacts, and there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { createWorkflowPersistence, persistWorkflowJson } from "./artifacts.ts";
import {
  cancelActiveWorkflowRun,
  type ActiveWorkflowRun,
} from "./cancellation.ts";
import {
  reconcileWorkflowStatus,
  RunController,
  WorkflowTerminationError,
} from "./controller.ts";
import {
  loadStoredRunDetails,
  sessionWorkflowRunIds,
  showWorkflowDashboard,
} from "./dashboard.ts";
import {
  assertWorkflowDraftApproved,
  assertWorkflowDraftArtifactMatches,
  createWorkflowDraft,
  loadWorkflowDraft,
  type WorkflowDraft,
} from "./drafts.ts";
import { showWorkflowDraftReview } from "./draft-review.ts";
import { CapacityPool, hostCapacity, resolveWorkflowLimits } from "./limits.ts";
import {
  extractMeta,
  formatWorkflowScriptParseError,
  prepareWorkflowScript,
  type WorkflowMeta,
} from "./meta.ts";
import {
  agentContext,
  aggregateUsage,
  countStates,
  emptyUsage,
  formatAgentLifecycle,
  formatElapsed,
  formatUsage,
  isWorkflowThinkingLevel,
  modelBadge,
  phaseGroups,
  resultJson,
  stateSquare,
  statusColor,
  statusWord,
  thinkingColor,
  thinkingExcerpt,
  SQUARE,
  WORKFLOW_THINKING_LEVELS,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowDraftMessage,
  buildWorkflowResultMessage,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  createWorkflowResources,
  runAgent,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import { runWorkflowSandbox } from "./sandbox.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";
import {
  ACTIVE_WORK_CHANNELS,
  workflowActiveWorkItem,
} from "./activity-protocol.ts";
import { renderWorkflowActivityCard } from "./activity-card.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;

/** What `agent()` resolves to inside the script. */
interface ScriptAgentResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  error?: string;
}

interface AgentCallOptions {
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
}

const WorkflowParams = Type.Union([
  Type.Object(
    {
      preview: Type.String({
        minLength: 1,
        description: WORKFLOW_PARAMETER_DESCRIPTIONS.preview,
      }),
      script: Type.String({
        description: WORKFLOW_PARAMETER_DESCRIPTIONS.script,
      }),
      args: Type.Optional(
        Type.String({
          description: WORKFLOW_PARAMETER_DESCRIPTIONS.args,
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description: WORKFLOW_PARAMETER_DESCRIPTIONS.background,
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      draftId: Type.String({
        description: WORKFLOW_PARAMETER_DESCRIPTIONS.draftId,
      }),
    },
    { additionalProperties: false },
  ),
]);

const WorkflowCancelParams = Type.Object(
  {
    runId: Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.runId,
    }),
  },
  { additionalProperties: false },
);

type WorkflowInput = Static<typeof WorkflowParams>;

interface WorkflowDraftToolDetails {
  kind: "draft";
  draftId: string;
  name?: string;
  preview: string;
  script: string;
  artifactPath: string;
  background: boolean;
  phases: WorkflowMeta["phases"];
  limits?: WorkflowMeta["limits"];
}

function isWorkflowDraftToolDetails(
  value: unknown,
): value is WorkflowDraftToolDetails {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "draft"
  );
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function summaryLine(details: WorkflowDetails): string {
  return `workflow ${details.name ?? details.runId}: ${formatAgentLifecycle(details)}${
    details.currentPhase ? ` · ${details.currentPhase}` : ""
  }`;
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
}

interface RunSummary {
  runId: string;
  name?: string;
  status: string;
  done: number;
  total: number;
  startedAt: number;
  active: boolean;
}

function listRuns(
  activeRuns: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
): RunSummary[] {
  const base = path.join(getAgentDir(), "workflows");
  let names: string[] = [];
  try {
    names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
  } catch {
    // No runs yet.
  }
  const summaries: RunSummary[] = [];
  for (const runId of names) {
    const live = activeRuns.get(runId);
    if (live) {
      const { done, failed } = countStates(live);
      summaries.push({
        runId,
        name: live.name,
        status: live.status,
        done: done + failed,
        total: live.agents.length,
        startedAt: live.startedAt,
        active: true,
      });
      continue;
    }
    const details = loadStoredRunDetails(runId, path.join(base, runId));
    if (
      !details ||
      (details.sessionId !== sessionId && !referencedRunIds.has(runId))
    ) {
      continue;
    }
    const { done, failed } = countStates(details);
    summaries.push({
      runId,
      name: details.name,
      status: details.status,
      done: done + failed,
      total: details.agents.length,
      startedAt: details.startedAt,
      active: false,
    });
  }
  return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

function runDetailText(
  run: RunSummary,
  activeRuns: Map<string, WorkflowDetails>,
): string {
  const runDir = path.join(getAgentDir(), "workflows", run.runId);
  const live = activeRuns.get(run.runId);
  if (live) return buildWorkflowResultMessage(live, runDir);
  const details = loadStoredRunDetails(run.runId, runDir);
  return details
    ? buildWorkflowResultMessage(details, runDir)
    : `Run ${run.runId} — ${run.status}`;
}

export default function workflows(pi: ExtensionAPI) {
  /** One extension-owned process-global pool shared by every run. */
  const sharedCapacity = new CapacityPool(hostCapacity());

  /** Process-memory authority prevents artifact edits from changing approval. */
  const pendingDrafts = new Map<string, WorkflowDraft>();
  let userInputRevision = 0;
  pi.on("input", (event) => {
    if (event.source !== "extension") userInputRevision += 1;
  });

  /** Live background runs, for /workflows and shutdown cleanup. */
  const activeRuns = new Map<string, ActiveWorkflowRun>();
  /** Recently settled background details keep their originating card accurate. */
  const finishedDetails = new Map<string, WorkflowDetails>();
  const toolRowInvalidators = new Map<
    string,
    { runId: string; invalidate: () => void }
  >();
  let activityTick: ReturnType<typeof setInterval> | undefined;
  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );

  const invalidateRun = (runId: string) => {
    for (const row of toolRowInvalidators.values()) {
      if (row.runId !== runId) continue;
      try {
        row.invalidate();
      } catch {
        // A historical row can disappear during branch/session changes.
      }
    }
  };

  const publishWorkflowActivity = (details: WorkflowDetails) => {
    const item = workflowActiveWorkItem(details);
    if (item) pi.events.emit(ACTIVE_WORK_CHANNELS.update, item);
    else {
      pi.events.emit(ACTIVE_WORK_CHANNELS.remove, {
        version: 1,
        key: `workflow:${details.runId}`,
      });
    }
    invalidateRun(details.runId);
  };

  const rememberFinished = (details: WorkflowDetails) => {
    finishedDetails.set(details.runId, compactToolDetails(details));
    while (finishedDetails.size > 64) {
      const oldest = finishedDetails.keys().next().value;
      if (typeof oldest !== "string") break;
      finishedDetails.delete(oldest);
    }
    publishWorkflowActivity(details);
  };

  const syncActivityTick = () => {
    if (activeRuns.size > 0 && !activityTick) {
      activityTick = setInterval(() => {
        for (const runId of activeRuns.keys()) invalidateRun(runId);
      }, 1_000);
      activityTick.unref?.();
    } else if (activeRuns.size === 0 && activityTick) {
      clearInterval(activityTick);
      activityTick = undefined;
    }
  };

  /** Finished counts remain visible until the dashboard acknowledges them. */
  let lastUi: ExtensionContext["ui"] | undefined;
  let completedRuns = 0;
  let failedRuns = 0;
  const updateIndicator = () => {
    const ui = lastUi;
    if (!ui) return;
    try {
      const running = activeRuns.size;
      syncActivityTick();
      if (running === 0 && completedRuns === 0 && failedRuns === 0) {
        ui.setStatus("workflows", undefined);
        return;
      }
      ui.setStatus(
        "workflows",
        formatActivityStatus(ui.theme, "workflows", {
          running,
          done: completedRuns,
          failed: failedRuns,
        }),
      );
    } catch {
      // UI may be unavailable.
    }
  };

  const recordSettledRun = (status: WorkflowDetails["status"]) => {
    if (status === "completed") completedRuns += 1;
    else failedRuns += 1;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) lastUi = ctx.ui;
    updateIndicator();
  });

  pi.on("session_shutdown", async () => {
    const runs = [...activeRuns.values()];
    for (const run of runs) {
      run.controller.abort(
        new WorkflowTerminationError(
          "session_cancelled",
          "Session is shutting down",
          "aborted",
        ),
      );
    }
    await Promise.all(
      runs.map((run) => run.controller.settle({ abort: true })),
    );
    const completions = runs
      .map((run) => run.completion)
      .filter(
        (completion): completion is Promise<void> => completion !== undefined,
      );
    if (completions.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 8_000);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled(completions), timeout]);
      if (timer) clearTimeout(timer);
    }
    if (activityTick) clearInterval(activityTick);
    activityTick = undefined;
    toolRowInvalidators.clear();
    for (const run of runs) {
      pi.events.emit(ACTIVE_WORK_CHANNELS.remove, {
        version: 1,
        key: `workflow:${run.details.runId}`,
      });
    }
    lastUi?.setStatus("workflows", undefined);
    lastUi = undefined;
  });

  pi.registerCommand("workflow-draft", {
    description: "Review a pending workflow draft and its exact source",
    getArgumentCompletions: (prefix) => {
      const matches = [...pendingDrafts.values()]
        .filter((draft) => draft.draftId.startsWith(prefix))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((draft) => ({
          value: draft.draftId,
          label: draft.draftId,
          description: draft.preview.split("\n", 1)[0],
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (rawArgs, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "Workflow draft review requires interactive mode.",
          "warning",
        );
        return;
      }
      const query = rawArgs.trim();
      const available = [...pendingDrafts.values()]
        .filter(
          (draft) =>
            draft.sessionId === ctx.sessionManager.getSessionId() &&
            draft.cwd === ctx.cwd,
        )
        .sort((a, b) => b.createdAt - a.createdAt);
      const matches = query
        ? available.filter(
            (draft) => draft.draftId === query || draft.draftId.endsWith(query),
          )
        : available.slice(0, 1);
      if (matches.length === 0) {
        ctx.ui.notify(
          query
            ? `No pending workflow draft matching "${query}".`
            : "No pending workflow drafts in this session.",
          "warning",
        );
        return;
      }
      if (matches.length > 1) {
        ctx.ui.notify(`Multiple pending drafts match "${query}".`, "warning");
        return;
      }
      const draft = matches[0]!;
      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(draft.script);
      } catch (error) {
        ctx.ui.notify(
          formatWorkflowScriptParseError(draft.script, error),
          "error",
        );
        return;
      }
      const artifactPath = path.join(
        getAgentDir(),
        "workflows",
        "drafts",
        draft.draftId,
        "draft.json",
      );
      await showWorkflowDraftReview(ctx, draft, prepared.meta, artifactPath);
    },
  });

  pi.registerCommand("workflows", {
    description:
      "List workflow runs (`/workflows <runId>` for one run's detail)",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();
      if (ctx.mode === "tui") {
        lastUi = ctx.ui;
        await showWorkflowDashboard(ctx, activeDetails, arg || undefined);
        // Opening the dashboard acknowledges finished runs.
        completedRuns = 0;
        failedRuns = 0;
        updateIndicator();
        return;
      }
      // Non-TUI fallback: plain text listing.
      const runs = listRuns(
        activeDetails(),
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
      );
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs yet.", "info");
        return;
      }
      if (arg) {
        const run = runs.find((r) => r.runId === arg || r.runId.endsWith(arg));
        ctx.ui.notify(
          run
            ? runDetailText(run, activeDetails())
            : `No workflow run matching "${arg}".`,
          run ? "info" : "warning",
        );
        return;
      }
      const labels = runs.map(
        (r) =>
          `${r.active ? "* " : "  "}${r.runId}  ${r.status}  ${r.name ?? ""}  ${r.done}/${r.total}`,
      );
      if (!ctx.hasUI) {
        ctx.ui.notify(labels.join("\n"), "info");
        return;
      }
      const choice = await ctx.ui.select("Workflow runs", labels);
      if (!choice) return;
      const run = runs[labels.indexOf(choice)];
      if (run) ctx.ui.notify(runDetailText(run, activeDetails()), "info");
    },
  });

  pi.registerTool({
    name: "workflow_cancel",
    label: "Cancel Workflow",
    description:
      "Cancel one exact active workflow run cleanly through its controller, wait for its agents and sandbox to settle, and report the persisted terminal status.",
    parameters: WorkflowCancelParams,

    async execute(_toolCallId, params) {
      const details = await cancelActiveWorkflowRun(activeRuns, params.runId);
      const message =
        details.status === "aborted"
          ? `Workflow ${params.runId} aborted cleanly.`
          : `Workflow ${params.runId} settled as ${details.status}${details.error ? `: ${details.error}` : "."}`;
      return {
        content: [{ type: "text", text: message }],
        details: compactToolDetails(details),
      };
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const workflowsDir = path.join(getAgentDir(), "workflows");
      if ("script" in params) {
        let prepared: ReturnType<typeof prepareWorkflowScript>;
        try {
          prepared = prepareWorkflowScript(params.script);
        } catch (error) {
          throw new Error(formatWorkflowScriptParseError(params.script, error));
        }
        const draft = createWorkflowDraft(workflowsDir, {
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          preparedAtUserInput: userInputRevision,
          preview: params.preview,
          script: params.script,
          ...(params.args !== undefined ? { args: params.args } : {}),
          background: params.background ?? false,
        });
        pendingDrafts.set(draft.draftId, draft);
        const directory = path.join(workflowsDir, "drafts", draft.draftId);
        const artifactPath = path.join(directory, "draft.json");
        const draftDetails: WorkflowDraftToolDetails = {
          kind: "draft",
          draftId: draft.draftId,
          ...(prepared.meta.name ? { name: prepared.meta.name } : {}),
          preview: draft.preview,
          script: draft.script,
          artifactPath,
          background: draft.background,
          phases: prepared.meta.phases,
          ...(prepared.meta.limits ? { limits: prepared.meta.limits } : {}),
        };
        return {
          content: [
            {
              type: "text",
              text: buildWorkflowDraftMessage({
                draftId: draft.draftId,
                preview: draft.preview,
                meta: prepared.meta,
                artifactPath,
              }),
            },
          ],
          details: draftDetails,
        };
      }

      const draft = pendingDrafts.get(params.draftId);
      if (!draft) {
        throw new Error(
          `Workflow draft ${params.draftId} is not pending in this session; prepare it again`,
        );
      }
      const artifact = loadWorkflowDraft(workflowsDir, params.draftId);
      assertWorkflowDraftArtifactMatches(draft, artifact);
      assertWorkflowDraftApproved(draft, {
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        userInput: userInputRevision,
      });
      const script = draft.script;
      const argsText = draft.args;
      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(script);
      } catch (error) {
        throw new Error(formatWorkflowScriptParseError(script, error));
      }

      let args: unknown;
      if (argsText !== undefined) {
        try {
          args = JSON.parse(argsText);
        } catch {
          args = argsText;
        }
      }

      const meta = prepared.meta;
      const effectiveLimits = resolveWorkflowLimits(
        meta.limits,
        sharedCapacity.capacity,
      );
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const runDir = path.join(workflowsDir, runId);
      const background = draft.background && ctx.hasUI;

      const details: WorkflowDetails = {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        name: meta.name,
        description: meta.description,
        background,
        status: "running",
        startedAt: Date.now(),
        limits: effectiveLimits,
        budget: {
          turns: 0,
          outputTokens: 0,
          costUsd: 0,
          outputComplete: true,
          costComplete: true,
        },
        phases: [...meta.phases],
        agents: [],
      };

      // Timers start with run creation, before persistence or sandbox startup.
      // Background runs survive Esc on the parent turn, but all runs are
      // aborted and settled during session shutdown.
      const controller = new RunController({
        parentSignal: background ? undefined : signal,
        limits: effectiveLimits,
        sharedCapacity,
      });
      const syncGovernance = () => {
        details.budget = controller.telemetry();
        details.termination = controller.terminationRecord;
      };

      writeRunFile(runDir, "script.js", script);
      if (argsText !== undefined) writeRunFile(runDir, "args.json", argsText);
      persistWorkflowJson(runDir, details);
      // Live checkpoints only need the compact workflow.json; the large
      // transcripts/result sidecars are written once at the final flush.
      const persistence = createWorkflowPersistence(runDir, details, {
        persist: (dir, current) =>
          persistWorkflowJson(dir, current, { artifacts: false }),
        finalPersist: (dir, current) =>
          persistWorkflowJson(dir, current, { artifacts: true }),
      });

      // Each concurrent child gets its own extension runtime. All children use
      // the parent cwd and live trust decision.
      const projectTrusted = ctx.isProjectTrusted();
      const getResources = (structured: boolean) =>
        createWorkflowResources(
          ctx.cwd,
          structured ? "structured" : "plain",
          projectTrusted,
        );

      // Throttled progress: tool-block updates when blocking. Background
      // runs are covered by the below-editor indicator and /workflows.
      let emitTimer: ReturnType<typeof setTimeout> | undefined;
      let lastEmit = 0;
      const flush = () => {
        emitTimer = undefined;
        lastEmit = Date.now();
        publishWorkflowActivity(details);
        if (background) return;
        onUpdate?.({
          content: [{ type: "text", text: summaryLine(details) }],
          details: compactToolDetails(details),
        });
      };
      const emit = (checkpoint = true) => {
        syncGovernance();
        if (checkpoint) persistence.checkpoint();
        if (emitTimer) return;
        emitTimer = setTimeout(
          flush,
          Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)),
        );
      };
      const flushNow = () => {
        if (emitTimer) clearTimeout(emitTimer);
        flush();
      };

      const phaseFn = (title: unknown) => {
        controller.activity();
        const text = String(title);
        details.currentPhase = text;
        if (!details.phases.some((p) => p.title === text))
          details.phases.push({ title: text });
        emit();
      };

      let agentCounter = 0;
      const agentFn = async (
        promptValue: unknown,
        optsValue: unknown = {},
        invocationSignal?: AbortSignal,
      ): Promise<ScriptAgentResult> => {
        const index = ++agentCounter;
        const opts: AgentCallOptions =
          optsValue && typeof optsValue === "object"
            ? (optsValue as AgentCallOptions)
            : {};
        const label =
          typeof opts.label === "string" && opts.label.trim()
            ? opts.label.trim().slice(0, 160)
            : `agent-${index}`;

        const queuedAt = Date.now();
        const record: AgentRecord = {
          index,
          label,
          phase:
            typeof opts.phase === "string"
              ? opts.phase.slice(0, 160)
              : details.currentPhase,
          state: "queued",
          model: ctx.model?.id,
          provider: ctx.model?.provider,
          modelName: ctx.model?.name,
          contextWindow: ctx.model?.contextWindow,
          queuedAt,
          lastActivityAt: queuedAt,
          currentTools: [],
          completedOperations: 0,
          preview: "",
          usage: emptyUsage(),
          transcript: [],
        };
        details.agents.push(record);
        persistence.checkpoint({ immediate: true });
        emit(false);

        const fail = (error: string): ScriptAgentResult => {
          controller.taskUpdate(() => {
            record.state = "error";
            record.error = error;
            record.finishedAt ??= Date.now();
            record.lastActivityAt = record.finishedAt;
            record.currentTools = [];
            emit();
          });
          return { ok: false, output: "", error };
        };

        const prompt =
          typeof promptValue === "string"
            ? promptValue
            : String(promptValue ?? "");
        if (!prompt.trim())
          return fail("agent() requires a non-empty prompt string");
        if (controller.signal.aborted)
          return fail("Workflow was aborted before this agent started");

        return controller
          .schedule(
            async (runSignal, runtime) => {
              // Model/provider resolution: default to the parent session's model.
              let model: WorkflowModel | undefined = ctx.model;
              if (opts.model !== undefined || opts.provider !== undefined) {
                const modelOpt =
                  typeof opts.model === "string" ? opts.model : undefined;
                const providerOpt =
                  typeof opts.provider === "string" ? opts.provider : undefined;
                if (!modelOpt)
                  return fail(
                    `agent "${label}": \`provider\` requires \`model\` as well`,
                  );
                let resolved: WorkflowModel | undefined;
                if (providerOpt) {
                  resolved = ctx.modelRegistry.find(providerOpt, modelOpt);
                } else {
                  const slash = modelOpt.indexOf("/");
                  if (slash > 0) {
                    resolved = ctx.modelRegistry.find(
                      modelOpt.slice(0, slash),
                      modelOpt.slice(slash + 1),
                    );
                  }
                  resolved ??= ctx.modelRegistry
                    .getAll()
                    .find((m) => m.id === modelOpt);
                }
                if (!resolved) {
                  const requested = providerOpt
                    ? `${providerOpt}/${modelOpt}`
                    : modelOpt;
                  return fail(
                    `agent "${label}": unknown model "${requested}" (use provider/id)`,
                  );
                }
                model = resolved;
              }
              // Effort → thinking level; default inherits the parent session.
              let thinkingLevel: ThinkingLevel = pi.getThinkingLevel();
              if (opts.effort !== undefined) {
                const effort = String(opts.effort);
                if (!isWorkflowThinkingLevel(effort)) {
                  return fail(
                    `agent "${label}": invalid effort "${effort}" (use ${WORKFLOW_THINKING_LEVELS.join("|")})`,
                  );
                }
                thinkingLevel = effort;
              }
              controller.taskUpdate(() => {
                record.model = model?.id;
                record.provider = model?.provider;
                record.modelName = model?.name;
                record.thinkingLevel = thinkingLevel;
                record.contextWindow = model?.contextWindow;
                emit();
              });

              runtime.activity();
              const resources = await getResources(opts.schema !== undefined);
              runtime.activity();
              const outcome = await runAgent({
                prompt,
                schema: opts.schema,
                model,
                thinkingLevel,
                cwd: ctx.cwd,
                loader: resources.loader,
                settingsManager: resources.settingsManager,
                modelRegistry: ctx.modelRegistry,
                signal: runSignal,
                onActivity: () => {
                  runtime.activity();
                  controller.taskUpdate(() => {
                    record.lastActivityAt = Date.now();
                    emit(false);
                  });
                },
                onTurnStart: runtime.reserveTurn,
                onUsage: runtime.reportUsage,
                onProgress: (progress) => {
                  controller.taskUpdate(() => {
                    record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
                    record.usage = { ...progress.usage };
                    record.model = progress.model ?? record.model;
                    record.provider = progress.provider ?? record.provider;
                    record.modelName = progress.modelName ?? record.modelName;
                    record.thinkingPreview =
                      progress.thinking ?? record.thinkingPreview;
                    record.contextWindow =
                      progress.contextWindow ?? record.contextWindow;
                    record.transcript = progress.transcript;
                    record.lastActivityAt = progress.lastActivityAt;
                    record.currentTools = progress.currentTools;
                    record.completedOperations = progress.completedOperations;
                    emit();
                  });
                },
              });

              controller.taskUpdate(() => {
                record.usage = { ...outcome.usage };
                record.model = outcome.model ?? record.model;
                record.provider = outcome.provider ?? record.provider;
                record.modelName = outcome.modelName ?? record.modelName;
                record.contextWindow =
                  outcome.contextWindow ?? record.contextWindow;
                record.transcript = outcome.transcript;
                record.preview = (outcome.output || record.preview).slice(
                  0,
                  PREVIEW_LENGTH,
                );
                record.finishedAt ??= Date.now();
                record.lastActivityAt = record.finishedAt;
                record.currentTools = [];
                record.state = outcome.ok ? "done" : "error";
                if (outcome.ok) {
                  delete record.error;
                } else {
                  record.error = outcome.error ?? "Agent failed";
                }
                emit();
              });

              return {
                ok: outcome.ok,
                output: outcome.output,
                ...(outcome.structured !== undefined
                  ? { structured: outcome.structured }
                  : {}),
                ...(outcome.error !== undefined
                  ? { error: outcome.error }
                  : {}),
              };
            },
            {
              invocationSignal,
              usageKey: index,
              onStarted: () => {
                controller.taskUpdate(() => {
                  record.state = "running";
                  record.startedAt = Date.now();
                  record.lastActivityAt = record.startedAt;
                  emit();
                });
              },
              onFinished: () => {
                controller.taskUpdate(() => {
                  record.finishedAt ??= Date.now();
                  record.lastActivityAt = record.finishedAt;
                  record.currentTools = [];
                });
              },
            },
          )
          .catch((error) => fail(errorText(error)));
      };

      const runScript = async () => {
        let sandboxSucceeded = false;
        try {
          details.result = await runWorkflowSandbox({
            source: prepared.source,
            args,
            cwd: ctx.cwd,
            signal: controller.signal,
            concurrency: effectiveLimits.concurrency,
            onAgent: agentFn,
            onPhase: phaseFn,
          });
          sandboxSucceeded = true;
        } catch (error) {
          if (!controller.termination) controller.failScript(errorText(error));
          details.error = controller.termination?.message ?? errorText(error);
        }

        // A typed controller reason always wins, including one racing apparent
        // sandbox success before this continuation executes.
        const settled = await controller.settle({
          abort: !sandboxSucceeded || controller.termination !== undefined,
        });
        const status = reconcileWorkflowStatus({
          sandboxSucceeded,
          termination: controller.termination,
          settled,
        });
        syncGovernance();
        if (controller.termination) {
          details.error = controller.termination.message;
        } else if (!settled) {
          details.error = "Agent shutdown deadline exceeded";
        }
        for (const record of details.agents) {
          if (record.state !== "running" && record.state !== "queued") continue;
          record.state = "error";
          record.error =
            record.error ?? "Agent did not settle before run cleanup";
          record.finishedAt ??= Date.now();
          record.lastActivityAt = record.finishedAt;
          record.currentTools = [];
        }
        details.status = status;
        details.finishedAt = Date.now();
        syncGovernance();
        try {
          persistence.flush();
        } catch (error) {
          details.status = "failed";
          details.error = `Artifact persistence failed: ${errorText(error)}`;
          throw new Error(details.error);
        } finally {
          flushNow();
        }
      };

      // Registered for /workflows visibility and session_shutdown abort;
      // blocking runs are watchable live from the dashboard too.
      const activeRun: ActiveWorkflowRun = { details, controller };
      activeRuns.set(runId, activeRun);
      publishWorkflowActivity(details);
      const completion = runScript();
      activeRun.completion = completion;
      if (ctx.hasUI) lastUi = ctx.ui;
      updateIndicator();

      if (background) {
        void completion
          .catch((error) => {
            details.status = "failed";
            details.finishedAt = Date.now();
            details.error = details.error ?? errorText(error);
          })
          .finally(() => {
            activeRuns.delete(runId);
            rememberFinished(details);
            recordSettledRun(details.status);
            updateIndicator();
            try {
              pi.sendUserMessage(
                buildBackgroundWorkflowFollowUp({
                  runId,
                  status: details.status,
                  result: buildWorkflowResultMessage(details, runDir),
                }),
                { deliverAs: "followUp" },
              );
            } catch {
              // Session may be shutting down.
            }
          });
        return {
          content: [
            {
              type: "text",
              text: buildBackgroundWorkflowLaunchResult({
                runId,
                name: details.name,
                runDir,
              }),
            },
          ],
          details: compactToolDetails(details),
        };
      }

      try {
        await completion;
      } finally {
        activeRuns.delete(runId);
        rememberFinished(details);
        recordSettledRun(details.status);
        updateIndicator();
      }
      if (details.status !== "completed") {
        // Pi marks tool failures only when execute throws; returning isError is
        // ignored by the extension API.
        throw new Error(buildWorkflowResultMessage(details, runDir));
      }
      return {
        content: [
          {
            type: "text",
            text: buildWorkflowResultMessage(details, runDir),
          },
        ],
        details: compactToolDetails(details),
      };
    },

    renderCall(args: Partial<WorkflowInput>, theme, context) {
      const component =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if ("draftId" in args && typeof args.draftId === "string") {
        component.setText(
          theme.fg("toolTitle", theme.bold("workflow execute ")) +
            theme.fg("accent", args.draftId),
        );
        return component;
      }
      const script = "script" in args ? args.script : undefined;
      const meta =
        typeof script === "string" ? extractMeta(script) : { phases: [] };
      let text =
        theme.fg("toolTitle", theme.bold("workflow draft ")) +
        theme.fg(
          "accent",
          (meta as WorkflowMeta).name ??
            (context.argsComplete ? "(script)" : "preparing…"),
        );
      if ("background" in args && args.background) {
        text += theme.fg("dim", " (background)");
      }
      if (!context.argsComplete) {
        const received =
          typeof script === "string"
            ? ` · ${script.length.toLocaleString("en-US")} chars received`
            : "";
        text += `\n  ${theme.fg("muted", "Preparing immutable script")}${theme.fg(
          "dim",
          `${received} · draft saves when complete`,
        )}`;
        const preview =
          "preview" in args && typeof args.preview === "string"
            ? args.preview.trim()
            : "";
        if (preview) {
          text += `\n\n${theme.fg("muted", theme.bold("Preview"))}\n${theme.fg(
            "toolOutput",
            preview,
          )}`;
        }
      }
      const description = (meta as WorkflowMeta).description;
      if (description) text += `\n  ${theme.fg("dim", description)}`;
      for (const phase of meta.phases.slice(0, 8)) {
        text += `\n  ${theme.fg("dim", SQUARE)} ${theme.fg("accent", phase.title)}${
          phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""
        }`;
      }
      component.setText(text);
      return component;
    },

    renderResult(result, { expanded }, theme, context) {
      const rawDetails = result.details as unknown;
      if (isWorkflowDraftToolDetails(rawDetails)) {
        const details = rawDetails;
        const label = details.name ?? details.draftId;
        const header =
          `${theme.fg("success", SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow draft "))}` +
          `${theme.fg("accent", label)} ${theme.fg("success", "ready")}` +
          (details.background ? theme.fg("dim", " (background)") : "");

        if (!expanded) {
          return new Text(
            `${header}\n  ${theme.fg("dim", `${details.draftId} · no agents started`)}\n` +
              theme.fg(
                "muted",
                `  /workflow-draft ${details.draftId} · inspect plan and exact source`,
              ),
            0,
            0,
          );
        }

        const container = new Container();
        container.addChild(new Text(header, 0, 0));
        container.addChild(
          new Text(
            theme.fg(
              "dim",
              `Draft: ${details.draftId}\nArtifact: ${details.artifactPath}\nNo agents started. Approve only after review.`,
            ),
            0,
            0,
          ),
        );
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", theme.bold("Preview")), 0, 0),
        );
        container.addChild(
          new Markdown(details.preview, 0, 0, getMarkdownTheme()),
        );
        if (details.phases.length > 0) {
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg("muted", theme.bold("Phases")), 0, 0),
          );
          for (const phase of details.phases) {
            container.addChild(
              new Text(
                `  ${theme.fg("accent", phase.title)}${phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""}`,
                0,
                0,
              ),
            );
          }
        }
        container.addChild(
          new Text(
            theme.fg(
              "dim",
              `Configured limits: ${details.limits ? JSON.stringify(details.limits) : "unbounded"}`,
            ),
            0,
            0,
          ),
        );
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            `${theme.fg("muted", theme.bold("Review inspector"))}\n` +
              `  /workflow-draft ${details.draftId}\n` +
              theme.fg(
                "dim",
                "  Opens the plan and exact immutable source side by side.",
              ),
            0,
            0,
          ),
        );
        return container;
      }

      let details = rawDetails as WorkflowDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }

      toolRowInvalidators.set(context.toolCallId, {
        runId: details.runId,
        invalidate: context.invalidate,
      });
      while (toolRowInvalidators.size > 128) {
        const oldest = toolRowInvalidators.keys().next().value;
        if (typeof oldest !== "string") break;
        toolRowInvalidators.delete(oldest);
      }
      details =
        activeRuns.get(details.runId)?.details ??
        finishedDetails.get(details.runId) ??
        details;

      const { failed } = countStates(details);
      const lifecycle = formatAgentLifecycle(details);
      const elapsed = formatElapsed(details.startedAt, details.finishedAt);
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", details.name ?? details.runId)} ` +
        theme.fg("dim", `${lifecycle} · ${elapsed} · `) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (details.background) header += theme.fg("dim", " (background)");
      if (details.status === "running" && details.currentPhase) {
        header += theme.fg("muted", ` · ${details.currentPhase}`);
      }
      const totals = formatUsage(aggregateUsage(details.agents));

      if (!expanded) {
        return new Text(renderWorkflowActivityCard(details, theme), 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.description) {
        container.addChild(
          new Text(theme.fg("dim", details.description), 0, 0),
        );
      }

      for (const group of phaseGroups(details)) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", `─── ${group.title} ───`), 0, 0),
        );
        for (const agent of group.agents) {
          const usage = formatUsage(agent.usage);
          const context = agentContext(agent);
          const model = modelBadge(agent)
            ? ` ${
                agent.provider
                  ? theme.fg("accent", agent.provider) +
                    theme.fg("dim", "/") +
                    theme.fg("text", agent.model ?? "")
                  : theme.fg("text", agent.model ?? "")
              }`
            : "";
          const think =
            agent.thinkingLevel && agent.thinkingLevel !== "off"
              ? ` ${theme.fg("dim", "think:")}${theme.fg(
                  thinkingColor(agent.thinkingLevel),
                  agent.thinkingLevel,
                )}`
              : "";
          let line =
            `${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)}` +
            model +
            think +
            theme.fg(
              "dim",
              ` ${[context, formatElapsed(agent.startedAt, agent.finishedAt)]
                .filter(Boolean)
                .join(" · ")}`,
            );
          if (usage) line += ` ${theme.fg("dim", usage)}`;
          container.addChild(new Text(line, 0, 0));
          if (agent.error) {
            container.addChild(
              new Text(`  ${theme.fg("error", agent.error)}`, 0, 0),
            );
          } else if (agent.preview) {
            const preview = agent.preview.split("\n").slice(0, 2).join(" ");
            container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
          }
          const reasoning = thinkingExcerpt(agent, 160);
          if (reasoning) {
            const color = agent.thinkingLevel
              ? thinkingColor(agent.thinkingLevel)
              : "thinkingText";
            container.addChild(
              new Text(
                `  ${theme.fg("dim", "⟡")} ${theme.fg(color, reasoning)}`,
                0,
                0,
              ),
            );
          }
        }
      }

      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("error", `Error: ${details.error}`), 0, 0),
        );
      }

      if (details.result !== undefined) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
        container.addChild(
          new Markdown(
            `\`\`\`json\n${resultJson(details.result)}\n\`\`\``,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
      }

      if (totals) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
      }
      return container;
    },
  });
}

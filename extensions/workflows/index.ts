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
import {
  cancelActiveWorkflowRun,
  type ActiveWorkflowRun,
} from "./cancellation.ts";
import { WorkflowTerminationError } from "./controller.ts";
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
import { CapacityPool, hostCapacity } from "./limits.ts";
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
  formatAgentLifecycle,
  formatElapsed,
  formatUsage,
  modelBadge,
  phaseGroups,
  resultJson,
  stateSquare,
  statusColorFor,
  statusWordFor,
  thinkingColor,
  thinkingExcerpt,
  SQUARE,
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
import { createWorkflowRun } from "./execution.ts";
import { safeStringify } from "./serialization.ts";
import {
  listSavedWorkflows,
  loadSavedWorkflow,
  savedWorkflowProvenance,
} from "./saved-workflows.ts";
import {
  ACTIVE_WORK_CHANNELS,
  workflowActiveWorkItem,
} from "./activity-protocol.ts";
import { renderWorkflowActivityCard } from "./activity-card.ts";
import {
  hasRecentWorkflowTerminalFlash,
  renderWorkflowFlow,
  workflowFlowSignature,
  WORKFLOW_FLOW_FLASH_TTL_MS,
} from "./flow-view.ts";

/** Pure seam for deduplicating identical below-editor widget projections. */
export function workflowWidgetNeedsUpdate(
  previousSignature: string,
  lines: readonly string[],
): boolean {
  return previousSignature !== workflowFlowSignature(lines);
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
      savedWorkflow: Type.String({
        description:
          "Saved workflow name from a project or agent workflow directory",
      }),
      preview: Type.String({
        minLength: 1,
        description: WORKFLOW_PARAMETER_DESCRIPTIONS.preview,
      }),
      args: Type.Optional(
        Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.args }),
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
  savedWorkflow?: string;
  sourceSha256?: string;
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
  /** UI and session identity for the additive workflow-owned widget. */
  let lastUi: ExtensionContext["ui"] | undefined;
  let uiSessionId: string | undefined;
  let workflowWidgetSignature = workflowFlowSignature([]);
  let workflowWidgetVisible = false;
  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );

  const updateWorkflowWidget = () => {
    const ui = lastUi;
    const sessionId = uiSessionId;
    if (!ui || !sessionId) return;
    try {
      const lines = renderWorkflowFlow(
        {
          active: [...activeRuns.values()].map((run) => run.details),
          finished: finishedDetails.values(),
          sessionId,
        },
        ui.theme,
      );
      const signature = workflowFlowSignature(lines);
      if (!workflowWidgetNeedsUpdate(workflowWidgetSignature, lines)) return;
      if (lines.length === 0) {
        if (!workflowWidgetVisible) {
          workflowWidgetSignature = signature;
          return;
        }
        ui.setWidget("workflow-flow", undefined, { placement: "belowEditor" });
        workflowWidgetVisible = false;
      } else {
        ui.setWidget("workflow-flow", lines, { placement: "belowEditor" });
        workflowWidgetVisible = true;
      }
      workflowWidgetSignature = signature;
    } catch {
      // UI may be unavailable during session transitions.
    }
  };

  const clearWorkflowWidget = (ui = lastUi) => {
    if (!workflowWidgetVisible) return;
    try {
      ui?.setWidget("workflow-flow", undefined, { placement: "belowEditor" });
      workflowWidgetVisible = false;
      workflowWidgetSignature = workflowFlowSignature([]);
    } catch {
      // UI may already be disposed during shutdown.
    }
  };

  const hasWorkflowFlowActivity = () =>
    activeRuns.size > 0 ||
    (uiSessionId !== undefined &&
      hasRecentWorkflowTerminalFlash(
        finishedDetails.values(),
        uiSessionId,
        Date.now(),
        WORKFLOW_FLOW_FLASH_TTL_MS,
      ));

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
    updateWorkflowWidget();
  };

  const rememberFinished = (details: WorkflowDetails) => {
    finishedDetails.set(details.runId, compactToolDetails(details));
    while (finishedDetails.size > 64) {
      const oldest = finishedDetails.keys().next().value;
      if (typeof oldest !== "string") break;
      finishedDetails.delete(oldest);
    }
    publishWorkflowActivity(details);
    syncActivityTick(true);
  };

  const syncActivityTick = (refresh = false) => {
    const hasActivity = hasWorkflowFlowActivity();
    if (!hasActivity) {
      const wasRunning = activityTick !== undefined;
      if (activityTick) clearInterval(activityTick);
      activityTick = undefined;
      if (wasRunning || refresh) updateWorkflowWidget();
      return;
    }
    if (!activityTick) {
      updateWorkflowWidget();
      activityTick = setInterval(() => {
        for (const runId of activeRuns.keys()) invalidateRun(runId);
        updateWorkflowWidget();
        if (!hasWorkflowFlowActivity()) {
          clearInterval(activityTick!);
          activityTick = undefined;
        }
      }, 1_000);
      activityTick.unref?.();
    } else if (refresh) {
      updateWorkflowWidget();
    }
  };

  /** Finished counts remain visible until the dashboard acknowledges them. */
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
    clearWorkflowWidget();
    lastUi = ctx.hasUI ? ctx.ui : undefined;
    uiSessionId = ctx.sessionManager.getSessionId();
    updateWorkflowWidget();
    updateIndicator();
  });

  pi.on("session_shutdown", async () => {
    const closingUi = lastUi;
    clearWorkflowWidget(closingUi);
    uiSessionId = undefined;
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
    closingUi?.setStatus("workflows", undefined);
    clearWorkflowWidget(closingUi);
    lastUi = undefined;
  });

  const openWorkflowDashboard = async (
    ctx: ExtensionContext,
    initialRunId?: string,
  ) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Workflow dashboard requires interactive mode.", "warning");
      return;
    }
    lastUi = ctx.ui;
    await showWorkflowDashboard(
      ctx,
      activeDetails,
      initialRunId,
      () => uiSessionId === ctx.sessionManager.getSessionId(),
    );
    // Opening the dashboard acknowledges finished runs.
    completedRuns = 0;
    failedRuns = 0;
    updateIndicator();
  };

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
        : ctx.mode === "tui"
          ? available.slice(0, 1)
          : available;
      if (matches.length === 0) {
        ctx.ui.notify(
          query
            ? `No pending workflow draft matching "${query}".`
            : "No pending workflow drafts in this session.",
          "warning",
        );
        return;
      }
      let draft = matches[0];
      if (matches.length > 1) {
        if (ctx.mode === "tui") {
          ctx.ui.notify(`Multiple pending drafts match "${query}".`, "warning");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `Multiple pending workflow drafts; specify one of: ${matches.map((item) => item.draftId).join(", ")}`,
            "warning",
          );
          return;
        }
        const options = matches.map(
          (item) => `${item.draftId} — ${item.preview.split("\n", 1)[0]}`,
        );
        const choice = await ctx.ui.select("Workflow drafts", options);
        if (!choice) return;
        draft = matches[options.indexOf(choice)];
      }
      if (!draft) return;
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
        await openWorkflowDashboard(ctx, arg || undefined);
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

  pi.registerCommand("workflow-saved", {
    description: "List validated saved workflow definitions",
    getArgumentCompletions: (prefix) => {
      try {
        const matches = listSavedWorkflows(process.cwd(), getAgentDir())
          .filter((workflow) => workflow.name.startsWith(prefix))
          .map((workflow) => ({
            value: workflow.name,
            label: workflow.name,
            description: workflow.meta.description ?? workflow.path,
          }));
        return matches.length > 0 ? matches : null;
      } catch {
        return null;
      }
    },
    handler: async (rawArgs, ctx) => {
      let saved;
      try {
        saved = listSavedWorkflows(ctx.cwd, getAgentDir());
      } catch (error) {
        ctx.ui.notify(
          `Saved workflow discovery failed: ${errorText(error)}`,
          "error",
        );
        return;
      }
      const query = rawArgs.trim();
      const matches = query
        ? saved.filter(
            (workflow) =>
              workflow.name === query || workflow.name.startsWith(query),
          )
        : saved;
      if (matches.length === 0) {
        ctx.ui.notify(
          query
            ? `No saved workflow matching "${query}".`
            : "No saved workflows found.",
          "warning",
        );
        return;
      }
      ctx.ui.notify(
        matches
          .map(
            (workflow) =>
              `${workflow.name} [${workflow.scope}]${workflow.meta.description ? ` — ${workflow.meta.description}` : ""}\n  ${workflow.path}`,
          )
          .join("\n"),
        "info",
      );
    },
  });

  pi.registerTool({
    name: "workflow_cancel",
    label: "Cancel Workflow",
    description:
      "Cancel one exact active workflow run cleanly through its controller, wait for its agents and sandbox to settle, and report the persisted terminal status.",
    parameters: WorkflowCancelParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const details = await cancelActiveWorkflowRun(
        activeRuns,
        params.runId,
        ctx.sessionManager.getSessionId(),
      );
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
      if ("savedWorkflow" in params) {
        const saved = loadSavedWorkflow(
          params.savedWorkflow,
          ctx.cwd,
          getAgentDir(),
        );
        const draft = createWorkflowDraft(workflowsDir, {
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          preparedAtUserInput: userInputRevision,
          preview: params.preview,
          script: saved.source,
          ...(params.args !== undefined ? { args: params.args } : {}),
          background: params.background ?? false,
          provenance: savedWorkflowProvenance(saved),
        });
        pendingDrafts.set(draft.draftId, draft);
        const artifactPath = path.join(
          workflowsDir,
          "drafts",
          draft.draftId,
          "draft.json",
        );
        const draftDetails: WorkflowDraftToolDetails = {
          kind: "draft",
          draftId: draft.draftId,
          ...(saved.meta.name ? { name: saved.meta.name } : {}),
          preview: draft.preview,
          script: draft.script,
          artifactPath,
          background: draft.background,
          phases: saved.meta.phases,
          ...(saved.meta.limits ? { limits: saved.meta.limits } : {}),
          savedWorkflow: saved.name,
          sourceSha256: saved.sha256,
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Prepared saved workflow ${saved.name} (${saved.sha256.slice(0, 12)}).\n` +
                buildWorkflowDraftMessage({
                  draftId: draft.draftId,
                  preview: draft.preview,
                  meta: saved.meta,
                  artifactPath,
                }),
            },
          ],
          details: draftDetails,
        };
      }
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

      const background = draft.background && ctx.hasUI;
      const meta = prepared.meta;
      const workflowRun = createWorkflowRun({
        workflowsDir,
        script,
        source: prepared.source,
        args,
        ...(argsText !== undefined ? { argsText } : {}),
        meta,
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        background,
        parentSignal: background ? undefined : signal,
        sharedCapacity,
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        projectTrusted: ctx.isProjectTrusted(),
        getThinkingLevel: () => pi.getThinkingLevel(),
        onProgress: (details) => {
          publishWorkflowActivity(details);
          if (background) return;
          onUpdate?.({
            content: [{ type: "text", text: summaryLine(details) }],
            details: compactToolDetails(details),
          });
        },
      });
      const { details, controller, runDir } = workflowRun;
      const { runId } = details;

      // Registered for /workflows visibility and session_shutdown abort;
      // blocking runs are watchable live from the dashboard too.
      const activeRun: ActiveWorkflowRun = { details, controller };
      activeRuns.set(runId, activeRun);
      publishWorkflowActivity(details);
      const completion = workflowRun.handle();
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
      const savedName =
        "savedWorkflow" in args && typeof args.savedWorkflow === "string"
          ? args.savedWorkflow
          : undefined;
      const meta =
        typeof script === "string" ? extractMeta(script) : { phases: [] };
      let text =
        theme.fg("toolTitle", theme.bold("workflow draft ")) +
        theme.fg(
          "accent",
          savedName ??
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
              `Draft: ${details.draftId}\nArtifact: ${details.artifactPath}${details.savedWorkflow ? `\nSaved workflow: ${details.savedWorkflow}\nSource SHA-256: ${details.sourceSha256}` : ""}\nNo agents started. Approve only after review.`,
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
        `${theme.fg(statusColorFor(details), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", details.name ?? details.runId)} ` +
        theme.fg("dim", `${lifecycle} · ${elapsed} · `) +
        theme.fg(statusColorFor(details), statusWordFor(details));
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

      if (details.logs?.length) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", "─── workflow log ───"), 0, 0),
        );
        for (const entry of details.logs.slice(-8)) {
          container.addChild(
            new Text(
              theme.fg("dim", `• ${entry.message.replace(/[\r\n]+/g, " ")}`),
              0,
              0,
            ),
          );
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

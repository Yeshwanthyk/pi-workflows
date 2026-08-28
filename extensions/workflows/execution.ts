import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkflowPersistence, persistWorkflowJson } from "./artifacts.ts";
import { reconcileWorkflowStatus, RunController } from "./controller.ts";
import {
  CapacityPool,
  resolveWorkflowLimits,
  type EffectiveWorkflowLimits,
} from "./limits.ts";
import {
  emptyUsage,
  isWorkflowThinkingLevel,
  WORKFLOW_THINKING_LEVELS,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";
import type { WorkflowMeta } from "./meta.ts";
import {
  measureWorkflow,
  measureWorkflowSync,
  type WorkflowMetricsSink,
} from "./metrics.ts";
import {
  createWorkflowResources,
  runAgent,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import {
  runWorkflowSandbox,
  type RunWorkflowSandboxOptions,
} from "./sandbox.ts";
import { truncateUtf8, writeFileAtomic } from "./serialization.ts";
import { sanitizeText } from "./transcript.ts";
import {
  MAX_WORKFLOW_LOG_BYTES,
  MAX_WORKFLOW_LOG_ENTRIES,
  MAX_WORKFLOW_LOG_TOTAL_BYTES,
} from "./sandbox.ts";

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

export interface WorkflowRunOptions {
  workflowsDir: string;
  script: string;
  source: string;
  args: unknown;
  argsText?: string;
  meta: WorkflowMeta;
  sessionId: string;
  cwd: string;
  background: boolean;
  parentSignal?: AbortSignal;
  sharedCapacity: CapacityPool;
  model?: WorkflowModel;
  modelRegistry: ExtensionContext["modelRegistry"];
  projectTrusted: boolean;
  getThinkingLevel: () => ThinkingLevel;
  onProgress?: (details: WorkflowDetails) => void;
  metrics?: WorkflowMetricsSink;
  runSandbox?: (
    options: RunWorkflowSandboxOptions,
  ) => ReturnType<typeof runWorkflowSandbox>;
  createResources?: typeof createWorkflowResources;
  runAgent?: typeof runAgent;
}

export interface WorkflowRunHandle {
  readonly details: WorkflowDetails;
  readonly controller: RunController;
  readonly runDir: string;
  /** Starts the run after the caller has registered the handle. */
  handle(): Promise<void>;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

/**
 * Create one reusable workflow execution. The caller owns registration,
 * activity publication, background delivery, and rendering; `handle()` starts
 * the execution once the caller has made it visible to those seams.
 */
export function createWorkflowRun(
  options: WorkflowRunOptions,
): WorkflowRunHandle {
  const effectiveLimits: EffectiveWorkflowLimits = measureWorkflowSync(
    options.metrics,
    "limits.resolve",
    () =>
      resolveWorkflowLimits(
        options.meta.limits,
        options.sharedCapacity.capacity,
      ),
  );
  const runId = `wf_${randomBytes(6).toString("hex")}`;
  const runDir = path.join(options.workflowsDir, runId);
  const details: WorkflowDetails = {
    runId,
    sessionId: options.sessionId,
    name: options.meta.name,
    description: options.meta.description,
    background: options.background,
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
    phases: [...options.meta.phases],
    logs: [],
    agents: [],
  };

  // Timers start with run creation, before persistence or sandbox startup.
  // Background runs survive Esc on the parent turn, but all runs are
  // aborted and settled during session shutdown.
  const controller = new RunController({
    parentSignal: options.parentSignal,
    limits: effectiveLimits,
    sharedCapacity: options.sharedCapacity,
  });
  const syncGovernance = () => {
    details.budget = controller.telemetry();
    details.termination = controller.terminationRecord;
  };

  measureWorkflowSync(options.metrics, "persistence.initial", () => {
    writeRunFile(runDir, "script.js", options.script);
    if (options.argsText !== undefined)
      writeRunFile(runDir, "args.json", options.argsText);
    // No sidecars yet: an early crash leaves a compact workflow.json only.
    persistWorkflowJson(runDir, details, { artifacts: false });
  });
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
  const getResources = options.createResources ?? createWorkflowResources;
  const executeAgent = options.runAgent ?? runAgent;
  const executeSandbox = options.runSandbox ?? runWorkflowSandbox;
  const getChildResources = (structured: boolean) =>
    getResources(
      options.cwd,
      structured ? "structured" : "plain",
      options.projectTrusted,
    );

  // Throttled progress is delivered through the caller-owned progress seam.
  let emitTimer: ReturnType<typeof setTimeout> | undefined;
  let lastEmit = 0;
  const flush = () => {
    emitTimer = undefined;
    lastEmit = Date.now();
    options.onProgress?.(details);
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

  let logBytes = 0;
  const logFn = (message: string) => {
    // Logging is progress projection only: deliberately do not call
    // controller.activity(), so a script cannot evade its idle budget.
    const logs = details.logs ?? (details.logs = []);
    if (logs.length >= MAX_WORKFLOW_LOG_ENTRIES) return;
    const remaining = MAX_WORKFLOW_LOG_TOTAL_BYTES - logBytes;
    if (remaining <= 0) return;
    const bounded = truncateUtf8(
      sanitizeText(message),
      Math.min(MAX_WORKFLOW_LOG_BYTES, remaining),
    );
    if (!bounded) return;
    logBytes += Buffer.byteLength(bounded, "utf8");
    logs.push({ timestamp: Date.now(), message: bounded });
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
      model: options.model?.id,
      provider: options.model?.provider,
      modelName: options.model?.name,
      contextWindow: options.model?.contextWindow,
      queuedAt,
      lastActivityAt: queuedAt,
      currentTools: [],
      completedOperations: 0,
      preview: "",
      usage: emptyUsage(),
      transcript: [],
    };
    details.agents.push(record);
    options.metrics?.increment("agents.requested");
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
      typeof promptValue === "string" ? promptValue : String(promptValue ?? "");
    if (!prompt.trim())
      return fail("agent() requires a non-empty prompt string");
    if (controller.signal.aborted)
      return fail("Workflow was aborted before this agent started");

    return controller
      .schedule(
        async (runSignal, runtime) => {
          // Model/provider resolution: default to the parent session's model.
          let model: WorkflowModel | undefined = options.model;
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
              resolved = options.modelRegistry.find(providerOpt, modelOpt);
            } else {
              const slash = modelOpt.indexOf("/");
              if (slash > 0) {
                resolved = options.modelRegistry.find(
                  modelOpt.slice(0, slash),
                  modelOpt.slice(slash + 1),
                );
              }
              resolved ??= options.modelRegistry
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
          let thinkingLevel: ThinkingLevel = options.getThinkingLevel();
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
          const resources = await measureWorkflow(
            options.metrics,
            "agent.resources",
            () => getChildResources(opts.schema !== undefined),
          );
          runtime.activity();
          const outcome = await measureWorkflow(
            options.metrics,
            "agent.execute",
            () =>
              executeAgent({
                prompt,
                schema: opts.schema,
                model,
                thinkingLevel,
                cwd: options.cwd,
                loader: resources.loader,
                settingsManager: resources.settingsManager,
                modelRegistry: options.modelRegistry,
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
                    record.thinkingPreview = (
                      progress.thinking ??
                      record.thinkingPreview ??
                      ""
                    ).slice(0, PREVIEW_LENGTH);
                    record.contextWindow =
                      progress.contextWindow ?? record.contextWindow;
                    record.transcript = progress.transcript;
                    record.lastActivityAt = progress.lastActivityAt;
                    record.currentTools = progress.currentTools;
                    record.completedOperations = progress.completedOperations;
                    emit();
                  });
                },
              }),
          );

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
              // An agent aborted by the run (e.g. a sibling tripped a
              // budget) gets the authoritative termination cause rather
              // than a generic child-teardown abort message.
              record.error =
                outcome.aborted && controller.termination
                  ? controller.termination.message
                  : (outcome.error ?? "Agent failed");
            }
            emit();
          });

          return {
            ok: outcome.ok,
            output: outcome.output,
            ...(outcome.structured !== undefined
              ? { structured: outcome.structured }
              : {}),
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          };
        },
        {
          invocationSignal,
          usageKey: index,
          onStarted: () => {
            controller.taskUpdate(() => {
              record.state = "running";
              record.startedAt = Date.now();
              options.metrics?.observe(
                "agent.queue_wait",
                Math.max(0, record.startedAt - record.queuedAt),
              );
              options.metrics?.increment("agents.started");
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
      details.result = await measureWorkflow(
        options.metrics,
        "sandbox.total",
        () =>
          executeSandbox({
            source: options.source,
            args: options.args,
            cwd: options.cwd,
            signal: controller.signal,
            concurrency: effectiveLimits.concurrency,
            onAgent: agentFn,
            onPhase: phaseFn,
            onLog: logFn,
          }),
      );
      sandboxSucceeded = true;
    } catch (error) {
      if (!controller.termination) controller.failScript(errorText(error));
      details.error = controller.termination?.message ?? errorText(error);
    }

    // A typed controller reason always wins, including one racing apparent
    // sandbox success before this continuation executes.
    const settled = await measureWorkflow(
      options.metrics,
      "controller.settle",
      () =>
        controller.settle({
          abort: !sandboxSucceeded || controller.termination !== undefined,
        }),
    );
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
      record.error = record.error ?? "Agent did not settle before run cleanup";
      record.finishedAt ??= Date.now();
      record.lastActivityAt = record.finishedAt;
      record.currentTools = [];
    }
    details.status = status;
    details.finishedAt = Date.now();
    syncGovernance();
    try {
      measureWorkflowSync(options.metrics, "persistence.final", () =>
        persistence.flush(),
      );
    } catch (error) {
      details.status = "failed";
      details.error = `Artifact persistence failed: ${errorText(error)}`;
      throw new Error(details.error);
    } finally {
      flushNow();
    }
  };

  let completion: Promise<void> | undefined;
  return {
    details,
    controller,
    runDir,
    handle() {
      return (completion ??= measureWorkflow(
        options.metrics,
        "run.total",
        runScript,
      ));
    },
  };
}

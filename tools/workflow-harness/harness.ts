import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createWorkflowRun } from "../../extensions/workflows/execution.ts";
import { CapacityPool } from "../../extensions/workflows/limits.ts";
import {
  WorkflowMetricsRecorder,
  measureWorkflowSync,
  type WorkflowMetricsSnapshot,
} from "../../extensions/workflows/metrics.ts";
import {
  emptyUsage,
  type AgentUsage,
} from "../../extensions/workflows/model.ts";
import { prepareWorkflowScript } from "../../extensions/workflows/meta.ts";
import type {
  AgentOutcome,
  RunAgentOptions,
  ThinkingLevel,
} from "../../extensions/workflows/runner.ts";

export interface WorkflowHarnessScenario {
  version: 1;
  id: string;
  workflow: {
    script?: string;
    scriptFile?: string;
    args?: string;
  };
  runtime?: {
    hostCapacity?: number;
    thinkingLevel?: ThinkingLevel;
  };
  synthetic?: {
    delayMs?: number;
    output?: string;
    failPromptIncludes?: string[];
    usage?: Partial<AgentUsage>;
  };
  expected?: {
    status?: "completed" | "failed" | "aborted";
    agentCount?: number;
  };
  benchmark?: {
    warmup?: number;
    iterations?: number;
  };
}

export interface WorkflowHarnessResult {
  schemaVersion: 1;
  scenarioId: string;
  scenarioHash: string;
  mode: "synthetic";
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    hostCapacity: number;
  };
  outcome: {
    status: "completed" | "failed" | "aborted";
    agentCount: number;
    completedAgents: number;
    failedAgents: number;
    error?: string;
  };
  metrics: WorkflowMetricsSnapshot;
}

const SCENARIO_KEYS = new Set([
  "version",
  "id",
  "workflow",
  "runtime",
  "synthetic",
  "expected",
  "benchmark",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

export function validateScenario(value: unknown): WorkflowHarnessScenario {
  const root = record(value, "scenario");
  for (const key of Object.keys(root)) {
    if (!SCENARIO_KEYS.has(key))
      throw new Error(`Unknown scenario key: ${key}`);
  }
  if (root.version !== 1) throw new Error("scenario.version must be 1");
  if (typeof root.id !== "string" || !root.id.trim()) {
    throw new Error("scenario.id must be a non-empty string");
  }
  const workflow = record(root.workflow, "scenario.workflow");
  const script =
    typeof workflow.script === "string" ? workflow.script : undefined;
  const scriptFile =
    typeof workflow.scriptFile === "string" ? workflow.scriptFile : undefined;
  if ((script === undefined) === (scriptFile === undefined)) {
    throw new Error(
      "scenario.workflow requires exactly one of script or scriptFile",
    );
  }
  if (workflow.args !== undefined && typeof workflow.args !== "string") {
    throw new Error("scenario.workflow.args must be a string");
  }
  if (root.runtime !== undefined) {
    const runtime = record(root.runtime, "scenario.runtime");
    finiteInteger(runtime.hostCapacity, "runtime.hostCapacity", 1, 16);
  }
  if (root.synthetic !== undefined) {
    const synthetic = record(root.synthetic, "scenario.synthetic");
    finiteInteger(synthetic.delayMs, "synthetic.delayMs", 0, 60_000);
  }
  if (root.benchmark !== undefined) {
    const benchmark = record(root.benchmark, "scenario.benchmark");
    finiteInteger(benchmark.warmup, "benchmark.warmup", 0, 20);
    finiteInteger(benchmark.iterations, "benchmark.iterations", 1, 100);
  }
  return value as WorkflowHarnessScenario;
}

export function loadScenario(file: string): WorkflowHarnessScenario {
  return validateScenario(JSON.parse(readFileSync(file, "utf8")));
}

function sourceForScenario(
  scenario: WorkflowHarnessScenario,
  scenarioFile?: string,
): string {
  if (scenario.workflow.script !== undefined) return scenario.workflow.script;
  const requested = scenario.workflow.scriptFile!;
  const base = scenarioFile ? dirname(resolve(scenarioFile)) : process.cwd();
  const file = isAbsolute(requested) ? requested : resolve(base, requested);
  if (!file.startsWith(`${base}/`) && file !== base) {
    throw new Error(
      "scenario.workflow.scriptFile escapes the scenario directory",
    );
  }
  return readFileSync(file, "utf8");
}

function parsedArgs(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Synthetic agent aborted"));
      },
      { once: true },
    );
  });
}

function syntheticRunner(
  scenario: WorkflowHarnessScenario,
): (options: RunAgentOptions) => Promise<AgentOutcome> {
  const config = scenario.synthetic ?? {};
  return async (options) => {
    options.onTurnStart?.();
    options.onActivity?.();
    try {
      await delay(config.delayMs ?? 0, options.signal);
    } catch (error) {
      return {
        ok: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        aborted: true,
        usage: emptyUsage(),
        transcript: [],
      };
    }
    const usage: AgentUsage = {
      ...emptyUsage(),
      ...config.usage,
      turns: config.usage?.turns ?? 1,
    };
    options.onUsage?.(usage);
    const failure = config.failPromptIncludes?.find((part) =>
      options.prompt.includes(part),
    );
    const output = failure
      ? ""
      : (config.output ?? `synthetic:${options.prompt}`);
    options.onProgress?.({
      preview: output,
      usage,
      transcript: [],
      lastActivityAt: Date.now(),
      currentTools: [],
      completedOperations: 0,
    });
    return {
      ok: failure === undefined,
      output,
      ...(failure ? { error: `Synthetic failure matched: ${failure}` } : {}),
      aborted: false,
      usage,
      transcript: [],
    };
  };
}

export async function runScenario(
  scenario: WorkflowHarnessScenario,
  options: {
    scenarioFile?: string;
    recorder?: WorkflowMetricsRecorder;
    keepArtifacts?: boolean;
  } = {},
): Promise<WorkflowHarnessResult> {
  const recorder = options.recorder ?? new WorkflowMetricsRecorder();
  const source = sourceForScenario(scenario, options.scenarioFile);
  const prepared = measureWorkflowSync(recorder, "workflow.parse", () =>
    prepareWorkflowScript(source),
  );
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-harness-"));
  const cwd = join(root, "project");
  const workflowsDir = join(root, "workflows");
  mkdirSync(cwd);
  mkdirSync(workflowsDir);
  const hostCapacity = scenario.runtime?.hostCapacity ?? 4;
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  try {
    const run = createWorkflowRun({
      workflowsDir,
      script: source,
      source: prepared.source,
      args: parsedArgs(scenario.workflow.args),
      ...(scenario.workflow.args !== undefined
        ? { argsText: scenario.workflow.args }
        : {}),
      meta: prepared.meta,
      sessionId: "workflow-harness",
      cwd,
      background: false,
      sharedCapacity: new CapacityPool(hostCapacity),
      modelRegistry: registry,
      projectTrusted: false,
      getThinkingLevel: () => scenario.runtime?.thinkingLevel ?? "medium",
      metrics: recorder,
      createResources: async () =>
        ({ loader: {}, settingsManager: {} }) as Awaited<
          ReturnType<
            NonNullable<
              Parameters<typeof createWorkflowRun>[0]["createResources"]
            >
          >
        >,
      runAgent: syntheticRunner(scenario),
    });
    await run.handle();
    const completedAgents = run.details.agents.filter(
      (agent) => agent.state === "done",
    ).length;
    const failedAgents = run.details.agents.filter(
      (agent) => agent.state === "error",
    ).length;
    const expected = scenario.expected;
    if (expected?.status && run.details.status !== expected.status) {
      throw new Error(
        `Expected status ${expected.status}, received ${run.details.status}`,
      );
    }
    if (
      expected?.agentCount !== undefined &&
      run.details.agents.length !== expected.agentCount
    ) {
      throw new Error(
        `Expected ${expected.agentCount} agents, received ${run.details.agents.length}`,
      );
    }
    if (run.details.status === "running") {
      throw new Error(
        "Workflow remained running after its execution handle settled",
      );
    }
    return {
      schemaVersion: 1,
      scenarioId: scenario.id,
      scenarioHash: createHash("sha256")
        .update(JSON.stringify(scenario))
        .digest("hex"),
      mode: "synthetic",
      environment: {
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        hostCapacity,
      },
      outcome: {
        status: run.details.status,
        agentCount: run.details.agents.length,
        completedAgents,
        failedAgents,
        ...(run.details.error ? { error: run.details.error } : {}),
      },
      metrics: recorder.snapshot(),
    };
  } finally {
    if (!options.keepArtifacts) rmSync(root, { recursive: true, force: true });
  }
}

export async function benchmarkScenario(
  scenario: WorkflowHarnessScenario,
  options: { scenarioFile?: string; warmup?: number; iterations?: number } = {},
): Promise<WorkflowHarnessResult> {
  const warmup = options.warmup ?? scenario.benchmark?.warmup ?? 1;
  const iterations = options.iterations ?? scenario.benchmark?.iterations ?? 7;
  for (let index = 0; index < warmup; index++) {
    await runScenario(scenario, { scenarioFile: options.scenarioFile });
  }
  const recorder = new WorkflowMetricsRecorder();
  let result: WorkflowHarnessResult | undefined;
  for (let index = 0; index < iterations; index++) {
    result = await runScenario(scenario, {
      scenarioFile: options.scenarioFile,
      recorder,
    });
  }
  if (!result) throw new Error("Benchmark ran no iterations");
  return { ...result, metrics: recorder.snapshot() };
}

export interface BaselineRegression {
  stage: string;
  baselineMs: number;
  candidateMs: number;
  allowedMs: number;
}

export function compareResults(
  baseline: WorkflowHarnessResult,
  candidate: WorkflowHarnessResult,
): BaselineRegression[] {
  if (
    baseline.schemaVersion !== candidate.schemaVersion ||
    baseline.scenarioHash !== candidate.scenarioHash ||
    baseline.mode !== candidate.mode ||
    baseline.environment.node.split(".")[0] !==
      candidate.environment.node.split(".")[0] ||
    baseline.environment.platform !== candidate.environment.platform ||
    baseline.environment.arch !== candidate.environment.arch
  ) {
    throw new Error("Harness results are not baseline-compatible");
  }
  const regressions: BaselineRegression[] = [];
  for (const [stage, baselineSummary] of Object.entries(
    baseline.metrics.stages,
  )) {
    const candidateSummary =
      candidate.metrics.stages[stage as keyof typeof candidate.metrics.stages];
    if (!baselineSummary || !candidateSummary) continue;
    const allowedMs = Math.max(
      baselineSummary.medianMs * 1.2,
      baselineSummary.medianMs + 2,
    );
    if (candidateSummary.medianMs > allowedMs) {
      regressions.push({
        stage,
        baselineMs: baselineSummary.medianMs,
        candidateMs: candidateSummary.medianMs,
        allowedMs,
      });
    }
  }
  return regressions;
}

export function writeResult(file: string, result: WorkflowHarnessResult): void {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

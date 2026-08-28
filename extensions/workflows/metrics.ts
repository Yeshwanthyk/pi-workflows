import { performance } from "node:perf_hooks";

export const WORKFLOW_METRIC_STAGES = [
  "workflow.parse",
  "limits.resolve",
  "persistence.initial",
  "sandbox.total",
  "agent.queue_wait",
  "agent.resources",
  "agent.execute",
  "controller.settle",
  "persistence.final",
  "run.total",
] as const;

export type WorkflowMetricStage = (typeof WORKFLOW_METRIC_STAGES)[number];

export interface WorkflowMetricsSink {
  observe(stage: WorkflowMetricStage, durationMs: number): void;
  increment(name: string, value?: number): void;
}

export interface WorkflowMetricSummary {
  count: number;
  minMs: number;
  medianMs: number;
  p90Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
}

export interface WorkflowMetricsSnapshot {
  stages: Partial<Record<WorkflowMetricStage, WorkflowMetricSummary>>;
  counters: Record<string, number>;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export class WorkflowMetricsRecorder implements WorkflowMetricsSink {
  private readonly samples = new Map<WorkflowMetricStage, number[]>();
  private readonly counters = new Map<string, number>();

  observe(stage: WorkflowMetricStage, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const samples = this.samples.get(stage) ?? [];
    samples.push(durationMs);
    this.samples.set(stage, samples);
  }

  increment(name: string, value = 1): void {
    if (!name || !Number.isFinite(value)) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  snapshot(): WorkflowMetricsSnapshot {
    const stages: WorkflowMetricsSnapshot["stages"] = {};
    for (const stage of WORKFLOW_METRIC_STAGES) {
      const values = this.samples.get(stage);
      if (!values || values.length === 0) continue;
      const sorted = [...values].sort((left, right) => left - right);
      const total = sorted.reduce((sum, value) => sum + value, 0);
      stages[stage] = {
        count: sorted.length,
        minMs: rounded(sorted[0] ?? 0),
        medianMs: rounded(percentile(sorted, 0.5)),
        p90Ms: rounded(percentile(sorted, 0.9)),
        p95Ms: rounded(percentile(sorted, 0.95)),
        maxMs: rounded(sorted[sorted.length - 1] ?? 0),
        totalMs: rounded(total),
      };
    }
    return {
      stages,
      counters: Object.fromEntries(
        [...this.counters.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    };
  }
}

export function measureWorkflowSync<T>(
  sink: WorkflowMetricsSink | undefined,
  stage: WorkflowMetricStage,
  operation: () => T,
): T {
  if (!sink) return operation();
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    sink.observe(stage, performance.now() - startedAt);
  }
}

export async function measureWorkflow<T>(
  sink: WorkflowMetricsSink | undefined,
  stage: WorkflowMetricStage,
  operation: () => Promise<T>,
): Promise<T> {
  if (!sink) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    sink.observe(stage, performance.now() - startedAt);
  }
}

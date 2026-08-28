import assert from "node:assert/strict";
import { test } from "node:test";
import {
  benchmarkScenario,
  compareResults,
  runScenario,
  validateScenario,
  type WorkflowHarnessScenario,
} from "./harness.ts";

const scenario: WorkflowHarnessScenario = {
  version: 1,
  id: "test-sequential",
  workflow: {
    script:
      "export const meta = { name: 'test' }\n" +
      "const a = await agent('a')\n" +
      "const b = await agent('b')\n" +
      "return [a, b]",
  },
  synthetic: { delayMs: 1, output: "ok" },
  expected: { status: "completed", agentCount: 2 },
  benchmark: { warmup: 0, iterations: 2 },
};

test("workflow harness validates closed top-level scenarios", () => {
  assert.equal(validateScenario(scenario).id, "test-sequential");
  assert.throws(
    () => validateScenario({ ...scenario, surprise: true }),
    /Unknown scenario key/,
  );
  assert.throws(
    () =>
      validateScenario({
        ...scenario,
        workflow: { script: "return true", scriptFile: "also.js" },
      }),
    /exactly one/,
  );
});

test("synthetic harness executes the production parser, sandbox, controller, and persistence", async () => {
  const result = await runScenario(scenario);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.outcome.status, "completed");
  assert.equal(result.outcome.agentCount, 2);
  assert.equal(result.metrics.counters["agents.requested"], 2);
  assert.equal(result.metrics.counters["agents.started"], 2);
  assert.equal(result.metrics.stages["workflow.parse"]?.count, 1);
  assert.equal(result.metrics.stages["sandbox.total"]?.count, 1);
  assert.equal(result.metrics.stages["agent.execute"]?.count, 2);
});

test("benchmarks aggregate iterations and baseline comparison catches regressions", async () => {
  const baseline = await benchmarkScenario(scenario, {
    warmup: 0,
    iterations: 2,
  });
  assert.equal(baseline.metrics.stages["run.total"]?.count, 2);
  const candidate = structuredClone(baseline);
  candidate.metrics.stages["run.total"]!.medianMs =
    baseline.metrics.stages["run.total"]!.medianMs + 10;
  const regressions = compareResults(baseline, candidate);
  assert.ok(regressions.some((item) => item.stage === "run.total"));
});

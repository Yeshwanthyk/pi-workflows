#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  benchmarkScenario,
  compareResults,
  loadScenario,
  runScenario,
  validateScenario,
  writeResult,
  type WorkflowHarnessResult,
} from "./harness.ts";

function usage(): never {
  throw new Error(
    "Usage: workflow-harness <validate|run|bench|compare> <scenario|baseline> [candidate] [--json] [--out file] [--warmup n] [--iterations n]",
  );
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerFlag(name: string): number | undefined {
  const value = flag(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} requires a non-negative integer`);
  }
  return parsed;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<number> {
  if (flag("--mode") === "live") {
    process.stderr.write(
      "Live provider mode is intentionally not available in the deterministic foundation harness.\n",
    );
    return 4;
  }
  const [command, first, second] = process.argv
    .slice(2)
    .filter((argument) => !argument.startsWith("--"));
  if (!command || !first) usage();
  const out = flag("--out");
  if (command === "validate") {
    const scenario = validateScenario(JSON.parse(readFileSync(first, "utf8")));
    emit({ valid: true, id: scenario.id, version: scenario.version });
    return 0;
  }
  if (command === "run") {
    const scenario = loadScenario(first);
    const result = await runScenario(scenario, { scenarioFile: first });
    if (out) writeResult(out, result);
    emit(result);
    return 0;
  }
  if (command === "bench") {
    const scenario = loadScenario(first);
    const iterations = integerFlag("--iterations");
    if (iterations === 0) throw new Error("--iterations must be at least 1");
    const result = await benchmarkScenario(scenario, {
      scenarioFile: first,
      warmup: integerFlag("--warmup"),
      iterations,
    });
    if (out) writeResult(out, result);
    emit(result);
    return 0;
  }
  if (command === "compare") {
    if (!second) usage();
    const baseline = JSON.parse(
      readFileSync(first, "utf8"),
    ) as WorkflowHarnessResult;
    const candidate = JSON.parse(
      readFileSync(second, "utf8"),
    ) as WorkflowHarnessResult;
    const regressions = compareResults(baseline, candidate);
    emit({ compatible: true, regressions });
    return regressions.length === 0 ? 0 : 3;
  }
  usage();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });

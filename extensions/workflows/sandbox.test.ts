import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflowSandbox } from "./sandbox.ts";

function run(
  source: string,
  overrides: Partial<Parameters<typeof runWorkflowSandbox>[0]> = {},
) {
  const abort = new AbortController();
  return runWorkflowSandbox({
    source,
    args: undefined,
    cwd: process.cwd(),
    signal: abort.signal,
    concurrency: 4,
    onAgent: async (prompt) => ({ ok: true, output: `reply:${prompt}` }),
    onPhase: () => {},
    ...overrides,
  });
}

test("sandbox exposes only workflow capabilities and validates results", async () => {
  const phases: string[] = [];
  const result = await run(
    `
      phase("Gather");
      const replies = await parallel([
        () => agent("one"),
        () => agent("two"),
      ], { concurrency: 99 });
      return {
        replies: replies.map((reply) => reply.output),
        processType: typeof process,
        requireType: typeof require,
        fetchType: typeof fetch,
      };
    `,
    { onPhase: (title) => phases.push(title) },
  );
  assert.deepEqual(result, {
    replies: ["reply:one", "reply:two"],
    processType: "undefined",
    requireType: "undefined",
    fetchType: "undefined",
  });
  assert.deepEqual(phases, ["Gather"]);
});

test("sandbox hides structured payloads from failed agent outcomes", async () => {
  const result = await run(`return await agent("partial");`, {
    onAgent: async () => ({
      ok: false,
      output: "partial output",
      structured: { unsafe: true },
      error: "failed",
    }),
  });

  assert.deepEqual(result, {
    ok: false,
    output: "partial output",
    error: "failed",
  });
});

test("sandbox result serialization handles cycles and bigint", async () => {
  const result = await run(`
    const value = { count: 7n };
    value.self = value;
    return value;
  `);
  assert.deepEqual(result, { count: "7n", self: "[circular]" });
});

test("sandbox rejects unawaited agent calls", async () => {
  let calls = 0;
  await assert.rejects(
    run(`agent("orphan"); return "done";`, {
      onAgent: async () => {
        calls++;
        return { ok: true, output: "unexpected" };
      },
    }),
    /unawaited agent/,
  );
  assert.equal(calls, 0);
});

test("sandbox VM still rejects non-yielding synchronous code", async () => {
  await assert.rejects(run(`while (true) {}`), /timed out/);
});

test("workflow agent invocations have no per-request wall timer", async () => {
  let signalAborted = false;
  const result = await run(`return (await agent("delayed")).output;`, {
    onAgent: async (_prompt, _options, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      signalAborted = signal.aborted;
      return { ok: true, output: "completed" };
    },
  });

  assert.equal(result, "completed");
  assert.equal(signalAborted, false);
});

test("workflow cancellation aborts a pending agent request", async () => {
  const controller = new AbortController();
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let requestAborted = false;
  const pending = run(`return await agent("pending");`, {
    signal: controller.signal,
    onAgent: async (_prompt, _options, signal) => {
      startedResolve?.();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return { ok: false, output: "", error: "Agent was aborted" };
    },
  });

  await started;
  controller.abort(new Error("cancel fixture"));
  await assert.rejects(pending, /cancel fixture/);
  assert.equal(requestAborted, true);
});

test("sandbox parallel defaults to four but explicit concurrency reaches runtime cap", async () => {
  const measure = async (parallelOptions: string) => {
    let active = 0;
    let peak = 0;
    await run(
      `await parallel(Array.from({ length: 12 }, (_, i) => () => agent(String(i)))${parallelOptions}); return true;`,
      {
        concurrency: 8,
        onAgent: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return { ok: true, output: "ok" };
        },
      },
    );
    return peak;
  };

  assert.equal(await measure(""), 4);
  assert.equal(await measure(", { concurrency: 8 }"), 8);
});

test("sandbox runtime concurrency fails closed and preserves the 32-call limit", async () => {
  await assert.rejects(
    run(`return true`, { concurrency: 0 }),
    /runtime concurrency/,
  );
  await assert.rejects(
    run(
      `return await parallel(Array.from({ length: 33 }, (_, i) => () => agent(String(i))), { concurrency: 16 });`,
      { concurrency: 16 },
    ),
    /agent request budget/,
  );
});

test("sandbox exposes bounded workflow log messages", async () => {
  const logs: string[] = [];
  const result = await run(
    `log("ready"); log("x".repeat(10_000)); return typeof log;`,
    { onLog: (message) => logs.push(message) },
  );

  assert.equal(result, "function");
  assert.equal(logs[0], "ready");
  assert.equal(logs[1]?.length, 4_096);
});

test("pipeline streams each item through stages and preserves result order", async () => {
  const calls: string[] = [];
  const result = await run(
    `
      return pipeline(["slow", "fast", "broken"],
        async (value, original, index) => {
          const reply = await agent("first:" + value);
          if (original === "broken") throw new Error("item failed");
          return reply.output + ":" + index;
        },
        async (value, original) => {
          const reply = await agent("second:" + original + ":" + value);
          return reply.output;
        },
      );
    `,
    {
      concurrency: 3,
      onAgent: async (prompt) => {
        calls.push(prompt);
        if (prompt === "first:slow")
          await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true, output: `reply:${prompt}` };
      },
    },
  );

  assert.deepEqual(result, [
    "reply:second:slow:reply:first:slow:0",
    "reply:second:fast:reply:first:fast:1",
    null,
  ]);
  assert.equal(calls.includes("second:broken:reply:first:broken:2"), false);
  assert.ok(
    calls.indexOf("second:fast:reply:first:fast:1") <
      calls.indexOf("second:slow:reply:first:slow:0"),
    "fast item should enter stage two before slow item leaves stage one",
  );
});

test("pipeline validates stages and shares the global agent-call budget", async () => {
  await assert.rejects(run(`return pipeline([1]);`), /stage functions/);
  await assert.rejects(
    run(
      `return pipeline(Array.from({ length: 33 }, (_, index) => index), (index) => agent(String(index)));`,
      { concurrency: 16 },
    ),
    /agent request budget/,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
  type AgentSession,
  type AgentSessionEventListener,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createFinalizedUsageAccumulator,
  createFirstResponseWatchdog,
  guardWorkflowChildTools,
  latestThinking,
  recordToolExecutionTiming,
  runAgent,
  transcriptFromMessages,
  type AgentProgress,
  type ToolExecutionTiming,
} from "./runner.ts";
import type { AgentUsage } from "./model.ts";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

async function runAfterStructuredOutput(mode: "error" | "abort") {
  const abortController = new AbortController();
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager,
  });
  const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  let releasePrompt: (() => void) | undefined;

  return runAgent({
    prompt: "return structured output",
    schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    cwd: process.cwd(),
    loader,
    settingsManager,
    modelRegistry,
    signal: abortController.signal,
    createSession: async (creationOptions) => {
      const tools = new Map(
        (creationOptions?.customTools ?? []).map((tool) => [tool.name, tool]),
      );
      const messages: AgentSession["messages"] = [];
      const session = {
        messages,
        model: undefined,
        bindExtensions: async () => {},
        getAllTools: () => [...tools.keys()].map((name) => ({ name })),
        getToolDefinition: (name: string) => tools.get(name),
        subscribe: (_listener: AgentSessionEventListener) => () => {},
        getContextUsage: () => undefined,
        prompt: async () => {
          const structuredTool = tools.get("structured_output");
          if (!structuredTool)
            throw new Error("missing structured_output tool");
          await structuredTool.execute(
            "structured-call",
            { value: "partial" },
            undefined,
            undefined,
            {} as ExtensionContext,
          );
          if (mode === "error") throw new Error("provider failed");
          const pending = new Promise<void>((resolve) => {
            releasePrompt = resolve;
          });
          abortController.abort();
          await pending;
        },
        abort: async () => {
          releasePrompt?.();
        },
        extensionRunner: {
          hasHandlers: () => false,
          emit: async () => {},
        },
        dispose: () => {},
      } as unknown as AgentSession;
      return { session };
    },
  });
}

async function runMissingStructuredOutputRecovery(recover = true) {
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager,
  });
  const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const prompts: string[] = [];
  let turnStarts = 0;
  let activities = 0;
  const progressUsage: AgentUsage[] = [];

  const outcome = await runAgent({
    prompt: "return structured output",
    schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    cwd: process.cwd(),
    loader,
    settingsManager,
    modelRegistry,
    onTurnStart: () => turnStarts++,
    onActivity: () => activities++,
    onProgress: (progress) => progressUsage.push(progress.usage),
    createSession: async (creationOptions) => {
      const tools = new Map(
        (creationOptions?.customTools ?? []).map((tool) => [tool.name, tool]),
      );
      const messages: AgentSession["messages"] = [];
      let listener: AgentSessionEventListener | undefined;
      const session = {
        messages,
        model: undefined,
        bindExtensions: async () => {},
        getAllTools: () => [...tools.keys()].map((name) => ({ name })),
        getToolDefinition: (name: string) => tools.get(name),
        subscribe: (next: AgentSessionEventListener) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        getContextUsage: () => undefined,
        prompt: async (prompt: string) => {
          prompts.push(prompt);
          listener?.({ type: "turn_start" });
          if (prompts.length === 1) {
            // Tool-loop continuations start provider turns without a new prompt.
            listener?.({ type: "turn_start" });
            const message = {
              role: "assistant" as const,
              content: [
                { type: "text" as const, text: '{"value":"plain-json"}' },
              ],
              api: "openai-responses" as const,
              provider: "fixture",
              model: "fixture",
              usage: zeroUsage,
              stopReason: "stop" as const,
              timestamp: Date.now(),
            };
            messages.push(message);
            listener?.({ type: "message_end", message });
            return;
          }
          if (!recover) {
            messages.push({
              role: "assistant",
              content: [{ type: "text", text: "still plain text" }],
              api: "openai-responses",
              provider: "fixture",
              model: "fixture",
              usage: zeroUsage,
              stopReason: "stop",
              timestamp: Date.now(),
            });
            return;
          }
          const message = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "calling tool" }],
            api: "openai-responses" as const,
            provider: "fixture",
            model: "fixture",
            usage: zeroUsage,
            stopReason: "toolUse" as const,
            timestamp: Date.now() + 1,
          };
          messages.push(message);
          listener?.({ type: "message_end", message });
          const structuredTool = tools.get("structured_output");
          if (!structuredTool)
            throw new Error("missing structured_output tool");
          await structuredTool.execute(
            "structured-call",
            { value: "recovered" },
            undefined,
            undefined,
            {} as ExtensionContext,
          );
        },
        abort: async () => {},
        extensionRunner: {
          hasHandlers: () => false,
          emit: async () => {},
        },
        dispose: () => {},
      } as unknown as AgentSession;
      return { session };
    },
  });

  return { outcome, prompts, turnStarts, activities, progressUsage };
}

function parallelToolMessages(): AgentSession["messages"] {
  return [
    { role: "user", content: "run both", timestamp: 900 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-a",
          name: "first",
          arguments: { value: 1 },
        },
        {
          type: "toolCall",
          id: "call-b",
          name: "second",
          arguments: { value: 2 },
        },
      ],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 950,
    },
    {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "first",
      content: [{ type: "text", text: "first result" }],
      isError: false,
      timestamp: 1_040,
    },
    {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "second",
      content: [{ type: "text", text: "second result" }],
      isError: false,
      timestamp: 1_041,
    },
  ];
}

test("finalized usage is cumulative, deduplicated, and treats finite zero cost as known", () => {
  const updates: AgentUsage[] = [];
  const accumulator = createFinalizedUsageAccumulator((usage) =>
    updates.push(usage),
  );
  const message = parallelToolMessages()[1]!;
  assert.equal(accumulator.add(message), true);
  assert.equal(accumulator.add(message), false);
  assert.equal(
    accumulator.add(structuredClone(message) as typeof message),
    false,
  );
  assert.equal(accumulator.usage.turns, 1);
  assert.equal(accumulator.usage.cost, 0);
  assert.equal(accumulator.usage.costComplete, true);
  assert.equal(updates.length, 1);

  const missing = {
    ...message,
    timestamp: 951,
    usage: { ...zeroUsage, cost: undefined },
  } as unknown as AgentSession["messages"][number];
  assert.equal(accumulator.add(missing), true);
  assert.equal(accumulator.usage.turns, 2);
  assert.equal(accumulator.usage.costComplete, false);
  assert.equal(
    updates[0]?.turns,
    1,
    "later accumulator mutation cannot alter a published usage snapshot",
  );

  const distinct = structuredClone(message) as typeof message;
  distinct.timestamp = 952;
  assert.equal(accumulator.add(distinct), true);
  assert.equal(accumulator.usage.turns, 3);

  const identicalTurns = createFinalizedUsageAccumulator();
  identicalTurns.addMessages([
    message,
    structuredClone(message) as typeof message,
  ]);
  assert.equal(
    identicalTurns.usage.turns,
    2,
    "separate snapshot positions remain distinct turns",
  );

  const afterCompaction = createFinalizedUsageAccumulator();
  afterCompaction.addMessages([message]);
  afterCompaction.addFinalizedTurn(structuredClone(message) as typeof message);
  afterCompaction.addMessages([structuredClone(message) as typeof message]);
  assert.equal(
    afterCompaction.usage.turns,
    2,
    "a new identical event remains distinct after the old turn is compacted",
  );
});

test("finalized turn events reject duplicate object identity without conflating identical turns", () => {
  const message = parallelToolMessages()[1]!;
  const accumulator = createFinalizedUsageAccumulator();

  assert.equal(accumulator.addFinalizedTurn(message), true);
  assert.equal(accumulator.addFinalizedTurn(message), false);
  assert.equal(accumulator.usage.turns, 1);

  const distinctIdenticalTurn = structuredClone(message) as typeof message;
  assert.equal(accumulator.addFinalizedTurn(distinctIdenticalTurn), true);
  assert.equal(accumulator.addFinalizedTurn(distinctIdenticalTurn), false);
  assert.equal(accumulator.usage.turns, 2);
  assert.equal(
    accumulator.addMessages([
      structuredClone(message) as typeof message,
      structuredClone(distinctIdenticalTurn) as typeof message,
    ]),
    0,
    "a cloned authoritative snapshot must preserve occurrence accounting",
  );
});

test("finalized usage retains all turns and compares complete large messages", () => {
  const base = parallelToolMessages()[1]!;
  const messages = Array.from({ length: 2_051 }, (_, index) => ({
    ...structuredClone(base),
    timestamp: index,
    usage: {
      ...zeroUsage,
      input: 1,
      output: 1,
      cost: { ...zeroUsage.cost, total: 1 },
    },
  })) as AgentSession["messages"];
  const accumulator = createFinalizedUsageAccumulator();

  assert.equal(accumulator.addMessages(messages), 2_051);
  assert.equal(
    accumulator.addMessages(structuredClone(messages)),
    0,
    "a cloned authoritative snapshot must not recharge old turns",
  );
  assert.equal(accumulator.usage.turns, 2_051);
  assert.equal(accumulator.usage.output, 2_051);
  assert.equal(accumulator.usage.cost, 2_051);

  const prefix = "x".repeat(70 * 1_024);
  const large = ["first", "second"].map((suffix) => ({
    ...structuredClone(base),
    timestamp: 99_999,
    content: [{ type: "text" as const, text: `${prefix}${suffix}` }],
  })) as AgentSession["messages"];
  assert.equal(accumulator.addMessages(large), 2);
  assert.equal(accumulator.usage.turns, 2_053);
});

test("finalized usage marks missing and non-finite output incomplete", () => {
  const accumulator = createFinalizedUsageAccumulator();
  const message = parallelToolMessages()[1]!;
  const missing = {
    ...message,
    usage: { ...zeroUsage, output: undefined },
  } as unknown as AgentSession["messages"][number];
  assert.equal(accumulator.add(missing), true);
  assert.equal(accumulator.usage.output, 0);
  assert.equal(accumulator.usage.outputComplete, false);

  const nonFinite = {
    ...message,
    timestamp: 953,
    usage: { ...zeroUsage, output: Number.NaN },
  } as AgentSession["messages"][number];
  assert.equal(accumulator.add(nonFinite), true);
  assert.equal(accumulator.usage.outputComplete, false);
});

test("completed parallel tool calls pair lifecycle timings with calls and results", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    1_000,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-b",
      toolName: "second",
      args: { value: 2 },
    },
    1_002,
  );
  // Parallel calls can finish in a different order than their result messages.
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-b",
      toolName: "second",
      result: { content: [{ type: "text", text: "second result" }] },
      isError: false,
    },
    1_012,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-a",
      toolName: "first",
      result: { content: [{ type: "text", text: "first result" }] },
      isError: false,
    },
    1_030,
  );

  const transcript = transcriptFromMessages(parallelToolMessages(), timings);
  const toolEntries = transcript.filter((entry) => entry.role === "tool");
  const resultEntries = transcript.filter(
    (entry) => entry.role === "toolResult",
  );

  for (const entries of [toolEntries, resultEntries]) {
    assert.deepEqual(
      entries.map(({ toolCallId, startedAt, finishedAt, durationMs }) => ({
        toolCallId,
        startedAt,
        finishedAt,
        durationMs,
      })),
      [
        {
          toolCallId: "call-a",
          startedAt: 1_000,
          finishedAt: 1_030,
          durationMs: 30,
        },
        {
          toolCallId: "call-b",
          startedAt: 1_002,
          finishedAt: 1_012,
          durationMs: 10,
        },
      ],
    );
  }
});

test("in-flight aborted tool calls retain start timing without completion", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    2_000,
  );

  const transcript = transcriptFromMessages(
    parallelToolMessages().slice(0, 2),
    timings,
  );
  const first = transcript.find((entry) => entry.toolCallId === "call-a");

  assert.equal(first?.startedAt, 2_000);
  assert.equal(first?.finishedAt, undefined);
  assert.equal(first?.durationMs, undefined);
  assert.equal(
    transcript.some((entry) => entry.role === "toolResult"),
    false,
  );
});

test("latestThinking returns the most recent non-empty reasoning excerpt", () => {
  const thinking = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "thinking" as const, thinking: text }],
  });
  const textMessage = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
  });
  const messages = [
    textMessage("first answer"),
    thinking("first reasoning"),
    thinking("  "),
    thinking("second reasoning"),
    textMessage("final answer"),
  ] as unknown as AgentSession["messages"];

  const minimal = (m: unknown): Parameters<typeof latestThinking>[0] =>
    m as Parameters<typeof latestThinking>[0];

  assert.equal(latestThinking(minimal(messages)), "second reasoning");
  assert.equal(
    latestThinking(minimal([textMessage("no thinking")])),
    undefined,
  );
  assert.equal(latestThinking(minimal([])), undefined);

  const longReasoning = "r".repeat(10_000);
  const capped = latestThinking(minimal([thinking(longReasoning)]), 4_096);
  assert.ok(capped);
  assert.equal(capped.length <= 4_096, true);
  assert.ok(capped?.startsWith("rrrr"));
});

test("runAgent recovers once when the model returns plain JSON instead of structured output", async () => {
  const { outcome, prompts, turnStarts, activities, progressUsage } =
    await runMissingStructuredOutputRecovery();

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.structured, { value: "recovered" });
  assert.equal(prompts.length, 2);
  assert.equal(
    prompts[0]?.match(/workflow already owns decomposition and coordination/gi)
      ?.length,
    1,
    "shared child guidance is applied exactly once",
  );
  assert.match(
    prompts[0] ?? "",
    /Assigned workflow step:\nreturn structured output/,
  );
  assert.equal(turnStarts, 3);
  assert.ok(activities >= 6, "setup and prompt boundaries emit activity");
  assert.equal(outcome.usage.turns, 2);
  assert.equal(
    progressUsage[0]?.turns,
    1,
    "late accumulator mutation cannot alter published progress after finalization",
  );
  assert.match(prompts[1], /call the required `structured_output` tool/i);
});

test("runAgent bounds missing structured output recovery to one turn", async () => {
  const { outcome, prompts } = await runMissingStructuredOutputRecovery(false);

  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /without calling structured_output/i);
  assert.equal(prompts.length, 2);
});

test("runAgent omits structured output after a provider error", async () => {
  const outcome = await runAfterStructuredOutput("error");

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "provider failed");
  assert.equal("structured" in outcome, false);
});

test("runAgent omits structured output after an abort", async () => {
  const outcome = await runAfterStructuredOutput("abort");

  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, true);
  assert.equal("structured" in outcome, false);
});

test("runAgent progress exposes live tool activity and completion counts", async () => {
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager,
  });
  const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const progress: AgentProgress[] = [];
  let listener: AgentSessionEventListener | undefined;

  const outcome = await runAgent({
    prompt: "inspect",
    cwd: process.cwd(),
    loader,
    settingsManager,
    modelRegistry,
    onProgress: (next) => progress.push(next),
    createSession: async () => {
      const messages: AgentSession["messages"] = [];
      const session = {
        messages,
        model: undefined,
        bindExtensions: async () => {},
        getAllTools: () => [],
        getToolDefinition: () => undefined,
        subscribe: (next: AgentSessionEventListener) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        getContextUsage: () => undefined,
        prompt: async () => {
          listener?.({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "npm test" },
          });
          listener?.({
            type: "tool_execution_update",
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "npm test" },
            partialResult: { content: [{ type: "text", text: "running" }] },
          });
          listener?.({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "bash",
            result: { content: [{ type: "text", text: "passed" }] },
            isError: false,
          });
          const message = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "done" }],
            api: "openai-responses" as const,
            provider: "fixture",
            model: "fixture",
            usage: zeroUsage,
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
          messages.push(message);
          listener?.({ type: "message_start", message });
          listener?.({ type: "message_end", message });
        },
        abort: async () => {},
        extensionRunner: { hasHandlers: () => false, emit: async () => {} },
        dispose: () => {},
      } as unknown as AgentSession;
      return { session };
    },
  });

  assert.equal(outcome.ok, true);
  assert.ok(
    progress.some(
      (entry) =>
        entry.currentTools[0]?.name === "bash" &&
        entry.currentTools[0]?.argsPreview?.includes("npm test"),
    ),
  );
  assert.ok(
    progress.some((entry) =>
      entry.currentTools[0]?.outputPreview?.includes("running"),
    ),
  );
  assert.equal(progress.at(-1)?.currentTools.length, 0);
  assert.equal(progress.at(-1)?.completedOperations, 1);
  // Transcript is snapshot-cached: tool events reuse one array reference and
  // only message_end refreshes it, so progress does not rebuild per event.
  const toolSnapshots = progress.filter(
    (entry) => entry.currentTools.length > 0,
  );
  assert.ok(toolSnapshots.length > 0);
  for (const snapshot of toolSnapshots) {
    assert.equal(snapshot.transcript, toolSnapshots[0]!.transcript);
  }
  const finalTranscript = progress.at(-1)?.transcript;
  assert.equal(finalTranscript?.length, 1);
  assert.equal(finalTranscript?.[0]?.role, "assistant");
  assert.notEqual(finalTranscript, toolSnapshots[0]!.transcript);
});

test("runAgent upgrades orderly teardown when cancellation races it", async () => {
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager,
  });
  const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const cancellation = new AbortController();
  let listener: AgentSessionEventListener | undefined;
  let releaseShutdown: (() => void) | undefined;
  let markShutdownStarted: (() => void) | undefined;
  const shutdownStarted = new Promise<void>((resolve) => {
    markShutdownStarted = resolve;
  });
  let aborts = 0;

  const running = runAgent({
    prompt: "finish",
    cwd: process.cwd(),
    loader,
    settingsManager,
    modelRegistry,
    signal: cancellation.signal,
    createSession: async () => {
      const messages: AgentSession["messages"] = [];
      const session = {
        messages,
        model: undefined,
        bindExtensions: async () => {},
        getAllTools: () => [],
        getToolDefinition: () => undefined,
        subscribe: (next: AgentSessionEventListener) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        getContextUsage: () => undefined,
        prompt: async () => {
          const message = {
            ...structuredClone(parallelToolMessages()[1]!),
            content: [{ type: "text" as const, text: "done" }],
            stopReason: "stop" as const,
          };
          messages.push(message);
          listener?.({ type: "message_end", message });
        },
        abort: async () => {
          aborts++;
        },
        extensionRunner: {
          hasHandlers: () => true,
          emit: async () => {
            markShutdownStarted?.();
            await new Promise<void>((resolve) => {
              releaseShutdown = resolve;
            });
          },
        },
        dispose: () => {},
      } as unknown as AgentSession;
      return { session };
    },
  });

  await shutdownStarted;
  cancellation.abort(new Error("late cancellation"));
  assert.equal(aborts, 1, "teardown is upgraded before orderly hooks finish");
  releaseShutdown?.();

  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.error, "late cancellation");
});

test("first-response watchdog awaits retained teardown before rejecting", async () => {
  let releaseTeardown: (() => void) | undefined;
  const teardown = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  let releaseOperation: (() => void) | undefined;
  const operation = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  let teardownStarted = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      teardownStarted = true;
      await teardown;
    },
    { timeoutMs: 10, model: "fixture-model" },
  );

  const waiting = watchdog.waitFor(operation);
  let rejected = false;
  void waiting.catch(() => {
    rejected = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(teardownStarted, true);
  assert.equal(rejected, false);
  releaseOperation?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rejected, false);

  releaseTeardown?.();
  await assert.rejects(
    waiting,
    /no assistant response event for fixture-model within 10 ms.*stalled/i,
  );
});

test("first assistant response disarms the watchdog without limiting the run", async () => {
  const watchdog = createFirstResponseWatchdog(
    async () => {
      throw new Error("watchdog should have been disarmed");
    },
    { timeoutMs: 10 },
  );
  watchdog.markResponse();

  const result = await watchdog.waitFor(
    new Promise<string>((resolve) => setTimeout(() => resolve("done"), 20)),
  );
  assert.equal(result, "done");
});

test("workflow children guard structured, normal, and dynamically registered tools", async () => {
  const structuredResult = {
    content: [{ type: "text" as const, text: "recorded" }],
    details: { value: "fixture" },
    terminate: true,
  };
  const structured = {
    name: "structured_output",
    label: "Structured Output",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      return structuredResult;
    },
  } satisfies ToolDefinition;
  const definitions = new Map<string, ToolDefinition>([
    [structured.name, structured],
  ]);
  let listener: AgentSessionEventListener | undefined;
  const session = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
    subscribe(next: AgentSessionEventListener) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };

  const unsubscribe = guardWorkflowChildTools(session, 10);
  assert.equal(await structured.execute(), structuredResult);

  let dynamicSignal: AbortSignal | undefined;
  const dynamic = {
    name: "dynamic_fixture",
    label: "Dynamic Fixture",
    description: "fixture",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      signal?: AbortSignal,
    ) {
      dynamicSignal = signal;
      return new Promise<never>(() => {});
    },
  } satisfies ToolDefinition;
  const originalDynamicExecute = dynamic.execute;
  definitions.set(dynamic.name, dynamic);
  listener?.({ type: "agent_start" });
  assert.notEqual(dynamic.execute, originalDynamicExecute);

  await assert.rejects(
    dynamic.execute("fixture", {}, undefined),
    /Tool call "dynamic_fixture" timed out after 10 ms\./,
  );
  assert.equal(dynamicSignal?.aborted, true);
  unsubscribe();
});

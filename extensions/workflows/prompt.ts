import type { WorkflowMeta } from "./meta.ts";
import {
  countStates,
  formatElapsed,
  resultJson,
  shortenHome,
  type WorkflowDetails,
} from "./model.ts";

/** Model-facing schema descriptions for workflow source, arguments, and background mode. */
export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  preview:
    "Free-form workflow preview for the user. Explain the outcome, ordered phases, scoped parallel lanes, dependencies, model/effort choices, shared limits, expected duration, and intentionally excluded work.",
  script:
    "JavaScript workflow script to save as a draft. May start with `export const meta = {...}`, then use phase(), agent(), parallel(), args, and a final `return`. Raw scripts never execute on submission.",
  args: "Optional JSON string saved with the draft and exposed to the script as `args` (parsed when valid JSON, otherwise passed through as the raw string).",
  background:
    "Save the draft for background execution. When approved and executed, the tool returns a run id immediately and sends a follow-up on completion. Defaults to false.",
  draftId:
    "Immutable workflow draft ID to execute after the user has reviewed it and responded. Script, args, and background cannot be overridden during execution.",
  runId: "Exact active workflow run ID to cancel.",
};

/** Defines the workflow DSL, constraints, reliability guidance, and model-authored task examples. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "The workflow tool is only to be called when the user says 'ultracode' or specifically requests a workflow run.",
  "Prepare and execute a multi-agent workflow in two deterministic steps. First submit a free-form preview with the JavaScript orchestration script; this validates and saves an immutable draft but starts no agents. Only after the user reviews it and sends a newer response may you call the tool again with only the draftId to execute the saved script, args, and background setting.",
  "Use workflows when a task benefits from several isolated subagents with distinct ownership or phase dependencies. Independent drafts may execute concurrently in background, while the process-global capacity pool bounds aggregate fan-out.",
  "The script runs as an async function body with these primitives:",
  "• export const meta = { name, description, phases: [{ title, detail? }], limits? } — static metadata for the progress UI and optional run limits. Declare all phases up front. `limits` is a closed literal-only object: { concurrency?, workflow?: { wallMs?, idleMs? }, agent?: { wallMs?, idleMs? }, total?: { turns?, outputTokens?, costUsd? } }. Concurrency and durations are positive safe integers; turns/outputTokens are non-negative safe integers; costUsd is non-negative finite. Omitted budgets are unbounded.",
  "• phase(title) — mark the current phase at runtime (use titles from meta.phases).",
  "• await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? }) — run ONE subagent in an isolated context and wait for it. Always resolves to { ok, output, structured?, error? }. Check `ok` before using the result. When you pass a JSON `schema`, `structured` holds the validated object on success. `model`/`provider` override the session model; `effort` sets the thinking level (off|minimal|low|medium|high|xhigh|max). Children receive normal built-ins and trust-appropriate extensions, settings, skills, and AGENTS.md context, but cannot recursively orchestrate, manage task lists, or ask the user.",
  "• await parallel([() => agent(...), () => agent(...)], { concurrency? }) — run zero-argument agent thunks concurrently and return results in order. Omitted concurrency defaults to min(4, the run cap); explicit concurrency may use the resolved run cap. A process-global host pool remains authoritative.",
  "• args — the parsed value of the `args` tool parameter (or undefined).",
  "Workflow JavaScript runs in a restricted, killable child with no imports, eval, timers, filesystem, network, or process APIs. A run may make at most 32 agent calls. Requested concurrency is clamped to the host hard capacity (min(16, max(1, availableParallelism - 2))); omission uses min(4, hard capacity). Optional metadata budgets bound workflow/agent wall and idle time plus total turns, output tokens, and cost. Configured output/cost budgets fail closed when finalized provider usage is missing or non-finite; finite zero is known usage. Each agent must receive its first assistant response event within 45 seconds so silent provider requests fail clearly. Each individual child tool call times out independently after 3 minutes, becomes an error tool result, and leaves the agent loop free to recover. Use map/filter/if/await to orchestrate, prefer quoted strings for static prompts, reserve template literals for interpolation, and `return` a JSON-serializable aggregate.",
  "Pass a `schema` to agent() whenever a later step branches on the result, so you get typed fields instead of prose. There is no resume: a failed run is simply re-run. Artifacts are saved under ~/.pi/agent/workflows/<runId>/ for inspection.",
  "Example script for the preparation call:",
  "export const meta = { name: 'reliability-review', description: 'Review modules for reliability risks, then report', phases: [{ title: 'Scan' }, { title: 'Report' }] }",
  "const FINDINGS = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' } }, required: ['issues', 'ok'] }",
  "phase('Scan')",
  "const scans = await parallel(args.files.map((f) => () => agent(`Review ${f} for correctness and reliability risks.`, { label: `scan:${f}`, phase: 'Scan', schema: FINDINGS })))",
  "const findings = scans.filter((r) => r.ok).map((r) => r.structured)",
  "phase('Report')",
  "const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, { label: 'report', phase: 'Report' })",
  "return { findings, report: report.ok ? report.output : report.error }",
  "Submit that script with a preview to create a draft. After preparation, surface the review instructions and preview instead of reducing the result to a bare draft ID. After a newer user response explicitly approves it, execute with { draftId }.",
].join("\n");

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Prepare an inspectable workflow draft, then execute it after user approval; orchestrate scoped isolated subagents with phase()/agent()/parallel() and optional background execution";

/** Guides the model toward proportional, non-overlapping workflow ownership. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Keep workflows proportional to the requested outcome. The workflow draft owns decomposition: use one agent for a naturally bounded outcome, or a few sequential fresh agents at meaningful completion boundaries for broader work. Use parallel branches only for independent bounded deliverables with distinct ownership, and avoid concurrent writes or repeated repository discovery.",
  "When preparing a workflow draft, emit the preview before the script in the workflow tool arguments and do not repeat the preview as separate assistant prose. Keep the immutable script compact so the preview appears immediately while source streams.",
  "Use quoted string literals for static agent prompts. Reserve template literals for interpolation; escape Markdown backticks inside template literals as `\\`` or omit the code-span delimiters.",
  "After a draft is prepared, show its preview and review instructions before requesting approval; never reduce the result to a bare draft ID.",
  "When implementation work shares files, sequence fresh writer agents instead of packing the whole change into one writer. Each writer should deliver one complete outcome with focused proof. Pass concise findings and relevant report or artifact paths forward instead of raw transcripts or mandatory rediscovery. When several writers contribute to one operator outcome, finish with one integration/proof agent that checks the complete result and fixes only integration defects.",
  "Use model/provider/effort intentionally. Prefer useful implementation and focused verification over reviewer swarms or exhaustive exploration.",
  "Independent approved drafts may run concurrently in background; the shared host pool bounds their aggregate concurrency.",
  "In workflow scripts, agent() never throws — always check `.ok` on its result before using `.output`/`.structured`.",
];

const WORKFLOW_CHILD_PERSPECTIVE = [
  "The workflow already owns decomposition and coordination. Complete the assigned outcome and its focused proof without creating another plan.",
  "Start from the concise handoff; consult referenced reports or artifacts when they are relevant to a decision or explicitly required.",
  "Reuse existing project patterns, avoid duplicating other agents, and do not expand into later roadmap work.",
  "Preserve unrelated work and report concise, decision-ready results.",
].join(" ");

/** Adds a shared scope boundary before the workflow-specific child assignment. */
export function buildWorkflowAgentPrompt(prompt: string) {
  return `${WORKFLOW_CHILD_PERSPECTIVE}\n\nAssigned workflow step:\n${prompt}`;
}

/** Builds the user-visible result for a prepared, non-executing workflow draft. */
export function buildWorkflowDraftMessage(options: {
  draftId: string;
  preview: string;
  meta: WorkflowMeta;
  artifactPath: string;
}) {
  const lines = [
    `Workflow draft ${options.meta.name ? `"${options.meta.name}"` : options.draftId} prepared — no agents started.`,
    `Draft: ${options.draftId}`,
    `Artifact: ${shortenHome(options.artifactPath)}`,
    "Review: press Ctrl+O to expand the tool result and inspect the exact immutable script.",
    "",
    "Preview:",
    options.preview,
  ];
  if (options.meta.phases.length > 0) {
    lines.push("", "Phases:");
    for (const phase of options.meta.phases) {
      lines.push(`- ${phase.title}${phase.detail ? ` — ${phase.detail}` : ""}`);
    }
  }
  lines.push(
    "",
    `Configured limits: ${options.meta.limits ? JSON.stringify(options.meta.limits) : "unbounded"}`,
    "Approve only after reviewing it; execution requires a newer, explicit user response.",
  );
  return lines.join("\n");
}

/** Instructs structured workflow children to terminate with exactly one structured_output call. */
export const STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION =
  "When your task is complete, do not answer with JSON or prose. Call the `structured_output` tool exactly once as your final action, with fields matching the required schema. Do not write any other text after it.";

/** One bounded recovery turn when a structured child settles without using its final tool. */
export const STRUCTURED_OUTPUT_RECOVERY_PROMPT =
  "Your previous response did not call the required `structured_output` tool. Do not continue researching or explain. Call `structured_output` now with your completed result, matching its schema exactly.";

/** Describes the terminating structured_output tool and its final-action contract. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.";

/** Builds the workflow completion report returned to the parent model. */
export function buildWorkflowResultMessage(
  details: WorkflowDetails,
  runDir: string,
) {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ` +
      `${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""} ` +
      `across ${details.phases.length} phase(s) in ${elapsed}.`,
    `Run dir: ${shortenHome(runDir)}`,
  ];
  if (details.error) lines.push(`Error: ${details.error}`);
  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const status =
        agent.state === "done"
          ? "ok"
          : agent.state === "error"
            ? "FAILED"
            : agent.state;
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${status}` +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  if (details.result !== undefined)
    lines.push("", "Result:", resultJson(details.result));
  return lines.join("\n");
}

/** Builds the follow-up user message that delivers a settled background workflow to the parent model. */
export function buildBackgroundWorkflowFollowUp(options: {
  runId: string;
  status: WorkflowDetails["status"];
  result: string;
}) {
  return `[Background workflow ${options.runId} ${options.status}]\n\n${options.result}`;
}

/** Builds the background-launch result and tells the parent model where progress and artifacts appear. */
export function buildBackgroundWorkflowLaunchResult(options: {
  runId: string;
  name?: string;
  runDir: string;
}) {
  return [
    `Workflow ${options.name ? `"${options.name}"` : options.runId} launched in background (run ${options.runId}).`,
    `Artifacts: ${shortenHome(options.runDir)}`,
    "You'll receive a follow-up message when it finishes; /workflows shows progress.",
  ].join("\n");
}

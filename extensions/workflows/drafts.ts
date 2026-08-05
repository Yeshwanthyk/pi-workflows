import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DRAFT_ID_PATTERN = /^draft_[a-f0-9]{12}$/;

export interface WorkflowDraft {
  version: 1;
  draftId: string;
  createdAt: number;
  sessionId: string;
  cwd: string;
  preparedAtUserInput: number;
  preview: string;
  script: string;
  args?: string;
  background: boolean;
}

export interface CreateWorkflowDraftInput {
  sessionId: string;
  cwd: string;
  preparedAtUserInput: number;
  preview: string;
  script: string;
  args?: string;
  background?: boolean;
}

function draftsDir(workflowsDir: string) {
  return path.join(workflowsDir, "drafts");
}

function draftDir(workflowsDir: string, draftId: string) {
  if (!DRAFT_ID_PATTERN.test(draftId)) {
    throw new Error(`Invalid workflow draft ID "${draftId}"`);
  }
  return path.join(draftsDir(workflowsDir), draftId);
}

function validateDraft(value: unknown, expectedDraftId: string): WorkflowDraft {
  if (!value || typeof value !== "object") {
    throw new Error("Workflow draft is not an object");
  }
  const draft = value as Record<string, unknown>;
  if (draft.version !== 1)
    throw new Error("Unsupported workflow draft version");
  if (draft.draftId !== expectedDraftId) {
    throw new Error("Workflow draft ID does not match its artifact path");
  }
  if (
    typeof draft.createdAt !== "number" ||
    !Number.isFinite(draft.createdAt)
  ) {
    throw new Error("Workflow draft has an invalid creation time");
  }
  for (const field of ["sessionId", "cwd", "preview", "script"] as const) {
    if (typeof draft[field] !== "string") {
      throw new Error(`Workflow draft has an invalid ${field}`);
    }
  }
  if (typeof draft.preview !== "string" || !draft.preview.trim()) {
    throw new Error("Workflow draft preview is empty");
  }
  if (draft.args !== undefined && typeof draft.args !== "string") {
    throw new Error("Workflow draft has invalid args");
  }
  if (
    typeof draft.preparedAtUserInput !== "number" ||
    !Number.isSafeInteger(draft.preparedAtUserInput) ||
    draft.preparedAtUserInput < 0
  ) {
    throw new Error("Workflow draft has an invalid approval boundary");
  }
  if (typeof draft.background !== "boolean") {
    throw new Error("Workflow draft has an invalid background setting");
  }
  return draft as unknown as WorkflowDraft;
}

/** Persist a new immutable workflow draft in its own exclusive directory. */
export function createWorkflowDraft(
  workflowsDir: string,
  input: CreateWorkflowDraftInput,
): WorkflowDraft {
  if (
    !Number.isSafeInteger(input.preparedAtUserInput) ||
    input.preparedAtUserInput < 0
  ) {
    throw new Error("Workflow draft requires a valid user-input boundary");
  }
  if (!input.preview.trim())
    throw new Error("Workflow preview cannot be empty");
  fs.mkdirSync(draftsDir(workflowsDir), { recursive: true, mode: 0o700 });
  const draftId = `draft_${randomBytes(6).toString("hex")}`;
  const directory = draftDir(workflowsDir, draftId);
  fs.mkdirSync(directory, { mode: 0o700 });
  const draft: WorkflowDraft = {
    version: 1,
    draftId,
    createdAt: Date.now(),
    sessionId: input.sessionId,
    cwd: input.cwd,
    preparedAtUserInput: input.preparedAtUserInput,
    preview: input.preview,
    script: input.script,
    ...(input.args !== undefined ? { args: input.args } : {}),
    background: input.background ?? false,
  };
  try {
    fs.writeFileSync(
      path.join(directory, "draft.json"),
      JSON.stringify(draft, null, 2),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze(draft);
}

/** Load and strictly validate the inspectable artifact copy. */
export function loadWorkflowDraft(
  workflowsDir: string,
  draftId: string,
): WorkflowDraft {
  const file = path.join(draftDir(workflowsDir, draftId), "draft.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not load workflow draft ${draftId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateDraft(parsed, draftId);
}

/** Reject any validly shaped artifact that differs from the in-memory authority. */
export function assertWorkflowDraftArtifactMatches(
  authoritative: WorkflowDraft,
  artifact: WorkflowDraft,
) {
  if (JSON.stringify(authoritative) !== JSON.stringify(artifact)) {
    throw new Error("Workflow draft artifact changed after preparation");
  }
}

/** Enforce a later human-input boundary and the captured project identity. */
export function assertWorkflowDraftApproved(
  draft: WorkflowDraft,
  context: {
    sessionId: string;
    cwd: string;
    userInput: number;
  },
) {
  if (context.sessionId !== draft.sessionId) {
    throw new Error("Workflow draft belongs to a different session");
  }
  if (context.cwd !== draft.cwd) {
    throw new Error("Workflow draft belongs to a different working directory");
  }
  if (context.userInput <= draft.preparedAtUserInput) {
    throw new Error(
      "Workflow draft requires a newer user response before execution",
    );
  }
}

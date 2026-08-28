import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { prepareWorkflowScript, type WorkflowMeta } from "./meta.ts";

export const SAVED_WORKFLOW_MAX_BYTES = 512 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SavedWorkflowScope = "project-pi" | "project-agents" | "agent";

export interface SavedWorkflow {
  name: string;
  path: string;
  scope: SavedWorkflowScope;
  source: string;
  sha256: string;
  meta: WorkflowMeta;
}

export interface SavedWorkflowProvenance {
  kind: "saved";
  name: string;
  path: string;
  scope: SavedWorkflowScope;
  sha256: string;
}

export function workflowSourceSha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function normalizedName(value: string): string {
  const trimmed = value.trim();
  const name = trimmed.endsWith(".js") ? trimmed.slice(0, -3) : trimmed;
  if (!SAFE_NAME.test(name) || name === "." || name === "..") {
    throw new Error(
      `Invalid saved workflow name "${value}" (use letters, numbers, dot, dash, or underscore)`,
    );
  }
  return name;
}

function roots(cwd: string, agentDir: string) {
  return [
    { scope: "project-pi" as const, root: path.join(cwd, ".pi", "workflows") },
    {
      scope: "project-agents" as const,
      root: path.join(cwd, ".agents", "workflows"),
    },
    { scope: "agent" as const, root: path.join(agentDir, "workflows") },
  ];
}

function loadFile(
  name: string,
  file: string,
  scope: SavedWorkflowScope,
): SavedWorkflow | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  if (stat.size > SAVED_WORKFLOW_MAX_BYTES) {
    throw new Error(
      `Saved workflow "${name}" exceeds ${SAVED_WORKFLOW_MAX_BYTES} bytes`,
    );
  }
  const source = fs.readFileSync(file, "utf8");
  const prepared = prepareWorkflowScript(source);
  return {
    name,
    path: file,
    scope,
    source,
    sha256: workflowSourceSha256(source),
    meta: prepared.meta,
  };
}

/** Discover validated workflows in precedence order; project definitions shadow global ones. */
export function listSavedWorkflows(
  cwd: string,
  agentDir: string,
): SavedWorkflow[] {
  const workflows = new Map<string, SavedWorkflow>();
  for (const candidate of roots(cwd, agentDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(candidate.root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".js") || entry.isSymbolicLink()) continue;
      const rawName = entry.name.slice(0, -3);
      if (!SAFE_NAME.test(rawName) || workflows.has(rawName)) continue;
      try {
        const loaded = loadFile(
          rawName,
          path.join(candidate.root, entry.name),
          candidate.scope,
        );
        if (loaded) workflows.set(rawName, loaded);
      } catch {
        // One malformed saved definition must not hide valid siblings.
      }
    }
  }
  return [...workflows.values()];
}

export function loadSavedWorkflow(
  nameValue: string,
  cwd: string,
  agentDir: string,
): SavedWorkflow {
  const name = normalizedName(nameValue);
  for (const candidate of roots(cwd, agentDir)) {
    const workflow = loadFile(
      name,
      path.join(candidate.root, `${name}.js`),
      candidate.scope,
    );
    if (workflow) return workflow;
  }
  throw new Error(`Saved workflow "${name}" was not found`);
}

export function savedWorkflowProvenance(
  workflow: SavedWorkflow,
): SavedWorkflowProvenance {
  return {
    kind: "saved",
    name: workflow.name,
    path: workflow.path,
    scope: workflow.scope,
    sha256: workflow.sha256,
  };
}

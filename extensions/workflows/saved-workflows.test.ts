import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  listSavedWorkflows,
  loadSavedWorkflow,
  savedWorkflowProvenance,
  workflowSourceSha256,
} from "./saved-workflows.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-saved-workflows-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  return { root, cwd, agentDir };
}

function save(file: string, source: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source, "utf8");
}

const source = (name: string) =>
  `export const meta = { name: "${name}", phases: [{ title: "Run" }] };\nreturn "${name}";`;

test("saved workflow discovery applies project precedence and static parsing", () => {
  const { root, cwd, agentDir } = fixture();
  try {
    save(join(agentDir, "workflows", "audit.js"), source("global"));
    save(join(cwd, ".agents", "workflows", "audit.js"), source("agents"));
    save(join(cwd, ".pi", "workflows", "audit.js"), source("project"));
    save(join(cwd, ".pi", "workflows", "release.js"), source("release"));

    const workflows = listSavedWorkflows(cwd, agentDir);
    assert.deepEqual(
      workflows.map((workflow) => [workflow.name, workflow.scope]),
      [
        ["audit", "project-pi"],
        ["release", "project-pi"],
      ],
    );
    const audit = loadSavedWorkflow("audit.js", cwd, agentDir);
    assert.equal(audit.meta.name, "project");
    assert.equal(audit.sha256, workflowSourceSha256(audit.source));
    assert.deepEqual(savedWorkflowProvenance(audit), {
      kind: "saved",
      name: "audit",
      path: audit.path,
      scope: "project-pi",
      sha256: audit.sha256,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved workflow discovery ignores symlinks and rejects unsafe names", () => {
  const { root, cwd, agentDir } = fixture();
  try {
    const directory = join(cwd, ".pi", "workflows");
    save(join(directory, "real.js"), source("real"));
    symlinkSync(join(directory, "real.js"), join(directory, "linked.js"));

    assert.deepEqual(
      listSavedWorkflows(cwd, agentDir).map((workflow) => workflow.name),
      ["real"],
    );
    assert.throws(
      () => loadSavedWorkflow("../real", cwd, agentDir),
      /Invalid saved workflow name/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved workflows reject oversized or dynamically invalid definitions", () => {
  const { root, cwd, agentDir } = fixture();
  try {
    const directory = join(cwd, ".pi", "workflows");
    save(join(directory, "oversized.js"), "x".repeat(512 * 1024 + 1));
    assert.deepEqual(listSavedWorkflows(cwd, agentDir), []);
    assert.throws(
      () => loadSavedWorkflow("oversized", cwd, agentDir),
      /exceeds 524288 bytes/,
    );

    rmSync(join(directory, "oversized.js"));
    save(
      join(directory, "dynamic.js"),
      "export const meta = { name: getName() }; return true;",
    );
    assert.deepEqual(listSavedWorkflows(cwd, agentDir), []);
    assert.throws(
      () => loadSavedWorkflow("dynamic", cwd, agentDir),
      /static literals|only static|must contain/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

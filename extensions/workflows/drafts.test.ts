import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
  assertWorkflowDraftApproved,
  assertWorkflowDraftArtifactMatches,
  createWorkflowDraft,
  loadWorkflowDraft,
} from "./drafts.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-draft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("workflow drafts round-trip exact execution inputs", (t) => {
  const root = fixture(t);
  const created = createWorkflowDraft(root, {
    sessionId: "session-a",
    cwd: "/project",
    preparedAtUserInput: 1,
    preview: "Parallel scan\nthen one writer",
    script: "const value = `exact\\nscript`;\nreturn value;",
    args: "{not-json}",
    background: true,
  });

  assert.equal(Object.isFrozen(created), true);
  assert.deepEqual(loadWorkflowDraft(root, created.draftId), created);
});

test("workflow draft loading fails closed on malformed or mismatched data", (t) => {
  const root = fixture(t);
  const created = createWorkflowDraft(root, {
    sessionId: "session-a",
    cwd: "/project",
    preparedAtUserInput: 1,
    preview: "One bounded task",
    script: "return 1",
  });
  const file = path.join(root, "drafts", created.draftId, "draft.json");

  fs.writeFileSync(file, "not json");
  assert.throws(
    () => loadWorkflowDraft(root, created.draftId),
    /Could not load workflow draft/,
  );

  fs.writeFileSync(
    file,
    JSON.stringify({ ...created, draftId: "draft_badbadbadbad" }),
  );
  assert.throws(
    () => loadWorkflowDraft(root, created.draftId),
    /does not match/,
  );
  assert.throws(
    () => loadWorkflowDraft(root, "../workflow.json"),
    /Invalid workflow draft ID/,
  );
});

test("workflow execution rejects a validly shaped modified artifact", (t) => {
  const root = fixture(t);
  const authoritative = createWorkflowDraft(root, {
    sessionId: "session-a",
    cwd: "/project",
    preparedAtUserInput: 1,
    preview: "One bounded task",
    script: "return 'approved'",
  });
  const file = path.join(root, "drafts", authoritative.draftId, "draft.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ ...authoritative, script: "return 'changed'" }),
  );
  const modified = loadWorkflowDraft(root, authoritative.draftId);

  assert.throws(
    () => assertWorkflowDraftArtifactMatches(authoritative, modified),
    /changed after preparation/,
  );
});

test("workflow drafts require later human input in the same project session", (t) => {
  const root = fixture(t);
  const draft = createWorkflowDraft(root, {
    sessionId: "session-a",
    cwd: "/project",
    preparedAtUserInput: 1,
    preview: "Two independent parallel lanes",
    script: "return 1",
  });

  assert.throws(
    () =>
      assertWorkflowDraftApproved(draft, {
        sessionId: "session-a",
        cwd: "/project",
        userInput: 1,
      }),
    /newer user response/,
  );
  assert.doesNotThrow(() =>
    assertWorkflowDraftApproved(draft, {
      sessionId: "session-a",
      cwd: "/project",
      userInput: 2,
    }),
  );
  assert.throws(
    () =>
      assertWorkflowDraftApproved(draft, {
        sessionId: "session-b",
        cwd: "/project",
        userInput: 2,
      }),
    /different session/,
  );
  assert.throws(
    () =>
      assertWorkflowDraftApproved(draft, {
        sessionId: "session-a",
        cwd: "/other",
        userInput: 2,
      }),
    /different working directory/,
  );
});

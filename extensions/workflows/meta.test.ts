import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractMeta,
  formatWorkflowScriptParseError,
  prepareWorkflowScript,
} from "./meta.ts";

test("metadata is decoded statically and removed from executable source", () => {
  const source = `export const meta = {
    name: "audit",
    description: "safe",
    phases: [{ title: "Scan", detail: "files" }],
  };
  return { ok: true };`;
  const prepared = prepareWorkflowScript(source);
  assert.deepEqual(prepared.meta, {
    name: "audit",
    description: "safe",
    phases: [{ title: "Scan", detail: "files" }],
  });
  assert.doesNotMatch(prepared.source, /name:\s*"audit"/);
  assert.equal(prepared.source.split("\n").length, source.split("\n").length);
});

test("metadata limits use a closed static schema without changing old metadata", () => {
  const prepared = prepareWorkflowScript(`export const meta = {
    name: "bounded",
    legacyUnknown: "ignored",
    limits: {
      concurrency: 10,
      workflow: { wallMs: 1000, idleMs: 500 },
      agent: { wallMs: 400, idleMs: 200 },
      total: { turns: 8, outputTokens: 9000, costUsd: 2.5 },
    },
  }; return true;`);
  assert.deepEqual(prepared.meta, {
    name: "bounded",
    phases: [],
    limits: {
      concurrency: 10,
      workflow: { wallMs: 1000, idleMs: 500 },
      agent: { wallMs: 400, idleMs: 200 },
      total: { turns: 8, outputTokens: 9000, costUsd: 2.5 },
    },
  });

  for (const limits of [
    `{ concurrency: 0 }`,
    `{ concurrency: 1.5 }`,
    `{ workflow: { wallMs: 0 } }`,
    `{ agent: { idleMs: 0 / 0 } }`,
    `{ total: { costUsd: 1 / 0 } }`,
    `{ surprise: 1 }`,
  ]) {
    assert.throws(() =>
      prepareWorkflowScript(`export const meta = { limits: ${limits} };`),
    );
  }
});

test("export-like text in strings, comments, regexes, and templates is untouched", () => {
  const source = `
    const string = "export default notSyntax";
    const template = \`export const meta = \${string}\`;
    const regex = /export\\s+default/;
    // export const fake = 1
    return { string, template, matches: regex.test(string) };
  `;
  const prepared = prepareWorkflowScript(source);
  assert.equal(prepared.source, source);
  assert.deepEqual(prepared.meta, { phases: [] });
});

test("parse errors identify the source line and likely template-literal fix", () => {
  const source = [
    "phase('Write')",
    "const result = await agent(`Update the `LOG.md` file.`)",
    "return result",
  ].join("\n");

  let parseError: unknown;
  try {
    prepareWorkflowScript(source);
  } catch (error) {
    parseError = error;
  }

  const message = formatWorkflowScriptParseError(source, parseError);
  assert.match(message, /Workflow script failed to parse/);
  assert.match(message, /2 \| const result/);
  assert.match(message, /\^/);
  assert.match(message, /unescaped backtick/i);
  assert.match(message, /quoted string/i);
});

test("executable and unsupported metadata fail closed", () => {
  assert.throws(
    () =>
      prepareWorkflowScript(
        `export const meta = { name: (() => "executed")(), phases: [] }; return 1;`,
      ),
    /only static literals/,
  );
  assert.throws(
    () => prepareWorkflowScript(`export default 1; return 1;`),
    /may only export/,
  );
  assert.deepEqual(
    extractMeta(`export const meta = { name: process.exit(), phases: [] }`),
    { phases: [] },
  );
});

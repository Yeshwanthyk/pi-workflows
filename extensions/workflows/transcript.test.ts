import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "./model.ts";
import {
  buildTranscriptLines,
  sanitizeText,
  type ThinkingThemeColor,
} from "./transcript.ts";

const theme = {
  fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[39m`,
  bg: (_color: string, text: string) => `\u001b[41m${text}\u001b[49m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  italic: (text: string) => `\u001b[3m${text}\u001b[23m`,
} as unknown as Theme;

function plain(lines: string[]): string {
  return lines.map(sanitizeText).join("\n");
}

test("sanitizeText removes terminal escapes and controls while expanding tabs", () => {
  assert.equal(
    sanitizeText("before\u001b[31m\t\u0007after\u001b[0m"),
    "before  after",
  );
});

test("buildTranscriptLines renders every transcript role and markdown shape", () => {
  const lines = buildTranscriptLines(
    [
      { role: "user", text: "question\twith ansi\u001b[2K" },
      {
        role: "assistant",
        text: "# Heading\n- first bullet\n```ts\nconst value = 1;\n```",
      },
      { role: "thinking", text: "internal reasoning", isError: false },
      { role: "tool", name: "read", text: '{"path":"file"}', durationMs: 1250 },
      {
        role: "toolResult",
        name: "read",
        text: "[artifact transcript truncated: older entries omitted]",
        isError: true,
      },
    ],
    48,
    theme,
    { thinkingColor: "thinkingHigh" as ThinkingThemeColor },
  );
  const output = plain(lines);

  assert.match(output, /USER/);
  assert.match(output, /question  with ansi/);
  assert.match(output, /Heading/);
  assert.match(output, /first bullet/);
  assert.match(output, /```ts/);
  assert.match(output, /\| const value = 1;/);
  assert.match(output, /THINKING/);
  assert.match(output, /read/);
  assert.match(
    output.replace(/\s+/g, " "),
    /artifact transcript truncated: older entries omitted/,
  );
  assert.ok(lines.some((line) => line.includes("\u001b[41m")));
});

test("buildTranscriptLines keeps every rendered row within the requested width", () => {
  const lines = buildTranscriptLines(
    [
      { role: "user", text: "a very long user message that must wrap safely" },
      {
        role: "assistant",
        text: "- a very long bullet that must wrap without exceeding the terminal",
      },
      {
        role: "toolResult",
        name: "very-long-tool-name",
        text: "x".repeat(400),
      },
    ],
    12,
    theme,
  );

  assert.ok(lines.length > 3);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 12, `${visibleWidth(line)} > 12: ${line}`);
  }
});

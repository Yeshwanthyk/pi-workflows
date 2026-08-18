import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme, TranscriptEntry } from "./model.ts";

const ANSI_PATTERN = new RegExp(
  String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);

export type ThinkingThemeColor =
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax";

export interface TranscriptRenderOptions {
  /** Keep the dashboard's thinking-level color without coupling the renderer to agent state. */
  thinkingColor?: ThinkingThemeColor;
}

/** Remove terminal escapes/control characters and use the dashboard's tab width. */
export function sanitizeText(text: string): string {
  return Array.from(text.replace(ANSI_PATTERN, "").replaceAll("\t", "  "))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(code <= 0x08 || (code >= 0x0b && code <= 0x1f) || code === 0x7f);
    })
    .join("");
}

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function wrap(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width));
}

function addWrapped(
  out: string[],
  text: string,
  width: number,
  prefix: string,
  color: Parameters<Theme["fg"]>[0],
  theme: Theme,
  style?: (value: string) => string,
) {
  const prefixWidth = visibleWidth(prefix);
  const parts = wrap(text, Math.max(1, width - prefixWidth));
  for (let index = 0; index < parts.length; index++) {
    const continuation = " ".repeat(
      Math.min(prefixWidth, Math.max(0, width - 1)),
    );
    const linePrefix = index === 0 ? prefix : continuation;
    const content = theme.fg(color, parts[index] ?? "");
    out.push(
      truncateToWidth(linePrefix + (style ? style(content) : content), width),
    );
  }
}

function renderUser(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
): void {
  const clean = sanitizeText(text).trim();
  if (!clean) return;
  const label = ` ${theme.fg("accent", "■")} ${theme.bold(theme.fg("accent", "USER"))}`;
  out.push(truncateToWidth(label, width));
  addWrapped(out, clean, width, "   ", "userMessageText", theme);
}

function renderThinking(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
  thinkingColor: ThinkingThemeColor | "dim" = "dim",
): void {
  const clean = sanitizeText(text).trim();
  if (!clean) return;
  const label = ` ${theme.fg(thinkingColor, "■")} ${theme.bold(theme.fg(thinkingColor, "THINKING"))}`;
  out.push(truncateToWidth(label, width));
  addWrapped(out, clean, width, "   ", "thinkingText", theme, (value) =>
    theme.italic(value),
  );
}

function renderAssistantText(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
): void {
  let inCodeBlock = false;
  for (const rawLine of sanitizeText(text).split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      out.push(truncateToWidth(theme.fg("dim", `   ${trimmed}`), width));
      continue;
    }

    if (inCodeBlock) {
      addWrapped(out, line, width, "   | ", "toolOutput", theme);
      continue;
    }

    const heading = trimmed.match(/^(?:#{1,6}\s+|\*\*(.+)\*\*\s*$)/);
    if (heading) {
      const content = heading[1] ?? trimmed.replace(/^#{1,6}\s+/, "");
      out.push(
        truncateToWidth(theme.fg("accent", theme.bold(`   ${content}`)), width),
      );
      continue;
    }

    const bullet = line.match(/^(\s*)([-*+] |\d+\. )(.*)$/);
    const prefix = bullet
      ? `${bullet[1]}${theme.fg("accent", bullet[2])}`
      : "   ";
    const body = bullet ? bullet[3] : line;
    addWrapped(out, body, width, prefix, "text", theme);
  }
}

function renderAssistant(
  theme: Theme,
  entry: TranscriptEntry,
  width: number,
  out: string[],
): void {
  const labelColor = entry.isError ? "error" : "success";
  const clean = sanitizeText(entry.text).trim();
  out.push(
    truncateToWidth(
      ` ${theme.fg(labelColor, "■")} ${theme.bold(theme.fg(labelColor, "ASSISTANT"))}`,
      width,
    ),
  );
  if (clean) {
    renderAssistantText(theme, entry.text, width, out);
  }
  if (entry.isError && !clean) {
    out.push(theme.fg("error", "   assistant error"));
  }
}

function singleLineBounded(text: string, maxLength = 160): string {
  const value = sanitizeText(text)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

function renderTool(
  theme: Theme,
  entry: TranscriptEntry,
  width: number,
  out: string[],
): void {
  const isCall = entry.role === "tool";
  const isError = entry.isError === true;
  const bgColor =
    isCall && !isError
      ? "toolPendingBg"
      : isError
        ? "toolErrorBg"
        : "toolSuccessBg";
  const bodyColor = isCall && !isError ? "dim" : isError ? "error" : "success";
  const roleLabel = isCall && !isError ? "TOOL" : isError ? "ERROR" : "RESULT";
  const name = `${roleLabel} ${sanitizeText(entry.name ?? "unknown")}`;
  const title =
    theme.bold(theme.fg("toolTitle", name)) +
    (entry.durationMs !== undefined
      ? theme.fg("dim", ` · ${(entry.durationMs / 1000).toFixed(1)}s`)
      : "");
  const bg = (value: string) => theme.bg(bgColor, value);
  out.push(truncateToWidth(bg(` ${title} `), width));

  const body = singleLineBounded(entry.text);
  if (!body) return;
  const innerWidth = Math.max(1, width - 2);
  for (const part of wrap(body, innerWidth)) {
    out.push(truncateToWidth(bg(` ${theme.fg(bodyColor, part)} `), width));
  }
}

/** Render normalized workflow transcript entries as width-bounded terminal lines. */
export function buildTranscriptLines(
  entries: readonly TranscriptEntry[],
  width: number,
  theme: Theme,
  options: TranscriptRenderOptions = {},
): string[] {
  const safe = safeWidth(width);
  const out: string[] = [];
  const thinkingColor = options.thinkingColor ?? "dim";

  for (const entry of entries) {
    const before = out.length;
    if (entry.role === "user") {
      renderUser(theme, entry.text, safe, out);
    } else if (entry.role === "assistant") {
      renderAssistant(theme, entry, safe, out);
    } else if (entry.role === "thinking") {
      renderThinking(theme, entry.text, safe, out, thinkingColor);
    } else {
      renderTool(theme, entry, safe, out);
    }
    if (out.length > before) out.push("");
  }

  while (out.at(-1) === "") out.pop();
  return out;
}

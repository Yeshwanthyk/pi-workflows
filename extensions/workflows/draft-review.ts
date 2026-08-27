import {
  highlightCode,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";
import type { WorkflowDraft } from "./drafts.ts";
import type { WorkflowMeta } from "./meta.ts";
import { shortenHome } from "./model.ts";

const MIN_SPLIT_WIDTH = 96;
const MIN_PANEL_HEIGHT = 8;

type Focus = "summary" | "source";
type ReviewAction = "close" | "approve";

function padToWidth(text: string, width: number) {
  const clipped = truncateToWidth(text, width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function panel(
  title: string,
  rows: string[],
  width: number,
  height: number,
  focused: boolean,
  theme: Theme,
) {
  const panelWidth = Math.max(4, width);
  const innerWidth = panelWidth - 2;
  const bodyHeight = Math.max(1, height - 2);
  const borderColor = focused ? "borderAccent" : "borderMuted";
  const titleText = ` ${title} `;
  const ruleLength = Math.max(0, innerWidth - visibleWidth(titleText) - 1);
  const lines = [
    theme.fg(borderColor, `╭─${titleText}${"─".repeat(ruleLength)}╮`),
  ];
  for (let index = 0; index < bodyHeight; index++) {
    const content = padToWidth(rows[index] ?? "", innerWidth);
    lines.push(
      `${theme.fg(borderColor, "│")}${content}${theme.fg(borderColor, "│")}`,
    );
  }
  lines.push(theme.fg(borderColor, `╰${"─".repeat(innerWidth)}╯`));
  return lines;
}

function detailRows(
  draft: WorkflowDraft,
  meta: WorkflowMeta,
  artifactPath: string,
  width: number,
  theme: Theme,
) {
  const rows: string[] = [];
  const addWrapped = (text: string, color: "text" | "muted" | "dim") => {
    for (const line of wrapTextWithAnsi(theme.fg(color, text), width)) {
      rows.push(line);
    }
  };

  rows.push(theme.fg("dim", "OUTCOME"));
  addWrapped(meta.description ?? draft.preview, "text");
  rows.push("");
  rows.push(theme.fg("dim", "PLAN"));
  if (meta.phases.length === 0) {
    rows.push(theme.fg("muted", "No declared phases"));
  } else {
    for (const [index, phase] of meta.phases.entries()) {
      const prefix = theme.fg("accent", `${index + 1}`);
      rows.push(`${prefix}  ${theme.bold(phase.title)}`);
      if (phase.detail) addWrapped(`   ${phase.detail}`, "muted");
    }
  }
  rows.push("");
  rows.push(theme.fg("dim", "REVIEW"));
  rows.push(`${theme.fg("success", "●")} immutable draft`);
  rows.push(`${theme.fg("success", "●")} no agents started`);
  rows.push(
    `${theme.fg("success", "●")} ${draft.background ? "background execution" : "blocking execution"}`,
  );
  rows.push(
    `${theme.fg("success", "●")} ${meta.limits ? "limits configured" : "no configured limits"}`,
  );
  if (draft.args !== undefined) {
    rows.push(`${theme.fg("success", "●")} arguments attached`);
  }
  rows.push("");
  rows.push(theme.fg("dim", "ARTIFACT"));
  addWrapped(shortenHome(artifactPath), "muted");
  rows.push("");
  rows.push(theme.fg("dim", "DRAFT"));
  rows.push(theme.fg("muted", draft.draftId));
  return rows;
}

function sourceRows(draft: WorkflowDraft, theme: Theme) {
  const highlighted = highlightCode(draft.script, "javascript");
  const numberWidth = String(Math.max(1, highlighted.length)).length;
  return highlighted.map(
    (line, index) =>
      `${theme.fg("dim", String(index + 1).padStart(numberWidth, " "))} ${theme.fg("borderMuted", "│")} ${line}`,
  );
}

/** Full-screen, source-split review for one authoritative pending draft. */
export class WorkflowDraftReview {
  private focus: Focus = "summary";
  private summaryScroll = 0;
  private sourceScroll = 0;
  private summaryRows = 0;
  private sourceRows = 0;
  private viewportSize = 1;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly draft: WorkflowDraft;
  private readonly meta: WorkflowMeta;
  private readonly artifactPath: string;
  private readonly done: (action: ReviewAction) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    draft: WorkflowDraft,
    meta: WorkflowMeta,
    artifactPath: string,
    done: (action: ReviewAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.draft = draft;
    this.meta = meta;
    this.artifactPath = artifactPath;
    this.done = done;
  }

  handleInput(data: string) {
    const cancel = this.keybindings.matches(data, "tui.select.cancel");
    const left =
      data === "h" || this.keybindings.matches(data, "tui.editor.cursorLeft");
    const right =
      data === "l" || this.keybindings.matches(data, "tui.editor.cursorRight");
    const up = data === "k" || this.keybindings.matches(data, "tui.select.up");
    const down =
      data === "j" || this.keybindings.matches(data, "tui.select.down");
    const pageUp =
      matchesKey(data, Key.ctrl("u")) ||
      this.keybindings.matches(data, "tui.select.pageUp");
    const pageDown =
      matchesKey(data, Key.ctrl("d")) ||
      this.keybindings.matches(data, "tui.select.pageDown");

    if (cancel) {
      this.done("close");
      return;
    }
    if (data === "a") {
      this.done("approve");
      return;
    }
    if (left) this.focus = "summary";
    else if (right) this.focus = "source";
    else if (data === "g") this.setScroll(0);
    else if (data === "G") this.setScroll(this.maxScroll());
    else if (up) this.setScroll(this.scroll() - 1);
    else if (down) this.setScroll(this.scroll() + 1);
    else if (pageUp) this.setScroll(this.scroll() - this.viewportSize + 2);
    else if (pageDown) this.setScroll(this.scroll() + this.viewportSize - 2);
    else return;
    this.tui.requestRender();
  }

  render(width: number) {
    const height = Math.max(MIN_PANEL_HEIGHT + 3, this.tui.terminal.rows - 1);
    const title =
      `${this.theme.fg("success", "●")} ${this.theme.bold("Draft inspector")} ` +
      `${this.theme.fg("accent", this.meta.name ?? this.draft.draftId)} ` +
      this.theme.fg("dim", "· immutable · not started");
    const header = truncateToWidth(` ${title}`, width, "");
    const footer = truncateToWidth(
      ` ${this.theme.fg("dim", "h/l focus · j/k scroll · ctrl-u/d page · g/G ·")} ` +
        `${this.theme.fg("accent", "a")} prefill approval · ` +
        `${this.theme.fg("accent", "esc")} close`,
      width,
      "",
    );
    const panelHeight = Math.max(MIN_PANEL_HEIGHT, height - 2);
    this.viewportSize = Math.max(1, panelHeight - 2);

    if (width < MIN_SPLIT_WIDTH) {
      const source = sourceRows(this.draft, this.theme);
      this.sourceRows = source.length;
      this.focus = "source";
      this.sourceScroll = Math.min(this.sourceScroll, this.maxScroll());
      return [
        header,
        ...panel(
          `Source ${this.sourceScroll + 1}-${Math.min(source.length, this.sourceScroll + this.viewportSize)}/${source.length}`,
          source.slice(
            this.sourceScroll,
            this.sourceScroll + this.viewportSize,
          ),
          width,
          panelHeight,
          true,
          this.theme,
        ),
        footer,
      ];
    }

    const gap = 1;
    const available = width - gap;
    const summaryWidth = Math.max(34, Math.floor(available * 0.36));
    const sourceWidth = available - summaryWidth;
    const summary = detailRows(
      this.draft,
      this.meta,
      this.artifactPath,
      summaryWidth - 4,
      this.theme,
    );
    const source = sourceRows(this.draft, this.theme);
    this.summaryRows = summary.length;
    this.sourceRows = source.length;
    this.summaryScroll = Math.min(
      this.summaryScroll,
      Math.max(0, summary.length - this.viewportSize),
    );
    this.sourceScroll = Math.min(
      this.sourceScroll,
      Math.max(0, source.length - this.viewportSize),
    );
    const left = panel(
      `Review ${this.summaryScroll + 1}-${Math.min(summary.length, this.summaryScroll + this.viewportSize)}/${summary.length}`,
      summary.slice(this.summaryScroll, this.summaryScroll + this.viewportSize),
      summaryWidth,
      panelHeight,
      this.focus === "summary",
      this.theme,
    );
    const right = panel(
      `Exact source ${this.sourceScroll + 1}-${Math.min(source.length, this.sourceScroll + this.viewportSize)}/${source.length}`,
      source.slice(this.sourceScroll, this.sourceScroll + this.viewportSize),
      sourceWidth,
      panelHeight,
      this.focus === "source",
      this.theme,
    );
    const body = left.map((line, index) => `${line} ${right[index] ?? ""}`);
    return [header, ...body, footer].map((line) =>
      truncateToWidth(line, width, ""),
    );
  }

  invalidate() {}

  private scroll() {
    return this.focus === "summary" ? this.summaryScroll : this.sourceScroll;
  }

  private setScroll(value: number) {
    const next = Math.max(0, Math.min(this.maxScroll(), value));
    if (this.focus === "summary") this.summaryScroll = next;
    else this.sourceScroll = next;
  }

  private maxScroll() {
    const rows = this.focus === "summary" ? this.summaryRows : this.sourceRows;
    return Math.max(0, rows - this.viewportSize);
  }
}

/** Text shown by the RPC editor while reviewing an immutable draft. */
export function workflowDraftReviewText(
  draft: WorkflowDraft,
  meta: WorkflowMeta,
  artifactPath: string,
): string {
  const phases =
    meta.phases.length > 0
      ? meta.phases.map(
          (phase, index) =>
            `${index + 1}. ${phase.title}${phase.detail ? ` — ${phase.detail}` : ""}`,
        )
      : ["No declared phases"];
  return [
    `Workflow draft ${meta.name ?? draft.draftId}`,
    `Draft: ${draft.draftId}`,
    `Artifact: ${artifactPath}`,
    "",
    "Preview",
    draft.preview,
    "",
    "Plan",
    ...phases,
    "",
    "Exact source",
    draft.script,
    "",
    "Approval",
    "Immutable draft; no agents have started.",
    "Review this source, then approve only by submitting the newer user response Pi pre-fills after confirmation.",
  ].join("\n");
}

/** Show one pending draft through RPC-safe dialogs and prefill approval. */
export async function showWorkflowDraftReviewFallback(
  ctx: ExtensionCommandContext,
  draft: WorkflowDraft,
  meta: WorkflowMeta,
  artifactPath: string,
) {
  const review = workflowDraftReviewText(draft, meta, artifactPath);
  if (!ctx.hasUI) {
    ctx.ui.notify(review, "info");
    return;
  }
  const editedReview = await ctx.ui.editor(
    `Workflow draft review · ${meta.name ?? draft.draftId}`,
    review,
  );
  if (editedReview === undefined) return;
  const approved = await ctx.ui.confirm(
    "Approve workflow draft?",
    `This only prepares a newer user response for ${draft.draftId}; submit the prefilled message to execute the immutable draft.`,
  );
  if (!approved) return;
  ctx.ui.setEditorText(`Approve workflow draft ${draft.draftId}.`);
  ctx.ui.notify(
    "Approval loaded in the editor. Submit it to execute the immutable draft.",
    "info",
  );
}

/** Show one pending draft and only prefill approval for explicit user submission. */
export async function showWorkflowDraftReview(
  ctx: ExtensionCommandContext,
  draft: WorkflowDraft,
  meta: WorkflowMeta,
  artifactPath: string,
) {
  if (ctx.mode !== "tui") {
    await showWorkflowDraftReviewFallback(ctx, draft, meta, artifactPath);
    return;
  }
  const action = await ctx.ui.custom<ReviewAction>(
    (tui, theme, keybindings, done) =>
      new WorkflowDraftReview(
        tui,
        theme,
        keybindings,
        draft,
        meta,
        artifactPath,
        done,
      ),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
  if (action !== "approve") return;
  ctx.ui.setEditorText(`Approve workflow draft ${draft.draftId}.`);
  ctx.ui.notify(
    "Approval loaded in the editor. Submit it to execute the immutable draft.",
    "info",
  );
}

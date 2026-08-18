import type {
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { buildTranscriptLines } from "./transcript.ts";
import {
  agentContext,
  formatElapsed,
  modelLabel,
  stateSquare,
  thinkingColor,
  type AgentRecord,
  type Theme,
  type WorkflowDetails,
} from "./model.ts";

const COMPACT_HEADER_WIDTH = 64;
const TRANSCRIPT_SCROLL_STEP = 6;

export interface AgentSelection {
  runId: string;
  agentIndex: number;
}

export function agentSelectionKey(selection: AgentSelection): string {
  return `${selection.runId}:${selection.agentIndex}`;
}

export function findSelectedAgent(
  details: WorkflowDetails | undefined,
  selection: AgentSelection,
): AgentRecord | undefined {
  if (!details || details.runId !== selection.runId) return undefined;
  return details.agents.find((agent) => agent.index === selection.agentIndex);
}

export function orderedAgentSelections(
  details: WorkflowDetails,
): AgentSelection[] {
  return details.agents.map((agent) => ({
    runId: details.runId,
    agentIndex: agent.index,
  }));
}

/** Move through agents by their stable index, never by their display row. */
export function cycleAgentSelection(
  details: WorkflowDetails,
  selection: AgentSelection,
  direction: -1 | 1,
): AgentSelection | undefined {
  const selections = orderedAgentSelections(details);
  if (selections.length === 0) return undefined;
  const current = selections.findIndex(
    (candidate) =>
      agentSelectionKey(candidate) === agentSelectionKey(selection),
  );
  const base = current >= 0 ? current : direction > 0 ? -1 : selections.length;
  return selections[(base + direction + selections.length) % selections.length];
}

function agentStatus(agent: AgentRecord): string {
  if (agent.state === "running") return "running";
  if (agent.state === "queued") return "queued";
  if (agent.state === "error") return "failed";
  return "done";
}

function headerLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "…");
}

/** Responsive header: identity, workflow context, then model/runtime facts. */
export function renderAgentPaneHeaderLines(
  details: WorkflowDetails,
  agent: AgentRecord,
  width: number,
  theme: Theme,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const identity = `${stateSquare(agent.state, theme)} ${theme.bold(theme.fg("accent", agent.label))}`;
  const status = theme.fg(
    agent.state === "error"
      ? "error"
      : agent.state === "done"
        ? "success"
        : "warning",
    agentStatus(agent).toUpperCase(),
  );
  const identityLine = `${identity} ${theme.fg("dim", "·")} ${status}`;
  const workflow = details.name ?? details.runId;
  const phase = agent.phase ?? details.currentPhase ?? "unphased";
  const workflowLine = theme.fg("muted", `${workflow} · ${phase}`);
  const model = modelLabel(agent);
  const context = agentContext(agent);
  const thinking = agent.thinkingLevel
    ? `think:${agent.thinkingLevel}`
    : undefined;
  const facts = [
    model,
    thinking,
    context ? `ctx ${context}` : undefined,
    formatElapsed(agent.startedAt, agent.finishedAt),
  ].filter((value): value is string => Boolean(value));
  const separator = theme.fg("dim", " · ");

  if (safeWidth < COMPACT_HEADER_WIDTH) {
    const firstFacts = facts.slice(0, 2).join(separator);
    const secondFacts = facts.slice(2).join(separator);
    return [
      headerLine(identityLine, safeWidth),
      headerLine(workflowLine, safeWidth),
      headerLine(firstFacts, safeWidth),
      ...(secondFacts ? [headerLine(secondFacts, safeWidth)] : []),
    ];
  }

  return [
    headerLine(identityLine, safeWidth),
    headerLine(workflowLine, safeWidth),
    headerLine(facts.join(separator), safeWidth),
  ];
}

export interface TranscriptViewport {
  visible: string[];
  maxScroll: number;
  scrollOffset: number;
  pinned: boolean;
}

/** Scroll offset is measured from the live tail: zero always means pinned. */
export function transcriptViewport(
  rows: readonly string[],
  height: number,
  scrollOffset: number,
): TranscriptViewport {
  const capacity = Math.max(1, Math.floor(height));
  const maxScroll = Math.max(0, rows.length - capacity);
  const boundedOffset = Math.min(
    Math.max(0, Math.floor(scrollOffset)),
    maxScroll,
  );
  const end = rows.length - boundedOffset;
  return {
    visible: rows.slice(Math.max(0, end - capacity), end),
    maxScroll,
    scrollOffset: boundedOffset,
    pinned: boundedOffset === 0,
  };
}

function renderBorder(theme: Theme, width: number): string {
  return theme.fg("borderAccent", "─".repeat(Math.max(1, Math.floor(width))));
}

export class WorkflowAgentPane implements Component {
  private selection: AgentSelection;
  private readonly initialDetails: WorkflowDetails;
  private readonly getActive: () => Map<string, WorkflowDetails>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: () => void;
  private readonly isSessionActive: () => boolean;
  private scrollOffset = 0;
  private closed = false;
  private ticker: ReturnType<typeof setInterval>;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    selection: AgentSelection,
    initialDetails: WorkflowDetails,
    getActive: () => Map<string, WorkflowDetails>,
    done: () => void,
    isSessionActive: () => boolean,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.selection = { ...selection };
    this.initialDetails = initialDetails;
    this.getActive = getActive;
    this.done = done;
    this.isSessionActive = isSessionActive;
    this.ticker = setInterval(() => {
      if (!this.isSessionActive()) {
        this.close();
        return;
      }
      this.tui.requestRender();
    }, 500);
  }

  private details(): WorkflowDetails {
    return this.getActive().get(this.selection.runId) ?? this.initialDetails;
  }

  private agent(): AgentRecord | undefined {
    return findSelectedAgent(this.details(), this.selection);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.done();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape)
    ) {
      this.close();
      return;
    }

    const details = this.details();
    if (matchesKey(data, Key.tab)) {
      const next = cycleAgentSelection(details, this.selection, 1);
      if (next) {
        this.selection = next;
        this.scrollOffset = 0;
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      const next = cycleAgentSelection(details, this.selection, -1);
      if (next) {
        this.selection = next;
        this.scrollOffset = 0;
      }
      this.tui.requestRender();
      return;
    }

    const up =
      this.keybindings.matches(data, "tui.editor.cursorUp") || data === "k";
    const down =
      this.keybindings.matches(data, "tui.editor.cursorDown") || data === "j";
    const pageUp =
      this.keybindings.matches(data, "tui.editor.pageUp") ||
      matchesKey(data, Key.ctrl("u"));
    const pageDown =
      this.keybindings.matches(data, "tui.editor.pageDown") ||
      matchesKey(data, Key.ctrl("d"));

    if (data === "g") this.scrollOffset = Number.MAX_SAFE_INTEGER;
    else if (data === "G") this.scrollOffset = 0;
    else if (up) this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
    else if (down)
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
    else if (pageUp) this.scrollOffset += this.viewportHeight();
    else if (pageDown)
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(),
      );
    else return;
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    return Math.max(1, (this.tui.terminal.rows || 30) - 9);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const details = this.details();
    const agent = this.agent();
    const lines: string[] = [renderBorder(this.theme, safeWidth)];

    if (!agent) {
      lines.push(
        headerLine(
          this.theme.fg(
            "dim",
            `${this.selection.runId}:${this.selection.agentIndex} is no longer tracked`,
          ),
          safeWidth,
        ),
        renderBorder(this.theme, safeWidth),
        headerLine(this.theme.fg("dim", "esc close"), safeWidth),
        renderBorder(this.theme, safeWidth),
      );
      return lines;
    }

    const header = renderAgentPaneHeaderLines(
      details,
      agent,
      safeWidth,
      this.theme,
    );
    lines.push(...header, renderBorder(this.theme, safeWidth));

    const chrome = header.length + 5;
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const viewport = Math.max(
      1,
      Math.min(
        this.viewportHeight(),
        (this.tui.terminal.rows || 30) - chrome - scrollRows,
      ),
    );
    const transcript =
      agent.transcript.length > 0
        ? buildTranscriptLines(
            agent.transcript,
            Math.max(1, safeWidth - 2),
            this.theme,
            {
              thinkingColor: agent.thinkingLevel
                ? thinkingColor(agent.thinkingLevel)
                : undefined,
            },
          )
        : [this.theme.fg("dim", "no transcript captured yet")];
    const view = transcriptViewport(transcript, viewport, this.scrollOffset);
    this.scrollOffset = view.scrollOffset;
    lines.push(...view.visible);
    while (lines.length < header.length + 2 + viewport) lines.push("");
    if (!view.pinned) {
      lines.push(
        headerLine(
          this.theme.fg("dim", `↑ ${view.scrollOffset} lines newer · g/G jump`),
          safeWidth,
        ),
      );
    }
    lines.push(renderBorder(this.theme, safeWidth));
    const help =
      safeWidth < COMPACT_HEADER_WIDTH
        ? `tab/shift-tab agents · j/k scroll · g top · G tail · esc close`
        : `tab/shift-tab agents · ↑/↓ scroll · ctrl-u/d page · g top · G tail · esc close`;
    lines.push(headerLine(this.theme.fg("dim", help), safeWidth));
    lines.push(
      headerLine(
        this.theme.fg(
          "dim",
          "read-only · workflow cancellation remains a whole-run action",
        ),
        safeWidth,
      ),
    );
    lines.push(renderBorder(this.theme, safeWidth));
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
  }

  invalidate(): void {}
}

export async function showWorkflowAgentPane(
  ctx: ExtensionContext,
  getActive: () => Map<string, WorkflowDetails>,
  selection: AgentSelection,
  initialDetails: WorkflowDetails,
  isSessionActive: () => boolean = () => true,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new WorkflowAgentPane(
        tui,
        theme,
        keybindings,
        selection,
        initialDetails,
        getActive,
        done,
        isSessionActive,
      ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "right-center",
        width: "72%",
        minWidth: 40,
        maxHeight: "92%",
        margin: { right: 1 },
      },
    },
  );
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { PiSessionItem } from "./session-provider.ts";

export type BoardAction =
  | { type: "open"; id: string }
  | { type: "new"; prompt: string }
  | { type: "pin"; id: string }
  | { type: "rename"; id: string }
  | { type: "close" };

export interface BoardMeta {
  cwd: string;
}

type DisplayRow =
  | { type: "section"; label: string; count: number }
  | { type: "session"; session: PiSessionItem };

// Terminal-native rendering of assets/pi-logo-on-dark.svg. Upper-half blocks
// compress its four pixel rows into two terminal rows, preserving its aspect ratio.
const PI_LOGO = ["█▀█ ", "█▀ █"] as const;
const TOP_ROWS = 3;
const BOTTOM_ROWS = 4;
const MIN_PANEL_HEIGHT = TOP_ROWS + BOTTOM_ROWS + 1;
const MAX_PROMPT_LENGTH = 2_000;

/**
 * A full-screen, task-first Pi session launcher. The prompt remains focused so
 * typing a task and pressing Enter starts a clean Pi session immediately.
 */
export class SessionBoard implements Component {
  public focused = false;

  private selectedIndex: number;
  private prompt = "";

  constructor(
    private readonly sessions: PiSessionItem[],
    selectedId: string | undefined,
    private readonly meta: BoardMeta,
    private readonly theme: Theme,
    private readonly done: (action: BoardAction) => void,
    private readonly onChange: () => void,
    private readonly getTerminalRows: () => number,
  ) {
    const restoredIndex = selectedId ? sessions.findIndex((session) => session.id === selectedId) : -1;
    this.selectedIndex = restoredIndex >= 0 ? restoredIndex : 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done({ type: "close" });
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      this.onChange();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      this.onChange();
      return;
    }
    if (matchesKey(data, "alt+p")) {
      this.runSelected("pin");
      return;
    }
    if (matchesKey(data, "alt+r")) {
      this.runSelected("rename");
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      if (this.prompt) {
        this.prompt = "";
        this.onChange();
      }
      return;
    }
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      if (this.prompt) {
        this.prompt = Array.from(this.prompt).slice(0, -1).join("");
        this.onChange();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const task = this.prompt.trim();
      if (task) this.done({ type: "new", prompt: task });
      else this.runSelected("open");
      return;
    }

    const text = printableInput(data);
    if (!text) return;
    this.prompt = `${this.prompt}${text}`.slice(0, MAX_PROMPT_LENGTH);
    this.onChange();
  }

  render(width: number): string[] {
    const height = Math.max(MIN_PANEL_HEIGHT, this.getTerminalRows());
    if (width < 20) return narrowPanel(width, height);

    const listRows = Math.max(1, height - TOP_ROWS - BOTTOM_ROWS);
    const lines = [
      this.row(this.brandLine(), width),
      this.row(this.workspaceLine(width), width),
      this.row(this.summaryLine(), width),
    ];

    const displayRows = this.getDisplayRows();
    const selectedId = this.sessions[this.selectedIndex]?.id;
    const selectedRowIndex = displayRows.findIndex((row) => row.type === "session" && row.session.id === selectedId);
    const { start, end } = visibleRange(selectedRowIndex, displayRows.length, listRows);

    for (let index = start; index < end; index++) {
      const displayRow = displayRows[index]!;
      lines.push(
        displayRow.type === "section"
          ? this.sectionRow(displayRow.label, displayRow.count, width)
          : this.sessionRow(displayRow.session, displayRow.session.id === selectedId, width),
      );
    }
    while (lines.length < TOP_ROWS + listRows) lines.push(this.row("", width));

    lines.push(this.divider(width));
    lines.push(this.inputRow(width));
    lines.push(this.divider(width));
    lines.push(this.row(this.theme.fg("dim", this.helpLabel()), width));
    return lines;
  }

  invalidate(): void {}

  private move(delta: number): void {
    if (this.sessions.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.sessions.length - 1, this.selectedIndex + delta));
  }

  private runSelected(type: "open" | "pin" | "rename"): void {
    const selected = this.sessions[this.selectedIndex];
    if (selected) this.done({ type, id: selected.id });
  }

  private getDisplayRows(): DisplayRow[] {
    const groups: Array<{ label: string; sessions: PiSessionItem[] }> = [
      { label: "Pinned", sessions: this.sessions.filter((session) => session.pinned) },
      { label: "Working", sessions: this.sessions.filter((session) => !session.pinned && session.status === "working") },
      {
        label: "Awaiting input",
        sessions: this.sessions.filter((session) => !session.pinned && session.status === "idle"),
      },
      { label: "Completed", sessions: this.sessions.filter((session) => !session.pinned && session.status === "done") },
    ];

    return groups.flatMap(({ label, sessions }) =>
      sessions.length === 0
        ? []
        : ([{ type: "section", label, count: sessions.length }, ...sessions.map((session) => ({ type: "session", session }))] as DisplayRow[]),
    );
  }

  private brandLine(): string {
    return `${this.logoPrefix(0)}${this.theme.bold("Pi Agents View")} ${this.theme.fg("dim", "· SESSION BOARD")}`;
  }

  private workspaceLine(width: number): string {
    const prefix = `${this.logoPrefix(1)}${this.theme.fg("muted", "Workspace  ")}`;
    const pathWidth = Math.max(1, width - visibleWidth(prefix));
    return `${prefix}${truncateToWidth(this.meta.cwd, pathWidth)}`;
  }

  private summaryLine(): string {
    const working = this.sessions.filter((session) => session.status === "working").length;
    const waiting = this.sessions.filter((session) => session.status === "idle").length;
    const completed = this.sessions.filter((session) => session.status === "done").length;
    return [
      this.logoPrefix(2),
      this.theme.fg("dim", "Sessions  "),
      this.theme.fg("accent", `${working} working`),
      this.theme.fg("muted", ` · ${waiting} awaiting input`),
      this.theme.fg("success", ` · ${completed} completed`),
    ].join("");
  }

  private logoPrefix(row: number): string {
    return `  ${this.theme.bold(PI_LOGO[row] ?? "    ")}  `;
  }

  private sectionRow(label: string, count: number, width: number): string {
    return this.row(`  ${this.theme.fg("muted", this.theme.bold(label))} ${this.theme.fg("dim", String(count))}`, width);
  }

  private sessionRow(session: PiSessionItem, selected: boolean, width: number): string {
    const pointer = selected ? this.theme.fg("accent", "> ") : "  ";
    const pin = session.pinned ? this.theme.fg("accent", "◆ ") : "  ";
    const status = statusSymbol(session.status, this.theme);
    const prefix = `  ${pointer}${pin}${status} `;
    const age = relativeAge(session.updatedAt);
    const project = projectName(session.cwd);
    const detail = width >= 64 ? `${project}  ${age}` : age;
    const nameWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(detail) - 4);
    const name = truncateToWidth(session.name, nameWidth);
    const gap = " ".repeat(Math.max(2, width - visibleWidth(prefix) - visibleWidth(name) - visibleWidth(detail) - 2));
    return this.row(`${prefix}${name}${gap}${this.theme.fg("dim", detail)}`, width, selected);
  }

  private inputRow(width: number): string {
    const prefix = `  ${this.theme.fg("accent", "›")} `;
    const availableWidth = Math.max(1, width - visibleWidth(prefix) - 2);
    const typed = truncateToWidth(this.prompt, availableWidth);
    const placeholder = this.theme.fg("muted", "Describe a task to start a new session");
    const beforeCursor = typed ? `${prefix}${typed}` : prefix;
    const afterCursor = typed ? "" : placeholder;
    const cursor = this.focused ? CURSOR_MARKER : "";
    return this.row(`${beforeCursor}${cursor}${afterCursor}`, width);
  }

  private divider(width: number): string {
    return this.theme.bg("customMessageBg", "─".repeat(width));
  }

  private helpLabel(): string {
    return "  Enter starts task · empty Enter opens selection · ↑↓ select · Alt-P pin · Alt-R rename · Esc close";
  }

  private row(content: string, width: number, selected = false): string {
    return this.theme.bg(selected ? "selectedBg" : "customMessageBg", pad(content, width));
  }
}

function statusSymbol(status: PiSessionItem["status"], theme: Theme): string {
  switch (status) {
    case "working":
      return theme.fg("accent", "●");
    case "idle":
      return theme.fg("muted", "○");
    case "done":
      return theme.fg("success", "·");
  }
}

function visibleRange(selectedRowIndex: number, count: number, maxRows: number): { start: number; end: number } {
  if (count <= maxRows) return { start: 0, end: count };
  const selected = selectedRowIndex < 0 ? 0 : selectedRowIndex;
  const start = Math.max(0, Math.min(selected - Math.floor(maxRows / 2), count - maxRows));
  return { start, end: start + maxRows };
}

function printableInput(data: string): string {
  // Escape sequences and other terminal control input are handled above, not
  // inserted into the task prompt. Pasted newlines become spaces.
  if (/\x1b|[\u0000-\u0008\u000e-\u001f\u007f]/.test(data)) return "";
  return data.replace(/[\r\n\t]+/g, " ");
}

function projectName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) || cwd;
}

function relativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function narrowPanel(width: number, height: number): string[] {
  const title = truncateToWidth("Pi Agents View — terminal too narrow", width);
  return Array.from({ length: height }, (_, index) => (index === 0 ? title : " ".repeat(width)));
}

function pad(content: string, width: number): string {
  const truncated = truncateToWidth(content, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

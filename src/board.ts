import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { PiSessionItem } from "./session-provider.ts";

export type BoardAction =
  | { type: "open"; id: string }
  | { type: "pin"; id: string }
  | { type: "rename"; id: string }
  | { type: "close" };

const MIN_PANEL_HEIGHT = 7;

/** A terminal-height Session Board intended for a full-screen overlay. */
export class SessionBoard implements Component {
  private selectedIndex: number;

  constructor(
    private readonly sessions: PiSessionItem[],
    selectedId: string | undefined,
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
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.move(-1);
      this.onChange();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.move(1);
      this.onChange();
      return;
    }

    const selected = this.sessions[this.selectedIndex];
    if (!selected) return;
    if (matchesKey(data, Key.enter)) {
      this.done({ type: "open", id: selected.id });
    } else if (matchesKey(data, "p")) {
      this.done({ type: "pin", id: selected.id });
    } else if (matchesKey(data, "r")) {
      this.done({ type: "rename", id: selected.id });
    }
  }

  render(width: number): string[] {
    const height = Math.max(MIN_PANEL_HEIGHT, this.getTerminalRows());
    if (width < 12) return narrowPanel(width, height);

    const innerWidth = width - 2;
    const contentRows = Math.max(1, height - 4); // header + divider + help + footer
    const lines = [this.border(this.headerLabel(), "┐", innerWidth)];

    if (this.sessions.length === 0) {
      lines.push(this.row(this.theme.fg("muted", "  No saved Pi sessions"), innerWidth));
    } else {
      const { start, end } = visibleRange(this.selectedIndex, this.sessions.length, contentRows);
      for (let index = start; index < end; index++) {
        lines.push(this.sessionRow(this.sessions[index]!, index === this.selectedIndex, innerWidth));
      }
    }

    // Deliberately fill unused space: a board must feel like a workspace, not
    // a small editor popup. The opaque rows also hide the underlying transcript.
    while (lines.length < contentRows + 1) lines.push(this.row("", innerWidth));

    lines.push(this.border("├", "┤", innerWidth));
    lines.push(this.row(this.theme.fg("dim", this.helpLabel()), innerWidth));
    lines.push(this.border("└", "┘", innerWidth));
    return lines;
  }

  invalidate(): void {}

  private move(delta: number): void {
    if (this.sessions.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.sessions.length - 1, this.selectedIndex + delta));
  }

  private headerLabel(): string {
    const position = this.sessions.length === 0 ? "0 / 0" : `${this.selectedIndex + 1} / ${this.sessions.length}`;
    return `┌─ ${this.theme.fg("accent", this.theme.bold("Sessions"))} ${this.theme.fg("dim", position)} `;
  }

  private helpLabel(): string {
    return " ↑↓/jk select · Enter open · p pin · r rename · Esc close";
  }

  private sessionRow(session: PiSessionItem, selected: boolean, width: number): string {
    const pointer = selected ? "> " : "  ";
    const pin = session.pinned ? "📌 " : "   ";
    const status = statusDisplay(session.status, this.theme);
    const prefix = `${pointer}${pin}${status.symbol} `;
    const nameWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(status.label) - 1);
    const content = `${prefix}${truncateToWidth(session.name, nameWidth)} ${status.label}`;
    return this.row(content, width, selected);
  }

  private border(left: string, right: string, innerWidth: number): string {
    const labelWidth = visibleWidth(left) + visibleWidth(right);
    const line = `${left}${"─".repeat(Math.max(0, innerWidth + 2 - labelWidth))}${right}`;
    return this.theme.bg("customMessageBg", line);
  }

  private row(content: string, innerWidth: number, selected = false): string {
    const line = `│${pad(content, innerWidth)}│`;
    return this.theme.bg(selected ? "selectedBg" : "customMessageBg", line);
  }
}

function statusDisplay(status: PiSessionItem["status"], theme: Theme): { symbol: string; label: string } {
  switch (status) {
    case "working":
      return { symbol: theme.fg("accent", "●"), label: theme.fg("accent", "working") };
    case "idle":
      return { symbol: theme.fg("muted", "○"), label: theme.fg("muted", "idle") };
    case "done":
      return { symbol: theme.fg("success", "✓"), label: theme.fg("success", "done") };
  }
}

function visibleRange(selectedIndex: number, count: number, maxRows: number): { start: number; end: number } {
  if (count <= maxRows) return { start: 0, end: count };
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxRows / 2), count - maxRows));
  return { start, end: start + maxRows };
}

function narrowPanel(width: number, height: number): string[] {
  const title = truncateToWidth("Sessions — terminal too narrow", width);
  return Array.from({ length: height }, (_, index) => (index === 0 ? title : " ".repeat(width)));
}

function pad(content: string, width: number): string {
  const truncated = truncateToWidth(content, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

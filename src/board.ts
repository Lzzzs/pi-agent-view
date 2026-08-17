import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { PiSessionItem } from "./session-provider.ts";

export type BoardAction =
  | { type: "open"; id: string }
  | { type: "pin"; id: string }
  | { type: "rename"; id: string }
  | { type: "close" };

const MAX_VISIBLE_ROWS = 10;

export class SessionBoard implements Component {
  private selectedIndex: number;

  constructor(
    private readonly sessions: PiSessionItem[],
    selectedId: string | undefined,
    private readonly theme: Theme,
    private readonly done: (action: BoardAction) => void,
    private readonly onChange: () => void,
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
    if (width < 12) return [truncateToWidth("Sessions", width)];

    const innerWidth = width - 2;
    const lines = [this.border("┌─ Sessions ", "┐", innerWidth)];
    if (this.sessions.length === 0) {
      lines.push(this.row(this.theme.fg("muted", "  No saved Pi sessions"), innerWidth));
    } else {
      const { start, end } = visibleRange(this.selectedIndex, this.sessions.length);
      if (start > 0) lines.push(this.row(this.theme.fg("dim", `  ↑ ${start} earlier session(s)`), innerWidth));
      for (let index = start; index < end; index++) {
        lines.push(this.sessionRow(this.sessions[index]!, index === this.selectedIndex, innerWidth));
      }
      if (end < this.sessions.length) {
        lines.push(this.row(this.theme.fg("dim", `  ↓ ${this.sessions.length - end} more session(s)`), innerWidth));
      }
    }
    lines.push(this.border("├", "┤", innerWidth));
    lines.push(this.row(this.theme.fg("dim", " ↑↓/jk select  Enter open  p pin  r rename  Esc close"), innerWidth));
    lines.push(this.border("└", "┘", innerWidth));
    return lines;
  }

  invalidate(): void {}

  private move(delta: number): void {
    if (this.sessions.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.sessions.length - 1, this.selectedIndex + delta));
  }

  private sessionRow(session: PiSessionItem, selected: boolean, width: number): string {
    const pointer = selected ? "> " : "  ";
    const pin = session.pinned ? "📌 " : "   ";
    const status = statusDisplay(session.status, this.theme);
    const prefix = `${pointer}${pin}${status.symbol} `;
    const nameWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(status.label) - 1);
    const content = `${prefix}${truncateToWidth(session.name, nameWidth)} ${status.label}`;
    const padded = pad(content, width);
    return this.row(selected ? this.theme.bg("selectedBg", padded) : padded, width);
  }

  private border(left: string, right: string, innerWidth: number): string {
    const labelWidth = visibleWidth(left) + visibleWidth(right);
    return `${left}${"─".repeat(Math.max(0, innerWidth + 2 - labelWidth))}${right}`;
  }

  private row(content: string, innerWidth: number): string {
    return `│${pad(content, innerWidth)}│`;
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

function visibleRange(selectedIndex: number, count: number): { start: number; end: number } {
  if (count <= MAX_VISIBLE_ROWS) return { start: 0, end: count };
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2), count - MAX_VISIBLE_ROWS));
  return { start, end: start + MAX_VISIBLE_ROWS };
}

function pad(content: string, width: number): string {
  const truncated = truncateToWidth(content, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

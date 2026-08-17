import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { SessionRuntime, SessionRuntimeStatus } from "./session-runtime.ts";

export type RuntimeViewAction = { type: "detach" };

const MAX_PROMPT_LENGTH = 4_000;
const FIXED_ROWS = 5;

/** Minimal attach surface for an RPC runtime; closing it never stops the worker. */
export class RuntimeView implements Component {
  public focused = false;

  private prompt = "";
  private scrollOffset = 0;
  private sendError?: string;
  private unsubscribe: () => void;

  constructor(
    private readonly runtime: SessionRuntime,
    private readonly sessionName: string,
    private readonly theme: Theme,
    private readonly done: (action: RuntimeViewAction) => void,
    private readonly onChange: () => void,
    private readonly getTerminalRows: () => number,
  ) {
    this.unsubscribe = runtime.subscribe(() => {
      this.scrollOffset = 0;
      this.onChange();
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribe = () => {};
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || (matchesKey(data, Key.left) && this.prompt.length === 0)) {
      this.done({ type: "detach" });
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset += 1;
      this.onChange();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.onChange();
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.prompt = "";
      this.onChange();
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
      const message = this.prompt.trim();
      if (!message) return;
      this.prompt = "";
      this.sendError = undefined;
      this.onChange();
      void this.runtime.send(message).catch((error: unknown) => {
        this.sendError = error instanceof Error ? error.message : String(error);
        this.onChange();
      });
      return;
    }

    const text = printableInput(data);
    if (!text) return;
    this.prompt = `${this.prompt}${text}`.slice(0, MAX_PROMPT_LENGTH);
    this.onChange();
  }

  render(width: number): string[] {
    const height = Math.max(8, this.getTerminalRows());
    const snapshot = this.runtime.getSnapshot();
    const lines = [
      this.row(
        `${this.theme.bold(this.sessionName)} ${this.theme.fg("dim", "·")} ${renderStatus(snapshot.status, this.theme)}`,
        width,
      ),
      this.row(this.theme.fg("dim", `${snapshot.sessionId} · ${snapshot.cwd}`), width),
    ];

    const transcriptHeight = Math.max(1, height - FIXED_ROWS);
    const transcript = renderTranscript(snapshot, width, this.theme, this.sendError);
    const maxOffset = Math.max(0, transcript.length - transcriptHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const end = Math.max(0, transcript.length - this.scrollOffset);
    const start = Math.max(0, end - transcriptHeight);
    const visible = transcript.slice(start, end);
    while (visible.length < transcriptHeight) visible.unshift("");
    for (const line of visible) lines.push(this.row(line, width));

    lines.push(this.divider(width));
    lines.push(this.inputRow(width));
    lines.push(
      this.row(
        this.theme.fg("dim", "Enter send · ←/Esc detach (runtime keeps running) · ↑↓ scroll"),
        width,
      ),
    );
    return lines;
  }

  invalidate(): void {}

  private inputRow(width: number): string {
    const prefix = `${this.theme.fg("accent", "›")} `;
    const typed = truncateToWidth(this.prompt, Math.max(1, width - visibleWidth(prefix)));
    const placeholder = this.theme.fg("muted", "Message this session");
    const cursor = this.focused ? CURSOR_MARKER : "";
    return this.row(`${prefix}${typed}${cursor}${typed ? "" : placeholder}`, width);
  }

  private divider(width: number): string {
    return this.theme.bg("customMessageBg", "─".repeat(width));
  }

  private row(content: string, width: number): string {
    return this.theme.bg("customMessageBg", pad(content, width));
  }
}

function renderTranscript(
  snapshot: ReturnType<SessionRuntime["getSnapshot"]>,
  width: number,
  theme: Theme,
  sendError?: string,
): string[] {
  const lines: string[] = [];
  for (const message of snapshot.messages.slice(-200)) {
    const formatted = formatMessage(message, theme);
    if (!formatted) continue;
    if (lines.length > 0) lines.push("");
    lines.push(...wrapTextWithAnsi(formatted, Math.max(1, width)));
  }

  if (snapshot.streamingText) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrapTextWithAnsi(`${theme.fg("accent", theme.bold("Pi"))}  ${snapshot.streamingText}`, Math.max(1, width)));
  }
  for (const tool of snapshot.activeTools) {
    lines.push(theme.fg("dim", `↳ running ${tool}`));
  }
  const error = sendError ?? snapshot.error;
  if (error) lines.push(...wrapTextWithAnsi(theme.fg("error", `✕ ${error}`), Math.max(1, width)));
  if (snapshot.notice) lines.push(...wrapTextWithAnsi(theme.fg("warning", `! ${snapshot.notice}`), Math.max(1, width)));
  if (lines.length === 0) lines.push(theme.fg("muted", "No messages yet."));
  return lines;
}

function formatMessage(value: unknown, theme: Theme): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  const role = typeof message.role === "string" ? message.role : "message";
  const text = contentText(message.content);

  switch (role) {
    case "user":
      return `${theme.fg("accent", theme.bold("You"))}  ${text}`;
    case "assistant":
      return `${theme.fg("success", theme.bold("Pi"))}  ${text || assistantToolSummary(message.content)}`;
    case "toolResult":
      return text ? `${theme.fg("dim", `↳ ${String(message.toolName ?? "tool")}`)}  ${text}` : undefined;
    case "bashExecution":
      return `${theme.fg("dim", `$ ${String(message.command ?? "")}`)}\n${String(message.output ?? "")}`;
    case "custom":
      return text ? theme.fg("muted", text) : undefined;
    default:
      return text || undefined;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "toolCall") return `[tool: ${String(block.name ?? "unknown")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function assistantToolSummary(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "toolCall")
    .map((part) => `[tool: ${String((part as Record<string, unknown>).name ?? "unknown")}]`)
    .join(" ");
}

function renderStatus(status: SessionRuntimeStatus, theme: Theme): string {
  switch (status) {
    case "starting":
      return theme.fg("warning", "◌ starting");
    case "working":
      return theme.fg("accent", "● working");
    case "idle":
      return theme.fg("muted", "○ idle");
    case "failed":
      return theme.fg("error", "✕ failed");
    case "stopped":
      return theme.fg("dim", "· stopped");
  }
}

function printableInput(data: string): string {
  if (/\x1b|[\u0000-\u0008\u000e-\u001f\u007f]/.test(data)) return "";
  return data.replace(/[\r\n\t]+/g, " ");
}

function pad(content: string, width: number): string {
  const truncated = truncateToWidth(content, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

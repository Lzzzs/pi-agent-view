import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomEditor,
  CustomMessageComponent,
  getMarkdownTheme,
  getSelectListTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  Loader,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { RuntimeToolSnapshot, SessionRuntime, SessionRuntimeSnapshot } from "./session-runtime.ts";

export type RuntimeViewAction = { type: "detach" };

/**
 * Pi-native attach surface for an RPC runtime. It reuses Pi's public message,
 * Markdown, tool, bash, editor, and theme components; only the data source is
 * the detached RPC session rather than InteractiveMode's private runtime.
 */
export class RuntimeView implements Component {
  public focused = false;

  private readonly editor: CustomEditor;
  private workingLoader?: Loader;
  private scrollOffset = 0;
  private sendError?: string;
  private localNotice?: string;
  private ctrlCArmedUntil = 0;
  private ctrlCNoticeTimer?: NodeJS.Timeout;
  private toolsExpanded = false;
  private unsubscribe: () => void;
  private cachedTranscript?: { revision: number; expanded: boolean; components: Component[] };
  private lastTranscriptLength = 0;

  constructor(
    private readonly runtime: SessionRuntime,
    private readonly sessionName: string,
    private readonly theme: Theme,
    private readonly tui: TUI,
    keybindings: KeybindingsManager,
    private readonly done: (action: RuntimeViewAction) => void,
    private readonly onChange: () => void,
    private readonly getTerminalRows: () => number,
  ) {
    const snapshot = runtime.getSnapshot();
    this.editor = new CustomEditor(
      tui,
      {
        borderColor: theme.getThinkingBorderColor(snapshot.state?.thinkingLevel ?? "off"),
        selectList: getSelectListTheme(),
      },
      keybindings,
      { paddingX: 1, autocompleteMaxVisible: 5 },
    );
    this.editor.onChange = () => this.onChange();
    this.editor.onSubmit = (text) => this.submit(text);
    this.editor.onEscape = () => {
      if (this.editor.getText()) {
        this.editor.setText("");
        this.onChange();
      } else {
        this.done({ type: "detach" });
      }
    };
    this.editor.onCtrlD = () => {
      if (!this.editor.getText()) this.done({ type: "detach" });
    };
    this.editor.onAction("app.tools.expand", () => this.toggleTools());
    this.editor.onAction("app.clear", () => {
      if (this.editor.getText()) {
        this.editor.setText("");
        this.disarmCtrlC();
        return;
      }
      if (Date.now() <= this.ctrlCArmedUntil) {
        this.done({ type: "detach" });
        return;
      }
      this.ctrlCArmedUntil = Date.now() + 1_000;
      this.localNotice = "Press Ctrl-C again to detach";
      this.cachedTranscript = undefined;
      this.onChange();
      this.ctrlCNoticeTimer = setTimeout(() => this.disarmCtrlC(), 1_000);
      this.ctrlCNoticeTimer.unref();
    });
    for (const message of snapshot.messages) {
      if (message && typeof message === "object" && (message as Record<string, unknown>).role === "user") {
        const text = userText((message as Record<string, unknown>).content);
        if (text) this.editor.addToHistory(text);
      }
    }

    this.unsubscribe = runtime.subscribe(() => {
      this.cachedTranscript = undefined;
      this.onChange();
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribe = () => {};
    this.workingLoader?.stop();
    this.workingLoader = undefined;
    if (this.ctrlCNoticeTimer) clearTimeout(this.ctrlCNoticeTimer);
    this.ctrlCNoticeTimer = undefined;
  }

  handleInput(data: string): void {
    this.editor.focused = this.focused;
    if ((matchesKey(data, Key.left) || matchesKey(data, "ctrl+left")) && this.editor.getText().length === 0) {
      this.done({ type: "detach" });
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset += Math.max(4, Math.floor(this.getTerminalRows() / 2));
      this.onChange();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(4, Math.floor(this.getTerminalRows() / 2)));
      this.onChange();
      return;
    }
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const height = Math.max(8, this.getTerminalRows());
    const snapshot = this.runtime.getSnapshot();
    this.editor.focused = this.focused;
    this.editor.borderColor = this.theme.getThinkingBorderColor(snapshot.state?.thinkingLevel ?? "off");

    const editorLines = this.editor.render(width);
    const footerLines = renderFooter(snapshot, this.sessionName, width, this.theme);
    const queueLines = renderQueue(snapshot, this.theme);
    const statusLines = this.renderStatus(snapshot, width);
    const transcriptHeight = Math.max(1, height - editorLines.length - footerLines.length - queueLines.length - statusLines.length);
    const transcript = this.transcript(snapshot, width);
    if (this.lastTranscriptLength !== transcript.length) {
      const growth = transcript.length - this.lastTranscriptLength;
      if (this.scrollOffset > 0) this.scrollOffset = Math.max(0, this.scrollOffset + growth);
      this.lastTranscriptLength = transcript.length;
    }
    const maxOffset = Math.max(0, transcript.length - transcriptHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const end = Math.max(0, transcript.length - this.scrollOffset);
    const start = Math.max(0, end - transcriptHeight);
    const visible = transcript.slice(start, end);
    while (visible.length < transcriptHeight) visible.unshift("");

    return [...visible, ...queueLines, ...statusLines, ...editorLines, ...footerLines].map((line) => pad(line, width));
  }

  invalidate(): void {
    this.cachedTranscript = undefined;
    this.editor.invalidate();
  }

  private submit(text: string): void {
    const message = text.trim();
    if (!message) return;
    this.editor.addToHistory(message);
    this.sendError = undefined;
    this.cachedTranscript = undefined;
    this.onChange();
    void this.runtime.send(message).catch((error: unknown) => {
      this.sendError = error instanceof Error ? error.message : String(error);
      this.cachedTranscript = undefined;
      this.onChange();
    });
  }

  private toggleTools(): void {
    this.toolsExpanded = !this.toolsExpanded;
    this.cachedTranscript = undefined;
    this.onChange();
  }

  private transcript(snapshot: SessionRuntimeSnapshot, width: number): string[] {
    const cached = this.cachedTranscript;
    if (!cached || cached.revision !== snapshot.revision || cached.expanded !== this.toolsExpanded) {
      this.cachedTranscript = {
        revision: snapshot.revision,
        expanded: this.toolsExpanded,
        components: buildTranscript(snapshot, this.theme, this.tui, this.toolsExpanded, this.sendError, this.localNotice),
      };
    }
    return this.cachedTranscript!.components.flatMap((component) => component.render(width));
  }

  private disarmCtrlC(): void {
    this.ctrlCArmedUntil = 0;
    if (this.ctrlCNoticeTimer) clearTimeout(this.ctrlCNoticeTimer);
    this.ctrlCNoticeTimer = undefined;
    if (!this.localNotice) return;
    this.localNotice = undefined;
    this.cachedTranscript = undefined;
    this.onChange();
  }

  private renderStatus(snapshot: SessionRuntimeSnapshot, width: number): string[] {
    if (snapshot.state?.isCompacting || snapshot.status === "working" || snapshot.status === "starting") {
      this.workingLoader ??= new Loader(
        this.tui,
        (spinner) => this.theme.fg("accent", spinner),
        (text) => this.theme.fg("muted", text),
        "Working...",
      );
      const message = snapshot.state?.isCompacting
        ? "Compacting context..."
        : snapshot.status === "starting"
          ? "Starting..."
          : "Working...";
      this.workingLoader.setMessage(message);
      return this.workingLoader.render(width);
    }
    this.workingLoader?.stop();
    this.workingLoader = undefined;
    return [];
  }
}

function buildTranscript(
  snapshot: SessionRuntimeSnapshot,
  theme: Theme,
  tui: TUI,
  expanded: boolean,
  sendError?: string,
  localNotice?: string,
): Component[] {
  const components: Component[] = [];
  const tools = new Map<string, ToolExecutionComponent>();
  const markdownTheme = getMarkdownTheme();

  for (const value of snapshot.messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, any>;
    switch (message.role) {
      case "user": {
        const text = userText(message.content);
        if (!text) break;
        if (components.length > 0) components.push(new Spacer(1));
        const skill = parseSkillBlock(text);
        if (skill) {
          const skillComponent = new SkillInvocationMessageComponent(skill, markdownTheme);
          skillComponent.setExpanded(expanded);
          components.push(skillComponent);
          if (skill.userMessage) {
            components.push(new Spacer(1));
            components.push(new UserMessageComponent(skill.userMessage, markdownTheme, 1));
          }
        } else {
          components.push(new UserMessageComponent(text, markdownTheme, 1));
        }
        break;
      }
      case "assistant": {
        components.push(new AssistantMessageComponent(message as any, false, markdownTheme, "Thinking...", 1));
        for (const call of toolCalls(message.content)) {
          const component = createToolComponent(call, snapshot.cwd, tui, expanded);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            component.updateResult({
              content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error") }],
              isError: true,
            });
          } else {
            component.setArgsComplete();
          }
          components.push(component);
          tools.set(call.id, component);
        }
        break;
      }
      case "toolResult": {
        const component = typeof message.toolCallId === "string" ? tools.get(message.toolCallId) : undefined;
        component?.updateResult({
          content: Array.isArray(message.content) ? message.content : [],
          ...(message.details === undefined ? {} : { details: message.details }),
          isError: message.isError === true,
        });
        if (component && typeof message.toolCallId === "string") tools.delete(message.toolCallId);
        break;
      }
      case "bashExecution": {
        const component = new BashExecutionComponent(String(message.command ?? ""), tui, message.excludeFromContext === true);
        if (typeof message.output === "string") component.appendOutput(message.output);
        component.setComplete(message.exitCode, message.cancelled === true, message.truncated ? ({ truncated: true } as any) : undefined, message.fullOutputPath);
        component.setExpanded(expanded);
        components.push(component);
        break;
      }
      case "custom": {
        if (message.display === false) break;
        const component = new CustomMessageComponent(message as any, undefined, markdownTheme, 1);
        component.setExpanded(expanded);
        components.push(component);
        break;
      }
      case "compactionSummary": {
        components.push(new Spacer(1));
        const component = new CompactionSummaryMessageComponent(message as any, markdownTheme);
        component.setExpanded(expanded);
        components.push(component);
        break;
      }
      case "branchSummary": {
        components.push(new Spacer(1));
        const component = new BranchSummaryMessageComponent(message as any, markdownTheme);
        component.setExpanded(expanded);
        components.push(component);
        break;
      }
    }
  }

  if (snapshot.streamingMessage && typeof snapshot.streamingMessage === "object") {
    const streaming = new AssistantMessageComponent(undefined, false, markdownTheme, "Thinking...", 1);
    streaming.updateContent(snapshot.streamingMessage as any, true);
    components.push(streaming);
    for (const call of toolCalls((snapshot.streamingMessage as Record<string, any>).content)) {
      if (tools.has(call.id)) continue;
      const component = createToolComponent(call, snapshot.cwd, tui, expanded);
      components.push(component);
      tools.set(call.id, component);
    }
  } else if (snapshot.streamingText) {
    const streaming = new AssistantMessageComponent(undefined, false, markdownTheme, "Thinking...", 1);
    streaming.updateContent(
      { role: "assistant", content: [{ type: "text", text: snapshot.streamingText }], stopReason: "stop", timestamp: Date.now() } as any,
      true,
    );
    components.push(streaming);
  }

  for (const tool of snapshot.tools) {
    let component = tools.get(tool.id);
    if (!component) {
      component = createToolComponent(tool, snapshot.cwd, tui, expanded);
      components.push(component);
      tools.set(tool.id, component);
    }
    applyRuntimeTool(component, tool);
  }

  const error = sendError ?? snapshot.error;
  if (error) {
    components.push(new Spacer(1));
    components.push(new Text(theme.fg("error", `Error: ${error}`), 1, 0));
  }
  const notice = localNotice ?? snapshot.notice;
  if (notice) {
    components.push(new Spacer(1));
    components.push(new Text(theme.fg("warning", notice), 1, 0));
  }

  return components;
}

function createToolComponent(
  tool: Pick<RuntimeToolSnapshot, "id" | "name" | "args">,
  cwd: string,
  tui: TUI,
  expanded: boolean,
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(tool.name, tool.id, tool.args ?? {}, {}, undefined, tui, cwd);
  component.setExpanded(expanded);
  return component;
}

function applyRuntimeTool(component: ToolExecutionComponent, tool: RuntimeToolSnapshot): void {
  component.updateArgs(tool.args ?? {});
  if (tool.executionStarted) component.markExecutionStarted();
  if (tool.argsComplete) component.setArgsComplete();
  if (tool.result) {
    component.updateResult(
      {
        content: tool.result.content as any[],
        ...(tool.result.details === undefined ? {} : { details: tool.result.details }),
        isError: tool.isError,
      },
      tool.isPartial,
    );
  }
}

function toolCalls(content: unknown): Array<{ id: string; name: string; args: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const call = part as Record<string, unknown>;
    if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") return [];
    return [{ id: call.id, name: call.name, args: call.arguments ?? {} }];
  });
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
    .map((part) => String((part as Record<string, unknown>).text ?? ""))
    .join("");
}

function renderQueue(snapshot: SessionRuntimeSnapshot, theme: Theme): string[] {
  const lines: string[] = [];
  for (const message of snapshot.pendingMessages.steering) {
    lines.push(theme.fg("dim", ` Steering: ${message.replace(/\s+/g, " ").trim()}`));
  }
  for (const message of snapshot.pendingMessages.followUp) {
    lines.push(theme.fg("dim", ` Follow-up: ${message.replace(/\s+/g, " ").trim()}`));
  }
  return lines.length > 0 ? ["", ...lines] : [];
}

function renderFooter(snapshot: SessionRuntimeSnapshot, fallbackName: string, width: number, theme: Theme): string[] {
  const state = snapshot.state;
  const model = state?.model as Record<string, any> | undefined;
  const sessionName = state?.sessionName?.trim() || fallbackName.trim();
  const cwd = formatCwd(snapshot.cwd);
  const location = sessionName ? `${cwd} • ${sessionName}` : cwd;

  const fallbackUsage = collectUsage(snapshot.messages);
  const baseTokens = snapshot.stats?.tokens ?? fallbackUsage;
  const pendingUsage = snapshot.stats ? snapshot.usageSinceStats : emptyCollectedUsage();
  const streamingUsage = snapshot.streamingMessage ? collectUsage([snapshot.streamingMessage]) : emptyCollectedUsage();
  const tokens = {
    input: baseTokens.input + pendingUsage.input + streamingUsage.input,
    output: baseTokens.output + pendingUsage.output + streamingUsage.output,
    cacheRead: baseTokens.cacheRead + pendingUsage.cacheRead + streamingUsage.cacheRead,
    cacheWrite: baseTokens.cacheWrite + pendingUsage.cacheWrite + streamingUsage.cacheWrite,
  };
  const contextUsage = snapshot.stats?.contextUsage as Record<string, unknown> | undefined;
  const contextWindow = numberValue(contextUsage?.contextWindow) || numberValue(model?.contextWindow);
  const latestContextTokens =
    streamingUsage.latestContextTokens ?? pendingUsage.latestContextTokens ?? fallbackUsage.latestContextTokens;
  const contextPercent =
    latestContextTokens !== undefined && contextWindow > 0
      ? (latestContextTokens / contextWindow) * 100
      : contextUsage?.percent;
  const context = `${typeof contextPercent === "number" ? `${contextPercent.toFixed(1)}%` : "?"}/${
    contextWindow > 0 ? formatTokens(contextWindow) : "?"
  }${state?.autoCompactionEnabled ? " (auto)" : ""}`;
  const leftParts: string[] = [];
  if (tokens.input > 0) leftParts.push(`↑${formatTokens(tokens.input)}`);
  if (tokens.output > 0) leftParts.push(`↓${formatTokens(tokens.output)}`);
  if (tokens.cacheRead > 0) leftParts.push(`R${formatTokens(tokens.cacheRead)}`);
  if (tokens.cacheWrite > 0) leftParts.push(`W${formatTokens(tokens.cacheWrite)}`);
  const cost = (snapshot.stats?.cost ?? fallbackUsage.cost) + pendingUsage.cost + streamingUsage.cost;
  if (cost > 0) leftParts.push(`$${cost.toFixed(3)}`);
  leftParts.push(context);

  const modelId = typeof model?.id === "string" ? model.id : "no-model";
  const provider = typeof model?.provider === "string" ? `(${model.provider}) ` : "";
  const thinking = model?.reasoning
    ? state?.thinkingLevel === "off"
      ? " • thinking off"
      : ` • ${state?.thinkingLevel ?? "off"}`
    : "";
  const stats = alignSides(leftParts.join(" "), `${provider}${modelId}${thinking}`, width);
  const attached = `background · ${statusText(snapshot.status)} · ← detach · PgUp/PgDn scroll`;

  return [
    truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "...")),
    theme.fg("dim", stats),
    truncateToWidth(theme.fg("dim", attached), width, theme.fg("dim", "...")),
  ];
}

function emptyCollectedUsage(): ReturnType<typeof collectUsage> {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function collectUsage(messages: readonly unknown[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestContextTokens?: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let latestContextTokens: number | undefined;
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, any>;
    if (message.role !== "assistant" || !message.usage || typeof message.usage !== "object") continue;
    const usage = message.usage as Record<string, unknown>;
    const currentInput = numberValue(usage.input);
    const currentCacheRead = numberValue(usage.cacheRead);
    const currentCacheWrite = numberValue(usage.cacheWrite);
    input += currentInput;
    output += numberValue(usage.output);
    cacheRead += currentCacheRead;
    cacheWrite += currentCacheWrite;
    const costValue = usage.cost;
    cost +=
      typeof costValue === "object" && costValue !== null
        ? numberValue((costValue as Record<string, unknown>).total)
        : numberValue(costValue);
    latestContextTokens = currentInput + currentCacheRead + currentCacheWrite;
  }
  return { input, output, cacheRead, cacheWrite, cost, ...(latestContextTokens === undefined ? {} : { latestContextTokens }) };
}

function formatCwd(cwd: string): string {
  const home = homedir();
  const resolvedCwd = resolve(cwd);
  const relativeToHome = relative(resolve(home), resolvedCwd);
  const inside = relativeToHome === "" || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  return inside ? (relativeToHome ? `~${sep}${relativeToHome}` : "~") : cwd;
}

function alignSides(left: string, right: string, width: number): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + 2 + rightWidth <= width) return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
  const available = Math.max(0, width - leftWidth - 2);
  if (available === 0) return truncateToWidth(left, width, "");
  const clippedRight = truncateToWidth(right, available, "");
  return `${truncateToWidth(left, Math.max(0, width - visibleWidth(clippedRight) - 2), "")}  ${clippedRight}`;
}

function statusText(status: SessionRuntimeSnapshot["status"]): string {
  switch (status) {
    case "starting":
      return "starting";
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pad(content: string, width: number): string {
  const truncated = truncateToWidth(content, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

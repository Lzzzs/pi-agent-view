import type { RpcSessionState, SessionStats } from "@earendil-works/pi-coding-agent";
import { PiRpcWorker, type PiRpcWorkerOptions } from "./pi-worker.ts";
import type { RuntimeSlashCommand, WorkerClient, WorkerProtocolEvent } from "./worker-protocol.ts";

export type SessionRuntimeStatus = "starting" | "working" | "idle" | "failed" | "stopped";

export interface RuntimeUsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestContextTokens?: number;
}

export interface RuntimeToolSnapshot {
  id: string;
  name: string;
  args: unknown;
  executionStarted: boolean;
  argsComplete: boolean;
  result?: { content: unknown[]; details?: unknown };
  isError: boolean;
  isPartial: boolean;
}

export interface SessionRuntimeSnapshot {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  status: SessionRuntimeStatus;
  attached: boolean;
  workerAlive: boolean;
  workerPid?: number;
  revision: number;
  state?: RpcSessionState;
  stats?: SessionStats;
  usageSinceStats: RuntimeUsageSnapshot;
  /** Optional for runtimes retained across an extension hot reload from versions before autocomplete support. */
  commands?: readonly RuntimeSlashCommand[];
  availableModels?: ReadonlyArray<NonNullable<RpcSessionState["model"]>>;
  messages: readonly unknown[];
  streamingMessage?: unknown;
  streamingText: string;
  tools: readonly RuntimeToolSnapshot[];
  pendingMessages: { steering: readonly string[]; followUp: readonly string[] };
  activeTools: readonly string[];
  error?: string;
  notice?: string;
}

export interface SessionRuntime {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly cwd: string;
  readonly status: SessionRuntimeStatus;

  start(): Promise<void>;
  send(message: string): Promise<void>;
  attach(): Promise<void>;
  detach(): Promise<void>;
  shutdown(): Promise<void>;
  getSnapshot(): SessionRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface RpcSessionRuntimeOptions {
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  worker?: WorkerClient;
  workerOptions?: Omit<PiRpcWorkerOptions, "cwd" | "sessionFile" | "sessionId">;
}

/** One Pi session owned by one isolated RPC process. */
export class RpcSessionRuntime implements SessionRuntime {
  private _sessionId: string;
  private _sessionFile?: string;
  private _status: SessionRuntimeStatus = "starting";
  private attached = false;
  private messages: unknown[] = [];
  private rpcState?: RpcSessionState;
  private sessionStats?: SessionStats;
  private usageSinceStats = emptyUsage();
  private commands: RuntimeSlashCommand[] = [];
  private availableModels: Array<NonNullable<RpcSessionState["model"]>> = [];
  private streamingMessage?: unknown;
  private streamingText = "";
  private readonly toolCallArgumentBuffers = new Map<number, string>();
  private readonly activeTools = new Map<string, string>();
  private readonly toolStates = new Map<string, RuntimeToolSnapshot>();
  private pendingMessages = { steering: [] as string[], followUp: [] as string[] };
  private readonly compactionQueue: string[] = [];
  private flushingCompactionQueue = false;
  private revision = 0;
  private messageGeneration = 0;
  private statsRefreshSequence = 0;
  private error?: string;
  private notice?: string;
  private runFailed = false;
  private readonly listeners = new Set<() => void>();
  private readonly worker: WorkerClient;
  private unsubscribeWorker?: () => void;
  private started = false;
  private workerAlive = false;

  readonly cwd: string;

  constructor(private readonly options: RpcSessionRuntimeOptions) {
    this.cwd = options.cwd;
    this._sessionId = options.sessionId ?? "starting";
    this._sessionFile = options.sessionFile;
    this.worker =
      options.worker ??
      new PiRpcWorker({
        cwd: options.cwd,
        sessionFile: options.sessionFile,
        sessionId: options.sessionId,
        ...options.workerOptions,
      });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get sessionFile(): string | undefined {
    return this._sessionFile;
  }

  get status(): SessionRuntimeStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeWorker = this.worker.onEvent((event) => this.handleWorkerEvent(event));

    try {
      const { state } = await this.worker.start();
      this.workerAlive = true;
      this.applyState(state);
      const [messages, stats] = await Promise.all([this.worker.getMessages(), this.worker.getSessionStats()]);
      this.messages = messages;
      this.sessionStats = stats;
      await this.refreshCatalogs();
      this._status = state.isStreaming ? "working" : "idle";
      this.emit();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async send(message: string): Promise<void> {
    const text = message.trim();
    if (!text) return;
    if (this._status === "stopped") throw new Error("Session runtime is stopped.");

    this.runFailed = false;
    this.error = undefined;
    this.notice = undefined;
    if (await this.executeBuiltInCommand(text)) return;
    if (this.rpcState?.isCompacting) {
      this.compactionQueue.push(text);
      this.emit();
      return;
    }
    try {
      await this.worker.prompt(text, this._status === "working" ? "steer" : undefined);
      const state = await this.worker.getState();
      this.applyState(state);
      this._status = state.isStreaming ? "working" : this.runFailed ? "failed" : "idle";
      this.emit();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private async executeBuiltInCommand(text: string): Promise<boolean> {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return false;
    const command = match[1]!.toLowerCase();
    const argument = match[2]?.trim() ?? "";
    if (!ATTACH_BUILTIN_COMMANDS.has(command)) return false;

    try {
      switch (command) {
        case "compact":
          if (this._status === "working") throw new Error("Wait for the current response to finish before compacting.");
          await this.worker.compact(argument || undefined);
          await this.refreshFromWorker(true);
          return true;
        case "name":
          if (!argument) throw new Error("Usage: /name <session name>");
          await this.worker.setSessionName(argument);
          if (this.rpcState) this.rpcState = { ...this.rpcState, sessionName: argument };
          this.notice = `Session renamed to “${argument}”.`;
          this.emit();
          return true;
        case "model": {
          if (!argument) throw new Error("Usage: /model <provider/model>");
          const candidates = this.availableModels.filter(
            (model) => `${model.provider}/${model.id}` === argument || model.id === argument,
          );
          if (candidates.length !== 1) throw new Error(`Unknown or ambiguous model “${argument}”.`);
          const selected = candidates[0]!;
          const model = await this.worker.setModel(selected.provider, selected.id);
          if (this.rpcState) this.rpcState = { ...this.rpcState, model };
          this.notice = `Model set to ${model.provider}/${model.id}.`;
          this.emit();
          return true;
        }
        case "session": {
          const stats = await this.worker.getSessionStats();
          this.sessionStats = stats;
          this.notice = `${stats.totalMessages} messages · ${stats.tokens.total} tokens · $${stats.cost.toFixed(3)}`;
          this.emit();
          return true;
        }
        case "export": {
          const path = await this.worker.exportHtml(argument || undefined);
          this.notice = `Exported session to ${path}`;
          this.emit();
          return true;
        }
        default:
          this.notice = `/${command} is only available in Pi’s native foreground view.`;
          this.emit();
          return true;
      }
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error);
      this.emit();
      return true;
    }
  }

  async attach(): Promise<void> {
    await this.refreshCatalogs();
    this.attached = true;
    this.emit();
  }

  async detach(): Promise<void> {
    // Deliberately do not touch status, prompt queues, tools, or the process.
    this.attached = false;
    this.emit();
  }

  async shutdown(): Promise<void> {
    if (this._status === "stopped") return;
    await this.worker.shutdown();
    this.workerAlive = false;
    this._status = "stopped";
    this.attached = false;
    this.activeTools.clear();
    this.toolStates.clear();
    this.pendingMessages = { steering: [], followUp: [] };
    this.compactionQueue.length = 0;
    this.unsubscribeWorker?.();
    this.unsubscribeWorker = undefined;
    this.emit();
  }

  getSnapshot(): SessionRuntimeSnapshot {
    return {
      sessionId: this._sessionId,
      sessionFile: this._sessionFile,
      cwd: this.cwd,
      status: this._status,
      attached: this.attached,
      workerAlive: this.workerAlive,
      ...(this.worker.processId === undefined ? {} : { workerPid: this.worker.processId }),
      revision: this.revision,
      ...(this.rpcState ? { state: cloneJson(this.rpcState) } : {}),
      ...(this.sessionStats ? { stats: cloneJson(this.sessionStats) } : {}),
      usageSinceStats: cloneJson(this.usageSinceStats),
      commands: cloneJson(this.commands),
      availableModels: cloneJson(this.availableModels),
      messages: cloneJson(this.messages),
      ...(this.streamingMessage === undefined ? {} : { streamingMessage: cloneJson(this.streamingMessage) }),
      streamingText: this.streamingText,
      tools: cloneJson([...this.toolStates.values()]),
      pendingMessages: cloneJson({
        steering: [...this.pendingMessages.steering, ...this.compactionQueue],
        followUp: this.pendingMessages.followUp,
      }),
      activeTools: [...this.activeTools.values()],
      ...(this.error ? { error: this.error } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async refreshCatalogs(): Promise<void> {
    if (!this.workerAlive) return;
    const [commands, models] = await Promise.allSettled([
      this.worker.getCommands(),
      this.worker.getAvailableModels(),
    ]);
    if (!this.workerAlive) return;
    if (commands.status === "fulfilled") this.commands = commands.value;
    if (models.status === "fulfilled") this.availableModels = models.value;
  }

  private applyState(state: RpcSessionState): void {
    if (this.options.sessionId && state.sessionId !== this.options.sessionId) {
      throw new Error(`Pi RPC worker opened session ${state.sessionId}, expected ${this.options.sessionId}.`);
    }
    this._sessionId = state.sessionId;
    this._sessionFile = state.sessionFile;
    this.rpcState = state;
  }

  private handleWorkerEvent(message: WorkerProtocolEvent): void {
    if (message.type === "exit") {
      this.workerAlive = false;
      if (message.expected) {
        this._status = "stopped";
        this.attached = false;
        this.activeTools.clear();
        this.toolStates.clear();
        this.pendingMessages = { steering: [], followUp: [] };
        this.compactionQueue.length = 0;
        this.emit();
      } else {
        this.fail(message.error ?? new Error("Pi RPC worker exited unexpectedly."));
      }
      return;
    }

    if (message.type === "extension_ui") {
      const method = message.request.method;
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        this.notice = `Background extension UI request “${method}” was cancelled because no modal is attached.`;
        this.emit();
      }
      return;
    }

    const event = message.event;
    switch (event.type) {
      case "agent_start":
        this.runFailed = false;
        this.error = undefined;
        this.streamingMessage = undefined;
        this.streamingText = "";
        this.toolCallArgumentBuffers.clear();
        this._status = "working";
        if (this.rpcState) this.rpcState = { ...this.rpcState, isStreaming: true };
        this.emit();
        break;
      case "agent_settled":
        this._status = this.runFailed ? "failed" : "idle";
        this.activeTools.clear();
        this.toolStates.clear();
        this.pendingMessages = { steering: [], followUp: [] };
        if (this.rpcState) this.rpcState = { ...this.rpcState, isStreaming: false, pendingMessageCount: 0 };
        this.emit();
        void this.refreshFromWorker(false);
        break;
      case "message_start": {
        const startedMessage = event.message as unknown;
        if (isRole(startedMessage, "assistant")) this.streamingMessage = cloneJson(startedMessage);
        this.emit();
        break;
      }
      case "message_update": {
        const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
        this.applyAssistantDelta(delta, event.usage);
        if (delta?.type === "text_delta" && typeof delta.delta === "string") this.streamingText += delta.delta;
        this.emit();
        break;
      }
      case "message_end": {
        const finalMessage = event.message;
        if (finalMessage && typeof finalMessage === "object") {
          this.appendMessage(finalMessage);
          const record = finalMessage as Record<string, unknown>;
          if (record.role === "assistant") {
            this.streamingMessage = undefined;
            this.streamingText = "";
            addUsage(this.usageSinceStats, record.usage);
            this.markToolArgsComplete(finalMessage);
            if (record.stopReason === "error") {
              this.runFailed = true;
              this.error = typeof record.errorMessage === "string" ? record.errorMessage : "Agent response failed.";
            }
          } else if (record.role === "toolResult" && typeof record.toolCallId === "string") {
            this.toolStates.delete(record.toolCallId);
          }
          this.emit();
        }
        break;
      }
      case "tool_execution_start":
        if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
          this.activeTools.set(event.toolCallId, event.toolName);
          const current = this.toolStates.get(event.toolCallId);
          this.toolStates.set(event.toolCallId, {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args ?? current?.args ?? {},
            executionStarted: true,
            argsComplete: current?.argsComplete ?? true,
            result: current?.result,
            isError: false,
            isPartial: true,
          });
          this.emit();
        }
        break;
      case "tool_execution_update":
        if (typeof event.toolCallId === "string") {
          const current = this.toolStates.get(event.toolCallId);
          if (current) {
            this.toolStates.set(event.toolCallId, {
              ...current,
              result: normalizeToolResult(event.partialResult),
              isError: false,
              isPartial: true,
            });
            this.emit();
          }
        }
        break;
      case "tool_execution_end":
        if (typeof event.toolCallId === "string") {
          this.activeTools.delete(event.toolCallId);
          const current = this.toolStates.get(event.toolCallId);
          if (current) {
            this.toolStates.set(event.toolCallId, {
              ...current,
              result: normalizeToolResult(event.result),
              isError: event.isError === true,
              isPartial: false,
            });
          }
          this.emit();
        }
        break;
      case "model_select":
        if (this.rpcState) this.rpcState = { ...this.rpcState, model: event.model as RpcSessionState["model"] };
        this.emit();
        break;
      case "thinking_level_changed":
        if (this.rpcState) {
          this.rpcState = { ...this.rpcState, thinkingLevel: event.level as RpcSessionState["thinkingLevel"] };
        }
        this.emit();
        break;
      case "session_info_changed":
        if (this.rpcState) {
          this.rpcState = {
            ...this.rpcState,
            sessionName: typeof event.name === "string" ? event.name : undefined,
          };
        }
        this.emit();
        break;
      case "queue_update": {
        const steering = Array.isArray(event.steering)
          ? event.steering.filter((value): value is string => typeof value === "string")
          : [];
        const followUp = Array.isArray(event.followUp)
          ? event.followUp.filter((value): value is string => typeof value === "string")
          : [];
        this.pendingMessages = { steering, followUp };
        if (this.rpcState) {
          this.rpcState = { ...this.rpcState, pendingMessageCount: steering.length + followUp.length };
        }
        this.emit();
        break;
      }
      case "compaction_start":
        if (this.rpcState) this.rpcState = { ...this.rpcState, isCompacting: true };
        this.emit();
        break;
      case "compaction_end":
        if (this.rpcState) this.rpcState = { ...this.rpcState, isCompacting: false };
        this.emit();
        if (event.aborted !== true && event.result) void this.refreshFromWorker(true);
        void this.flushCompactionQueue();
        break;
      case "auto_retry_end":
        if (event.success === false) {
          this.runFailed = true;
          this.error = typeof event.finalError === "string" ? event.finalError : "Agent retry failed.";
          this.emit();
        }
        break;
    }
  }

  private applyAssistantDelta(delta: Record<string, unknown> | undefined, usage: unknown): void {
    if (!delta) return;
    if (delta.type === "done" && isRole(delta.message, "assistant")) {
      this.streamingMessage = cloneJson(delta.message);
      return;
    }
    if (delta.type === "error" && isRole(delta.error, "assistant")) {
      this.streamingMessage = cloneJson(delta.error);
      return;
    }

    const current = isRole(this.streamingMessage, "assistant")
      ? cloneJson(this.streamingMessage as Record<string, unknown>)
      : ({ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as Record<string, unknown>);
    const content = Array.isArray(current.content) ? [...current.content] : [];
    const contentIndex = typeof delta.contentIndex === "number" ? delta.contentIndex : -1;
    if (contentIndex >= 0) {
      const existing = content[contentIndex] as Record<string, unknown> | undefined;
      switch (delta.type) {
        case "text_start":
          content[contentIndex] = { type: "text", text: "" };
          break;
        case "text_delta":
          content[contentIndex] = {
            type: "text",
            text: `${existing?.type === "text" && typeof existing.text === "string" ? existing.text : ""}${
              typeof delta.delta === "string" ? delta.delta : ""
            }`,
          };
          break;
        case "text_end":
          content[contentIndex] = { type: "text", text: typeof delta.content === "string" ? delta.content : "" };
          break;
        case "thinking_start":
          content[contentIndex] = { type: "thinking", thinking: "" };
          break;
        case "thinking_delta":
          content[contentIndex] = {
            type: "thinking",
            thinking: `${
              existing?.type === "thinking" && typeof existing.thinking === "string" ? existing.thinking : ""
            }${typeof delta.delta === "string" ? delta.delta : ""}`,
          };
          break;
        case "thinking_end":
          content[contentIndex] = {
            type: "thinking",
            thinking: typeof delta.content === "string" ? delta.content : "",
          };
          break;
        case "toolcall_start":
          this.toolCallArgumentBuffers.set(contentIndex, "");
          break;
        case "toolcall_delta":
          this.toolCallArgumentBuffers.set(
            contentIndex,
            `${this.toolCallArgumentBuffers.get(contentIndex) ?? ""}${typeof delta.delta === "string" ? delta.delta : ""}`,
          );
          break;
        case "toolcall_end":
          if (delta.toolCall && typeof delta.toolCall === "object") {
            const toolCall = cloneJson(delta.toolCall as Record<string, unknown>);
            const buffered = this.toolCallArgumentBuffers.get(contentIndex);
            if (toolCall.arguments === undefined && buffered) {
              try {
                toolCall.arguments = JSON.parse(buffered);
              } catch {
                // The authoritative toolcall_end payload normally includes
                // parsed arguments; keep it unchanged if a provider emitted
                // malformed incremental JSON.
              }
            }
            content[contentIndex] = toolCall;
          }
          this.toolCallArgumentBuffers.delete(contentIndex);
          break;
      }
    }
    current.content = content;
    if (usage && typeof usage === "object") current.usage = cloneJson(usage);
    this.streamingMessage = current;
    this.syncToolCalls(current);
  }

  private async refreshFromWorker(reloadMessages: boolean): Promise<void> {
    if (!this.workerAlive) return;
    const generation = this.messageGeneration;
    const statsSequence = ++this.statsRefreshSequence;
    try {
      const [stats, messages] = await Promise.all([
        this.worker.getSessionStats(),
        reloadMessages ? this.worker.getMessages() : Promise.resolve(undefined),
      ]);
      if (!this.workerAlive) return;

      const unchanged = generation === this.messageGeneration;
      let changed = false;
      let retry = false;
      if (statsSequence === this.statsRefreshSequence) {
        if (unchanged) {
          this.sessionStats = stats;
          this.usageSinceStats = emptyUsage();
          changed = true;
        } else {
          retry = true;
        }
      }
      if (messages) {
        if (unchanged) {
          this.messages = messages;
          this.messageGeneration += 1;
          if (this.rpcState) this.rpcState = { ...this.rpcState, messageCount: messages.length };
          changed = true;
        } else {
          retry = true;
        }
      }
      if (changed) this.emit();
      if (retry) queueMicrotask(() => void this.refreshFromWorker(reloadMessages));
    } catch {
      // Lifecycle state remains authoritative. usageSinceStats keeps the footer
      // current, and the next settled/compaction event retries exact stats.
    }
  }

  private async flushCompactionQueue(): Promise<void> {
    if (this.flushingCompactionQueue || this.compactionQueue.length === 0 || this.rpcState?.isCompacting) return;
    this.flushingCompactionQueue = true;
    try {
      while (this.compactionQueue.length > 0 && !this.rpcState?.isCompacting && this.workerAlive) {
        const message = this.compactionQueue.shift()!;
        const remaining = [...this.compactionQueue];
        this.emit();
        try {
          await this.send(message);
        } catch (error) {
          this.compactionQueue.splice(0, this.compactionQueue.length, message, ...remaining);
          this.notice = `Queued message could not be sent: ${error instanceof Error ? error.message : String(error)}`;
          this.emit();
          break;
        }
      }
    } finally {
      this.flushingCompactionQueue = false;
    }
  }

  private syncToolCalls(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const call = part as Record<string, unknown>;
      if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
      const current = this.toolStates.get(call.id);
      this.toolStates.set(call.id, {
        id: call.id,
        name: call.name,
        args: call.arguments ?? current?.args ?? {},
        executionStarted: current?.executionStarted ?? false,
        argsComplete: current?.argsComplete ?? false,
        result: current?.result,
        isError: current?.isError ?? false,
        isPartial: current?.isPartial ?? true,
      });
    }
  }

  private markToolArgsComplete(message: unknown): void {
    this.syncToolCalls(message);
    for (const tool of this.toolStates.values()) tool.argsComplete = true;
  }

  private appendMessage(message: unknown): void {
    // RPC message_end is emitted exactly once per persisted message. Do not use
    // millisecond timestamps as identity: parallel and queued messages can
    // legitimately share both role and timestamp.
    this.messages.push(message);
    this.messageGeneration += 1;
    if (this.rpcState) this.rpcState = { ...this.rpcState, messageCount: this.messages.length };
  }

  private fail(error: unknown): void {
    this.runFailed = true;
    this._status = "failed";
    this.error = error instanceof Error ? error.message : String(error);
    this.activeTools.clear();
    this.toolStates.clear();
    this.pendingMessages = { steering: [], followUp: [] };
    this.compactionQueue.length = 0;
    this.emit();
  }

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

const ATTACH_BUILTIN_COMMANDS = new Set([
  "agents",
  "agents-new-safe",
  "settings",
  "model",
  "scoped-models",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "tree",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
]);

function isRole(message: unknown, role: string): boolean {
  return !!message && typeof message === "object" && (message as Record<string, unknown>).role === role;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function emptyUsage(): RuntimeUsageSnapshot {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(target: RuntimeUsageSnapshot, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const usage = value as Record<string, unknown>;
  const input = finiteNumber(usage.input);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  target.input += input;
  target.output += finiteNumber(usage.output);
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.latestContextTokens = input + cacheRead + cacheWrite;
  const cost = usage.cost;
  target.cost +=
    cost && typeof cost === "object" ? finiteNumber((cost as Record<string, unknown>).total) : finiteNumber(cost);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeToolResult(value: unknown): { content: unknown[]; details?: unknown } {
  if (!value || typeof value !== "object") return { content: [] };
  const result = value as Record<string, unknown>;
  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(result.details === undefined ? {} : { details: result.details }),
  };
}

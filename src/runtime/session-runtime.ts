import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { PiRpcWorker, type PiRpcWorkerOptions } from "./pi-worker.ts";
import type { WorkerClient, WorkerProtocolEvent } from "./worker-protocol.ts";

export type SessionRuntimeStatus = "starting" | "working" | "idle" | "failed" | "stopped";

export interface SessionRuntimeSnapshot {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  status: SessionRuntimeStatus;
  attached: boolean;
  workerAlive: boolean;
  workerPid?: number;
  messages: readonly unknown[];
  streamingText: string;
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
  private streamingText = "";
  private readonly activeTools = new Map<string, string>();
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
      this.applyIdentity(state);
      this.messages = await this.worker.getMessages();
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
    try {
      await this.worker.prompt(text, this._status === "working" ? "steer" : undefined);
      const state = await this.worker.getState();
      this._status = state.isStreaming ? "working" : this.runFailed ? "failed" : "idle";
      this.emit();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async attach(): Promise<void> {
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
      messages: [...this.messages],
      streamingText: this.streamingText,
      activeTools: [...this.activeTools.values()],
      ...(this.error ? { error: this.error } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applyIdentity(state: RpcSessionState): void {
    if (this.options.sessionId && state.sessionId !== this.options.sessionId) {
      throw new Error(`Pi RPC worker opened session ${state.sessionId}, expected ${this.options.sessionId}.`);
    }
    this._sessionId = state.sessionId;
    this._sessionFile = state.sessionFile;
  }

  private handleWorkerEvent(message: WorkerProtocolEvent): void {
    if (message.type === "exit") {
      this.workerAlive = false;
      if (message.expected) {
        this._status = "stopped";
        this.attached = false;
        this.activeTools.clear();
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
        this.streamingText = "";
        this._status = "working";
        this.emit();
        break;
      case "agent_settled":
        this._status = this.runFailed ? "failed" : "idle";
        this.activeTools.clear();
        this.emit();
        break;
      case "message_update": {
        const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.delta === "string") {
          this.streamingText += delta.delta;
          this.emit();
        }
        break;
      }
      case "message_end": {
        const finalMessage = event.message;
        if (finalMessage && typeof finalMessage === "object") {
          this.appendMessage(finalMessage);
          const record = finalMessage as Record<string, unknown>;
          if (record.role === "assistant") {
            this.streamingText = "";
            if (record.stopReason === "error") {
              this.runFailed = true;
              this.error = typeof record.errorMessage === "string" ? record.errorMessage : "Agent response failed.";
            }
          }
          this.emit();
        }
        break;
      }
      case "tool_execution_start":
        if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
          this.activeTools.set(event.toolCallId, event.toolName);
          this.emit();
        }
        break;
      case "tool_execution_end":
        if (typeof event.toolCallId === "string") {
          this.activeTools.delete(event.toolCallId);
          this.emit();
        }
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

  private appendMessage(message: unknown): void {
    const record = message as Record<string, unknown>;
    const index = this.messages.findIndex((candidate) => {
      const value = candidate as Record<string, unknown>;
      return value.role === record.role && value.timestamp === record.timestamp;
    });
    if (index >= 0) this.messages[index] = message;
    else this.messages.push(message);
  }

  private fail(error: unknown): void {
    this.runFailed = true;
    this._status = "failed";
    this.error = error instanceof Error ? error.message : String(error);
    this.activeTools.clear();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

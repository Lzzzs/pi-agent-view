import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, type RpcExtensionUIRequest, type RpcResponse, type RpcSessionState } from "@earendil-works/pi-coding-agent";
import {
  responseData,
  type RpcCommandBody,
  type WorkerClient,
  type WorkerProtocolEvent,
  type WorkerStartResult,
} from "./worker-protocol.ts";

export interface PiRpcWorkerOptions {
  cwd: string;
  sessionFile?: string;
  sessionId?: string;
  cliPath?: string;
  extensionPath?: string;
  env?: NodeJS.ProcessEnv;
  noSession?: boolean;
  requestTimeoutMs?: number;
}

const MAX_JSONL_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;

/** Strict JSONL RPC transport around one isolated Pi process. */
export class PiRpcWorker implements WorkerClient {
  private child?: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: WorkerProtocolEvent) => void>();
  private readonly pending = new Map<
    string,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private requestSequence = 0;
  private stderr = "";
  private expectedExit = false;
  private exitReported = false;
  private decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";

  constructor(private readonly options: PiRpcWorkerOptions) {}

  get processId(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<WorkerStartResult> {
    if (this.child) throw new Error("Pi RPC worker already started.");

    const cliPath = this.options.cliPath ?? join(getPackageDir(), "dist", "cli.js");
    const extensionPath = this.options.extensionPath ?? fileURLToPath(new URL("../../index.ts", import.meta.url));
    const args = [cliPath, "--mode", "rpc", "--extension", extensionPath];
    if (this.options.sessionFile && existsSync(this.options.sessionFile)) args.push("--session", this.options.sessionFile);
    else if (this.options.sessionId) args.push("--session-id", this.options.sessionId);
    else if (this.options.noSession) args.push("--no-session");

    const child = spawn(process.execPath, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env, PI_AGENTS_VIEW_WORKER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.installProcessHandlers(child);

    // get_state is both a readiness barrier and the authoritative identity of
    // the session the child actually opened.
    const state = await this.getState();
    return { state };
  }

  onEvent(listener: (event: WorkerProtocolEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.request({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
  }

  async getState(): Promise<RpcSessionState> {
    return responseData<RpcSessionState>(await this.request({ type: "get_state" }));
  }

  async getMessages(): Promise<unknown[]> {
    const data = responseData<{ messages: unknown[] }>(await this.request({ type: "get_messages" }));
    return data.messages;
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;

    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 1_500);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = undefined;
  }

  private installProcessHandlers(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stdout.on("end", () => {
      if (this.exitReported) return;
      this.stdoutBuffer += this.decoder.end();
      if (this.stdoutBuffer) this.handleLine(this.stdoutBuffer.endsWith("\r") ? this.stdoutBuffer.slice(0, -1) : this.stdoutBuffer);
      this.stdoutBuffer = "";
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_CHARS);
    });
    child.stdin.on("error", (error) => {
      this.reportExit(new Error(`Pi RPC stdin failed: ${error.message}`));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    child.once("error", (error) => this.reportExit(new Error(`Pi RPC process failed: ${error.message}`)));
    child.once("exit", (code, signal) => {
      const error = this.expectedExit
        ? undefined
        : new Error(`Pi RPC worker exited (code=${String(code)}, signal=${String(signal)}).${this.stderr ? ` ${this.stderr}` : ""}`);
      this.reportExit(error);
    });
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.exitReported) return;
    this.stdoutBuffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_JSONL_RECORD_BYTES) {
      this.protocolFailure(new Error("Pi RPC worker emitted an oversized JSONL record."));
      return;
    }

    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) this.handleLine(line);
      if (this.exitReported) return;
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.protocolFailure(
        new Error(`Pi RPC worker emitted invalid JSONL: ${error instanceof Error ? error.message : String(error)}`),
      );
      return;
    }

    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message as unknown as RpcResponse);
      return;
    }

    if (message.type === "extension_ui_request") {
      const request = message as unknown as RpcExtensionUIRequest;
      this.emit({ type: "extension_ui", request });
      if (request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor") {
        // A detached worker has no human-owned modal. Cancelling is safer than
        // hanging forever or pretending that a destructive confirmation passed.
        this.writeRaw({ type: "extension_ui_response", id: request.id, cancelled: true });
      }
      return;
    }

    this.emit({ type: "rpc_event", event: message });
  }

  private request(command: RpcCommandBody): Promise<RpcResponse> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) {
      return Promise.reject(new Error(`Pi RPC worker is not running.${this.stderr ? ` ${this.stderr}` : ""}`));
    }

    const id = `agents_view_${process.pid}_${++this.requestSequence}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC response to ${command.type}.${this.stderr ? ` ${this.stderr}` : ""}`));
      }, this.options.requestTimeoutMs ?? 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeRaw({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).then((response) => {
      if (!response.success) throw new Error(response.error);
      return response;
    });
  }

  private writeRaw(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) throw new Error("Pi RPC stdin is not writable.");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private protocolFailure(error: Error): void {
    this.reportExit(error);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  private reportExit(error?: Error): void {
    if (this.exitReported) return;
    this.exitReported = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("Pi RPC worker stopped."));
    }
    this.pending.clear();
    this.emit({ type: "exit", expected: this.expectedExit, ...(error ? { error } : {}) });
  }

  private emit(event: WorkerProtocolEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

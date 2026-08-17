import { randomUUID } from "node:crypto";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { SessionClaimRegistry, type SessionClaimLease } from "./session-claim.ts";
import {
  RpcSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeSnapshot,
  type SessionRuntimeStatus,
} from "./session-runtime.ts";

export interface RuntimeManagerEvent {
  sessionId: string;
  snapshot?: SessionRuntimeSnapshot;
}

export interface RuntimeFactoryOptions {
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
}

export type RuntimeFactory = (options: RuntimeFactoryOptions) => SessionRuntime;
export type RuntimeManagerListener = (event: RuntimeManagerEvent) => void;

const MANAGER_SYMBOL = Symbol.for("pi-agents-view.runtime-manager.v1");

export class DefaultSessionRuntimeManager {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly runtimeUnsubscribers = new Map<string, () => void>();
  private readonly claims = new Map<string, SessionClaimLease>();
  private readonly hostClaims = new Map<string, SessionClaimLease>();
  private readonly hostReservations = new Map<string, { claim: SessionClaimLease; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<RuntimeManagerListener>();
  private readonly pendingStarts = new Map<string, Promise<SessionRuntime>>();
  private readonly startingRuntimes = new Map<string, SessionRuntime>();
  private readonly hostStatuses = new Map<string, SessionRuntimeStatus>();
  private shuttingDown = false;

  constructor(
    private readonly runtimeFactory: RuntimeFactory = (options) => new RpcSessionRuntime(options),
    private readonly claimRegistry = new SessionClaimRegistry(),
  ) {}

  get(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  listSnapshots(): SessionRuntimeSnapshot[] {
    return [...this.runtimes.values()].map((runtime) => runtime.getSnapshot());
  }

  async getOrCreate(sessionId: string): Promise<SessionRuntime> {
    const pending = this.pendingStarts.get(sessionId);
    if (pending) return pending;

    const current = this.runtimes.get(sessionId);
    if (current && current.status !== "stopped" && current.getSnapshot().workerAlive) return current;
    if (this.hostStatuses.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already owned by the foreground Pi runtime.`);
    }

    const start = current ? this.restart(current) : this.startExisting(sessionId);
    this.pendingStarts.set(sessionId, start);
    try {
      return await start;
    } finally {
      this.pendingStarts.delete(sessionId);
    }
  }

  async create(cwd: string): Promise<SessionRuntime> {
    this.assertAcceptingStarts();
    // Supplying the ID lets us claim ownership before Pi creates or writes the
    // corresponding JSONL file.
    const sessionId = randomUUID();
    const start = this.startOwned({ cwd, sessionId });
    this.pendingStarts.set(sessionId, start);
    try {
      return await start;
    } finally {
      this.pendingStarts.delete(sessionId);
    }
  }

  async attach(sessionId: string): Promise<SessionRuntime> {
    const runtime = await this.getOrCreate(sessionId);
    await runtime.attach();
    this.emit(sessionId, runtime.getSnapshot());
    return runtime;
  }

  async detach(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    await runtime.detach();
    this.emit(sessionId, runtime.getSnapshot());
  }

  getStatus(sessionId: string): SessionRuntimeStatus | undefined {
    return this.runtimes.get(sessionId)?.status ?? this.hostStatuses.get(sessionId);
  }

  async reserveHost(sessionId: string): Promise<void> {
    if (this.hostClaims.has(sessionId) || this.hostReservations.has(sessionId)) return;
    if (this.runtimes.has(sessionId)) throw new Error(`Session ${sessionId} is owned by a background runtime.`);
    const claim = await this.claimRegistry.acquire(sessionId);
    const timer = setTimeout(() => {
      const reservation = this.hostReservations.get(sessionId);
      if (reservation?.claim !== claim) return;
      this.hostReservations.delete(sessionId);
      void claim.release().catch(() => {});
    }, 30_000);
    timer.unref();
    this.hostReservations.set(sessionId, { claim, timer });
  }

  async registerHost(sessionId: string): Promise<void> {
    if (this.hostClaims.has(sessionId)) return;
    if (this.runtimes.has(sessionId)) throw new Error(`Session ${sessionId} is owned by a background runtime.`);
    const reservation = this.hostReservations.get(sessionId);
    const claim = reservation?.claim ?? (await this.claimRegistry.acquire(sessionId));
    if (reservation) {
      clearTimeout(reservation.timer);
      this.hostReservations.delete(sessionId);
    }
    this.hostClaims.set(sessionId, claim);
    this.hostStatuses.set(sessionId, "idle");
    this.emit(sessionId);
  }

  setHostStatus(sessionId: string, status: SessionRuntimeStatus): void {
    if (!this.hostClaims.has(sessionId) && process.env.PI_AGENTS_VIEW_WORKER !== "1") return;
    this.hostStatuses.set(sessionId, status);
    this.emit(sessionId);
  }

  async unregisterHost(sessionId: string): Promise<void> {
    this.hostStatuses.delete(sessionId);
    const claim = this.hostClaims.get(sessionId);
    this.hostClaims.delete(sessionId);
    await claim?.release().catch(() => {});
    this.emit(sessionId);
  }

  ownsSessionFile(sessionFile: string): boolean {
    for (const runtime of this.runtimes.values()) {
      if (runtime.sessionFile === sessionFile && runtime.status !== "stopped") return true;
    }
    return false;
  }

  subscribe(listener: RuntimeManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async removeRuntime(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      await runtime.shutdown().catch(() => {});
      this.runtimeUnsubscribers.get(sessionId)?.();
      this.runtimeUnsubscribers.delete(sessionId);
      this.runtimes.delete(sessionId);
    }
    const claim = this.claims.get(sessionId);
    this.claims.delete(sessionId);
    await claim?.release().catch(() => {});
    this.emit(sessionId);
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    // Interrupt readiness requests first; never wait a full RPC timeout merely
    // because quit crossed a child startup.
    await Promise.allSettled([...this.startingRuntimes.values()].map((runtime) => runtime.shutdown()));
    await Promise.allSettled([...this.pendingStarts.values()]);
    await Promise.allSettled([...this.runtimes.keys()].map((id) => this.removeRuntime(id)));
    await Promise.allSettled([...this.hostClaims.keys()].map((id) => this.unregisterHost(id)));
    await Promise.allSettled(
      [...this.hostReservations.entries()].map(async ([id, reservation]) => {
        clearTimeout(reservation.timer);
        this.hostReservations.delete(id);
        await reservation.claim.release();
      }),
    );
  }

  private async startExisting(sessionId: string): Promise<SessionRuntime> {
    this.assertAcceptingStarts();
    const session = (await PiSessionManager.listAll()).find((item) => item.id === sessionId);
    if (!session) throw new Error(`Pi session not found: ${sessionId}`);
    return this.startOwned({ cwd: session.cwd, sessionId: session.id, sessionFile: session.path });
  }

  private async restart(previous: SessionRuntime): Promise<SessionRuntime> {
    const options: RuntimeFactoryOptions = {
      cwd: previous.cwd,
      sessionId: previous.sessionId,
      ...(previous.sessionFile ? { sessionFile: previous.sessionFile } : {}),
    };
    await this.removeRuntime(previous.sessionId);
    return this.startOwned(options);
  }

  private async startOwned(options: RuntimeFactoryOptions): Promise<SessionRuntime> {
    this.assertAcceptingStarts();
    const expectedId = options.sessionId;
    if (!expectedId) throw new Error("A managed runtime requires a session ID before startup.");
    if (this.runtimes.has(expectedId) || this.hostStatuses.has(expectedId) || this.claims.has(expectedId)) {
      throw new Error(`Session ${expectedId} already has a live runtime.`);
    }

    const claim = await this.claimRegistry.acquire(expectedId);
    let runtime: SessionRuntime | undefined;
    try {
      this.assertAcceptingStarts();
      runtime = this.runtimeFactory(options);
      this.startingRuntimes.set(expectedId, runtime);
      const startup = runtime.start().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      // PiRpcWorker spawns synchronously before start() reaches its readiness
      // await. Record the writer PID now, not after model/runtime startup, so a
      // parent crash cannot make a still-running child look unowned.
      await claim.setWriterPid(runtime.getSnapshot().workerPid);
      const outcome = await startup;
      if (!outcome.ok) throw outcome.error;
      this.startingRuntimes.delete(expectedId);
      this.assertAcceptingStarts();
      if (runtime.sessionId !== expectedId) {
        throw new Error(`Pi RPC opened session ${runtime.sessionId}; expected ${expectedId}.`);
      }
      if (this.runtimes.has(expectedId) || this.hostStatuses.has(expectedId)) {
        throw new Error(`Session ${expectedId} already has a live runtime.`);
      }
      this.claims.set(expectedId, claim);
      this.registerRuntime(runtime);
      return runtime;
    } catch (error) {
      this.startingRuntimes.delete(expectedId);
      await runtime?.shutdown().catch(() => {});
      await claim.release().catch(() => {});
      throw error;
    }
  }

  private registerRuntime(runtime: SessionRuntime): void {
    this.runtimes.set(runtime.sessionId, runtime);
    this.runtimeUnsubscribers.set(
      runtime.sessionId,
      runtime.subscribe(() => this.emit(runtime.sessionId, runtime.getSnapshot())),
    );
    this.emit(runtime.sessionId, runtime.getSnapshot());
  }

  private assertAcceptingStarts(): void {
    if (this.shuttingDown) throw new Error("Pi background runtime manager is shutting down.");
  }

  private emit(sessionId: string, snapshot?: SessionRuntimeSnapshot): void {
    for (const listener of this.listeners) listener({ sessionId, snapshot });
  }
}

export function getSessionRuntimeManager(): DefaultSessionRuntimeManager {
  const target = globalThis as typeof globalThis & { [MANAGER_SYMBOL]?: DefaultSessionRuntimeManager };
  target[MANAGER_SYMBOL] ??= new DefaultSessionRuntimeManager();
  return target[MANAGER_SYMBOL];
}

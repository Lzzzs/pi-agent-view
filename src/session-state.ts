import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type SessionStatus = "working" | "idle" | "done";
export type LiveSessionStatus = Exclude<SessionStatus, "done">;

export interface SessionRuntime {
  pid: number;
  status: LiveSessionStatus;
  updatedAt: number;
}

interface StoredSessionRuntime {
  pid: number;
  status: SessionStatus;
  updatedAt: number;
}

export interface SessionViewState {
  /** User-defined Agent View name. Pi's own session name remains untouched. */
  name?: string;
  pinned?: boolean;
  /** One live lifecycle record per Pi process currently using this session. */
  runtimes?: Record<string, SessionRuntime>;
}

interface AgentViewStateFile {
  version: 1;
  lastSelectedSessionId?: string;
  sessions: Record<string, SessionViewState>;
}

const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_RETRIES = 200;
const LOCK_RETRY_DELAY_MS = 15;

export function defaultStatePath(): string {
  return join(homedir(), ".pi", "agents-view", "state.json");
}

function legacyStatePath(): string {
  return join(homedir(), ".pi", "agent-view", "state.json");
}

/**
 * Stores only Agent View metadata. Pi's session JSONL files remain the source
 * of truth for transcripts, titles, and session locations. Updates use a small
 * lock file because several Pi terminal processes can publish lifecycles at
 * the same time.
 */
export class AgentViewStateStore {
  constructor(private readonly filePath = defaultStatePath()) {}

  async get(): Promise<AgentViewStateFile> {
    return this.readState();
  }

  async getSession(id: string): Promise<SessionViewState | undefined> {
    return (await this.get()).sessions[id];
  }

  async getLastSelectedSessionId(): Promise<string | undefined> {
    return (await this.get()).lastSelectedSessionId;
  }

  async setLastSelectedSessionId(id: string): Promise<void> {
    await this.update((state) => {
      state.lastSelectedSessionId = id;
    });
  }

  async setName(id: string, name: string | undefined): Promise<void> {
    await this.update((state) => {
      const session = (state.sessions[id] ??= {});
      if (name) session.name = name;
      else delete session.name;
      pruneSession(state, id);
    });
  }

  async togglePinned(id: string): Promise<boolean> {
    let pinned = false;
    await this.update((state) => {
      const session = (state.sessions[id] ??= {});
      session.pinned = !session.pinned;
      pinned = session.pinned;
      pruneSession(state, id);
    });
    return pinned;
  }

  async setRuntime(id: string, status: LiveSessionStatus): Promise<void> {
    await this.update((state) => {
      const session = (state.sessions[id] ??= {});
      (session.runtimes ??= {})[String(process.pid)] = {
        pid: process.pid,
        status,
        updatedAt: Date.now(),
      };
    });
  }

  async removeRuntime(id: string): Promise<void> {
    await this.update((state) => {
      const session = state.sessions[id];
      if (!session?.runtimes) return;
      delete session.runtimes[String(process.pid)];
      if (Object.keys(session.runtimes).length === 0) delete session.runtimes;
      pruneSession(state, id);
    });
  }

  private async readState(): Promise<AgentViewStateFile> {
    const current = await readStateFile(this.filePath);
    if (current) return current;

    // Rename compatibility: preserve existing pins/names from Pi Agent View.
    if (this.filePath === defaultStatePath()) {
      return (await readStateFile(legacyStatePath())) ?? cloneEmptyState();
    }
    return cloneEmptyState();
  }

  private async update(mutator: (state: AgentViewStateFile) => void): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState();
      mutator(state);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await mkdir(dirname(this.filePath), { recursive: true });

    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      if (await recoverOrWaitForStateReaper(lockPath)) {
        await delay(LOCK_RETRY_DELAY_MS);
        continue;
      }
      const owner: StateLockOwner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
      if (await tryCreateStateLock(lockPath, owner)) {
        try {
          return await operation();
        } finally {
          if (await lockHasToken(lockPath, owner.token)) await rm(lockPath, { force: true });
        }
      }

      const existing = await readStateLock(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        await delay(LOCK_RETRY_DELAY_MS);
        continue;
      }
      if (!existing && !(await isMalformedLockStale(lockPath))) {
        await delay(LOCK_RETRY_DELAY_MS);
        continue;
      }
      await tryReapStateLock(lockPath, existing);
      await delay(LOCK_RETRY_DELAY_MS);
    }

    throw new Error(`Timed out waiting for Agent View state lock: ${lockPath}`);
  }
}

function cloneEmptyState(): AgentViewStateFile {
  return { version: 1, sessions: {} };
}

async function readStateFile(path: string): Promise<AgentViewStateFile | undefined> {
  try {
    return normalizeState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

function normalizeState(value: unknown): AgentViewStateFile {
  if (!value || typeof value !== "object") return cloneEmptyState();
  const source = value as Partial<AgentViewStateFile> & {
    sessions?: Record<string, SessionViewState & { runtime?: unknown }>;
  };
  const sessions: Record<string, SessionViewState> = {};

  if (source.sessions && typeof source.sessions === "object") {
    for (const [id, raw] of Object.entries(source.sessions)) {
      if (!raw || typeof raw !== "object") continue;
      const session: SessionViewState = {};
      if (typeof raw.name === "string" && raw.name.trim()) session.name = raw.name.trim();
      if (raw.pinned === true) session.pinned = true;

      const runtimes = normalizeRuntimes(raw.runtimes);
      // Migrate the initial V1 shape, which recorded a single runtime.
      if (!runtimes && raw.runtime && isStoredRuntime(raw.runtime)) {
        if (raw.runtime.status !== "done") {
          session.runtimes = {
            [String(raw.runtime.pid)]: {
              pid: raw.runtime.pid,
              status: raw.runtime.status,
              updatedAt: raw.runtime.updatedAt,
            },
          };
        }
      } else if (runtimes) {
        session.runtimes = runtimes;
      }

      if (Object.keys(session).length > 0) sessions[id] = session;
    }
  }

  return {
    version: 1,
    lastSelectedSessionId:
      typeof source.lastSelectedSessionId === "string" ? source.lastSelectedSessionId : undefined,
    sessions,
  };
}

function normalizeRuntimes(value: unknown): Record<string, SessionRuntime> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const runtimes: Record<string, SessionRuntime> = {};
  for (const raw of Object.values(value as Record<string, unknown>)) {
    if (!isStoredRuntime(raw) || raw.status === "done") continue;
    runtimes[String(raw.pid)] = {
      pid: raw.pid,
      status: raw.status === "working" ? "working" : "idle",
      updatedAt: raw.updatedAt,
    };
  }
  return Object.keys(runtimes).length > 0 ? runtimes : undefined;
}

function isStoredRuntime(value: unknown): value is StoredSessionRuntime {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Partial<StoredSessionRuntime>;
  return (
    typeof runtime.pid === "number" &&
    typeof runtime.updatedAt === "number" &&
    (runtime.status === "working" || runtime.status === "idle" || runtime.status === "done")
  );
}

function pruneSession(state: AgentViewStateFile, id: string): void {
  const session = state.sessions[id];
  if (!session) return;
  if (!session.name && !session.pinned && !session.runtimes) delete state.sessions[id];
}

interface StateLockOwner {
  pid: number;
  token: string;
  createdAt: number;
}

async function tryCreateStateLock(lockPath: string, owner: StateLockOwner): Promise<boolean> {
  const candidate = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
  await writeFile(candidate, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
  try {
    await link(candidate, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(candidate, { force: true });
  }
}

async function readStateLock(lockPath: string): Promise<StateLockOwner | undefined> {
  try {
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as Partial<StateLockOwner>;
    if (
      typeof payload.pid !== "number" ||
      !Number.isInteger(payload.pid) ||
      payload.pid <= 0 ||
      typeof payload.token !== "string" ||
      !payload.token ||
      typeof payload.createdAt !== "number"
    ) {
      return undefined;
    }
    return payload as StateLockOwner;
  } catch {
    return undefined;
  }
}

async function tryReapStateLock(lockPath: string, observed: StateLockOwner | undefined): Promise<void> {
  const generation = observed?.token ?? "malformed";
  const reaperPath = `${lockPath}.reap-${generation}`;
  const reaper: StateLockOwner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
  if (!(await tryCreateStateLock(reaperPath, reaper))) return;
  try {
    const current = await readStateLock(lockPath);
    if (observed) {
      if (current?.token === observed.token && !isProcessAlive(current.pid)) await rm(lockPath, { force: true });
    } else if (!current && (await isMalformedLockStale(lockPath))) {
      await rm(lockPath, { force: true });
    }
  } finally {
    if (await lockHasToken(reaperPath, reaper.token)) await rm(reaperPath, { force: true });
  }
}

async function recoverOrWaitForStateReaper(lockPath: string): Promise<boolean> {
  const prefix = `${basename(lockPath)}.reap-`;
  let markerName: string | undefined;
  try {
    markerName = (await readdir(dirname(lockPath))).find((name) => name.startsWith(prefix));
  } catch {
    return false;
  }
  if (!markerName) return false;

  const markerPath = join(dirname(lockPath), markerName);
  const takeoverMatch = markerName.match(/\.reap-takeover-(\d+)-/);
  const markerOwner = takeoverMatch ? Number(takeoverMatch[1]) : (await readStateLock(markerPath))?.pid;
  if (markerOwner !== undefined && isProcessAlive(markerOwner)) return true;
  if (markerOwner === undefined && !(await isMalformedLockStale(markerPath))) return true;

  const takeoverPath = `${lockPath}.reap-takeover-${process.pid}-${randomUUID()}`;
  try {
    await rename(markerPath, takeoverPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  try {
    const current = await readStateLock(lockPath);
    if ((current && !isProcessAlive(current.pid)) || (!current && (await isMalformedLockStale(lockPath)))) {
      await rm(lockPath, { force: true });
    }
  } finally {
    await rm(takeoverPath, { force: true });
  }
  return true;
}

async function isMalformedLockStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_AFTER_MS;
  } catch {
    return true;
  }
}

async function lockHasToken(lockPath: string, token: string): Promise<boolean> {
  return (await readStateLock(lockPath))?.token === token;
}

function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

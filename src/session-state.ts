import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
    try {
      return normalizeState(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      return cloneEmptyState();
    }
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
      try {
        const lock = await open(lockPath, "wx");
        try {
          await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        } finally {
          await lock.close();
        }

        try {
          return await operation();
        } finally {
          await rm(lockPath, { force: true });
        }
      } catch (error: unknown) {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
        if (await isStaleLock(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        await delay(LOCK_RETRY_DELAY_MS);
      }
    }

    throw new Error(`Timed out waiting for Agent View state lock: ${lockPath}`);
  }
}

function cloneEmptyState(): AgentViewStateFile {
  return { version: 1, sessions: {} };
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

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const [raw, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const payload = JSON.parse(raw) as { pid?: unknown };
    if (typeof payload.pid === "number" && isProcessAlive(payload.pid)) return false;
    return Date.now() - info.mtimeMs > LOCK_STALE_AFTER_MS || !isProcessAlive(payload.pid as number);
  } catch {
    // A vanished or malformed lock is safe to reclaim.
    return true;
  }
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

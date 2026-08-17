import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { resolveSessionStatus } from "./status.ts";
import { AgentViewStateStore, type SessionStatus } from "./session-state.ts";
import type { SessionRuntimeSnapshot, SessionRuntimeStatus } from "./runtime/session-runtime.ts";

export type PiSessionStatus = SessionStatus | SessionRuntimeStatus;

export interface SessionItem {
  id: string;
  name: string;
  status: PiSessionStatus;
  pinned: boolean;
  updatedAt: number;
}

export interface SessionProvider {
  list(): Promise<SessionItem[]>;
  open(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  getStatus(id: string): Promise<PiSessionStatus>;
}

export interface PiSessionItem extends SessionItem {
  file: string;
  cwd: string;
}

type OpenSession = (sessionPath: string) => Promise<void>;
type GetRuntimeStatus = (sessionId: string) => SessionRuntimeStatus | undefined;
type GetRuntimeSnapshots = () => readonly SessionRuntimeSnapshot[];

/** Pi-backed discovery plus process-local runtime status projection. */
export class PiSessionProvider implements SessionProvider {
  constructor(
    private readonly state: AgentViewStateStore,
    private readonly openSession: OpenSession,
    private readonly getRuntimeStatus?: GetRuntimeStatus,
    private readonly getRuntimeSnapshots?: GetRuntimeSnapshots,
  ) {}

  async list(): Promise<PiSessionItem[]> {
    const [sessions, state] = await Promise.all([SessionManager.listAll(), this.state.get()]);
    const items = sessions.map((session) => {
      const view = state.sessions[session.id];
      return {
        id: session.id,
        file: session.path,
        cwd: session.cwd,
        name: displayName(session, view?.name),
        status: this.getRuntimeStatus?.(session.id) ?? resolveSessionStatus(view),
        pinned: view?.pinned === true,
        updatedAt: session.modified.getTime(),
      } satisfies PiSessionItem;
    });

    const discoveredIds = new Set(items.map((item) => item.id));
    for (const runtime of this.getRuntimeSnapshots?.() ?? []) {
      if (discoveredIds.has(runtime.sessionId) || runtime.status === "stopped") continue;
      const view = state.sessions[runtime.sessionId];
      items.push({
        id: runtime.sessionId,
        file: runtime.sessionFile ?? "",
        cwd: runtime.cwd,
        name: view?.name?.trim() || `Session ${runtime.sessionId.slice(0, 8)}`,
        status: runtime.status,
        pinned: view?.pinned === true,
        updatedAt: Date.now(),
      });
    }

    return items.sort(compareSessions);
  }

  async open(id: string): Promise<void> {
    const session = (await SessionManager.listAll()).find((candidate) => candidate.id === id);
    if (!session) throw new Error("This session no longer exists.");
    await this.openSession(session.path);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.state.setName(id, normalizeName(name));
  }

  async getStatus(id: string): Promise<PiSessionStatus> {
    return this.getRuntimeStatus?.(id) ?? resolveSessionStatus(await this.state.getSession(id));
  }

  async togglePin(id: string): Promise<boolean> {
    return this.state.togglePinned(id);
  }
}

export function displayName(session: Pick<SessionInfo, "name" | "firstMessage">, override?: string): string {
  return override?.trim() || session.name?.trim() || summarizePrompt(session.firstMessage) || "Untitled Session";
}

export function summarizePrompt(prompt: string): string | undefined {
  const summary = prompt.replace(/\s+/g, " ").trim();
  if (!summary || summary === "(no messages)") return undefined;
  return summary;
}

function normalizeName(name: string): string {
  return name.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
}

function compareSessions(a: PiSessionItem, b: PiSessionItem): number {
  const group = sessionGroup(a) - sessionGroup(b);
  if (group !== 0) return group;
  const recentFirst = b.updatedAt - a.updatedAt;
  return recentFirst !== 0 ? recentFirst : a.name.localeCompare(b.name);
}

function sessionGroup(item: SessionItem): number {
  if (item.pinned) return 0;
  if (item.status === "working" || item.status === "starting") return 1;
  if (item.status === "idle") return 2;
  return 3;
}

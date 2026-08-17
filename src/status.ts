import type { SessionViewState } from "./session-state.ts";
import type { SessionStatus } from "./session-state.ts";

/**
 * Pi lifecycle events identify working work for processes that load this
 * extension. Pi has no public cross-process session activity registry, so a
 * session with no live Agent View runtime record is intentionally shown as
 * done (historical) rather than guessed from its modification time.
 */
export function resolveSessionStatus(viewState: SessionViewState | undefined): SessionStatus {
  const liveRuntimes = Object.values(viewState?.runtimes ?? {}).filter((runtime) => isProcessAlive(runtime.pid));
  if (liveRuntimes.some((runtime) => runtime.status === "working")) return "working";
  if (liveRuntimes.length > 0) return "idle";
  return "done";
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

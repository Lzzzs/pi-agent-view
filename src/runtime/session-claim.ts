import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const CLAIM_RETRIES = 120;
const CLAIM_RETRY_MS = 25;
const MALFORMED_CLAIM_GRACE_MS = 30_000;

interface ClaimOwner {
  managerPid: number;
  writerPid?: number;
  token: string;
  sessionId: string;
  createdAt: number;
}

interface ReaperOwner {
  managerPid: number;
  token: string;
  createdAt: number;
}

export interface SessionClaimLease {
  readonly sessionId: string;
  readonly ownerPid: number;
  setWriterPid(pid: number | undefined): Promise<void>;
  release(): Promise<void>;
}

export class SessionOwnedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly ownerPid?: number,
  ) {
    super(
      ownerPid === undefined
        ? `Session ${sessionId} is already owned by another Pi runtime.`
        : `Session ${sessionId} is already owned by live Pi process ${ownerPid}.`,
    );
    this.name = "SessionOwnedError";
  }
}

/**
 * Cooperative cross-process writer claims for Pi session JSONL files.
 *
 * A fully-written temporary owner record is hard-linked to the canonical claim
 * path. link(2) is the acquisition compare-and-set: exactly one process can
 * create the path, and readers never observe an empty initialization window.
 */
export class SessionClaimRegistry {
  constructor(private readonly claimsDir = defaultClaimsDir()) {}

  async acquire(sessionId: string): Promise<SessionClaimLease> {
    await mkdir(this.claimsDir, { recursive: true });
    const claimPath = this.pathFor(sessionId);
    const owner: ClaimOwner = {
      managerPid: process.pid,
      token: randomUUID(),
      sessionId,
      createdAt: Date.now(),
    };

    for (let attempt = 0; attempt < CLAIM_RETRIES; attempt++) {
      // A reaper marker fences the empty interval between stale-claim removal
      // and the next acquisition. Dead reapers are taken over with one atomic
      // rename whose filename identifies the new owner.
      if (await recoverOrWaitForReaper(claimPath)) {
        await delay(CLAIM_RETRY_MS);
        continue;
      }
      if (await tryAtomicCreate(claimPath, owner)) return this.lease(claimPath, owner);

      const existing = await readOwner(claimPath);
      if (existing && ownerIsAlive(existing)) {
        throw new SessionOwnedError(sessionId, liveOwnerPid(existing));
      }
      if (!existing && (await ageMs(claimPath)) < MALFORMED_CLAIM_GRACE_MS) {
        await delay(CLAIM_RETRY_MS);
        continue;
      }

      if (existing) await tryReapClaim(claimPath, existing);
      else await tryReapMalformedClaim(claimPath);
      await delay(CLAIM_RETRY_MS);
    }

    throw new SessionOwnedError(sessionId);
  }

  private lease(claimPath: string, initialOwner: ClaimOwner): SessionClaimLease {
    let owner = initialOwner;
    let released = false;
    return {
      sessionId: owner.sessionId,
      ownerPid: owner.managerPid,
      setWriterPid: async (pid) => {
        if (released) return;
        const current = await readOwner(claimPath);
        if (!current || current.token !== owner.token || current.managerPid !== owner.managerPid) {
          throw new Error(`Lost ownership claim for session ${owner.sessionId}.`);
        }
        owner = { ...owner, ...(pid === undefined ? {} : { writerPid: pid }) };
        if (pid === undefined) delete owner.writerPid;
        await atomicReplace(claimPath, owner);
      },
      release: async () => {
        if (released) return;
        released = true;
        const current = await readOwner(claimPath);
        if (!current || current.token !== owner.token || current.managerPid !== owner.managerPid) return;
        await rm(claimPath, { force: true });
      },
    };
  }

  private pathFor(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(this.claimsDir, `${digest}.claim`);
  }
}

function defaultClaimsDir(): string {
  return join(homedir(), ".pi", "agents-view", "claims");
}

async function tryAtomicCreate(path: string, value: object): Promise<boolean> {
  const candidate = `${path}.candidate-${process.pid}-${randomUUID()}`;
  await writeFile(candidate, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  try {
    await link(candidate, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(candidate, { force: true });
  }
}

async function atomicReplace(path: string, value: object): Promise<void> {
  const candidate = `${path}.replace-${process.pid}-${randomUUID()}`;
  await writeFile(candidate, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  try {
    await rename(candidate, path);
  } finally {
    await rm(candidate, { force: true });
  }
}

async function tryReapClaim(claimPath: string, observed: ClaimOwner): Promise<void> {
  const markerPath = `${claimPath}.reap-${createHash("sha256").update(observed.token).digest("hex").slice(0, 16)}`;
  const reaper: ReaperOwner = { managerPid: process.pid, token: randomUUID(), createdAt: Date.now() };
  if (!(await tryAtomicCreate(markerPath, reaper))) return;
  try {
    const current = await readOwner(claimPath);
    if (current?.token === observed.token && !ownerIsAlive(current)) await rm(claimPath, { force: true });
  } finally {
    await releaseInitialReaper(markerPath, reaper);
  }
}

async function tryReapMalformedClaim(claimPath: string): Promise<void> {
  const markerPath = `${claimPath}.reap-malformed`;
  const reaper: ReaperOwner = { managerPid: process.pid, token: randomUUID(), createdAt: Date.now() };
  if (!(await tryAtomicCreate(markerPath, reaper))) return;
  try {
    if (!(await readOwner(claimPath)) && (await ageMs(claimPath)) >= MALFORMED_CLAIM_GRACE_MS) {
      await rm(claimPath, { force: true });
    }
  } finally {
    await releaseInitialReaper(markerPath, reaper);
  }
}

async function recoverOrWaitForReaper(claimPath: string): Promise<boolean> {
  const prefix = `${basename(claimPath)}.reap-`;
  let markerName: string | undefined;
  try {
    markerName = (await readdir(dirname(claimPath))).find((name) => name.startsWith(prefix));
  } catch {
    return false;
  }
  if (!markerName) return false;

  const markerPath = join(dirname(claimPath), markerName);
  const markerPid = await reaperPid(markerPath);
  if (markerPid !== undefined && isProcessAlive(markerPid)) return true;
  if (markerPid === undefined && (await ageMs(markerPath)) < MALFORMED_CLAIM_GRACE_MS) return true;

  const takeoverPath = `${claimPath}.reap-takeover-${process.pid}-${randomUUID()}`;
  try {
    await rename(markerPath, takeoverPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  // The takeover filename itself is the atomic ownership record. Other
  // contenders see this live PID and cannot replace or remove the marker.
  try {
    const current = await readOwner(claimPath);
    if ((current && !ownerIsAlive(current)) || (!current && (await ageMs(claimPath)) >= MALFORMED_CLAIM_GRACE_MS)) {
      await rm(claimPath, { force: true });
    }
  } finally {
    await rm(takeoverPath, { force: true });
  }
  return true;
}

async function reaperPid(markerPath: string): Promise<number | undefined> {
  const match = basename(markerPath).match(/\.reap-takeover-(\d+)-/);
  if (match) return Number(match[1]);
  return (await readReaper(markerPath))?.managerPid;
}

async function releaseInitialReaper(path: string, owner: ReaperOwner): Promise<void> {
  const current = await readReaper(path);
  if (current?.token === owner.token && current.managerPid === owner.managerPid) await rm(path, { force: true });
}

async function readOwner(path: string): Promise<ClaimOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ClaimOwner> & { pid?: unknown };
    const managerPid = typeof value.managerPid === "number" ? value.managerPid : value.pid;
    if (
      typeof managerPid !== "number" ||
      !Number.isInteger(managerPid) ||
      managerPid <= 0 ||
      (value.writerPid !== undefined &&
        (typeof value.writerPid !== "number" || !Number.isInteger(value.writerPid) || value.writerPid <= 0)) ||
      typeof value.token !== "string" ||
      !value.token ||
      typeof value.sessionId !== "string" ||
      typeof value.createdAt !== "number"
    ) {
      return undefined;
    }
    return {
      managerPid,
      ...(typeof value.writerPid === "number" ? { writerPid: value.writerPid } : {}),
      token: value.token,
      sessionId: value.sessionId,
      createdAt: value.createdAt,
    };
  } catch {
    return undefined;
  }
}

async function readReaper(path: string): Promise<ReaperOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ReaperOwner>;
    if (
      typeof value.managerPid !== "number" ||
      !Number.isInteger(value.managerPid) ||
      value.managerPid <= 0 ||
      typeof value.token !== "string" ||
      !value.token ||
      typeof value.createdAt !== "number"
    ) {
      return undefined;
    }
    return value as ReaperOwner;
  } catch {
    return undefined;
  }
}

function ownerIsAlive(owner: ClaimOwner): boolean {
  return isProcessAlive(owner.managerPid) || (owner.writerPid !== undefined && isProcessAlive(owner.writerPid));
}

function liveOwnerPid(owner: ClaimOwner): number {
  if (isProcessAlive(owner.managerPid)) return owner.managerPid;
  return owner.writerPid ?? owner.managerPid;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function ageMs(path: string): Promise<number> {
  try {
    return Math.max(0, Date.now() - (await stat(path)).mtimeMs);
  } catch {
    return 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

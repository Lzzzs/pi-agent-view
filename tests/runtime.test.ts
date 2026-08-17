import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRuntimeAutocompleteProvider } from "../src/runtime/runtime-autocomplete.ts";
import { PiRpcWorker } from "../src/runtime/pi-worker.ts";
import { SessionClaimRegistry, SessionOwnedError } from "../src/runtime/session-claim.ts";
import { DefaultSessionRuntimeManager } from "../src/runtime/runtime-manager.ts";
import { RpcSessionRuntime } from "../src/runtime/session-runtime.ts";
import { PiSessionProvider } from "../src/session-provider.ts";
import { AgentViewStateStore } from "../src/session-state.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCli = join(here, "fixtures", "fake-pi-rpc.mjs");

function createRuntime(
  cwd: string,
  sessionId: string,
  delayMs = 350,
  extraEnv: Record<string, string> = {},
): RpcSessionRuntime {
  return new RpcSessionRuntime({
    cwd,
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    worker: new PiRpcWorker({
      cwd,
      cliPath: fakeCli,
      env: { FAKE_SESSION_ID: sessionId, FAKE_DELAY_MS: String(delayMs), ...extraEnv },
    }),
  });
}

test("detach preserves a working runtime and its session identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-runtime-"));
  const runtime = createRuntime(cwd, "session-a");
  try {
    await runtime.start();
    const external = runtime.getSnapshot();
    if (external.state) external.state.sessionId = "mutated-outside-runtime";
    assert.equal(runtime.getSnapshot().state?.sessionId, "session-a");
    await runtime.attach();
    await runtime.send("long task");
    assert.equal(runtime.status, "working");
    assert.match(JSON.stringify(runtime.getSnapshot().streamingMessage), /working:session-a/);
    assert.equal(runtime.getSnapshot().attached, true);

    await runtime.detach();
    assert.equal(runtime.status, "working", "detach must not settle or stop the worker");
    assert.equal(runtime.sessionId, "session-a");
    assert.equal(runtime.getSnapshot().attached, false);

    await delay(500);
    assert.equal(runtime.status, "idle");
    assert.equal(runtime.sessionId, "session-a");
    assert.match(JSON.stringify(runtime.getSnapshot().messages), /done:session-a/);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime autocomplete exposes native, extension, skill, model, and file-aware commands", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-autocomplete-"));
  const runtime = createRuntime(cwd, "session-autocomplete");
  try {
    await writeFile(join(cwd, "autocomplete-file.txt"), "test");
    await runtime.start();
    const provider = createRuntimeAutocompleteProvider(runtime.getSnapshot());
    const signal = new AbortController().signal;
    const commands = await provider.getSuggestions(["/"], 0, 1, { signal });
    assert.ok(commands?.items.some((item) => item.value === "model"));
    assert.ok(commands?.items.some((item) => item.value === "fake-command"));
    assert.ok(commands?.items.some((item) => item.value === "skill:fake"));
    assert.ok(!commands?.items.some((item) => item.value === "settings"), "foreground-only commands must be absent");

    const filtered = await provider.getSuggestions(["/fake"], 0, 5, { signal });
    assert.equal(filtered?.items[0]?.value, "fake-command");

    const models = await provider.getSuggestions(["/model model"], 0, 12, { signal });
    assert.ok(models?.items.some((item) => item.value === "fake/model-a"));
    assert.ok(models?.items.some((item) => item.value === "fake/model-b"));

    const files = await provider.getSuggestions(["@autocomplete-f"], 0, 15, { signal });
    assert.ok(files?.items.some((item) => item.value.includes("autocomplete-file.txt")));
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("catalog failures do not prevent a runtime from starting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-catalog-failure-"));
  const runtime = createRuntime(cwd, "session-catalog-failure", 20, { FAKE_CATALOG_FAILURE: "1" });
  try {
    await runtime.start();
    assert.equal(runtime.status, "idle");
    assert.deepEqual(runtime.getSnapshot().commands, []);
    assert.deepEqual(runtime.getSnapshot().availableModels, []);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reattaching refreshes command and model catalogs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-catalog-refresh-"));
  const runtime = createRuntime(cwd, "session-catalog-refresh", 20, { FAKE_ROTATE_COMMANDS: "1" });
  try {
    await runtime.start();
    assert.ok(runtime.getSnapshot().commands.some((command) => command.name === "fake-command"));
    await runtime.attach();
    const snapshot = runtime.getSnapshot();
    assert.ok(snapshot.commands.some((command) => command.name === "refreshed-command"));
    assert.ok(!snapshot.commands.some((command) => command.name === "fake-command"));
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("attach-view built-in slash commands execute through RPC instead of becoming prompts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-builtin-commands-"));
  const runtime = createRuntime(cwd, "session-builtin-commands", 20);
  try {
    await runtime.start();
    await runtime.send("/name Background Work");
    assert.equal(runtime.getSnapshot().state?.sessionName, "Background Work");
    await runtime.send("/model fake/model-b");
    assert.equal(runtime.getSnapshot().state?.model?.id, "model-b");
    await runtime.send("/export /tmp/background.html");
    assert.match(runtime.getSnapshot().notice ?? "", /background\.html/);
    await runtime.send("/session");
    assert.match(runtime.getSnapshot().notice ?? "", /messages/);
    await runtime.send("/compact keep decisions");
    assert.equal(runtime.getSnapshot().state?.isCompacting, false);
    assert.equal(runtime.getSnapshot().messages.length, 0, "built-in commands must not be appended as user prompts");

    await runtime.send("/fake-command");
    assert.match(JSON.stringify(runtime.getSnapshot().messages), /\/fake-command/);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("streamed tool-call argument deltas are reconstructed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-tool-delta-"));
  const runtime = createRuntime(cwd, "session-tool-delta");
  try {
    await runtime.start();
    await runtime.send("stream-tool-args");
    const serialized = JSON.stringify(runtime.getSnapshot().streamingMessage);
    assert.match(serialized, /call-x/);
    assert.match(serialized, /\"path\":\"x\"/);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a fast settled agent error remains failed after send reads state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-agent-error-"));
  const runtime = createRuntime(cwd, "session-error");
  try {
    await runtime.start();
    await runtime.send("agent-error");
    assert.equal(runtime.status, "failed");
    assert.match(runtime.getSnapshot().error ?? "", /synthetic agent failure/);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("parallel tool results with the same timestamp are not deduplicated", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-tool-results-"));
  const runtime = createRuntime(cwd, "session-tool-results");
  try {
    await runtime.start();
    await runtime.send("parallel-results");
    const results = runtime
      .getSnapshot()
      .messages.filter((message) => message && typeof message === "object" && (message as { role?: unknown }).role === "toolResult");
    assert.equal(results.length, 2);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("same-role messages with the same timestamp remain distinct", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-same-timestamp-"));
  const runtime = createRuntime(cwd, "session-same-timestamp");
  try {
    await runtime.start();
    await runtime.send("same-timestamp-users");
    const serialized = JSON.stringify(runtime.getSnapshot().messages);
    assert.match(serialized, /queued-a/);
    assert.match(serialized, /queued-b/);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("successful compaction reloads the authoritative message snapshot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-compaction-"));
  const runtime = createRuntime(cwd, "session-compaction");
  try {
    await runtime.start();
    await runtime.send("compact");
    await delay(100);
    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.state?.isCompacting, false);
    assert.equal(snapshot.messages.length, 1);
    assert.match(JSON.stringify(snapshot.messages), /compacted transcript/);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("compaction refresh cannot overwrite newer post-compaction messages", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-compaction-race-"));
  const runtime = createRuntime(cwd, "session-compaction-race", 20);
  try {
    await runtime.start();
    await runtime.send("compact-race");
    await runtime.send("fast-after-compaction");
    await delay(250);
    const serialized = JSON.stringify(runtime.getSnapshot().messages);
    assert.match(serialized, /compacted transcript/);
    assert.match(serialized, /fast-after-compaction-complete/);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("messages submitted during compaction queue and flush afterward", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-compaction-queue-"));
  const runtime = createRuntime(cwd, "session-compaction-queue", 30);
  try {
    await runtime.start();
    await runtime.send("slow-compact");
    assert.equal(runtime.getSnapshot().state?.isCompacting, true);
    await runtime.send("queued-during-compaction");
    assert.match(JSON.stringify(runtime.getSnapshot().pendingMessages), /queued-during-compaction/);
    await delay(300);
    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.pendingMessages.steering.length, 0);
    assert.match(JSON.stringify(snapshot.messages), /done:session-compaction-queue/);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a failed compaction-queue flush preserves every queued message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-compaction-queue-failure-"));
  const runtime = createRuntime(cwd, "session-compaction-queue-failure", 30);
  try {
    await runtime.start();
    await runtime.send("slow-compact");
    await runtime.send("reject-queued");
    await runtime.send("still-queued");
    await delay(180);
    const pending = JSON.stringify(runtime.getSnapshot().pendingMessages);
    assert.match(pending, /reject-queued/);
    assert.match(pending, /still-queued/);
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("three sessions run concurrently and detach independently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-concurrent-"));
  const runtimes = [createRuntime(cwd, "session-a", 450), createRuntime(cwd, "session-b", 500), createRuntime(cwd, "session-c", 550)];
  try {
    await Promise.all(runtimes.map((runtime) => runtime.start()));
    await Promise.all(runtimes.map((runtime) => runtime.attach()));
    await Promise.all(runtimes.map((runtime, index) => runtime.send(`task-${index}`)));
    assert.deepEqual(runtimes.map((runtime) => runtime.status), ["working", "working", "working"]);

    await Promise.all(runtimes.map((runtime) => runtime.detach()));
    assert.deepEqual(
      runtimes.map((runtime) => runtime.status),
      ["working", "working", "working"],
      "detaching all views must leave all workers running",
    );

    await delay(700);
    assert.deepEqual(runtimes.map((runtime) => runtime.status), ["idle", "idle", "idle"]);
  } finally {
    await Promise.allSettled(runtimes.map((runtime) => runtime.shutdown()));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session claims reject a second writer and release cleanly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-claims-"));
  const firstRegistry = new SessionClaimRegistry(join(cwd, "claims"));
  const secondRegistry = new SessionClaimRegistry(join(cwd, "claims"));
  const first = await firstRegistry.acquire("claimed-session");
  try {
    await assert.rejects(secondRegistry.acquire("claimed-session"), SessionOwnedError);
  } finally {
    await first.release();
  }
  const second = await secondRegistry.acquire("claimed-session");
  await second.release();

  const childOwnedId = "child-still-writing";
  const childOwnedPath = join(
    cwd,
    "claims",
    `${createHash("sha256").update(childOwnedId).digest("hex")}.claim`,
  );
  await mkdir(join(cwd, "claims"), { recursive: true });
  await writeFile(
    childOwnedPath,
    JSON.stringify({
      managerPid: 2_147_483_647,
      writerPid: process.pid,
      token: randomUUID(),
      sessionId: childOwnedId,
      createdAt: Date.now(),
    }),
  );
  await assert.rejects(secondRegistry.acquire(childOwnedId), SessionOwnedError);
  await rm(childOwnedPath, { force: true });

  const legacyId = "legacy-directory-claim";
  const legacyPath = join(cwd, "claims", `${createHash("sha256").update(legacyId).digest("hex")}.claim`);
  await mkdir(legacyPath);
  await writeFile(
    join(legacyPath, "owner.json"),
    JSON.stringify({ pid: process.pid, token: randomUUID(), sessionId: legacyId, createdAt: Date.now() }),
  );
  await assert.rejects(secondRegistry.acquire(legacyId), SessionOwnedError);
  await rm(legacyPath, { recursive: true, force: true });

  const staleId = "stale-reaper-session";
  const staleToken = randomUUID();
  const stalePath = join(cwd, "claims", `${createHash("sha256").update(staleId).digest("hex")}.claim`);
  await writeFile(
    stalePath,
    JSON.stringify({ managerPid: 2_147_483_647, token: staleToken, sessionId: staleId, createdAt: 1 }),
  );
  await writeFile(
    `${stalePath}.reap-${createHash("sha256").update(staleToken).digest("hex").slice(0, 16)}`,
    JSON.stringify({ managerPid: 2_147_483_647, token: randomUUID(), createdAt: 1 }),
  );
  const recovered = await secondRegistry.acquire(staleId);
  await recovered.release();
  assert.deepEqual(await readdir(join(cwd, "claims")), []);
  await rm(cwd, { recursive: true, force: true });
});

test("state metadata lock recovers a dead reaper without losing updates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-state-lock-"));
  const statePath = join(cwd, "state.json");
  const lockPath = `${statePath}.lock`;
  const staleToken = randomUUID();
  await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: staleToken, createdAt: 1 }));
  await writeFile(
    `${lockPath}.reap-${staleToken}`,
    JSON.stringify({ pid: 2_147_483_647, token: randomUUID(), createdAt: 1 }),
  );
  const state = new AgentViewStateStore(statePath);
  await state.setName("session", "preserved");
  assert.equal((await state.getSession("session"))?.name, "preserved");
  assert.deepEqual((await readdir(cwd)).sort(), ["state.json"]);
  await rm(cwd, { recursive: true, force: true });
});

test("foreground host sessions participate in cross-manager claims", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-host-claims-"));
  const claimsDir = join(cwd, "claims");
  const first = new DefaultSessionRuntimeManager(undefined, new SessionClaimRegistry(claimsDir));
  const second = new DefaultSessionRuntimeManager(undefined, new SessionClaimRegistry(claimsDir));
  try {
    await first.registerHost("foreground-session");
    await assert.rejects(second.reserveHost("foreground-session"), SessionOwnedError);
    await assert.rejects(second.registerHost("foreground-session"), SessionOwnedError);
    await first.unregisterHost("foreground-session");
    await second.reserveHost("foreground-session");
    await second.registerHost("foreground-session");
  } finally {
    await Promise.all([first.shutdownAll(), second.shutdownAll()]);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("SessionRuntimeManager detach keeps multiple managed workers active", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-manager-"));
  const manager = new DefaultSessionRuntimeManager(
    (options) =>
      new RpcSessionRuntime({
        ...options,
        worker: new PiRpcWorker({
          cwd: options.cwd,
          cliPath: fakeCli,
          env: { FAKE_SESSION_ID: options.sessionId, FAKE_DELAY_MS: "450" },
        }),
      }),
    new SessionClaimRegistry(join(cwd, "claims")),
  );
  try {
    const [a, b] = await Promise.all([manager.create(cwd), manager.create(cwd)]);
    const state = new AgentViewStateStore(join(cwd, "state.json"));
    await state.setName(a.sessionId, "runtime-only session");
    const provider = new PiSessionProvider(
      state,
      async () => {},
      (id) => manager.getStatus(id),
      () => manager.listSnapshots(),
    );
    const runtimeOnlyItem = (await provider.list()).find((item) => item.id === a.sessionId);
    assert.equal(runtimeOnlyItem?.name, "runtime-only session");
    assert.equal(runtimeOnlyItem?.status, "idle");

    await Promise.all([a.send("task-a"), b.send("task-b")]);
    await Promise.all([manager.attach(a.sessionId), manager.attach(b.sessionId)]);
    await Promise.all([manager.detach(a.sessionId), manager.detach(b.sessionId)]);
    assert.equal(manager.getStatus(a.sessionId), "working");
    assert.equal(manager.getStatus(b.sessionId), "working");
    await delay(600);
    assert.equal(manager.getStatus(a.sessionId), "idle");
    assert.equal(manager.getStatus(b.sessionId), "idle");
  } finally {
    await manager.shutdownAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shutdown waits for an in-flight worker start and leaves no claim", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-shutdown-"));
  const claimsDir = join(cwd, "claims");
  const manager = new DefaultSessionRuntimeManager(
    (options) =>
      new RpcSessionRuntime({
        ...options,
        worker: new PiRpcWorker({
          cwd: options.cwd,
          cliPath: fakeCli,
          env: { FAKE_SESSION_ID: options.sessionId, FAKE_START_DELAY_MS: "60000" },
        }),
      }),
    new SessionClaimRegistry(claimsDir),
  );
  try {
    const starting = manager.create(cwd);
    await delay(30);
    const startedAt = Date.now();
    const shutdown = manager.shutdownAll();
    await assert.rejects(starting);
    await shutdown;
    assert.ok(Date.now() - startedAt < 3_000, "shutdown must cancel an unresponsive readiness request");
    assert.deepEqual(await readdir(claimsDir), []);
  } finally {
    await manager.shutdownAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a crashed managed worker is replaced without changing session ID", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-recovery-"));
  const manager = new DefaultSessionRuntimeManager(
    (options) =>
      new RpcSessionRuntime({
        ...options,
        worker: new PiRpcWorker({
          cwd: options.cwd,
          cliPath: fakeCli,
          env: { FAKE_SESSION_ID: options.sessionId, FAKE_DELAY_MS: "300" },
        }),
      }),
    new SessionClaimRegistry(join(cwd, "claims")),
  );
  try {
    const first = await manager.create(cwd);
    const sessionId = first.sessionId;
    await first.send("crash");
    await delay(160);
    assert.equal(first.getSnapshot().workerAlive, false);

    const recovered = await manager.getOrCreate(sessionId);
    assert.notEqual(recovered, first);
    assert.equal(recovered.sessionId, sessionId);
    assert.equal(recovered.status, "idle");
    assert.equal(recovered.getSnapshot().workerAlive, true);
  } finally {
    await manager.shutdownAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("one worker crash is isolated from other sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-isolation-"));
  const crashed = createRuntime(cwd, "session-crash", 600);
  const healthy = createRuntime(cwd, "session-healthy", 450);
  try {
    await Promise.all([crashed.start(), healthy.start()]);
    await Promise.all([crashed.send("crash"), healthy.send("healthy task")]);
    await delay(180);
    assert.equal(crashed.status, "failed");
    assert.equal(healthy.status, "working", "a sibling crash must not stop another worker");
    await delay(450);
    assert.equal(healthy.status, "idle");
  } finally {
    await Promise.allSettled([crashed.shutdown(), healthy.shutdown()]);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("real manager owns and releases an installed Pi RPC worker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-real-manager-"));
  const claimsDir = join(cwd, "claims");
  const manager = new DefaultSessionRuntimeManager(undefined, new SessionClaimRegistry(claimsDir));
  try {
    const runtime = await manager.create(cwd);
    assert.equal(runtime.status, "idle");
    assert.equal(runtime.getSnapshot().workerAlive, true);
    assert.equal((await readdir(claimsDir)).filter((name) => name.endsWith(".claim")).length, 1);
  } finally {
    await manager.shutdownAll();
    assert.deepEqual(await readdir(claimsDir), []);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("installed Pi RPC starts a preassigned session headlessly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agents-view-pi-smoke-"));
  const sessionId = randomUUID();
  const worker = new PiRpcWorker({ cwd, sessionId, requestTimeoutMs: 60_000 });
  try {
    const { state } = await worker.start();
    assert.equal(state.sessionId, sessionId);
    assert.match(state.sessionFile ?? "", new RegExp(`${sessionId}\\.jsonl$`));
    assert.equal(state.isStreaming, false);
  } finally {
    await worker.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

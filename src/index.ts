import { resolve } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionBoard, type BoardAction } from "./board.ts";
import { installBackToBoardEditor } from "./keybindings.ts";
import { SessionOwnedError } from "./runtime/session-claim.ts";
import { getSessionRuntimeManager, type DefaultSessionRuntimeManager } from "./runtime/runtime-manager.ts";
import { RuntimeView, type RuntimeViewAction } from "./runtime/runtime-view.ts";
import type { SessionRuntime } from "./runtime/session-runtime.ts";
import { PiSessionProvider, type PiSessionItem } from "./session-provider.ts";
import { AgentViewStateStore } from "./session-state.ts";

const FULLSCREEN_OVERLAY = {
  overlay: true as const,
  overlayOptions: {
    width: "100%" as const,
    maxHeight: "100%" as const,
    row: 0,
    col: 0,
    margin: 0,
  },
};

export default function agentView(pi: ExtensionAPI): void {
  const state = new AgentViewStateStore();
  const runtimes = getSessionRuntimeManager();
  const unsafeHostSessions = new Set<string>();

  pi.registerCommand("agents-new-safe", {
    description: "Recover from a session ownership conflict",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  pi.registerCommand("agents", {
    description: "Open the terminal Session Board",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Session Board is available in Pi's terminal UI only.", "warning");
        return;
      }
      await showBoard(ctx, state, runtimes);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (process.env.PI_AGENTS_VIEW_WORKER !== "1") {
      try {
        await runtimes.registerHost(sessionId);
        unsafeHostSessions.delete(sessionId);
      } catch (error) {
        unsafeHostSessions.add(sessionId);
        const ownershipConflict = error instanceof SessionOwnedError;
        ctx.ui.notify(
          `${error instanceof Error ? error.message : String(error)} ${
            ownershipConflict ? "Moving to a clean session." : "Input is disabled to prevent an unclaimed writer."
          }`,
          "error",
        );
        if (ownershipConflict) {
          queueMicrotask(() => pi.sendUserMessage("/agents-new-safe", { expandPromptTemplates: true }));
        }
      }
    } else {
      // The owning parent holds the cooperative claim for this RPC writer.
      runtimes.setHostStatus(sessionId, "idle");
    }
    await markCurrentSession(state, ctx, "idle");
    if (ctx.mode !== "tui") return;

    installBackToBoardEditor(pi, ctx);

    if (event.reason === "startup" && !unsafeHostSessions.has(sessionId)) {
      queueMicrotask(() => {
        pi.sendUserMessage("/agents", { expandPromptTemplates: true });
      });
    }
  });

  pi.on("input", async (_event, ctx) => {
    if (!unsafeHostSessions.has(ctx.sessionManager.getSessionId())) return { action: "continue" };
    ctx.ui.notify("Input blocked because this session is owned by another live writer.", "error");
    return { action: "handled" };
  });

  // These are real Pi lifecycle events. Detaching never changes them.
  pi.on("agent_start", async (_event, ctx) => {
    await markCurrentSession(state, ctx, "working");
    runtimes.setHostStatus(ctx.sessionManager.getSessionId(), "working");
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await markCurrentSession(state, ctx, "idle");
    runtimes.setHostStatus(ctx.sessionManager.getSessionId(), "idle");
  });

  // A native switch to a worker-owned JSONL would create two unsynchronized
  // writers. Pi session files have no writer lock, so keep ownership exclusive.
  pi.on("session_before_switch", async (event, ctx) => {
    if (!event.targetSessionFile) return;
    const targetFile = resolve(event.targetSessionFile);
    const target = (await SessionManager.listAll()).find((session) => resolve(session.path) === targetFile);
    if (runtimes.ownsSessionFile(targetFile)) {
      ctx.ui.notify("That session is owned by a background runtime. Open it from /agents instead.", "warning");
      return { cancel: true };
    }
    if (target && target.id !== ctx.sessionManager.getSessionId()) {
      try {
        // Reserve before Pi tears down the old runtime. session_start promotes
        // this exact claim, closing the check/open race between processes.
        await runtimes.reserveHost(target.id);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return { cancel: true };
      }
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (event.reason !== "reload") {
      unsafeHostSessions.delete(sessionId);
      await removeCurrentRuntime(state, ctx);
      if (process.env.PI_AGENTS_VIEW_WORKER !== "1") await runtimes.unregisterHost(sessionId);
    }
    // V1 workers intentionally live only as long as this owning Pi process.
    if (event.reason === "quit") await runtimes.shutdownAll();
  });
}

async function showBoard(
  ctx: ExtensionCommandContext,
  state: AgentViewStateStore,
  runtimes: DefaultSessionRuntimeManager,
): Promise<void> {
  const provider = new PiSessionProvider(
    state,
    async (sessionPath) => {
      await ctx.switchSession(sessionPath);
    },
    (sessionId) => runtimes.getStatus(sessionId),
    () => runtimes.listSnapshots(),
  );

  const hostSessionId = ctx.sessionManager.getSessionId();
  let selectedId = (await state.getLastSelectedSessionId()) ?? hostSessionId;

  while (true) {
    const sessions = await provider.list();
    const action = await showBoardOverlay(ctx, provider, runtimes, sessions, selectedId);
    if (!action || action.type === "close") return;

    if (action.type === "new") {
      try {
        const runtime = await runtimes.create(ctx.cwd);
        selectedId = runtime.sessionId;
        await state.setLastSelectedSessionId(selectedId);
        await provider.rename(selectedId, summarizeTask(action.prompt));
        try {
          await runtime.send(action.prompt);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        await attachRuntimeView(ctx, runtimes, runtime, summarizeTask(action.prompt));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      continue;
    }

    selectedId = action.id;
    await state.setLastSelectedSessionId(selectedId);

    if (action.type === "pin") {
      await provider.togglePin(action.id);
      continue;
    }

    if (action.type === "rename") {
      const item = sessions.find((session) => session.id === action.id);
      if (!item) continue;
      const name = await ctx.ui.input("Rename session", item.name);
      if (name !== undefined) await provider.rename(action.id, name);
      continue;
    }

    // The native host runtime is already attached beneath the Board overlay.
    // Closing the Board reveals it without replacement, abort, or re-prompt.
    if (action.id === hostSessionId) return;

    const item = sessions.find((session) => session.id === action.id);
    try {
      // getOrCreate acquires an atomic cross-process claim before opening the
      // JSONL, so this remains safe even if the Board snapshot is stale.
      const runtime = await runtimes.getOrCreate(action.id);
      await attachRuntimeView(ctx, runtimes, runtime, item?.name ?? "Pi Session");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

async function showBoardOverlay(
  ctx: ExtensionCommandContext,
  provider: PiSessionProvider,
  runtimes: DefaultSessionRuntimeManager,
  initialSessions: PiSessionItem[],
  selectedId: string | undefined,
): Promise<BoardAction | undefined> {
  let unsubscribe = () => {};
  let active = true;
  let refreshing = false;
  let refreshAgain = false;

  const action = await ctx.ui.custom<BoardAction>(
    (tui, theme, _keybindings, done) => {
      const board = new SessionBoard(
        initialSessions,
        selectedId,
        { cwd: ctx.cwd },
        theme,
        done,
        () => tui.requestRender(),
        () => tui.terminal.rows,
      );

      const refresh = async (): Promise<void> => {
        if (!active) return;
        if (refreshing) {
          refreshAgain = true;
          return;
        }
        refreshing = true;
        try {
          const sessions = await provider.list();
          if (active) {
            board.setSessions(sessions);
            tui.requestRender();
          }
        } catch {
          // Keep the last consistent Board snapshot; the next lifecycle event
          // retries discovery without turning a background error into a crash.
        } finally {
          refreshing = false;
          if (refreshAgain) {
            refreshAgain = false;
            void refresh();
          }
        }
      };
      unsubscribe = runtimes.subscribe(() => void refresh());
      return board;
    },
    FULLSCREEN_OVERLAY,
  );

  active = false;
  unsubscribe();
  return action;
}

async function attachRuntimeView(
  ctx: ExtensionCommandContext,
  runtimes: DefaultSessionRuntimeManager,
  runtime: SessionRuntime,
  sessionName: string,
): Promise<void> {
  await runtimes.attach(runtime.sessionId);
  let view: RuntimeView | undefined;
  try {
    await ctx.ui.custom<RuntimeViewAction>(
      (tui, theme, keybindings, done) => {
        view = new RuntimeView(
          runtime,
          sessionName,
          theme,
          tui,
          keybindings,
          done,
          () => tui.requestRender(),
          () => tui.terminal.rows,
        );
        return view;
      },
      FULLSCREEN_OVERLAY,
    );
  } finally {
    view?.dispose();
    // This is the core invariant: detach only drops UI ownership. It does not
    // abort, settle, stop, or dispose the underlying Pi RPC worker.
    await runtimes.detach(runtime.sessionId);
  }
}

function summarizeTask(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  return text.length <= 60 ? text : `${text.slice(0, 57)}…`;
}

async function markCurrentSession(
  state: AgentViewStateStore,
  ctx: ExtensionContext,
  status: "working" | "idle",
): Promise<void> {
  if (!ctx.sessionManager.getSessionFile()) return;
  await state.setRuntime(ctx.sessionManager.getSessionId(), status);
}

async function removeCurrentRuntime(state: AgentViewStateStore, ctx: ExtensionContext): Promise<void> {
  if (!ctx.sessionManager.getSessionFile()) return;
  await state.removeRuntime(ctx.sessionManager.getSessionId());
}

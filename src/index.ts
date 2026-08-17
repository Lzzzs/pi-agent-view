import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionBoard, type BoardAction } from "./board.ts";
import { installBackToBoardEditor } from "./keybindings.ts";
import { PiSessionProvider } from "./session-provider.ts";
import { AgentViewStateStore } from "./session-state.ts";

export default function agentView(pi: ExtensionAPI): void {
  const state = new AgentViewStateStore();

  pi.registerCommand("agents", {
    description: "Open the terminal Session Board",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Session Board is available in Pi's terminal UI only.", "warning");
        return;
      }
      await showBoard(ctx, state);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await markCurrentSession(state, ctx, "idle");
    if (ctx.mode === "tui") installBackToBoardEditor(pi, ctx);
  });

  // These are Pi lifecycle events, not timestamp heuristics.
  pi.on("agent_start", async (_event, ctx) => {
    await markCurrentSession(state, ctx, "working");
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await markCurrentSession(state, ctx, "idle");
  });
  pi.on("session_shutdown", async (event, ctx) => {
    // /reload immediately binds a new runtime to the same session; do not show
    // a transient false "done" state during that operation.
    if (event.reason !== "reload") await removeCurrentRuntime(state, ctx);
  });
}

async function showBoard(ctx: ExtensionCommandContext, state: AgentViewStateStore): Promise<void> {
  const provider = new PiSessionProvider(state, async (sessionPath) => {
    await ctx.switchSession(sessionPath);
  });

  let selectedId = (await state.getLastSelectedSessionId()) ?? ctx.sessionManager.getSessionId();
  while (true) {
    const sessions = await provider.list();
    const action = await ctx.ui.custom<BoardAction>((tui, theme, _keybindings, done) =>
      new SessionBoard(sessions, selectedId, theme, done, () => tui.requestRender()),
    );

    if (!action || action.type === "close") return;
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

    if (action.id === ctx.sessionManager.getSessionId()) return;
    await provider.open(action.id);
    return; // ctx is stale after a real session switch.
  }
}

async function markCurrentSession(
  state: AgentViewStateStore,
  ctx: ExtensionContext,
  status: "working" | "idle",
): Promise<void> {
  // Ephemeral Pi sessions are not discoverable by SessionManager.listAll().
  if (!ctx.sessionManager.getSessionFile()) return;
  await state.setRuntime(ctx.sessionManager.getSessionId(), status);
}

async function removeCurrentRuntime(state: AgentViewStateStore, ctx: ExtensionContext): Promise<void> {
  if (!ctx.sessionManager.getSessionFile()) return;
  await state.removeRuntime(ctx.sessionManager.getSessionId());
}

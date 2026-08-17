import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/**
 * The board command is invoked through Pi's normal command dispatcher so the
 * eventual switchSession call remains inside a command context.
 */
export function installBackToBoardEditor(pi: ExtensionAPI, ctx: ExtensionContext): void {
  // Replacing a different extension's editor would be intrusive. The normal
  // Pi editor gets the requested ← / Ctrl+← behavior; another custom editor
  // can still use /agents directly.
  if (ctx.ui.getEditorComponent()) return;

  ctx.ui.setEditorComponent((tui, theme, keybindings) =>
    new BackToBoardEditor(tui, theme, keybindings, () => {
      if (ctx.ui.getEditorText().length !== 0) return false;
      // Extension commands execute immediately even while Pi is streaming.
      // Opening the Board is a UI detach; it must never abort the active run.
      pi.sendUserMessage("/agents", { expandPromptTemplates: true });
      return true;
    }),
  );
}

class BackToBoardEditor extends CustomEditor {
  private backRequested = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly onBack: () => boolean,
  ) {
    super(tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    const wantsBack = matchesKey(data, Key.left) || matchesKey(data, Key.ctrl("left"));
    if (wantsBack && !this.backRequested && this.getText().length === 0 && this.onBack()) {
      this.backRequested = true;
      queueMicrotask(() => {
        this.backRequested = false;
      });
      return;
    }
    super.handleInput(data);
  }
}

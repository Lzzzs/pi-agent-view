import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import type { SessionRuntimeSnapshot } from "./session-runtime.ts";

/** Built-ins that the attach view can execute safely through structured RPC. */
const ATTACH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "model", description: "Select model", argumentHint: "<provider/model>" },
  { name: "export", description: "Export session as HTML", argumentHint: "[path]" },
  { name: "name", description: "Set session display name", argumentHint: "<name>" },
  { name: "session", description: "Show session info and stats" },
  { name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" },
];

export function runtimeAutocompleteSignature(snapshot: SessionRuntimeSnapshot): string {
  return JSON.stringify({
    commands: snapshot.commands.map((command) => [command.name, command.description, command.source]),
    models: snapshot.availableModels.map((model) => [model.provider, model.id]),
  });
}

export function createRuntimeAutocompleteProvider(snapshot: SessionRuntimeSnapshot): CombinedAutocompleteProvider {
  const nativeCommands: SlashCommand[] = ATTACH_COMMANDS.map((command) => ({
    ...command,
    ...(command.name === "model"
      ? {
          getArgumentCompletions: (prefix: string) => {
            const query = prefix.toLowerCase();
            return snapshot.availableModels
              .map((model) => ({
                value: `${model.provider}/${model.id}`,
                label: model.id,
                description: model.provider,
              }))
              .filter((item) => `${item.value} ${item.label}`.toLowerCase().includes(query));
          },
        }
      : {}),
  }));

  const nativeNames = new Set(nativeCommands.map((command) => command.name));
  const rpcCommands: SlashCommand[] = snapshot.commands
    .filter(
      (command) =>
        !nativeNames.has(command.name) && command.name !== "agents" && command.name !== "agents-new-safe",
    )
    .map((command) => ({
      name: command.name,
      description: `[${command.source}] ${command.description ?? ""}`.trim(),
    }));

  return new CombinedAutocompleteProvider([...nativeCommands, ...rpcCommands], snapshot.cwd, findFdPath());
}

let cachedFdPath: string | null | undefined;

function findFdPath(): string | null {
  if (cachedFdPath !== undefined) return cachedFdPath;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const executable of process.platform === "win32" ? ["fd.exe", "fd.cmd", "fd"] : ["fd", "fdfind"]) {
      const candidate = join(directory, executable);
      try {
        accessSync(candidate, constants.X_OK);
        cachedFdPath = candidate;
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  cachedFdPath = null;
  return null;
}

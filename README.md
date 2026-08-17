# Pi Agents View

A small, terminal-native session switcher for [Pi](https://github.com/badlogic/pi-mono).

It is deliberately not a web dashboard. It provides one terminal-native loop:

```text
see session status → type a new task or resume a session → work → ← → return to the board
```

## Features

- Starts directly in a full-terminal Session Board when you run `pi`
- Uses the supplied Pi mark as a compact terminal-native logo (works without image-protocol support)
- A focused task input starts a **new** real Pi session with `Enter`
- Shows workspace metadata and grouped `Pinned` / `Working` / `Awaiting input` / `Completed` sessions
- Select a group and use empty `Enter` to expand or collapse it
- Uses the full terminal height to show as many sessions as possible
- No browser, HTTP server, desktop app, PTY scraping, or transcript copying
- One isolated `pi --mode rpc` worker per background session
- Structured Pi RPC commands and live agent/message/tool/lifecycle events
- Background attach view reuses Pi's native Markdown, user/assistant message, tool, bash, editor, theme, spinner, and footer conventions
- Native-style `/` autocomplete for RPC extension commands, prompt templates, skills, models, and `@` file paths
- Keyboard-first navigation with an always-ready task input
- Persistent pins and display-name overrides
- Lifecycle-backed `starting` / `working` / `idle` / `failed` states
- `←` returns to the Board even while the current session is working; detach never aborts the task

## Requirements

- Pi `0.84.2` or newer
- Interactive terminal mode

## Install

### From GitHub

```bash
pi install git:github.com/Lzzzs/pi-agents-view
```

Restart Pi, or run `/reload` in an existing Pi session.

### From a local clone

```bash
git clone https://github.com/Lzzzs/pi-agents-view.git
cd pi-agents-view
pi install "$(pwd)"
```

To try a local checkout for one invocation without installing it:

```bash
pi -e ./index.ts
```

## Use

After installation, a normal interactive launch opens the board directly:

```bash
pi
```

Press `Esc` to close it and return to the current session. Open it again at any time with:

```text
/agents
```

```text

  █▀█   Pi Agents View · SESSION BOARD
  █▀ █  Workspace  /Users/me/code/project
        Sessions   1 working · 2 awaiting input · 18 completed

▾ Pinned  1
  recorder-multi-tab                  ● working  project  now
▾ Working  1
  eslint-fix                           ● working  project  2m
▾ Completed  18
  qianfan-config                       · done     project  1h
────────────────────────────────────────────────────────────────
  › Describe a task to start a new session
────────────────────────────────────────────────────────────────
  Enter starts task · empty Enter opens session / toggles group · ↑↓ select
```

| Key | Action |
| --- | --- |
| Type a task, then `Enter` | Start a clean Pi session and send it the task |
| `↑` | Previous session |
| `↓` | Next session |
| Empty `Enter` | Attach the selected session, or expand/collapse a selected group |
| `Alt+P` | Pin or unpin the selected session |
| `Alt+R` | Rename the selected session |
| `Esc` | Close the board |
| `←` / `Ctrl+←` | Detach to the Board when the editor is empty, including while Pi is working |
| `PageUp` / `PageDown` | Scroll an attached background transcript |
| `Ctrl+O` | Expand or collapse attached tool output |
| `/` | Show commands available to the attached runtime; continue typing to fuzzy-filter |

Pins, custom names, selection, and lightweight runtime records are stored in
`~/.pi/agents-view/state.json`. Existing state from the earlier
`~/.pi/agent-view/state.json` location is migrated automatically. Pi session
JSONL files remain the source of truth for transcripts, existing titles, and
session data.

## Background runtime model

```text
               Session Board
                    │
        ┌───────────┼───────────┐
        │           │           │
        ▼           ▼           ▼
    Runtime A   Runtime B   Runtime C
        │           │           │
    Session A   Session B   Session C
      working     working       idle
```

A background session owns one isolated Pi RPC child process and one session JSONL file. The attach view consumes `get_messages` plus live RPC events; sending input uses `prompt` and steering semantics when the worker is already running. Its data source is custom, but its visual building blocks are Pi's public native components, including Markdown/thinking blocks, user message boxes, built-in tool renderers, bash output, the multiline editor, working indicator, model/context footer, and theme colors.

`detach()` only releases the terminal view. It does **not** call RPC `abort`, send a signal, clear queues, or dispose the worker. Workers are stopped when the owning Pi process quits; V1 does not install a daemon.

Pi's native `AgentSessionRuntime.switchSession()` aborts the active response before replacement, and `InteractiveMode` does not expose a public attach/detach data-source API. That is why background sessions use the structured RPC attach view instead of forcing a busy native runtime to switch.

Pi session JSONL has no built-in multi-writer lock. Foreground and background runtimes therefore acquire cooperative ownership records under `~/.pi/agents-view/claims/`. Claim creation uses an atomic filesystem link, records both manager and writer PIDs, and is held until the writer exits. The extension blocks both a background attach and a native switch when another live Pi Agents View process owns that session.

## Session status

- **starting** — RPC worker is starting and resolving its session identity.
- **working** — Pi emitted `agent_start` and has not emitted `agent_settled`.
- **idle** — The runtime is alive and accepts a new prompt.
- **failed** — The last agent run failed or its worker crashed; sibling runtimes continue.
- **done** — No live Agent View runtime owns the historical session.

Status is driven by Pi RPC/native lifecycle events rather than session-file modification time.

## Scope and limitations

Pi Agents View intentionally does not implement cloning, forking, a web UI, daemon persistence, or machine-reboot recovery. Background extension dialogs are cancelled rather than guessed when no modal is attached. Ownership is cooperative: a separate Pi process that does not load this extension cannot be forced to honor its claim files.

Pi `0.84.2` does not expose public mouse row hit-testing to extensions. The board is keyboard-first; it does not parse raw mouse sequences or modify Pi core.

## Development

```bash
npm install
npm run typecheck
npm test
```

The test suite verifies detach invariants, three concurrent structured workers, foreground/background ownership claims, stale-lock recovery, startup cancellation, crash recovery/isolation, runtime-only Board discovery, and installed-Pi RPC startup.

## License

MIT

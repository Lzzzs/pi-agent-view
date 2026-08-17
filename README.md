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
- No browser, HTTP server, desktop app, or transcript copy
- Real Pi session creation and resume through Pi's `newSession()` and `switchSession()` APIs
- Keyboard-first navigation with an always-ready task input
- Persistent pins and display-name overrides
- Lifecycle-backed `working` / `idle` / `done` states for Pi processes running the extension
- `←` (with `Ctrl+←` fallback) returns to the board only when the normal prompt editor is empty and idle

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
| Empty `Enter` | Resume the selected session, or expand/collapse a selected group |
| `Alt+P` | Pin or unpin the selected session |
| `Alt+R` | Rename the selected session |
| `Esc` | Close the board |
| `←` / `Ctrl+←` | Return to the board when the normal editor is empty and Pi is idle |

Pins, custom names, selection, and lightweight runtime records are stored in
`~/.pi/agents-view/state.json`. Existing state from the earlier
`~/.pi/agent-view/state.json` location is migrated automatically. Pi session
JSONL files remain the source of truth for transcripts, existing titles, and
session data.

## Session status

- **working** — Pi emitted `agent_start` for that session and has not settled.
- **idle** — A live Pi process running this extension owns the session, but its agent is not active.
- **done** — No live Agent View runtime record exists for the session; this includes historical sessions.

The extension uses Pi lifecycle events rather than session-file modification times to identify `working`. Pi currently has no public cross-process activity registry, so a Pi process without this extension cannot report live status to the board.

## Scope and limitations

Pi Agents View intentionally does not implement cloning, forking, a web UI, or a separate chat renderer. Starting a task creates an actual clean Pi session; opening a row resumes the actual selected Pi session.

Pi `0.84.2` does not expose public mouse row hit-testing to extensions. The board is therefore keyboard-first; it does not parse raw mouse sequences or modify Pi core.

## Development

```bash
npm install
npm run typecheck
```

## License

MIT

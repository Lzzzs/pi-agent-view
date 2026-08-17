# Pi Agent View

A small, terminal-native session switcher for [Pi](https://github.com/badlogic/pi-mono).

It is deliberately not a task manager or a web dashboard. It optimizes one loop:

```text
see session status → open a session → work → ← → return to the board
```

## Features

- Terminal-only Session Board: no browser, HTTP server, desktop app, or transcript copy
- Real Pi session resume through Pi's `switchSession()` API
- Keyboard-first navigation: `↑`/`↓`, `j`/`k`, `Enter`, `p`, `r`, and `Esc`
- Persistent pins and display-name overrides
- Lifecycle-backed `working` / `idle` / `done` states for Pi processes running the extension
- `←` (with `Ctrl+←` fallback) returns to the board only when the normal prompt editor is empty and idle

## Requirements

- Pi `0.84.2` or newer
- Interactive terminal mode

## Install

### From GitHub

```bash
pi install git:github.com/Lzzzs/pi-agent-view
```

Restart Pi, or run `/reload` in an existing Pi session.

### From a local clone

```bash
git clone https://github.com/Lzzzs/pi-agent-view.git
cd pi-agent-view
pi install "$(pwd)"
```

To try a local checkout for one invocation without installing it:

```bash
pi -e ./index.ts
```

## Use

Open the board with:

```text
/agents
```

```text
┌─ Sessions ──────────────────────────────────────┐
│ > 📌 ● recorder-multi-tab              working  │
│     ○ qianfan-config                    idle     │
│     ✓ eslint-fix                        done     │
├────────────────────────────────────────────────┤
│ ↑↓/jk select  Enter open  p pin  r rename       │
└────────────────────────────────────────────────┘
```

| Key | Action |
| --- | --- |
| `↑` / `k` | Previous session |
| `↓` / `j` | Next session |
| `Enter` | Resume the selected Pi session |
| `p` | Pin or unpin the selected session |
| `r` | Rename the selected session |
| `Esc` | Close the board |
| `←` / `Ctrl+←` | Return to the board when the normal editor is empty and Pi is idle |

Pins, custom names, selection, and lightweight runtime records are stored in
`~/.pi/agent-view/state.json`. Pi session JSONL files remain the source of truth
for transcripts, existing titles, and session data.

## Session status

- **working** — Pi emitted `agent_start` for that session and has not settled.
- **idle** — A live Pi process running this extension owns the session, but its agent is not active.
- **done** — No live Agent View runtime record exists for the session; this includes historical sessions.

The extension uses Pi lifecycle events rather than session-file modification times to identify `working`. Pi currently has no public cross-process activity registry, so a Pi process without this extension cannot report live status to the board.

## Scope and limitations

Pi Agent View intentionally does not implement cloning, forking, task management, a web UI, or a separate chat renderer. Opening a row resumes the actual Pi session.

Pi `0.84.2` does not expose public mouse row hit-testing to extensions. The board is therefore keyboard-first; it does not parse raw mouse sequences or modify Pi core.

## Development

```bash
npm install
npm run typecheck
```

## License

MIT

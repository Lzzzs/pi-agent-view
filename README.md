# Pi Agent View

A minimal, terminal-native Pi session switcher.

## Install for this checkout

```bash
# Run this from the cloned repository root.
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-agent-view
# Start a fresh Pi process, or run /reload in an existing one.
```

Then use `/agents`:

- `↑`/`↓` or `j`/`k`: select
- `Enter`: resume the selected Pi session
- `p`: pin/unpin
- `r`: rename (stored in `~/.pi/agent-view/state.json`)
- `Esc`: close
- `←` (or `Ctrl+←`) from an empty, idle normal editor: return to the board

Pi's own `SessionManager.listAll()` discovers sessions, and `ctx.switchSession()`
performs a real resume. The extension never clones sessions or copies transcripts.

## Status model

`working` is written from Pi's `agent_start` / `agent_settled` lifecycle events
for Pi processes running this extension. A live process with no active agent is
`idle`; sessions with no live Agent View runtime record are `done` (historical).
Pi has no public cross-process session activity API, so this is deliberately not
inferred from session-file timestamps.

## Known V1 limit

Pi 0.84.2 has no public extension mouse event or row hit-testing API. The board
is keyboard-first; no Pi core changes or raw mouse parsing are used.

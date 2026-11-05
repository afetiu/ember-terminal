# Hybrid: the real CLI's input and menus at the bottom, everything it produces on a canvas above

Decided by the owner on 2026-11-05, after trying the other designs. Supersedes
[one-claude.md](one-claude.md) (Ember's composer and cards over a hidden TUI) and
[canvas-native.md](canvas-native.md) (Ember driving Claude Code's structured mode).

## Why

> Don't replicate the whole CLI — people would just use Claude Code. Only the content is
> formatted into the canvas; the CLI itself stays the same, so we don't have to keep
> updating it.

Every earlier design rebuilt part of the CLI in Ember: an input box, `/` and `@` menus, a
queue, permission / question / plan / trust cards, a status bar. Each was a copy that had
to follow every Claude Code and Codex release, and each fell behind in some way (pickers
only the TUI has, `/login`, MCP OAuth, a queue that could not be edited). The hybrid keeps
none of that: the person types into the agent's own prompt, and Ember does the one thing
the terminal cannot — it draws what the agent says and shows as a readable canvas.

## The layout

- A tab is a terminal first. Running `claude` or `codex` in it (Ember's shim announces it,
  `OSC 133;E;ember-agent=…`) splits the tab: **the canvas above, the agent's real terminal
  below**, a hairline seam between. Exit the agent and the tab is a terminal again.
- The bottom box is the tab's own xterm, moved: the pane keeps its left, right and bottom
  edges and only its `top` changes (`loom/host.ts`, `place`), and the terminal is fitted to
  the new box in the same frame (`Session.applyFit`, not the resize observer's debounce), so
  the PTY is the box's size from that frame on. The TUI redraws itself at that size.
  **Nothing of the terminal is cropped, masked, clipped or transformed**, nothing glides
  (a box mid-glide is not its PTY's size), and nothing of the canvas is drawn over it.
- `Ctrl+`` / Canvas | CLI gives the CLI the whole tab — the full conversation in the real
  TUI — and back.
- The keyboard lives in the terminal. A click on the canvas can take it for a moment; Esc
  or typing a character gives it back. The canvas's own keys (`Ctrl+``, `Ctrl+↑` into the
  objects, `Ctrl+Shift+↑/↓` between turns) work from the terminal; every other key typed
  there is the agent's (Esc, PageUp, Ctrl+C).

## The CLI box: the stream engine

**Superseded twice.** The tight CLI of 1.7.x (the PTY sized to the TUI's bottom area as read
from the screen, with pre-grows and kicks) is gone. The box now shows exactly the CLI's live
area, read from the PTY byte stream, while the real terminal runs the whole tab underneath:
[stream-engine.md](stream-engine.md). Claude Code still runs its classic renderer inside
Ember (`tui: "default"`): the full-screen one is an alternate screen and can't be split.

## What Ember still reads and types

- **The conversation**: the session's transcript (Claude Code's JSONL, Codex's rollout log)
  through main's watcher, as before — replies, diagrams, tables, the plan from TodoWrite,
  subagent pills, pictures in your turns. `/clear` and `/resume` are found by the switch to
  a new transcript (`canvas.ts`).
- **The working line** (`✶ Pondering… (12s)`) from the screen, for the canvas's live line.
- **Model and context** for the sidebar card from Claude Code's status line, as before.
- **Hooks**: SessionStart only (it binds the tab to its session, `/clear` included), Stop
  for the session's name, and PostToolUse/Stop for the panel's images. No hook waits: there
  is no PermissionRequest hook and nothing is answered from Ember. Codex gets no hooks.
- **Typing**, one small path (`pasteIntoTui`): the reply's question deck and the canvas's
  "ask about this" paste their words into the prompt (bracketed paste, Enter a beat
  later), then the keyboard goes back to the terminal.
- **Pictures**: `Ctrl+V` with only an image on the clipboard sends Claude Code its own
  Alt+V (Codex: Ctrl+V); the TUI reads the clipboard and attaches `[Image #n]`. Ember keeps
  the picture and shows a thumbnail just above the CLI, labelled with the TUI's mark
  read from the prompt rows; it goes when the mark leaves the prompt. A dropped file's path
  is pasted into the prompt (Claude Code makes an image's path an `[Image #n]`), with a
  thumbnail for a picture. Sent, the picture is part of your turn on the canvas.

## Removed

Ember's composer (`Composer.ts`) and its `/` and `@` menus, the queue, the cards for
permissions, questions, plans, trust and elicitation (`Asks.ts`), the TUI drivers
(`ClaudeTui.ts`, `CodexTui.ts`, `AgentWrapper.ts`), the command catalog
(`claudeCatalog.ts`), the "showing something in the CLI" banner, the bar under the
composer, the blocking `/hook` path, Codex's `-c hooks.*` flags and `ember-hook.cmd`.
In 1.8: the draggable divider and its remembered height (`ember.cliRows`), the CLI's glide,
and the full-screen renderer inside Ember.

## Keeping up with Claude Code

`.github/workflows/claude-watch.yml` (weekly) opens one issue per new Claude Code version
with its changelog and SDK type changes. What to look at: transcript format changes (the
canvas), renderer changes (re-record with `scripts/record-stream.mjs` and run
`scripts/test-stream-engine.mjs`: `src/shared/streamEngine.ts`), and hook inputs (`bridge.ts`, `hook.mjs`).

## Tests

`scripts/probe-engine.mjs` (real `claude --model haiku --permission-mode default` in
~/agent-box; `--codex` adds the real `codex`): the real terminal is the whole tab, the box
shows the live region's rows exactly, nothing covers it, no conversation in it, and every
frame of every transition shows the prompt line or a dialog's keys. Replays of recorded
streams: `node --test scripts/test-stream-engine.mjs`. See [stream-engine.md](stream-engine.md).

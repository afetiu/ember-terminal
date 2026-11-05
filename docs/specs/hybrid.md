# Hybrid: the real CLI at the bottom, its output on a canvas above

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
  below**, a glass divider between. Exit the agent and the tab is a terminal again.
- The bottom box is the tab's own xterm, moved: the pane keeps its left, right and bottom
  edges and only its `top` changes (`loom/host.ts`, `place`). The session's resize observer
  fits xterm to that box and resizes the PTY, and the TUI redraws itself at that size.
  **Nothing of the terminal is cropped, masked, clipped or transformed**, and nothing of
  the canvas is drawn over it: the canvas is a sibling above with `overflow: hidden`, so
  its menus, pieces, rail and lightbox stay inside it.
- The CLI's height is the person's: 15 rows by default, never under 10, dragged with the
  divider (remembered in `localStorage`, `ember.cliRows`), double-click resets. The height
  is a whole number of rows plus the terminal's padding, so the fit has no spare row.
- `Ctrl+`` / Canvas | CLI gives the CLI the whole tab and back.
- The keyboard lives in the terminal. A click on the canvas can take it for a moment; Esc
  or typing a character gives it back. The canvas's own keys (`Ctrl+``, `Ctrl+↑` into the
  objects, `Ctrl+Shift+↑/↓` between turns) work from the terminal; every other key typed
  there is the agent's (Esc, PageUp, Ctrl+C).

## Growing and shrinking

`canvas/tuiScreen.ts` reads the visible rows (never to cut them out, only to decide the
height) and `host.look` sizes the box from what it says:

| The TUI shows | The CLI |
| --- | --- |
| the plain prompt (input box, footer) and the working line | the person's height |
| a dialog or picker in place of the prompt (permission prompt, AskUserQuestion, plan approval, trust, `/mcp`, `/model`, `/config`, `/resume`…), or the prompt gone after it was seen | 70 % of the tab |
| the `/` or `@` menu (the prompt holds `/word` or `@word`) | 70 % |
| a prompt of 3+ lines (Claude Code scrolls a long prompt inside its box) | 70 % |
| a bottom area taller than the height: queued messages, the working line, its todo list, the box, the footer | that area's rows + 3 |

More room is given once the screen has held still for 120 ms (a redraw can show a
half-drawn screen); it is taken back after 350 ms of the smaller need. The growth glides
(180 ms on `top`/`height`, none with reduced motion). A drag while grown holds until the
TUI is plain again.

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
  the picture and shows a thumbnail just above the divider, labelled with the TUI's mark
  read from the prompt rows; it goes when the mark leaves the prompt. A dropped file's path
  is pasted into the prompt (Claude Code makes an image's path an `[Image #n]`), with a
  thumbnail for a picture. Sent, the picture is part of your turn on the canvas.

## Removed

Ember's composer (`Composer.ts`) and its `/` and `@` menus, the queue, the cards for
permissions, questions, plans, trust and elicitation (`Asks.ts`), the TUI drivers
(`ClaudeTui.ts`, `CodexTui.ts`, `AgentWrapper.ts`), the command catalog
(`claudeCatalog.ts`), the "showing something in the CLI" banner, the bar under the
composer, the blocking `/hook` path, Codex's `-c hooks.*` flags and `ember-hook.cmd`.

## Keeping up with Claude Code

`.github/workflows/claude-watch.yml` (weekly) opens one issue per new Claude Code version
with its changelog and SDK type changes. What to look at: transcript format changes (the
canvas), TUI layout changes (the input box, dialogs, the queue, the `/` menu:
`tuiScreen.ts`), and hook inputs (`bridge.ts`, `hook.mjs`).

## Tests

`scripts/probe-hybrid.mjs` (real `claude --model haiku` in `~/agent-box`; `--codex` adds
the real `codex`). At each step it checks that the PTY's size is the terminal's, that the
rows fill the box exactly, that nothing has a transform / clip / mask, and that no element
is drawn over the terminal's rows (`elementsFromPoint` over a grid, and every visible
element's clipped rect).

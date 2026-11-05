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

## The tight CLI (1.8)

The owner's verdict on 1.7.0, whose CLI was 15 rows by default: *"I need to see ONLY the
input and the menus of the Claude CLI, while everything about the content uses the
canvas."* So the CLI's box is exactly the TUI's **bottom area** plus one spare row, and the
conversation has no room in it. There is no divider to drag any more.

- **The bottom area** is what the TUI pins under the conversation: the working line and its
  tip, the todo list, queued messages, the prompt box (all its lines), `[Image #n]`, the
  footer and mode lines — or, in their place or under the box, a picker, permission prompt,
  AskUserQuestion, plan approval, the trust dialog, the `/` or `@` list. `canvas/tuiScreen.ts`
  measures it from the screen (read only): from its first row (the working line, the queue
  above it, the box's top rule, a dialog's top rule) to the last row drawn.
- **Claude Code runs its classic renderer inside Ember** (`tui: "default"` in the settings
  file Ember passes with `--settings`; the person's own setting is untouched elsewhere).
  The full-screen renderer keeps at least half the screen for the conversation whatever the
  size (its bottom pane is capped at `rows / 2`) — exactly what the owner saw in 1.7.0. The
  classic renderer prints the conversation above its bottom area and lets it scroll up into
  the scrollback, out of a box that holds only the bottom area.
- **Growing is immediate**: the next frame, measured 0–5 ms from the frame in which the TUI
  first draws the larger area. When the area outgrows the box its top scrolls up into the
  scrollback; the reader looks up to 60 lines above the screen, so it knows by how much.
  Claude Code's classic screen does not redraw a bottom area that scrolled away when the
  screen gets *taller*, only when it gets *shorter* — so a growth for a scrolled area is a
  **kick**: one row more than needed and, 90 ms later, back by one, which makes it draw the
  area whole at its final height.
- **Keys that open a menu grow the box before the TUI draws it**: `/` or `@` into an empty
  prompt and Enter on a `/command` add 6 rows on the key itself (the measure trims what was
  not needed); Enter on a message in Codex adds 3 (Codex leaves its working line out when it
  has no row for it, so nothing on screen would say a turn started).
- **Shrinking waits 300 ms** of the smaller need (a menu filtering as you type changes height
  every key), and nothing reads as cut within 150 ms of a resize while the TUI redraws.
  Something that outgrows the box right after a shrink (the same dialog, or the working
  area) keeps the height it had before that shrink while it shows: no shrink-grow cycles.
- **Pickers are drawn at the size the TUI picks for that height.** Claude Code's `/model` and
  `/mcp` size their lists to the screen and say "… +7 models" / "↓ 33 more"; Ember does not
  chase those (a taller list comes with as many conversation rows above it).
  A picker or dialog never gets more than half the tab: it sizes its list to the screen, so
  room given makes it longer and it would ask for more again. At that cap it is kicked to
  draw at the height it has, then measured down to its own rows.
- **Claude Code's glyphs vary by run** (same version): the pointer is `❯` or `>`, an
  ellipsis `…` or `...`. The reader accepts both sets.
- **While messages are queued** Claude Code redraws the prompt that started the turn with
  the queue; a box without room for it overflows and garbles, so the box keeps it (the
  height held after one shrink-grow cycle). That echo is the one conversation line that can
  show in the CLI, and only then.
- The box is never under 4 rows nor over the tab less 96 px of canvas. Before the agent's
  first prompt it is 12 rows (the banner, a trust dialog).
- **The canvas shows everything the conversation has**: your words, the replies, every tool
  call as a compact row (its result one click away), notices (`/command` output, background
  tasks reporting in), the live working line. Narration between steps still gives way to
  the turn's last message.

| The TUI shows | Its bottom area starts at |
| --- | --- |
| the prompt box, between turns | the box's top rule |
| the working line (Claude `✶ Verb…`, Codex `• Working (… • esc to interrupt)`) | the working line, or the queued messages above it (Claude draws them in the dim colour of its "ctrl+x ctrl+s to send now"; the brighter prompt that started the turn is the conversation's) |
| a dialog in place of the box | its top rule (Claude); the first row after the blank that ends the conversation (Codex) |
| the `/` or `@` list | Claude: the box (the list is under it); Codex: the popup's first row, above the prompt |
| Codex's prompt with no footer under it | the footer was dropped for want of rows: two more |
| nothing it recognises (a redraw in progress) | the height stays |

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
canvas), TUI layout changes (the input box, dialogs, the queue, the `/` menu:
`tuiScreen.ts`), and hook inputs (`bridge.ts`, `hook.mjs`).

## Tests

`scripts/probe-hybrid.mjs` (real `claude --model haiku --permission-mode default` in
`~/agent-box`; `--codex` adds the real `codex`). At each step it checks that the PTY's size
is the terminal's, that the rows fill the box exactly, that nothing has a transform / clip /
mask, and that no element is drawn over the terminal's rows (`elementsFromPoint` over a
grid, and every visible element's clipped rect) — and that the box holds only the bottom
area (at most one row above it, none of the conversation's words): at rest, after a reply,
with the `/` list (typed and pasted), `/mcp`, `/model`, a six-line prompt, a permission
prompt for `New-Item probe-tight.txt`, three queued messages, and after each goes away.
Every transition is sampled each animation frame: no run of more than one frame may lack the
prompt line or a dialog's keys (Codex: two — it clears its viewport on a resize and draws it
on its next frame). It prints the worst run per transition and how long the box took to
grow. The tool turn's canvas must show your words, the tool call and the reply.

# One Claude, instant switch

> **Superseded 2026-11-05 by [hybrid.md](hybrid.md).** Ember's composer, menus, queue and cards
> are gone; the real CLI sits at the bottom of the tab and the canvas shows its output above.

Decided by the owner on 2026-11-04. Supersedes `canvas-native.md` (the structured-mode
canvas) and the screen-cropping canvas in `loom.md`.

## The design

- **A terminal first.** Every tab is a plain shell. There is no agent picker and no
  auto-start; `+` / `Ctrl+Shift+T` is a terminal, `Ctrl+K` › *New Claude tab* is a terminal
  that runs `claude` as it starts.
- **One process.** Run `claude` in any tab and Ember's PowerShell shim announces it
  (`OSC 133;E;ember-agent=claude`). The tab becomes the canvas wrapper. The real Claude
  Code TUI keeps running in the tab's PTY, full screen (Ember's settings force
  `tui: fullscreen`). Canvas | CLI and `Ctrl+`` only show or hide that terminal. Nothing
  restarts and no command line is typed. When Claude Code exits, the shell's next prompt
  ends the announcement and the tab is a terminal again.
- **No cropping.** In the Canvas view no part of the TUI is shown. The canvas shows the
  transcript feed (main's watcher), Ember's composer and Ember's cards.

## Driving the TUI (ClaudeTui, an AgentWrapper)

| Action | What is typed into the PTY |
| --- | --- |
| Message | bracketed paste of the text (newlines kept, no early submit), then `\r` on its own |
| Picture | the PNG on the clipboard (main), `Alt+V` (`\x1bv`), wait for `[Image #n]` in the prompt |
| `!cmd` | `!` (bash mode), then the command, then `\r` |
| Interrupt | `Esc` |
| Send now (one queued message) | the message (Claude Code queues it mid-turn), then `Ctrl+X Ctrl+S` |
| Trust this folder | `Down` until the screen shows `❯` on "Yes, I trust this folder", then `
`; No is `Esc` |
| Mode | `Shift+Tab` (`\x1b[Z`); the mode is read back from the mode line |
| Model | `/model <value>` from the bar's picker |

A trailing `@path` gets a space so the TUI's file menu does not swallow the Enter.

**The queue is Ember's.** A message written while a turn runs (or while a send is still
being typed) is held by Ember, not typed into the TUI. Claude Code's own queue can only be
edited by pulling messages back into its prompt with Up, one at a time, then Enter to edit
(`popEditableAt` in 2.1.318) — driving that blind would mean rewriting the prompt under the
person, so Ember does not. Held in Ember, each queued message has **×** (drops it) and
**Send now** (types it mid-turn, then Claude Code's send-now key, which makes the running
turn give way). The rest are typed as one message, joined as Claude Code joins its own,
once the turn is over (the Stop hook, or the screen for an interrupt). **Esc** stops the
turn and gives every queued message back to the composer, pictures included.

**Text left in the TUI's prompt** (typed in the CLI view, or a message Claude Code gave
back after an interrupt) is never sent by surprise and never lost. Coming back to the
canvas moves it into the composer and clears the TUI's prompt with `Ctrl+C` (only while
the prompt has text; Claude Code reads that as "clear the input"). If text is still there
at send time, a message puts it in front of its own words, and a `/command` or `!` leaves
it in the composer. The TUI's placeholder (`Try "…"`) is drawn dim and is not counted.

## Hooks (no screen reading for state)

`resources/hook.mjs`, run by Claude Code from Ember's settings file, posts the hook input
to the bridge (`POST /hook`, token-authenticated). Every input names the session, so the
tab follows `/clear` and `/resume` at once.

- `PermissionRequest` (blocking, 1 h timeout) becomes Ember's card: tools, AskUserQuestion
  (answers go back as `updatedInput.answers`) and ExitPlanMode. The card's answer is the
  hook output `hookSpecificOutput.decision {behavior, updatedInput, updatedPermissions,
  message, interrupt}`. No canvas for the tab, or Ember gone: no output, and Claude Code
  asks in its own screen.
- Claude Code 2.1.318 runs PermissionRequest hooks **beside** its own dialog in an
  interactive session (`awaitAutomatedChecksBeforeDialog` is only set for subagents), so
  the TUI draws its dialog on its hidden screen meanwhile. The hook's answer resolves it.
  If the person answers it in the CLI view instead, the card closes when the dialog leaves
  the screen.
- `SessionStart` (`source: clear` resets the canvas), `UserPromptSubmit` / `Stop` (turn on
  and off, sorted by the time each hook ran, since they are `async`), `SubagentStop`,
  `Notification`, `PreCompact`, `SessionEnd`. All `async`, so Claude never waits on them.

One row of the screen is read as text: the spinner line, for the canvas's working line. An
interrupt has no Stop hook, so a turn with no spinner for 2 s and the prompt back is over;
the screen is looked at again every 600 ms meanwhile, since an interrupted screen stops
changing.

## What the TUI still owns

Anything no hook describes: `/model` and other pickers, `/login`, MCP OAuth, `/config`,
`/resume`'s list. When the input box leaves the screen with no card pending (or, before the
first prompt, a dialog is on it), the canvas shows one line, "Claude is showing something in the CLI", with
**Open CLI**. The commands that only have a picker (`/login`, `/resume`, `/permissions`, …)
open the CLI view by themselves after being typed.

**Trust.** The one startup dialog Ember answers itself: Claude Code in a folder it has not
trusted draws "Accessing workspace … Yes, I trust this folder". Read from the screen (both
lines), it becomes Ember's card, "Trust <folder>? Claude Code will be able to read and run
files here." with Yes / No. The dialog opens on "No, exit", so Yes moves the selection
and checks it on screen before Enter; No is the dialog's Esc (Claude Code exits, the tab is
a shell again). The answer counts only once the dialog has left the screen; it is tried
up to three times, and then the CLI view opens. Answered in the CLI view, the card closes.

## The `/` and `@` menus

Commands and models come from one short structured run of `claude` that says `initialize`
and exits (`src/main/claudeCatalog.ts`), cached in `EMBER_HOME/claude-catalog.json` for a
day, plus the project's `.claude/commands` and `.claude/skills`. Files come from
`git ls-files` in the tab's folder (a bounded walk outside a repo).

## Tests

`scripts/probe-one-claude.mjs`: the real `claude --model haiku` in `~/agent-box`.
`scripts/probe-gaps.mjs`: trust (Yes and No, in new folders under `C:UsersPublic`, since
the home folder is trusted and trust is inherited; removed after, with their
`~/.claude.json` entries) and Ember's queue (×, Send now, flush at turn end, Esc).
`scripts/test-question.mjs`: the canvas ask box's question check (`node --test`).

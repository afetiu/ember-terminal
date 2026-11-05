# Canvas, native: Ember drives Claude Code instead of reading its screen

> **Superseded 2026-11-05 by [hybrid.md](hybrid.md)** (and before that, 2026-11-04, by [one-claude.md](one-claude.md)). The structured-mode driver
> (`claudeHost.ts`, `NativeClaude.ts`) is gone; its Composer and Asks live on in `ClaudeTui`.

Status: approved 2026-11-03, in progress on branch `canvas-native`. Phases 1–5 done
(`claudeHost.ts`, `canvas/NativeClaude.ts`, `canvas/Composer.ts`, `canvas/Asks.ts`, the bar
and CLI view in `canvas/LoomView.ts`, `.github/workflows/claude-watch.yml`; probes
`scripts/probe-native.mjs`, `scripts/probe-native-composer.mjs`, `scripts/probe-native-bar.mjs`).
Protocol facts: [claude-protocol-reference.md](claude-protocol-reference.md).

## Why

The canvas today overlays Claude Code's full-screen TUI and cuts its input box, menus and
dialogs out of the screen (`LoomView.findDock`). Every layout change in Claude Code breaks
something: the question dialog, `!` shell mode, a tall status line, the `/` menu with wrapped
descriptions. Each fix is another guess about rows of text.

Claude Code has a structured stdio mode, the one the Agent SDK and the IDE extensions use.
It sends the session as data (messages, tool calls, permission requests, questions, the
command list) and takes commands (send, interrupt, set model, set permission mode, answer).
Driving that, Ember owns every pixel of the canvas and reads nothing off a screen.

## What changes for the user

- A Claude tab opened on the canvas runs Claude Code in structured mode. The input box,
  `/` and `@` menus, image paste, permission prompts, Claude's questions, the plan, queued
  messages, model and permission mode are Ember's own UI.
- **CLI** (Ctrl+`) stops this process and opens the same session in the real TUI
  (`claude --resume <id>`). Switching back stops the TUI and resumes structured mode. Only
  one process owns a session at a time.
- Things that only exist in the TUI (`/login`, MCP OAuth, `/config`, `/resume` picker, vim
  mode) open the CLI view.
- Behind a setting until it matches today's canvas: Settings › Agent › "Canvas drives
  Claude directly" (`canvas.native`). Off = today's overlay, untouched.

## Architecture

```
main:      ClaudeHost (one per tab)   spawn claude.exe stream-json, line codec, control
           requests with ids/timeouts, answers to can_use_tool, restart/resume
           ipc: claude:start/send/control/answer/stop  →  renderer events claude:event
renderer:  NativeClaude (per tab)     state machine: idle / working / asking / waiting
           Feed (existing)            fed the stream's assistant/user messages directly —
                                      they have the transcript's shapes
           Composer                   Ember's input: text, images, `/` and `@` menus,
                                      `!` runs in the tab's shell, queue + send now
           Asks                       permission card, question card, plan approval
           Bar                        model, permission mode, context %, interrupt
```

- **Spawn** (reference §1.2): `--output-format stream-json --verbose --input-format
  stream-json --include-partial-messages --replay-user-messages --permission-prompt-tool
  stdio`, plus `--resume <id>` or `--session-id <uuid>`. Long-path cwd. Ember's MCP config
  and settings (statusLine, hooks) as today. `initialize` first, declaring the dialog kinds
  Ember renders.
- **One warm process per tab.** Startup is 4–9 s (hooks, MCP servers); never respawn per
  message.
- **Unknown message types are ignored**, never fatal. Features are gated on the
  `capabilities` list in `system/init`.
- **Permissions:** every `can_use_tool` becomes a card; "always allow" echoes the
  `permission_suggestions` entry and is hidden when `suppress_always_allow_rule`. A
  `control_cancel_request` closes the card. An unanswered request stalls the turn, so the
  card is never dismissable without an answer (Esc = deny).
- **AskUserQuestion** arrives as `can_use_tool`; answered with `updatedInput.answers`.
- **ExitPlanMode** is a plan card: approve (and pick the mode) or keep planning.
- **`!command`** has no equivalent on this channel: Ember runs it in the tab's shell and
  shows the output in the turn.
- **Interrupt** cancels the turn; queued messages are cancelled with it unless sent now.
- **Cost:** `total_cost_usd` is list price even on a subscription; shown only as tokens.

## Keeping up with Claude Code

`.github/workflows/claude-watch.yml`, weekly and on demand:

1. `npm view @anthropic-ai/claude-code version` against `docs/specs/claude-version.txt`.
2. On a new version: fetch the changelog section (github.com/anthropics/claude-code
   CHANGELOG.md), `npm pack @anthropic-ai/claude-agent-sdk` and diff its `sdk.d.ts`
   against the copy kept in `docs/specs/sdk.d.ts`.
3. Open one issue: new version, changelog lines, new message types / control subtypes /
   capabilities, and which of them Ember does not handle yet. No code changes from CI.
4. Update the stored version and `sdk.d.ts` in the issue's suggested PR, for review.

## Phases

1. **Host and stream** — ClaudeHost, IPC, the stream feeding Feed; plain text in, replies
   out; interrupt. Behind the setting.
2. **Composer** — Ember's input with images, `/` menu from `commands`, `@` from
   `file_suggestions`, queue and send now, `!` in the shell.
   `!` output is captured by the shell itself and returned base64 in a private OSC (7771),
   not read off the screen (ConPTY reorders passed-through marks); it rides on the next
   message as `<bash-input>`/`<bash-stdout>` text blocks. Send now = `interrupt` without
   `cancel_queued` (the queue runs next); Esc = `interrupt` with `cancel_queued`, and the
   queued text goes back into the input.
3. **Asks** — permission, question and plan cards; elicitation.
4. **Bar and switches** — model, permission mode, effort, context %, CLI view hand-off
   (stop → `--resume` in the TUI → back).
   - The mode chip and Shift+Tab cycle default → acceptEdits → plan (→ auto when the model
     has `supportsAutoMode`) with `set_permission_mode`; bypass is never offered. The model
     is a picker over `initialize.models` (`set_model`, `default` = null); effort cycles the
     model's `supportedEffortLevels` (`apply_flag_settings {effortLevel}`); the context meter
     is `get_context_usage.percentage`, asked after each `result`.
   - Sessions across restarts: `native-tabs.json` under EMBER_HOME, `[{sessionId, cwd}]` in
     tab order, written whenever a native tab's session id or folder changes and when one is
     closed. At boot with `canvas.native` on, each comes back with `--resume <id>`; a tab that
     never started a turn comes back fresh in its folder; a session that is gone (`--resume`
     exits before `initialize`) is said so and a new one starts.
   - CLI view: the turn is finished, or stopped after asking ("Stop the current turn and open
     the CLI?" — a card like Claude's, Esc = no); the process is stopped and waited on; then
     `claude --resume <id>` is typed into the tab's shell (its `claude` carries Ember's
     settings and panel; `Set-Location` first if the shell moved). TUI-only commands
     (`/login`…) are typed into the TUI once its input box is up (`findDock`). Back: refused
     while the TUI shows "esc to interrupt"; otherwise Ctrl+C, a beat, Ctrl+C (the first
     clears anything half-typed) until the shell's prompt returns; the id it ended on comes
     from the status line (or the panel server's binding), and the canvas resumes on it.
     While the TUI owns the session the canvas follows the transcript again.
   - Learned on the real one: Claude Code's screen may be inline (normal buffer), not
     full-screen, so "the TUI has gone" is the shell's next prompt (OSC 9;9), not the buffer.
     A folder the TUI never trusted opens on its "trust this folder?" dialog (structured
     mode never asks); the CLI view shows it as is.
5. **Watch job** — the GitHub workflow above: `scripts/claude-watch.mjs` (runnable with
   `--dry`), `docs/specs/claude-version.txt`, `docs/specs/sdk.d.ts`.
6. **Parity and default** — probes for each phase, then the setting defaults on and the
   overlay code (`findDock` and friends) is retired.

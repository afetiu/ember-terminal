# Loom — a terminal whose output space is a canvas

Status: v1 built 2026-10-31, uncommitted. Concept pages: `loom-concepts.html`, `loom-model.html`
(the explorations that led here; the user picked a simpler direction than both).

## What it is

A new kind of Ember tab (Ctrl+Shift+L, `ember loom [dir]`, palette "New Loom session"). It starts as
a plain PowerShell with the prompt at the bottom of an empty space. Typing `claude` runs the real
Claude Code. The conversation is then drawn on a canvas above Claude Code's own input box: replies as
rich text, mermaid fences as live diagrams, edits as diffs with line numbers, commands as one quiet
line, exploration (reads, searches) folded into one line, images inline, and whatever the session
chooses to show — html pieces, media, a live browser it can annotate, a steps card. Existing tabs are
unchanged; the side panel is not used in a Loom tab.

## The one rule: nothing of the CLI is replaced

- The real `claude` runs in the tab's pty, as in any tab. Every key goes to it.
- Claude Code 2.1 is a full-screen TUI (alternate screen). The bottom of its screen — input box,
  slash/@ menus, effort line, mode line, Ember's status line, permission dialogs, pickers like
  `/model` — is kept on screen as the **dock**: the real terminal, cropped with a CSS `clip-path` and
  bottom-anchored with a `translate`. The pty keeps its full size; Claude Code lays out as always.
- Dock detection (`LoomView.findDock`) is measured against real screens (`scripts/probe-loom.mjs`):
  a rule (full-width `─`/`▔`, no box junctions), the `❯` line directly under it → input box; a lone
  lowest rule → a dialog or picker. Anything unrecognised shows the **whole** terminal. Ctrl+` flips
  to the whole TUI at any time.
- The conversation is not scraped from the screen. It comes from the session's transcript JSONL
  (`src/main/canvas.ts` tails it from line 1, 250ms poll), bound to the tab by the panel MCP server's
  announcement and re-bound from the status line's `transcript_path` (follows `/clear`, `/resume`).

## Pieces

- `src/main/canvas.ts` — transcript tail → `ember:canvas:feed`; media registry served by the bridge at
  `/media/<id>` (unguessable ids, byte ranges for video); the annotate round trip.
- `src/main/bridge.ts` — `/canvas/media`, `/canvas/annotate`, `/canvas/steps`; Loom tabs keep up to
  400 pushes and `replace` does not empty them (frames must still load their documents).
- `resources/mcp-panel.mjs` — with `EMBER_SURFACE=canvas` (set at spawn for Loom shells) the server
  gives canvas instructions and adds `show_media`, `annotate`, `show_steps`. Same tool names otherwise,
  so skills that call `show_panel` work in both kinds of tab.
- `src/renderer/src/canvas/` — `LoomView` (dock, modes, pieces, browser + annotate, steps, ask-about,
  keys), `Feed` (transcript → DOM), `markdown` (escape-first subset), `diff`.
- Model-authored markup never runs in the renderer: markdown is escaped first; html pieces and mermaid
  diagrams are bridge documents in sandboxed iframes that report their height by postMessage.

## Interaction

- Typing anywhere goes to the prompt. PgUp/PgDn and Ctrl+Home/End scroll the canvas.
- Select text → "? ask" chip; right-click a piece, diagram, image, code block, table or step → ask about
  it. The question is typed into the session as "About … — question".
- `[label](ember:text)` in a reply is a button that sends `text`; localhost links open inline.
- Esc closes Loom overlays only when one is open; otherwise it is Claude Code's interrupt.

## Not done yet

- Persistence: Ember restores no tabs at all, so a Loom tab is not restored either.
- Claude Code without full-screen mode (inline renderer) gets shell mode — the plain terminal.
- The TodoWrite-less 2.1 build has no task list of its own; `show_steps` is the canvas's.
- Ideas held back on purpose (see `loom-model.html`): timeline/branching, spatial/atlas views,
  a local small model for prose. The user asked for simple first.

## Testing

`npm run build`, then `node scripts/probe-loom.mjs --stage all` (real `claude`, isolated EMBER_HOME,
a few cents of tokens; screenshots in `%TEMP%\loom-shots`). `--stage extras` checks show_steps,
show_media and the Ctrl+` toggle.

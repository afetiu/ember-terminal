# Notes and todos: yours first, your agents' second

Status: planned (2026-11-01).

Ember is about a person working with an agent in a session. Notes and todos are the two
things that live outside any session — a meeting, a thought, a thing to do tomorrow —
and that the agents should still be able to see.

## Notes

- **The Notes page** (a tab): write anything, any time, no session needed. A list on the
  left (search, newest first), the note on the right. Plain markdown files in the notes
  folder, as now.
- **Sticky notes in a session**: one key (N in the canvas keyboard mode, or Ctrl+Shift+N
  from the input) drops a note on the canvas, ready to type. It floats, snaps, resizes
  like any object and stays in that session's canvas. It is a real note file, so it is on
  the Notes page too, marked with the session it came from (click: back to the session).
- **Agents**: a `notes` tool on every surface (canvas or not): `list`, `search <text>`,
  `read <name>`, `add <name> <text>` (append, or create). Read-only by default in
  wording: the agent adds to a note only when asked.

## Todos

- **The Todo page** (a tab): add, tick, reorder, edit — no session needed. Todo.md as now.
- **Agents**: a `todo` tool on every surface: `list`, `add <text>`, `done <text>`. The
  agent adds a todo when something in the conversation is the person's to do, and ticks
  one it finished. A todo added from a session remembers it (a link back).
- **The daily check**: the first time Ember opens each day, the Todo page leads with a
  short **Today** review — the open items, the ones that have sat for a week, and the
  ones a session ticked since yesterday — triaged with single keys: D done, T today,
  L later, Del drop. Nothing runs in the background; it is just the first thing you see.

## Not in scope

No scanning of mail, Slack, Jira or GitHub. No reminders or notifications. No sync.

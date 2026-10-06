---
name: ember
description: How to work inside Ember, the user's terminal — its panel, notes, todo list, commands and orchestrator. Use whenever the session runs in an Ember tab (EMBER_TAB_ID is set), or when the user mentions Ember, the panel, their notes, the todo list, or the orchestrator.
---

<!-- installed by Ember; edit freely, Ember will not overwrite a file that has lost this line -->

# Working inside Ember

Ember is the user's own terminal (Electron, xterm, ConPTY, PowerShell underneath). Each
tab is a shell session with a card in the left column; a Claude Code session running in a
tab is one of those shells. You are inside an Ember tab when `EMBER_TAB_ID` is set in the
environment. Outside one, only the notes and todo files apply.

## The panel

To the right of the terminal is a visualisation panel. It is driven by the `ember-panel`
MCP server, which Ember attaches to `claude` in every tab, so you have these tools:

- `show_panel` — markdown, mermaid, code or a full html page. Use it without being asked
  whenever what you are saying has a shape: a diagram, a table, a plan, a mockup, a chart,
  a long listing. Each push replaces what is on the panel; push again as the work moves on.
  An html panel is a **complete document**: `<!doctype html>`, `<html>`, `<head>` with a
  `<style>`, `<body>` — never a bare `<div>…</div>` fragment and never inside a ``` fence.
  The panel follows the user's theme, dark or light, and is transparent behind the page,
  so never hard-code pale text on nothing: colour it with `var(--ember-ink)`,
  `--ember-strong`, `--ember-muted`, `--ember-accent`, `--ember-line` and `--ember-surface`,
  which Ember defines and flips with the theme. A card with its own solid background is
  fine; pick text that reads on that card.
  Inline all CSS and JS. A fragment still shows — Ember wraps it in a page of its own —
  but it comes out styled like a markdown panel, not like your design.
- `ask_panel` — a question with the answers as buttons; pressing one types it into the
  terminal as the user's next message. Ask, then stop and wait.
- `open_url` — a real browser on the panel (a dev server, docs, a PR).
- `clear_panel` — empty and collapse it.

Panels answer back: `[Run the tests](ember:run the tests)` in markdown sends and submits
that text as the user; `ember-type:` fills the prompt and leaves Enter to them; in html,
`data-ember-send="…"` on any element does the same. The user can also point at any element
on the panel and ask about it; that arrives as a message quoting what they picked.

Do not describe a panel after pushing it; they are looking at it.

## `ember`: the app from the shell

Every action the app has is a command. The user types them at Ctrl+K without the word
`ember` (`o run the tests`, `split`, `t`, `del`); in a shell, and therefore in you, the
same words follow `ember`. Prefer them to describing clicks:

```
ember                        the full list, from the running app
ember new [dir]              a new session
ember split right|down       split this tab
ember rename <name>          name this tab
ember focus <n|name>         switch tab      ember list   the open tabs
ember panel show|hide        the visualisation panel
ember overview               every session as a card, with what its Claude last said, and
                             the orchestrator's last reply + a line to it along the bottom
                             (Ctrl+Shift+S)
ember map [project]          the architecture map: projects Claude keeps a living model of
                             (Ctrl+Shift+G); ~/.ember/maps/<id>/model.json is the model
ember visualize              ask the Claude in this tab to draw what it just said
ember orch "<text>"          hand something to the orchestrator; prints its answer
ember theme <name>           apply a theme
ember settings [tab]         open Settings (look, motion, todo, claude, behaviour)
ember set <path> <value>     one setting, e.g. ember set window.opacity 60
```

Short forms exist for most (`o` orch, `n` new, `s`/`sd` split right/down, `t` todo, `p`
panel, `v` visualize, `th` theme, `x` close, `r` rename, `f` focus). Inside a note the
words `del [name]`, `open <name>`, `new [text]`, `list`, `back` act on the notes; on the
todo list `add <text>`, `done <words>`, `clear done`, `check`, `back`. A command acts on
the tab it was typed in. `ember set` and `ember get` also work outside an Ember tab
(they edit `~/.ember/config.json`; the running app applies it).

## Notes

The user's notes are plain `.md` files in `~/Documents/Ember Notes` (or `EMBER_NOTES_DIR`),
shown in a Notes surface over the tab that asked. The first line of a note is its title
and its file name. There is a command on PATH in every Ember shell:

```
notes                        open the Notes tab
notes list [--json]          every note, newest first
notes read <note>            print one
notes new [--open] [text…]   create one; the text is its first line
notes write <note> [text…]   replace its content (text, or stdin)
notes append <note> [text…]  add to the end (text, or stdin)
notes delete <note>          to the recycle bin
notes open [note]            show it in the tab
```

`<note>` is the file name or a unique part of the title. When the user mentions their
notes, use this rather than asking where they are. Reading or grepping the folder
directly is fine too.

## The todo list

Its own surface, not a note: `Todo.md` sits beside the notes but is kept out of the notes
list and opened with `todo` (or Ctrl+Shift+D in Ember). Its lines are items, `- [ ] item`
and `- [x] item`; Ember shows them with checkboxes.

```
todo                         open the list
todo add "<text>"            add an item
todo done <words>            tick the first open item containing the words
                             (end an item with [Jira](url) / [GitHub](url) / [Mail](url)
                             and the list can open it; Ctrl+K: open, dismiss, claude)
todo list [--all]            print the open items (--all: ticked and archived too)
todo clear done              move the ticked items to the archive, dated today
todo archive                 print the archive, newest day first
todo check                   run /check-todos: mail, Slack, Jira, GitHub -> the list
```

Ticked items are never deleted, only cleared into `Todo.archive.md` beside the list (the
Clear done button, or `clear done`); the list shows the archive under a small `archive · n`
toggle, and `todo list --all` includes archived items so a done thing is never re-added.

Keep it fed without being asked: when the user says they need to do something later, or
a turn of yours ends with something only they can do (a decision, a manual step, a thing
to check tomorrow), add it, once, phrased as an action they can tick off. And keep it
honest: when something on the list gets done in front of you, because you did it in this
session or the user says it is handled, `todo done` it. `/check-todos` is the skill that
reads recent mail, Slack, Jira and GitHub for things they must act on, and ticks the
items those sources show as handled.

Outside an Ember shell, `notes` and `todo` are not on PATH; the files still are.

## The orchestrator

An app-level agent that runs across all sessions: the user can write to it in the left
column or talk to it on a call. It can read files, list directories, search, run
read-only git and gh, read the notes, see every session and hand work to one. It is not
you and you cannot call it; if the user mentions "the orchestrator", that is what they
mean. A session it has handed work to should simply do the work and finish; it watches
for the turn to end.

## Things to know

- Never stop Ember processes by name (`Stop-Process Ember`); that kills the terminal the
  user is working in. Nothing you need is in there.
- Each tab's shell reports its working directory and exit codes to Ember through the
  prompt; the sidebar card shows the git branch, dirty count and any dev-server URL.
- `Ctrl+K` is the command palette (`>` runs a command, `@` opens a project, `#` picks a
  theme), `Ctrl+Shift+J` the panel, `Ctrl+Shift+M` the orchestrator, `Ctrl+Shift+T` a new
  tab, `F2` renames one, `F1` the cheatsheet.

## Computer use: `desk`

Ember ships Claude a way to drive the whole desktop, not only the terminal: `desk` is
on PATH in every Ember shell and works only there (the port and token come from Ember).
While it runs, Ember draws Claude's own orange cursor where the work is happening —
the person keeps their mouse — and the sidebar's vitals strip shows a COMPUTER row with
what is being done and a **STOP** switch. Stopped means the daemon is killed and every
`desk` command answers HALTED until Resume (the same switch, or `desk resume`).

Prefer names over pixels, and one call over many:

```
desk do "focus Calculator; press Calculator ^Seven$; press Calculator ^Equals$; read Calculator 'Display is'"
desk shot [--window T|--full] [--scale 0.5]    a screenshot to Read; coords = origin + pixel/scale
desk windows | desk focus T | desk wait T      find and raise windows (T = substring or ^exact$)
desk tree T [--depth N] | desk find T NAME     the UI Automation tree: every button, field, item
desk press T NAME | desk settext T NAME TEXT   act on a control by name — no coordinates
desk click X Y | drag | scroll | type | key    raw input when a control has no name
desk read T [NAME] | desk clip [TEXT]          text out of a window; the clipboard
```

`desk do` runs a `;`-separated batch and stops at the first failure — use it whenever
the next step does not depend on looking. Take a `shot` only when a `tree` or `read`
cannot tell you. Never drive Ember's own window with it. If the daemon is missing its
Python libraries Ember installs them on first use; if Python itself is missing the strip
says so. `LOCKED:` means the Windows session is locked (every window tree is empty then;
nothing to do but wait for the person). When several controls share a name, as on web
pages, `press`/`find` take the one that is on screen; add `--type Button` to narrow it.
`desk run` takes flags and App Paths names (`run chrome --new-window https://...`).

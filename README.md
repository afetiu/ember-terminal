<p align="center"><img src="build/icon-256.png" width="88" alt="Ember"></p>

<h1 align="center">Ember</h1>

<p align="center">Your coding agent, on a canvas. A free Windows app for Claude Code, Codex and the other agent CLIs you already use.</p>

![Fixing a bug in Ember: the agent answers with a chart, the chart is pinned to the side, a line of code is changed from its right-click menu while the tests run, and one click opens the pull request.](docs/media/ember-demo.gif)

**Download:** [ember.deepanswerlabs.com](https://ember.deepanswerlabs.com), or
`Ember-Setup-win-x64.exe` from the [releases page](https://github.com/afetiu/ember-terminal/releases/latest).
The clip above is also an [MP4](docs/media/ember-demo.mp4), and the website plays four more scenarios.

Free · MIT · no account · no telemetry · Windows 10/11 x64

## What it does

- **Answers you can use.** Replies come as readable text with diagrams, tables, charts,
  kanban boards, PDFs, Markdown, spreadsheets, video and live web pages in them. Resize
  them, drag them out and snap them to an edge, or open one full screen and zoom in. The
  words make room, and the pieces stay live as the work goes on.
- **Right-click to ask or to change.** Every object has a menu. Ask a question about it, or
  about the part you clicked, and the answer comes right there without interrupting the
  session. Say what to change instead, and the agent changes it in place.
- **Canvas or CLI.** One switch, ``Ctrl+` ``, between the canvas and the agent's own screen.
  It stays in the same place in both views, and Ember remembers your pick.
- **Keyboard first.** `Ctrl+↑` walks the objects, `Enter` opens one full screen, `Esc`
  is always the way back, and `Ctrl+K` does the rest.
- **Notes and a todo list, outside sessions.** A sticky note with `Ctrl+Shift+N`, a todo
  list in the sidebar. Every agent can read them, add to them and tick things off.
- **Computer use you can watch.** The agent reads your screen as text, with every control
  numbered, and acts with a pointer of its own. STOP is always on screen.
- **One memory for all your agents.** What one agent learns about you and your projects,
  the others know too. Shared instructions, shared skills.

## Your agents

Ember runs the agent CLIs you already have, each with its own sign-in and its own plan,
exactly as in any other terminal:

**Claude Code · Codex CLI · Gemini CLI · Cursor Agent · OpenCode · Copilot CLI · Qwen Code · Amp · Aider · Crush**

The first run finds the ones you have installed and checks that each one answers. The chip
at the top of the sidebar picks the agent; `+` (or `Ctrl+Shift+T`) opens a session with it,
straight on its canvas.

Claude Code and Codex get the most: their replies, tool calls and objects are read from
their own session logs. The others run in their own screen, with Ember's tools available
to them. How each CLI is run lives in `src/shared/agents.ts`.

## Install

Download the installer from [ember.deepanswerlabs.com](https://ember.deepanswerlabs.com) or
the [releases page](https://github.com/afetiu/ember-terminal/releases/latest). There is a
portable `.zip` and `.tar.gz` too. It installs for your user only, with no admin prompt.

Or from a terminal, which installs or updates to the latest release, checks it against the
release's checksums, and starts Ember:

```powershell
# PowerShell
irm https://ember.deepanswerlabs.com/install.ps1 | iex

# cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://ember.deepanswerlabs.com/install.ps1 | iex"
```

**Not code signed yet.** Windows SmartScreen may warn the first time: choose **More info**,
then **Run anyway**. Every release is built from this repository by GitHub Actions and
ships with `SHA256SUMS.txt` so you can check the file (see [CODE_SIGNING.md](CODE_SIGNING.md)).

Ember replaces the window, not your shell. It runs PowerShell 7 through ConPTY, the way
Windows Terminal does, so your profile, modules, oh-my-posh and PSReadLine work as before.

## Working on the canvas

- **Ask in the input box** at the bottom. The current turn fills the canvas; earlier turns
  are a step away with `Ctrl+Shift+↑` / `↓`, or keep scrolling past the top or bottom.
- **Objects in a reply** resize from any edge. **Drag out** takes one out of the reply:
  drop it anywhere, or at an edge to snap it there (up to four per edge, each where you drop
  it), and the text moves out of the way.
- **Full screen** has a zoom bar. `Ctrl` + wheel or a pinch zooms toward the pointer,
  `+` / `−` / `0` from the keyboard, and a double-click zooms to 2×.
- **The plan** of a longer piece of work is an object like the others: it ticks itself off, follows
  the work into later turns, and can be moved, snapped, minimized or removed.
- **Subagents** show as pills while they work. Click one to see the steps it took.
- **Queued messages**, sent while the agent works, wait right above the input; **Send now**
  sends them without waiting for the turn to end.

| Keys | With an object selected (`Ctrl+↑` from the input) |
| --- | --- |
| `↑` `↓` | Choose another object |
| `Enter` | Full screen |
| `P` | Place it on screen, or put it back |
| `Shift` + arrows | Snap to that edge |
| `M` | Minimize |
| `N` | New sticky note |
| `Space` | Its menu |
| `Del` | Remove |
| `Esc` | Back to typing |

`F1` shows every shortcut in the app.

## Notes, todos and shared knowledge

- **Notes** are Markdown files in `Documents\Ember Notes`. Edit them in Ember or in any
  editor. A sticky note from a session is a real note too, with the date and the session.
- **Todo** is one list, `Todo.md` in the same folder (`Ctrl+Shift+D`). An item can be
  handed to a new session as its task.
- **Agents use both** through Ember's tools: "add a todo: rebuild the website", "what's in
  my notes about the release?"
- **Shared knowledge:** instructions in `~/.ember/brain/instructions.md`, one fact per file
  in `~/.ember/brain/memory`, and shared skills, handed to every agent Ember finds. Settings
  › Agent › Shared knowledge shows what is shared and turns it off.

## Computer use

Agents in Ember can use your Windows desktop, with a pointer of Ember's own that glides
to each target and dips on every click.

- `look` reads a window as text, with its controls numbered: `#7 [Button] 'Save' (412,88)`.
- `act` runs a whole sequence in one call (`press #7; settext #3 "hello"; key ctrl+s`) and
  its reply ends with the screen afterwards, numbered again.
- `point` shows you where something is, with a short note beside it, and never clicks.

**STOP** is on screen whenever an agent acts. `Ctrl+K` › **Computer use: on / off** turns
it off altogether. Computer use needs Python 3 and an unlocked session.

## Everything else

- `Ctrl+K` is the command line for everything Ember can do. The same commands work from
  any shell as `ember`: `ember new`, `ember theme`, `ember set window.opacity 60`…
- Under every session is a real PowerShell, with command blocks, splits
  (`Alt+Shift+` `+` / `−`), find in scrollback and a task runner.
- `Ctrl+,` opens Settings: themes (a day and a night pair, plus many more), fonts, window
  backdrop, motion, agents, sound.
- Notes, todos and settings are plain files in your user folder. Your work goes where your
  agent CLI already sends it; Ember adds no account and no telemetry.

The full guide is at [ember.deepanswerlabs.com/docs](https://ember.deepanswerlabs.com/docs).

## Building from source

```bash
pnpm install
pnpm dev       # hot-reloading app
pnpm build     # typecheck + bundle to out/
pnpm dist      # -> release/Ember-Setup-win-x64.exe (+ Ember-win-x64.zip, .tar.gz)
```

If `electron.exe` is missing after install, run `node node_modules/electron/install.js`
(pnpm does not run that package's install script by default).

Releasing and the website are two steps. A `v*` tag builds the installer and attaches it
to a GitHub Release; the site's download buttons follow the latest release
(`site/_redirects`). The site (`site/`, ember.deepanswerlabs.com) is a Cloudflare Pages
project that is not connected to this repository, so publish it with `pnpm site:deploy`
after a `wrangler login`.

`node scripts/demo/record-site-demo.mjs [scene]` records the clip at the top of this page
from the website's own demo (needs Edge and `ffmpeg`).

```
src/main/       Electron main: ConPTY host, agents, the bridge and MCP tools, computer use
src/preload/    contextBridge -> window.ember
src/renderer/   the canvas, sessions, sidebar, notes, todo, settings
resources/      the MCP servers and CLIs Ember hands to every agent and shell
site/           the website and the phone app's page
```

How session status is read off the terminal, what the window glass costs, performance
measurements and the traps found on the way are in
[docs/engineering-notes.md](docs/engineering-notes.md). See [CONTRIBUTING.md](CONTRIBUTING.md)
to help.

## License

[MIT](LICENSE). Made by [Deep Answer Labs](https://deepanswerlabs.com). Claude Code, Codex,
Gemini CLI, Cursor Agent, OpenCode and GitHub Copilot CLI are trademarks of their owners;
Ember isn't affiliated with any of them.

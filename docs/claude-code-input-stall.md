# Claude Code: keystrokes stall for 1–3 s while a response streams (Windows / ConPTY)

Draft of an upstream report, with the measurements behind it. Repro scripts live in this
repo: `scripts/probe-input.cjs` (bare node-pty + xterm headless parser, no terminal UI)
and `scripts/probe-input-electron.mjs` (the same inside Ember).

## What happens

While Claude Code streams a long answer, characters typed into the prompt do not appear
for one to three seconds, then land all at once. The prompt is focused; nothing else is
running. CPU on the machine is not saturated.

## Measurement

Method: spawn `pwsh` under ConPTY with node-pty, run `claude`, submit
"Print 200 lines, each exactly `row N lorem ipsum…`", and while the rows stream type one
letter every 450 ms; measure how long until the letter shows in the input box (the
screen is parsed with xterm's headless parser, so what is measured is what a person sees).

Machine: Windows 11 Pro 10.0.26200, PowerShell 7.6, Claude Code v2.1.258, Node 24.
Two runs per configuration; typical key ≈ median, stalls are the outliers.

| Stack | Terminal size | Typical key | Stalls per run |
|---|---|---|---|
| node-pty, in-box ConPTY, no terminal UI | 160×45 | 31 ms | 0.7 s and 1.1 s; 1.1 s and 1.0 s |
| node-pty, conpty.dll v1.25.2603 (bundled) | 160×45 | 31 ms | 0.8 s and 0.8 s; 0.7 s and 1.3 s |
| node-pty, in-box | 100×20 | 32 ms | 1.8 s and 1.2 s |
| node-pty, in-box | 200×90 | 33 ms | 2.7 s and 2.1 s |
| Ember (Electron, xterm.js) | ~120×45 | 45–66 ms | 1.5 s and 2.6–3.3 s |

During the stalls the terminal's own processes are idle (an IPC round trip inside the
terminal stays under 20 ms) and the bytes have been written to the pty; the echo simply
does not come back until the stall ends. The stall length grows with the terminal's
size, which points at the TUI's repaint of the visible region rather than at input
plumbing. The same thing shows with no terminal UI at all, so it is not a renderer
problem.

Two stalls appear per run: one when the answer starts streaming, one part-way through
(likely when the message re-wraps or the final render happens).

## What was ruled out

- ConPTY version: in-box and v1.25.2603 behave the same.
- The terminal: bare node-pty, a Rust/wgpu terminal (alacritty_terminal + portable-pty) and
  Electron/xterm.js all show it.
- A `statusLine` command and an MCP server in the settings: removing both changes nothing.

## Ask

Process stdin between render batches during streaming (or cap the repaint cost when the
viewport is tall), so typed input is echoed within a frame even while the answer streams.

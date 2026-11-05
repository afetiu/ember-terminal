# The stream engine: the CLI box shows exactly the CLI's live area

Owner-approved design, 2026-11-05. Replaces the tight CLI of 1.7.x (`canvas/tuiScreen.ts`
measuring the bottom area from the screen's glyphs, and `loom/host.ts` sizing the PTY to it,
with pre-grows and kicks). The verdict on 1.7.1 was that sizing the PTY from screen
heuristics "made it worse": pickers sized to the box and looped, frames tore, `❯` became `>`.

**The design.** The agent runs in a full-size PTY (the whole tab), so nothing it draws is ever
starved of rows. The stream engine (`src/shared/streamEngine.ts`) watches the PTY's byte stream
as xterm parses it and says, per complete frame, which rows are the CLI's live area — the
rows it keeps redrawing at the bottom: the prompt, `/` and `@` lists, pickers, permission
prompts, questions, the trust dialog, queued messages, the working line, the status lines.
The visible CLI box shows those rows only, copied from the real terminal on complete frames.
The box's size never feeds back into the TUI.

## Step 1 — what the streams show

Recorded with `scripts/record-stream.mjs` (node-pty, 120×45, real `claude --model haiku` in
~/agent-box with `{"tui":"default"}`, real `codex`), every chunk timestamped with the input
sent; fixtures in `scripts/fixtures/streams/`. `scripts/dump-stream.mjs` prints one readable.

### ConPTY: the OS one destroys the evidence, the bundled one keeps it

| | Windows' in-box ConPTY (Ember ≤ 1.7) | OpenConsole bundled with node-pty (`useConptyDll`) |
| --- | --- | --- |
| what arrives | ConPTY's own re-render of its buffer: absolute `CUP`, spaces as `CUF`/`ECH`, only changed cells | the app's own sequences, passed through: `CUU`/`CUD` from its own origin, `EL`, `ED`, `DECSTBM`, `?2026` |
| scroll regions | dropped | passed (Codex's `DECSTBM 1;top`) |
| `?2026` frames | forwarded, but detached from the content they bracketed | intact around the frame |
| start-up | ~0.1 s | 3.0 s — *only* because OpenConsole asks `CSI c` (DA1) and waits 3 s for an answer. Answered, it is 0.09–0.10 s (`cmd`), 0.42–0.46 s (`powershell`), the same as in-box (measured 4 runs each) |

So Ember spawns every PTY with the bundled OpenConsole and answers its start-up DA1 at once in
main (`ConPtyHost`), stripping it from what the renderer sees. That was the 4–7 s
"PowerShell is slower" of 2026-09-05: the DA1 wait, not OpenConsole.

### Per CLI

| CLI (version) | renderer | what states the live area | exact? |
| --- | --- | --- | --- |
| **Codex** 0.156.1 | ratatui inline viewport | every frame in `?2026h … ?2026l`; on any viewport move/resize it clears from the viewport's top row (`CUP top;1`, `ED 0`); history goes in above it inside `DECSTBM 1;top` + LF, then `DECSTBM` reset | **yes**: top = last `ED 0` at column 0 or `DECSTBM 1;b` (then top = b), tracked through whole-screen scrolls; bottom = last row drawn |
| **Gemini CLI** 0.62 | Ink log-update | each frame erases the previous one bottom-up (`EL 2`, `CUU 1` × height) before redrawing | **yes**: top = the topmost erased row |
| **Copilot CLI** 1.0.91 | alternate screen | `?1049h` | full screen: not split |
| **Claude Code** 2.1.318, `tui: "fullscreen"` | alternate screen, absolute `CUP`, no scroll regions | `?1049h` | full screen: not split (why Ember keeps the classic renderer) |
| **Claude Code** 2.1.318, `tui: "default"` | **cell-diff** renderer (not Ink's log-update) | see below | **bottom yes; top partly** |

**Claude Code's classic renderer**, byte by byte: every frame is `?25l`, a return to its origin
(`CUB` caret column, `CUD` to the row under the frame), a `CUU` to the *first row that
changed*, only the changed rows rewritten (gaps as `CHA`), a `CUU`/`CUF` back to the caret,
`?25h`. No `?2026`, no scroll region, no erase-down. A commit (a finished message) is one
write from the old frame's top: the new static lines and the new frame together. A shrink
erases rows bottom-up (`CUU 1`, `EL`) then jumps to the first changed row. It never writes
above the frame's top.

What that gives exactly: the frame's **bottom** (every frame), and that **every changed row is
inside the frame**. What it does not give: rows of the frame that did not change since the
frame was laid out — the prompt box's top border while idle, a dialog's top border, queued
messages that sit still. Nothing in the stream restates them. That is the one place the design
needs a fallback, and it is narrow:

1. **The frame floor** — the first row of the last write that started at or above the live
   top (a commit or a redraw): nothing above it is live, ever. The conversation is never
   searched.
2. **The border** — the first full-width border row (one non-letter character repeated over
   ≥ 60% of the width; any character: `─`, `╌`, `━`, `-`) at or below the floor. Every Claude
   bottom area starts with one (prompt box, picker, permission prompt, AskUserQuestion, trust
   dialog). Not a glyph match: no `❯`/`>`, `…`/`...`, no words.
3. **Animated rows** — rows that small frames (≤ 4 rows changed) keep rewriting: the working
   line and its timer. Kept as a distance from the frame's bottom (the frame moves down as the
   conversation grows; its bottom moves with it), lapsing 800 ms after the last change. They
   extend the top above the border while the turn runs.
4. **Queued messages** — the frame the TUI draws in answer to the person's Enter while the
   working line animates (`noteInput`): its first changed row is the queued message's. Held
   while that row stays (followed if the frame moves), dropped when it goes (sent, or taken
   back to edit).
5. The visible caret is always inside.

### Replay results (`node --test scripts/test-stream-engine.mjs`)

Ground truth per mark is what the recorded screen showed, read once and written into the
test: rows that must be in the region (the prompt line, a dialog's choices and footer, a
menu's entries, the working line, queued messages) and conversation text that must not.
Every frame is also checked: visible caret inside, and no height bounce (A → B → A in 300 ms).

**59/59 pass.** 11 recordings, 1,749 frames, 0 frames with the caret outside, 0 bounces.

| recording | marks | frames | height changes | bounces |
| --- | --- | ---: | ---: | ---: |
| claude-idle-typing | idle, typing, cleared | 47 | 0 | 0 |
| claude-reply | idle, working, replied | 118 | 3 | 0 |
| claude-menus | `/`, filtered, Esc, `/mcp`, `/model`, `@`, 6-line paste, resize ×2, Esc Esc | 57 | 19 | 0 |
| claude-permission-queue | permission prompt, denied, 2 messages queued mid-turn, done | 279 | 13 | 0 |
| claude-ask | AskUserQuestion, closed | 140 | 5 | 0 |
| claude-trust | trust dialog, after | 26 | 1 | 0 |
| claude-fullscreen | full (alt screen) | 120 | 0 | 0 |
| codex-session | idle, typing, `/`, `/model`, `/mcp`, paste, resize ×2, working, 3 queued, replied, permission, denied | 786 | 36 | 0 |
| codex-short | idle, `/` | 93 | 4 | 0 |
| gemini-short | trust dialog | 29 | 5 | 0 |
| copilot-short | full (alt screen) | 54 | 0 | 0 |

### Where it is not exact, honestly

- **Claude's top rests on the border rule** while nothing above the border animates. If a
  future Claude Code dropped the border above its prompt box *and* drew nothing animated, the
  region would start at the frame floor (the last commit's first row): too tall, never cut.
- **Claude's in-progress tool rows** above the working line are not in the region (they do not
  animate); the canvas shows them from the transcript.
- **Codex keeps its streaming message tail inside its viewport**: while it streams, the
  viewport (exactly read) holds the last lines of the reply. That is Codex's own live area.
- **The in-box ConPTY** gives no exact reading at all; Ember no longer uses it.
- **A resize** reflows the screen; Claude's classic renderer does not redraw on a width
  change, so its frame is read as xterm reflowed it until its next frame.

## Step 2 — Ember

- Every PTY: the bundled OpenConsole, its start-up DA1 answered in main (`ConPtyHost`).
- The tab's real terminal (`Session.term`, its PTY the whole tab) stays where it was, full
  size, invisible under the canvas while an agent runs, and keeps the keyboard: keys, paste,
  Ctrl+V → Alt+V, IME all go to it as before.
- `canvas/liveView.ts`: the engine on the real terminal; on each complete frame (the write
  callback, a sync frame closed) it copies the live rows (cells, colours, attributes; the
  caret and its shape) into a small display-only xterm, exactly that many rows tall, pinned
  to the tab's bottom. Its height is the region's, up to the whole tab less the canvas's
  least (96 px): a 60% cap cut Claude's `/mcp` (it sizes its list to the 45-row screen, 39
  rows) above its selection. A taller region would show its bottom part (the input line and
  a dialog's footer are at the bottom) and the seam turns accent. Re-read when an animation
  lapses.
- `Ctrl+`` shows the real terminal, whole tab; back again.
- Alt-screen apps (and anything the engine reads as `full`): the real terminal, whole tab.
- The canvas: Claude Code and Codex from their session logs as before (Feed); for other
  agents the committed lines the engine hands over.
- Deleted: the tight CLI's measuring and sizing (`tuiScreen.ts`'s dock/cut/kick reading,
  `host.ts`'s grow/shrink/kick/pre-grow logic). What the canvas still reads from the live
  rows (the working line, `[Image #n]` marks, the prompt's text) reads the region's rows.

## Step 2 — live results (`node scripts/probe-engine.mjs --codex`)

Real `claude --model haiku` and real `codex` in Ember tabs in ~/agent-box, 1280×860 window
(45×139 PTY). 160 checks, 159 pass on the full run; the one failure ("at rest: box text row
for row") was the probe reading while Claude rewrote its `/rc connecting…` status between the
box's read and the real terminal's — a re-read 600 ms later was added, and the rest-only rerun
passes. **Worst frame run without the prompt line or a dialog's keys: 0 frames, over 20
sampled transitions (3,653 frames). Frames with conversation text in the box: 0.**

| transition | frames | box heights |
| --- | ---: | --- |
| Claude turn (working line, reply) | 505 | 5→7→5 |
| `/` typed, closed | 50, 46 | 5→25, 25→5 |
| `/mcp` opened, closed | 73, 69 | 10→3→39, 39→5 |
| `/model` opened, closed | 72, 64 | 21, 21→5 |
| six-line prompt, cleared | 157, 89 | 5→…→10, 10→5 |
| permission prompt, denied | 149, 80 | 5→7→13, 13→5 |
| three queued mid-turn | 561 | 5→7→10→12→14→13→15→5 |
| window resized and back | 324 | 5→3→5 |
| Codex `/`, closed | 51, 51 | 11→19, 13→5 |
| Codex `/model`, closed | 70, 76 | 6→13, 13→5 |
| Codex turn + three queued | 625 | 5→7→8→5 |
| Codex approval, denied | 334, 98 | 5→7→18, 18→7→5 |

What the live runs taught, now in the code:

- **Read the frame when it is complete, paint it later**: the box's rows are composed at the
  write callback (outside any `?2026` frame); by the next paint the real terminal can be
  halfway through Codex's next frame. Painting from the live buffer showed blank frames.
- **An empty live area is not a frame** (Codex clears its viewport, then draws it).
- **An area that moved or changed size waits for 20 ms of quiet (at most 50 ms)**; the same
  area redrawn (typing, the working line) paints on the next frame.
- **Reset at the shim's `OSC 133;E` announcement, in the stream**, not when layout learns of the
  agent a frame later: Codex's first history insert had already gone by.
- **Codex keeps its session card in its viewport** until the first message (it says
  `model: loading` and then the model): the box shows it at rest, exactly as Codex has it.
- The box's cap is the tab less the canvas's 96 px: Claude sizes `/mcp` to the screen (39 of
  45 rows) and a 60% cap cut it above its selection.
- The transient 3-row frames (`/mcp`, resize) are Claude's own: its echo line between closing
  the prompt box and drawing the dialog, and its frame redrawn at the new width.

Kept passing: `smoke.mjs`, `probe-clear.mjs`, `probe-answer-card.mjs`, `probe-security.mjs`.
Not done: other agents' committed lines on the canvas (the engine hands them over,
`takeCommitted()`, nothing renders them yet; those agents keep the Canvas | CLI switch over
their whole screen).

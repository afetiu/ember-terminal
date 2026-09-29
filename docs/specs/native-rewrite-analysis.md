# Is a native (Rust + wgpu) or hybrid Ember worth it, performance-wise?

Measured 2026-09-05 on the Slim Pro (i9-13905H, RTX 4060 laptop, 3840×2160), Windows 11.
Every number below was taken on this machine today; nothing is quoted from a README.

## Method

The same three workloads in every terminal, same PowerShell 7 binary, same window size where
it matters:

- **idle** — a quiet `pwsh -NoLogo -NoProfile` prompt.
- **spinner** — a Claude Code-like status line repainting at ~30 fps (`scratch/spinner.ps1`),
  which is what the terminal shows for most of a working day. The script itself costs
  **6.5 %** of a core in a hidden console; that is subtracted in the "terminal only" column.
- **throughput** — the repo's `bench.mjs` payload, 20 000 lines through `Out-Host`.

CPU is % of one core over 10 s, RAM is the working set of the terminal's own processes
(the shell's ~85–100 MB excluded). Ember was measured with `scripts/probe-cpu.mjs`
(a dev build with an isolated home, same as the other probes). Alacritty 0.17 (Rust,
OpenGL) and WezTerm (Rust, wgpu) were installed with winget for the comparison; Windows
Terminal is the C++/DirectX reference. The hybrid's web view was a real WebView2
(SDK 1.0.4191, runtime 152) hosting the panel page with a mermaid diagram.

## Results

| | Ember (Electron) | Windows Terminal | Alacritty (Rust/GL) | WezTerm (Rust/wgpu) |
|---|---|---|---|---|
| Spinner, whole tree | 87.3 % | 7.8 % | 8.6 % | 5.6 % |
| Spinner, **terminal only** | **≈ 81 %** (GPU proc 53, renderer 28) | ≈ 1.3 % | ≈ 2 % | < 1 % |
| Spinner, Ember plain window (no acrylic) | 96.9 % | | | |
| Spinner, Ember DOM renderer (no WebGL) | 63.8 % | | | |
| Idle prompt | 12.3 % | 1.6 % | 0.3–1.6 % | 1.2–2.8 % |
| RAM, terminal only | 740–900 MB dev (7 procs); **1 150 MB installed** (9 procs) | 120 MB | 88 MB | 158 MB (691 MB after the 20k-line flood) |
| Cold start → window | 0.56–0.75 s | 1.2–1.4 s | 0.9 s | 0.7 s warm, 3.0 s cold |
| Throughput, 20 000 lines, ~280×72 | 4.2 s | **2.7–3.0 s** | 4.2–4.4 s | 4.8–5.0 s |
| WebView2 panel (hybrid's web half) | | | | +353 MB, 0.2 % idle (6 processes) |

Ember's time to a *usable prompt* was 7.4 s in the probe, but that is the user's PowerShell
profile loading (the other terminals ran `-NoProfile`), not the app; the window itself is
up faster than any of the natives.

## What the numbers say

1. **CPU while Claude is working is the one real outlier, and it is big.** A status line
   ticking at 30 fps costs Ember ~80 % of a core; the natives spend 1–2 %. That is 40×,
   and on this CPU roughly 6–10 W — a large share of battery drain during a session.
   It is not the acrylic (plain window is *worse*), not the WebGL renderer (DOM is 64 %),
   and not Ember's motion settings (glow, trail, output motion are already off). It is
   the pipeline: xterm.js repaints its canvas, Chromium re-composites a 3840×2160
   transparent surface, the GPU process does that work per frame. Idle is the same story
   in miniature: 12 % vs 1–2 %.
2. **Memory: 1.15 GB vs 90–160 MB.** Native is ~8× lighter. The hybrid is not: one
   WebView2 with the panel page is 353 MB of Chromium on its own, so a Rust terminal plus
   the panel lands around 500–550 MB — about half of today, not a tenth.
3. **Throughput does not improve.** At the same grid Ember (4.2 s) equals Alacritty
   (4.2–4.4 s) and beats WezTerm (4.8–5.0 s). Windows Terminal wins (2.7–3.0 s) because of
   its ConPTY/OpenConsole integration, not because it is native. A rewrite buys nothing here;
   the earlier "1.58× slower than WT" is a ConPTY story, not an Electron one.
4. **Startup does not improve.** Ember's window is up in 0.6–0.75 s, faster than all three.
   What the user waits for is the shell profile.
5. **Typing latency** was not re-measured today; the September probe put Ember at the
   ConPTY floor plus one compositor frame (~8 ms at 120 Hz). Native removes that frame.

## The three options

| | Keep Electron, fix the pipeline | Hybrid: Rust + wgpu terminal, WebView2 panel | Pure Rust + wgpu |
|---|---|---|---|
| CPU during Claude streaming | 80 % today; plausible target 20–30 % with frame budgeting (untested) | ~2 % (measured proxies) | ~2 % |
| RAM | 1.15 GB → ~0.9 GB after the known cuts | ~500–550 MB | ~100–200 MB |
| Throughput / startup | unchanged | unchanged | unchanged |
| Keeps mermaid + HTML panels, notes, voice pages | yes | yes | **no** (no browser engine) |
| Keeps the animated look (springs, cursor, mascot) | yes | rebuilt in a custom wgpu UI | rebuilt |
| Effort | days | ~2–3 months to parity | ~5–8 months, and the panel never comes back |

## Recommendation

The rewrite is justified by exactly one metric, but it is the metric that matters most
for a laptop running Claude all day: CPU and battery while output streams. Everything else
(throughput, startup, latency) is already at parity or better.

Do it in two steps, so the decision is made on Ember's numbers rather than proxies:

1. **One to two days inside Electron first.** Cap xterm's repaint to 15–20 fps while output
   is streaming, stop the full-canvas redraw for a one-line change, and re-run
   `node scripts/probe-cpu.mjs`. If the spinner drops under ~25 % of a core, the rewrite has
   lost most of its case and the memory cuts (overlay teardown, lazy panel MCP, audio only
   during voice) finish the job.
2. **If it cannot get there, go hybrid, not pure native.** The hybrid keeps every panel
   feature and the voice pages as they are, reaches the same 2 % CPU as native, and halves
   memory. Pure native saves another ~350 MB at the cost of mermaid, HTML panels and months.

## Files

- `scripts/probe-cpu.mjs` — Ember's CPU/RAM/startup probe (dev build, isolated home).
- Scratch (this session): `Measure-Term.ps1`, `spinner.ps1`, `drive-natives.ps1`,
  `drive-rest.ps1`, `webview-host.ps1`, `panel.html` under the Claude scratchpad.
- Alacritty and WezTerm remain installed via winget for re-runs (`winget uninstall` to remove).

## Follow-up, same day: the Electron fix, measured

The "fix the pipeline first" step was done the same evening. The repaint cap and the caret
change did nothing measurable; the profiler showed the renderer's JavaScript 78 % idle and
the cost in Chromium's compositor, and Chromium's own tracing pointed at the sidebar:

- a class toggled on every card on every animation frame (160/s) — a style recalc and a
  commit per frame for the whole window;
- the card status "odometer": one span per character, glyphs swapped and animated on every
  change, which Chromium cannot composite on its own;
- the mascot badges redrawn at 30 fps for as long as a session worked, plus infinite
  box-shadow "breathe" keyframes on the status dot and the rail tick.

All four are gone: the toggle is guarded, the status line is plain text, a badge is drawn
once when its state changes, the breathe/nudge keyframes are removed. Same probe, same
spinner, medians of three with the machine otherwise idle:

| | before (afternoon) | after |
|---|---|---|
| Spinner, whole tree | 130–146 % | **18–27 %** (spinner script itself is 6.5 of that) |
| Idle prompt | 12.3 % | **5.1 %** |
| Running command, no output | 10.2 % | 7.4 % |
| Style recalcs / commits per second | 124 / 187 | 4 / — |
| Frames drawn per second | 120 | 13 |

Ember's own share while a Claude-like status line ticks is now ~15 points of a core against
1–2 for the native terminals. Memory is unchanged (~730 MB dev, ~1.1 GB installed).

Instruments added to `scripts/probe-cpu.mjs`: `--profile` (CPU profile), `--trace`
(Chromium tracing: paints, commits, invalidation tracking by node and reason), `--styles`
(per-frame style/DOM writes by caller), `--inject=<css>` (A/B a CSS override without a
rebuild), `--silent`, `--idle`, `--shot`, and a workload check that marks a run invalid
when the spinner did not start. Run-to-run noise on this laptop is large while anything
else animates; measure with the session idle and take medians.

**Revised verdict.** The 40× gap is now ~8–15×, and the absolute cost (about 15 % of one
core while streaming, 5 % idle) is no longer something a person feels. The remaining
reasons for a Rust rewrite are memory (1.1 GB vs ~150 MB) and the ~10 points of per-frame
compositing on a 4K glass window that xterm.js + Chromium will never shed. Those are real
but they are a "someday, deliberately" project, not an urgency.

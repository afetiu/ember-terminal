# Loom: what Ember costs a session — before and after (2026-10-31)

Real `claude -p` sessions (Opus 5.5), same prompts, panel server as committed in 839a863 ("before")
versus with data views, show_file, edit_panel and trimmed tool text ("after"). A stub bridge answers
every call. Script: `scripts/bench-canvas-cost.mjs`. One run per scenario.

| Scenario | Cost before → after | Output tokens | Ember tool-call chars | Before / after behaviour |
|---|---|---|---|---|
| Bar chart | $0.203 → $0.128 (−37%) | 1,912 → 292 | 3,104 → 118 | html page → show_view data |
| Report written and shown | $0.204 → $0.172 (−16%) | 2,654 → 1,883 | 3,344 → 198 | content resent → show_file path |
| Dashboard + one change | $0.336 → $0.275 (−18%) | 1,562 → 577 | 2,516 → 360 | page rewritten twice → data twice |
| Table | $0.111 → $0.110 | 108 → 122 | 0 → 0 | markdown table in reply both times |
| **Total** | **$0.853 → $0.684 (−20%)** | **6,236 → 2,874 (−54%)** | **8,964 → 676 (−92%)** | |

~$0.07–0.10 of every run is the fixed context (Claude Code system prompt, user CLAUDE.md, memory),
which Ember does not control; per visual in a longer session the saving approaches the token figures.
Per-call Ember text (instructions + tool schemas) went from ~11.4k to ~6.2k characters.

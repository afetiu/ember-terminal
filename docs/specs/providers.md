# Providers: any agent in Loom, one-tap switch, and the council

Status: building (2026-11-01).

## Goal

Ember already hosts several agent CLIs (`src/shared/agents.ts`: detection, install,
headless runs, giving each the canvas tools). Loom, though, only *reads* Claude Code: it
tails Claude's transcript and recognises Claude's screen. This makes every provider a
first-class Loom citizen, adds a one-tap switch between them, and adds a council where
several of them debate one question.

Ember still holds no keys. Every agent runs as the person, on its own sign-in.
OpenRouter is reached through an agent that supports it (OpenCode), with the key in
that agent's own config, never in Ember.

## 1. Reading any agent (log adapters)

`src/main/providers/logs.ts` — one adapter per agent whose session log we can read:

```ts
interface AgentLog {
  /** Newest session log for this folder written since `since` (ms), or null. */
  locate(cwd: string, since: number): string | null
  /** 'jsonl' = appended lines (tail by offset); 'doc' = one JSON document rewritten whole. */
  kind: 'jsonl' | 'doc'
  /** Raw records → Claude-transcript-shaped lines (the canonical form Feed and PhoneHost read). */
  convert(records: Json[], state: Record<string, unknown>): Json[]
}
```

Canonical line = what Claude Code writes: `{ type: 'user' | 'assistant', uuid, timestamp,
message: { content: [...blocks], stop_reason? } }` with blocks `text`, `tool_use
{id,name,input}`, `tool_result {tool_use_id,content}`. A turn's last assistant line gets
`stop_reason: 'end_turn'`. uuids are stable so re-reading a `doc` never duplicates.

The renderer tells main which agent a tab runs (`canvas.tabAgent`, from the shim's
`ember-agent=` mark). `Tail` uses Claude's binding when there is one, else the tab
agent's adapter. An agent without an adapter still gets the canvas: its objects arrive
through the canvas tools; only the narration is missing.

## 2. Loom for any agent's screen

Claude's input is found and framed precisely. Other agents' TUIs are not guessed at:
Loom shows the canvas above and the bottom of the agent's own screen below (its input
and status), un-cropped. Ctrl+` shows the whole TUI, as for Claude.

## 3. Switch

A provider chip in the Loom bar. Tap → the installed agents. Picking one:
1. writes a handoff brief from the canvas (the last turns, the plan, what is on screen),
2. ends the current agent (its own exit), starts the new one with the canvas tools,
3. sends the brief as its first message.
Same tab, same canvas, same objects. Labelled honestly: a handoff, not shared memory.

## 4. Council

Ctrl+K → Council. Pick members (any installed agents), rounds (0–3), a chair, ask.
- Round 0: each member answers alone, in parallel, read-only, in the tab's folder.
- Rounds 1..n: each sees everyone's last answer and replies once (agree, push back, refine).
- The chair writes the conclusion: agreement, disagreement, recommendation.
- The person can add a note between rounds; everyone reads it next round.
One card per member, the conclusion at the end; it can be put on the canvas.

`src/main/council.ts` runs it (headless runs through `agents.ts`); `src/renderer/src/ui/Council.ts`
shows it. IPC: `ember:council:start|stop`, events on `ember:council:event`.

## 5. More providers

Registry additions, detection and headless only where the CLI's flags are known:
Qwen Code, Amp, Aider, Goose, Crush; OpenRouter documented as "via OpenCode".

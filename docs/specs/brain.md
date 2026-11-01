# Ember Brain: one knowledge for every agent

Status: built (2026-11-01). Code: `src/main/brain.ts`, tools in `resources/mcp-panel.mjs`,
Settings › Agent › Shared knowledge.

## Problem

Each agent CLI keeps what it knows in its own place (Claude: CLAUDE.md, memory folders,
skills; Codex: AGENTS.md, its own skills). Someone who mostly uses Claude has years of
context there; switch a tab to Codex and that context is gone.

## Design

Self-contained in Ember's own folder — no repo, no service:

```
~/.ember/brain/
  instructions.md      how the user works; handed to every agent
  memory/              one fact per file (name/description frontmatter) + MEMORY.md index
  skills/<name>/SKILL.md
  state.json           where instructions were seeded from, last sync
```

- **Seed (first sync):** instructions from `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`
  (whichever exists, without Ember's own section), Claude's memory files from every
  `~/.claude/projects/*/memory/`, Claude's skills. Otherwise a short template.
- **Memory for every agent:** Ember's MCP server (which every agent with the canvas tools
  loads) offers `recall`, `remember`, `forget`, `skills` on every surface. The files are
  plain markdown, so an agent without the tools can read them too.
- **Instructions:** a marked section (`<!-- ember:brain:start -->` … `end`) in each agent's
  global file — `~/.claude/CLAUDE.md` (an `@import` of instructions.md), `~/.codex/AGENTS.md`,
  `~/.gemini/GEMINI.md`, `~/.qwen/QWEN.md`, `~/.config/opencode/AGENTS.md` (the text itself)
  — plus the shared-memory protocol. Only agents whose folder exists. The agent the
  instructions were seeded from gets only the protocol. Each file is backed up once
  (`<file>.ember-backup`) before Ember first writes it; text outside the section is never touched.
- **Skills:** copied into `~/.codex/skills` and `~/.claude/skills` where missing (an existing
  skill there belongs to its owner and stays). Others read them through `skills`.
- **Staying current:** sync at start and every 15 minutes (Claude keeps writing its own
  memory); Settings has Sync now and an off switch (`config.brain.sync`).

## Limits

The models still differ. Claude-only features (hooks, subagent types, plugins' non-skill
parts) have no equivalent elsewhere. MCP server lists are not translated yet.

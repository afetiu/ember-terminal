# Contributing to Ember

Thanks for looking. Ember is a small Windows terminal for working alongside coding-agent
CLIs, and it means to stay small. Bug fixes and CLI support are the most welcome
changes. For anything bigger, open an issue or a discussion first, so nobody spends a
weekend on something that won't fit.

## The ideal first PR: one row of the agents table

Everything Ember knows about an agent CLI is one entry in
[`src/shared/agents.ts`](src/shared/agents.ts): how to find it, install it and sign in,
how to ask it one question headless, how to make that run read-only, how to give it the
panel's MCP server, and how to recognise it from the terminal title. The CLIs change
their flags often, so a row goes stale quietly. Checking one against the version you
have installed, and fixing it, is a contained and useful change.

To verify a row:

1. **Flags.** Check every flag in `headless`, `readOnly`, `unattended` and `promptFlag`
   against `<cli> --help` for your installed version.
2. **Headless answer.** Pick the CLI in Settings › Agent and press **Test**. It should
   come back with `ready`. Then run the map on a small repo. The run must not be able to
   change files.
3. **Orchestrator.** Ask the orchestrator something that makes it use its tools, for
   example "what is each tab doing?". This is the headless run with an MCP server
   attached (`attachMcp` in [`src/main/agents.ts`](src/main/agents.ts)).
4. **Panel and status.** Start the CLI in a tab. The card should show it, and asking it
   to draw something should reach the side panel. The PowerShell shims that announce
   each CLI and hand it the panel are `otherAgentShims` in
   [`src/main/pty/ConPtyHost.ts`](src/main/pty/ConPtyHost.ts).

In the PR, say which CLI version you tested against and which of the four steps you
ran. "Verified 1–3; the panel needs a login I don't have" is a fine PR.

Adding a CLI Ember doesn't know yet is the same work. Add a row and a case in
`attachMcp`. If the CLI has no per-session way to take an MCP server, use
`panel: 'none'`, as Cursor Agent does.

## Development setup

You need Windows 10 or 11, Node.js 22+, Git, and pnpm through corepack.

```powershell
git clone https://github.com/afetiu/ember-terminal
cd ember-terminal
corepack pnpm install
node node_modules/electron/install.js   # pnpm does not run Electron's download script
corepack pnpm dev                       # hot-reloading dev instance
```

Before you open a PR:

```powershell
corepack pnpm build    # typecheck both halves + bundle to out/
```

If you already use Ember as your terminal, close the dev instance by its own window or
process id, never by process name. `Stop-Process -Name electron` (or `Ember`) also
closes the terminal you are typing in.

## Ground rules

- **No API keys, ever.** Every AI feature goes through a CLI the person has already
  signed in to. Ember stores no credentials.
- **The shell stays untouched.** Ember wraps PowerShell. It does not change the user's
  profile or their agent CLIs' own config files. Anything Ember hands a CLI is set for
  that one call and nowhere else.
- **Small and plain.** Match the code style around you, and explain *why* in comments,
  not what. Keep a PR to one thing.
- **Typing never lags.** Changes that touch the terminal or the render loop should say
  how they were measured (`scripts/probe-*.mjs`).

By contributing you agree that your work is released under the [MIT license](LICENSE).

/**
 * The coding-agent CLIs Ember can host.
 *
 * Ember never talks to a model itself and never asks for an API key: every AI feature
 * goes through a CLI the person has already installed and signed in to, on their own
 * plan. This table is everything Ember needs to know about each one — how to find it,
 * how to install it, how to ask it one question headless, how to give it the panel,
 * and how to recognise it on a terminal screen.
 *
 * Shared by main (detection, install, headless runs, shims) and the renderer (Settings,
 * onboarding, status detection), so it holds data only.
 */

export type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'copilot' | 'qwen' | 'amp' | 'aider' | 'crush'

/** How a headless run's stdout is read. */
export type AgentOutput =
  /** Claude Code and Cursor Agent: `{"type":"assistant",…}` lines, then `{"type":"result"}`. */
  | 'claude-stream'
  /** Codex: `{"type":"item.completed","item":{"type":"agent_message","text":…}}` lines. */
  | 'codex-jsonl'
  /** Everything else: stdout is the answer. */
  | 'text'

/** How the panel's MCP server is handed to an interactive session. */
export type PanelAttach =
  /** `--mcp-config <file>` (Claude Code). */
  | 'mcp-config-flag'
  /** `-c mcp_servers.…` overrides on the command line (Codex). */
  | 'codex-overrides'
  /** `--additional-mcp-config @<file>` (Copilot CLI). */
  | 'copilot-flag'
  /** A settings file named by an environment variable (OpenCode). */
  | 'env-settings'
  /** No per-session way in yet; the panel works only if the person adds it themselves. */
  | 'none'

export interface AgentInstall {
  /** Shown on the button and run in a new tab, so the person watches it happen. */
  command: string
  /** What the install needs first, said plainly. */
  needs?: string
}

export interface AgentSpec {
  id: AgentId
  name: string
  vendor: string
  /** The command a person types. */
  bin: string
  /** Other names the same CLI answers to on PATH. */
  altBins?: string[]
  /** One line for Settings and onboarding. */
  blurb: string
  /** Where to read about it and sign in. */
  homepage: string
  /** How to get it signed in, said plainly, for Settings and onboarding. */
  setup?: string
  install: AgentInstall
  /** First run after install: how the person signs in (a command, or just the bin). */
  login: string
  /** Headless: the args before the prompt. The prompt goes in on stdin unless `promptArg`. */
  headless: string[]
  /** Headless flags that keep a run read-only, where the CLI has them. */
  readOnly: string[]
  /** Pass the prompt as the last argument instead of on stdin. */
  promptArg: boolean
  /**
   * With `promptArg`, the flag the prompt is the value of. It goes last, right before the
   * prompt, so no flag that takes a list (Copilot's `--allow-tool`) can swallow it.
   */
  promptFlag?: string
  output: AgentOutput
  panel: PanelAttach
  /** The environment variable an `env-settings` agent reads its extra config from. */
  settingsEnv?: string
  /** Matches the terminal title the CLI sets — or the one Ember's shim sets for it. */
  title: RegExp
  /**
   * Flags for a session Ember starts and briefs by itself: anything the CLI would
   * otherwise stop on at startup, where a typed brief would land in the wrong place.
   */
  unattended?: string[]
  /** Does it read `~/<dir>/skills/<name>/SKILL.md`? Ember's skills are installed there. */
  skillsDir?: string
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  claude: {
    id: 'claude',
    setup: 'Run claude once in a tab and sign in with your Claude account (Pro, Max, Team or Console).',
    name: 'Claude Code',
    vendor: 'Anthropic',
    bin: 'claude',
    blurb: 'Anthropic’s coding agent. Everything in Ember works with it, including live transcripts and plan usage.',
    homepage: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    install: { command: 'npm install -g @anthropic-ai/claude-code', needs: 'Node.js 18+' },
    login: 'claude',
    headless: ['-p', '--output-format', 'stream-json', '--verbose'],
    readOnly: ['--allowedTools', 'Read,Glob,Grep,LS', '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash'],
    promptArg: false,
    output: 'claude-stream',
    panel: 'mcp-config-flag',
    title: /(^|\s)claude(\s|$)|claude\s*code/i,
    skillsDir: '.claude',
  },
  codex: {
    id: 'codex',
    setup: 'Sign in runs codex login: choose Sign in with ChatGPT to use your ChatGPT plan.',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    bin: 'codex',
    blurb: 'OpenAI’s coding agent, signed in with your ChatGPT plan. Panel and status both work.',
    homepage: 'https://developers.openai.com/codex/cli',
    install: { command: 'npm install -g @openai/codex', needs: 'Node.js 18+' },
    login: 'codex login',
    headless: ['exec', '--json', '--skip-git-repo-check'],
    readOnly: ['--sandbox', 'read-only'],
    promptArg: false,
    output: 'codex-jsonl',
    panel: 'codex-overrides',
    title: /(^|\s)codex(\s|$)/i,
    unattended: ['-c', 'check_for_update_on_startup=false'],
    skillsDir: '.codex',
  },
  gemini: {
    id: 'gemini',
    setup: 'Run gemini once and choose Login with Google — the free tier needs nothing else.',
    name: 'Gemini CLI',
    vendor: 'Google',
    bin: 'gemini',
    blurb: 'Google’s open-source agent, signed in with a Google account. The panel does not reach its tabs yet.',
    homepage: 'https://github.com/google-gemini/gemini-cli',
    install: { command: 'npm install -g @google/gemini-cli', needs: 'Node.js 20+' },
    login: 'gemini',
    // Headless Gemini refuses to start in a folder nobody has trusted (exit 55), and a
    // headless run happens in whatever folder it is pointed at.
    headless: ['--skip-trust'],
    // Non-interactive, `default` runs read-only tools and trusted MCP servers and turns
    // down everything that would have asked. `plan` would also turn down MCP tools.
    readOnly: ['--approval-mode', 'default'],
    promptArg: false,
    output: 'text',
    // Since 0.6x Gemini skips a system settings file in any folder the user can write to,
    // so there is no per-session way in; a run gets a workspace of its own instead.
    panel: 'none',
    title: /(^|\s)gemini(\s|$)/i,
  },
  cursor: {
    id: 'cursor',
    setup: 'Sign in runs cursor-agent login with your Cursor account.',
    name: 'Cursor Agent',
    vendor: 'Cursor',
    bin: 'cursor-agent',
    altBins: ['agent'],
    blurb: 'Cursor’s agent in the terminal, on your Cursor plan. Add the panel in ~/.cursor/mcp.json to draw on it.',
    homepage: 'https://cursor.com/cli',
    install: {
      command: "powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm 'https://cursor.com/install?win32=true' | iex\"",
    },
    login: 'cursor-agent login',
    headless: ['-p', '--output-format', 'stream-json', '--trust'],
    readOnly: ['--mode', 'ask'],
    promptArg: true,
    output: 'claude-stream',
    panel: 'none',
    title: /(^|\s)(cursor[- ]?agent|cursor)(\s|$)/i,
  },
  opencode: {
    id: 'opencode',
    setup: 'Sign in runs opencode auth login: pick a provider. For OpenRouter, choose it and paste your OpenRouter key — the key stays in OpenCode, not Ember.',
    name: 'OpenCode',
    vendor: 'SST',
    bin: 'opencode',
    blurb: 'Open-source, provider-agnostic agent. Sign in with any provider it supports — OpenRouter included, which reaches most models with one key — or start on its free models.',
    homepage: 'https://opencode.ai',
    install: { command: 'npm install -g opencode-ai', needs: 'Node.js 18+' },
    login: 'opencode auth login',
    // `run` reads the prompt from stdin. As an argument it would have to point at a file,
    // and `run` turns down any read outside the working folder without asking.
    headless: ['run'],
    readOnly: ['--agent', 'plan'],
    promptArg: false,
    output: 'text',
    panel: 'env-settings',
    settingsEnv: 'OPENCODE_CONFIG',
    title: /(^|\s)opencode(\s|$)/i,
  },
  copilot: {
    id: 'copilot',
    setup: 'Sign in runs copilot login with the GitHub account that has your Copilot subscription.',
    name: 'Copilot CLI',
    vendor: 'GitHub',
    bin: 'copilot',
    blurb: 'GitHub Copilot’s agent in the terminal, on your Copilot subscription.',
    homepage: 'https://github.com/github/copilot-cli',
    install: { command: 'npm install -g @github/copilot', needs: 'Node.js 22+' },
    login: 'copilot login',
    // `-s` prints the answer alone, without the usage summary. With no `--allow-*` flag a
    // `-p` run reads but cannot write or run commands.
    headless: ['-s'],
    readOnly: [],
    promptArg: true,
    promptFlag: '-p',
    output: 'text',
    panel: 'copilot-flag',
    title: /(^|\s)(github\s+)?copilot(\s+cli)?(\s|$)/i,
  },
  qwen: {
    id: 'qwen',
    setup: 'Run qwen once and sign in with Qwen OAuth — or point it at any OpenAI-compatible endpoint (OpenRouter included) with its own settings.',
    name: 'Qwen Code',
    vendor: 'Alibaba',
    bin: 'qwen',
    blurb: 'Qwen’s coding agent, built on Gemini CLI. Sign in with a Qwen account, or point it at any OpenAI-compatible endpoint.',
    homepage: 'https://github.com/QwenLM/qwen-code',
    install: { command: 'npm install -g @qwen-code/qwen-code', needs: 'Node.js 20+' },
    login: 'qwen',
    headless: [],
    readOnly: ['--approval-mode', 'default'],
    promptArg: true,
    promptFlag: '-p',
    output: 'text',
    panel: 'none',
    title: /(^|\s)qwen(\s|$)/i,
  },
  amp: {
    id: 'amp',
    setup: 'Sign in runs amp login with your Amp account.',
    name: 'Amp',
    vendor: 'Sourcegraph',
    bin: 'amp',
    blurb: 'Sourcegraph’s agent, on your Amp account.',
    homepage: 'https://ampcode.com',
    install: { command: 'npm install -g @sourcegraph/amp', needs: 'Node.js 20+' },
    login: 'amp login',
    // Execute mode: one prompt, the answer on stdout, then exit.
    headless: [],
    readOnly: [],
    promptArg: true,
    promptFlag: '-x',
    output: 'text',
    panel: 'none',
    title: /(^|\s)amp(\s|$)/i,
  },
  aider: {
    id: 'aider',
    setup: 'Aider reads API keys from your environment: set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) for your user, then pick a model with --model, e.g. openrouter/anthropic/claude-sonnet-5.',
    name: 'Aider',
    vendor: 'Aider',
    bin: 'aider',
    blurb: 'The open-source pair programmer. Works with most model providers, OpenRouter included, through their own API keys.',
    homepage: 'https://aider.chat',
    install: { command: 'python -m pip install aider-install && aider-install', needs: 'Python 3.10+' },
    login: 'aider',
    headless: ['--yes-always', '--no-auto-commits', '--no-pretty', '--no-stream'],
    readOnly: ['--dry-run'],
    promptArg: true,
    promptFlag: '--message',
    output: 'text',
    panel: 'none',
    title: /(^|\s)aider(\s|$)/i,
  },
  crush: {
    id: 'crush',
    setup: 'Run crush once and choose a provider; for OpenRouter paste your key when it asks. The key stays in Crush.',
    name: 'Crush',
    vendor: 'Charm',
    bin: 'crush',
    blurb: 'Charm’s terminal agent. Bring any provider: OpenAI, Anthropic, Gemini, OpenRouter and more.',
    homepage: 'https://github.com/charmbracelet/crush',
    install: { command: 'npm install -g @charmland/crush', needs: 'Node.js 18+' },
    login: 'crush',
    headless: ['run'],
    readOnly: [],
    promptArg: true,
    output: 'text',
    panel: 'none',
    title: /(^|\s)crush(\s|$)/i,
  },
}

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[]

export function agentSpec(id: string | undefined): AgentSpec {
  return AGENTS[(id as AgentId) in AGENTS ? (id as AgentId) : 'claude']
}

/** Which agent a terminal title announces, if any. */
export function agentFromTitle(title: string): AgentId | null {
  for (const id of AGENT_IDS) if (AGENTS[id].title.test(title)) return id
  return null
}

/** What detection found on this machine. */
export interface AgentStatus {
  id: AgentId
  installed: boolean
  /** Resolved path of the command, when found. */
  path?: string
  version?: string
}

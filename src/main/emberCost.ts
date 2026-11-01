import type { EmberCost } from '../shared/types.js'

/**
 * What Ember itself costs a Claude session: the tokens spent on its panel and canvas
 * tools, measured from the session's own transcript.
 *
 * Three parts, each an estimate built from what the transcript records:
 *
 * - **out** — the share of each reply's output tokens that went into Ember tool calls (a
 *   diagram, a page, a step list). A reply's `usage.output_tokens` is split across its
 *   blocks by the length of what each block carried. Thinking is recorded empty, so its
 *   tokens are spread over the visible blocks; the share is a fair estimate, not a count.
 * - **carry** — that same content, and Ember's tool results, re-read on every later call
 *   while it stays in the conversation. Billed at the cache-read price.
 * - **overhead** — the panel server's instructions on every call, and its tool definitions
 *   once the session has loaded them (Claude Code defers MCP tools until they are needed).
 *
 * Prices are per million tokens, from the published price list (2026-06). A model not in
 * the table is priced as Opus 5.
 */

const PRICES: Array<[RegExp, { input: number; output: number; read: number }]> = [
  [/fable|mythos/i, { input: 10, output: 50, read: 0.25 }],
  [/opus-5-5|opus 5\.5/i, { input: 4, output: 20, read: 0.2 }],
  [/opus/i, { input: 5, output: 25, read: 0.5 }],
  [/sonnet-5|sonnet 5/i, { input: 2, output: 10, read: 0.2 }],
  [/sonnet/i, { input: 3, output: 15, read: 0.3 }],
  [/haiku/i, { input: 1, output: 5, read: 0.1 }],
]

function price(model: string): { input: number; output: number; read: number } {
  return PRICES.find(([re]) => re.test(model))?.[1] ?? { input: 5, output: 25, read: 0.5 }
}

/** Measured from resources/mcp-panel.mjs with EMBER_SURFACE=canvas (2026-10-31, after trimming): ~1.1k chars of instructions, ~3.3k of tool schemas. */
const INSTRUCTION_TOKENS = 400
const TOOL_DEF_TOKENS = 1350

const EMBER = /^mcp__ember-panel__/

/** Roughly four characters to a token for this kind of text. */
const tokens = (chars: number) => Math.ceil(chars / 4)

type Json = Record<string, unknown>

interface Reply {
  model: string
  out: number
  emberChars: number
  allChars: number
}

export class CostMeter {
  private readonly replies = new Map<string, Reply>()
  private readonly emberIds = new Set<string>()
  /** Ember content standing in the context, in tokens, and what re-reading it has cost. */
  private standing = 0
  private carryTokens = 0
  private carryUsd = 0
  private overheadTokens = 0
  private overheadUsd = 0
  private loaded = false
  private calls = 0

  /** One raw transcript line. Returns true when the totals changed. */
  add(line: Json): boolean {
    if (line['isSidechain'] === true) return false
    const msg = (line['message'] ?? {}) as Json
    const content = Array.isArray(msg['content']) ? (msg['content'] as Json[]) : []
    if (line['type'] === 'assistant') {
      const id = String(msg['id'] ?? line['uuid'] ?? '')
      const model = String(msg['model'] ?? '')
      let r = this.replies.get(id)
      if (!r) {
        // A new API call: everything standing in the context is read again.
        r = { model, out: 0, emberChars: 0, allChars: 0 }
        this.replies.set(id, r)
        this.calls++
        const p = price(model)
        const over = INSTRUCTION_TOKENS + (this.loaded ? TOOL_DEF_TOKENS : 0)
        this.overheadTokens += over
        this.overheadUsd += (over * p.read) / 1e6
        this.carryTokens += this.standing
        this.carryUsd += (this.standing * p.read) / 1e6
      }
      const usage = (msg['usage'] ?? {}) as Json
      r.out = Math.max(r.out, Number(usage['output_tokens'] ?? 0))
      for (const b of content) {
        const chars = b['type'] === 'text' ? String(b['text'] ?? '').length : b['type'] === 'tool_use' ? JSON.stringify(b['input'] ?? {}).length : 0
        r.allChars += chars
        if (b['type'] === 'tool_use' && EMBER.test(String(b['name'] ?? ''))) {
          r.emberChars += chars
          this.emberIds.add(String(b['id'] ?? ''))
          this.standing += tokens(chars)
          this.loaded = true
        }
      }
      return true
    }
    if (line['type'] === 'user') {
      let changed = false
      for (const b of content) {
        if (b['type'] !== 'tool_result' || !this.emberIds.has(String(b['tool_use_id'] ?? ''))) continue
        const c = b['content']
        this.standing += tokens(typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length)
        changed = true
      }
      // A compacted conversation starts over: what Ember put in it is gone.
      if (line['isCompactSummary'] === true) {
        this.standing = 0
        changed = true
      }
      return changed
    }
    return false
  }

  summary(tabId: string): EmberCost {
    let outTokens = 0
    let outUsd = 0
    for (const r of this.replies.values()) {
      if (!r.emberChars || !r.allChars) continue
      const share = Math.round(r.out * (r.emberChars / r.allChars))
      outTokens += share
      outUsd += (share * price(r.model).output) / 1e6
    }
    return {
      tabId,
      calls: this.calls,
      outTokens,
      carryTokens: this.carryTokens,
      overheadTokens: this.overheadTokens,
      tokens: outTokens + this.carryTokens + this.overheadTokens,
      usd: outUsd + this.carryUsd + this.overheadUsd,
    }
  }
}

import { escapeHtml, renderMarkdown } from './markdown'

/**
 * What Claude Code asks the person, as cards over the composer: a tool it wants to run,
 * its multiple-choice questions, the plan it wants approved. They arrive as Claude Code's
 * PermissionRequest hook (ClaudeTui); the answers are the hook's decision, in the same
 * shape the SDK's canUseTool takes (behavior, updatedInput, updatedPermissions, message).
 *
 * Every card stays until it is answered: an unanswered request holds the turn. Esc is
 * always the "no" of the card on top. Keys: the number on a button presses it, Enter is the
 * first one.
 */

type Json = Record<string, unknown>

export interface AsksContext {
  answer(requestId: string, response: Json): void
  /** After a plan is approved: the permission mode it was approved into. */
  setMode(mode: string): void
  relayout(): void
  /** A card closed: the keyboard goes back to the input. */
  closed(): void
}

interface Card {
  el: HTMLElement
  kind: 'tool' | 'question' | 'plan' | 'elicitation' | 'confirm'
  /** Esc. */
  no(): void
  key?(e: KeyboardEvent): boolean
}

export class Asks {
  readonly el = document.createElement('div')
  private readonly cards = new Map<string, Card>()

  constructor(private readonly ctx: AsksContext) {
    this.el.className = 'loom-asks'
  }

  get size(): number {
    return this.cards.size
  }

  kinds(): string[] {
    return [...this.cards.values()].map((c) => c.kind)
  }

  open(requestId: string, req: Json): void {
    if (this.cards.has(requestId)) return
    const subtype = String(req['subtype'] ?? 'can_use_tool')
    const tool = String(req['tool_name'] ?? '')
    const card =
      subtype === 'elicitation'
        ? this.elicitation(requestId, req)
        : tool === 'AskUserQuestion'
          ? this.question(requestId, req)
          : tool === 'ExitPlanMode'
            ? this.plan(requestId, req)
            : this.tool(requestId, req)
    this.mount(requestId, card)
  }

  private mount(requestId: string, card: Card): void {
    card.el.dataset['req'] = requestId
    card.el.tabIndex = -1
    card.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return // the canvas's Esc says no, for every card
      if (card.key?.(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    })
    this.cards.set(requestId, card)
    this.el.appendChild(card.el)
    this.el.classList.add('has-items')
    this.ctx.relayout()
    // The keyboard goes to the question: 1 / 2 / 3 and Enter answer it. At once, so a key
    // pressed the moment it shows is the card's; and again after layout, in case the
    // card was not focusable yet (its frame still hidden).
    const take = () => {
      if (!card.el.isConnected || card.el.contains(document.activeElement)) return
      const first = card.el.querySelector<HTMLElement>('[data-autofocus]')
      ;(first ?? card.el).focus({ preventScroll: true })
    }
    take()
    requestAnimationFrame(take)
  }

  /**
   * One of Ember's own questions, as a card like Claude's (nothing is sent to Claude Code):
   * yes or no, Esc = no. Resolves with the answer.
   */
  confirm(question: string, yes: string, no: string): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `ember-confirm-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const el = card(escapeHtml(question), 'is-confirm')
      el.insertAdjacentHTML('beforeend', acts([['yes', yes, true], ['no', no]], 'Enter yes · Esc no'))
      const done = (answer: boolean) => {
        if (!this.cards.has(id)) return
        this.close(id)
        resolve(answer)
      }
      el.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).closest<HTMLElement>('button[data-a]')?.dataset['a']
        if (a) done(a === 'yes')
      })
      this.mount(id, {
        el,
        kind: 'confirm',
        no: () => done(false),
        key: (e) => {
          if (e.key === '1' || (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement))) {
            done(true)
            return true
          }
          if (e.key === '2') {
            done(false)
            return true
          }
          return false
        },
      })
    })
  }

  /** Esc: no to the card on top. False when there is none. */
  escape(): boolean {
    const top = [...this.cards.values()].pop()
    if (!top) return false
    top.no()
    return true
  }

  close(requestId: string): void {
    const c = this.cards.get(requestId)
    if (!c) return
    c.el.remove()
    this.cards.delete(requestId)
    this.el.classList.toggle('has-items', this.cards.size > 0)
    this.ctx.relayout()
    this.ctx.closed()
  }

  closeAll(): void {
    for (const id of [...this.cards.keys()]) this.close(id)
  }

  private reply(requestId: string, response: Json): void {
    if (!this.cards.has(requestId)) return
    this.ctx.answer(requestId, response)
    this.close(requestId)
  }

  // ------------------------------------------------------------- a tool

  private tool(id: string, req: Json): Card {
    const input = (req['input'] ?? {}) as Json
    const tool = String(req['tool_name'] ?? '')
    const name = String(req['display_name'] ?? tool)
    const why = String(req['decision_reason'] ?? '')
    const suggestions = Array.isArray(req['permission_suggestions']) ? (req['permission_suggestions'] as Json[]) : []
    const always = suggestions.length > 0 && req['suppress_always_allow_rule'] !== true
    const el = card(`Claude wants to use <b>${escapeHtml(name)}</b>${req['agent_id'] ? ' <span class="loom-ask-card-sub">for a subagent</span>' : ''}`)
    el.insertAdjacentHTML('beforeend', preview(tool, input, String(req['description'] ?? '')))
    if (why) el.insertAdjacentHTML('beforeend', `<div class="loom-ask-card-why">${escapeHtml(why.slice(0, 400))}</div>`)
    const buttons: Array<[string, string, boolean?]> = [['yes', 'Yes', true]]
    if (always) buttons.push(['always', alwaysLabel(suggestions)])
    buttons.push(['no', 'No'])
    el.insertAdjacentHTML(
      'beforeend',
      acts(buttons) +
        `<input class="loom-ask-card-say" type="text" spellcheck="false" placeholder="Or tell Claude what to do instead, then Enter" aria-label="Tell Claude what to do instead">`
    )
    const allow = () => this.reply(id, { behavior: 'allow', updatedInput: input })
    const allowAlways = () => this.reply(id, { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions })
    // A plain No stops the turn, as Claude Code's own "No" does; words with it let it go on.
    const deny = (message = '') =>
      this.reply(id, message ? { behavior: 'deny', message: `The user said no: ${message}` } : { behavior: 'deny', message: "The user doesn't want to proceed with this tool use. The tool use was rejected.", interrupt: true })
    const say = el.querySelector<HTMLInputElement>('.loom-ask-card-say')!
    say.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && say.value.trim()) {
        e.preventDefault()
        e.stopPropagation()
        deny(say.value.trim())
      }
    })
    const run = (a: string | undefined) => (a === 'yes' ? allow() : a === 'always' ? allowAlways() : a === 'no' ? deny() : undefined)
    el.addEventListener('click', (e) => run((e.target as HTMLElement).closest<HTMLElement>('button[data-a]')?.dataset['a']))
    return {
      el,
      kind: 'tool',
      no: () => deny(),
      key: (e) => {
        if (isField(e.target)) return false
        const order = buttons.map((b) => b[0])
        if (/^[1-9]$/.test(e.key) && order[Number(e.key) - 1]) {
          run(order[Number(e.key) - 1])
          return true
        }
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          allow()
          return true
        }
        // Typing a letter starts the "what to do instead" line.
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) say.focus()
        return false
      },
    }
  }

  // ------------------------------------------------------------- a question

  private question(id: string, req: Json): Card {
    const input = (req['input'] ?? {}) as Json
    const qs = (Array.isArray(input['questions']) ? (input['questions'] as Json[]) : []).slice(0, 4)
    const el = card(`Claude asks${qs.length > 1 ? ` ${qs.length} questions` : ''}`, 'is-question')
    const picked: Array<Set<number>> = qs.map(() => new Set())
    const body = document.createElement('div')
    body.className = 'loom-ask-qs'
    qs.forEach((q, qi) => {
      const multi = q['multiSelect'] === true
      const opts = (Array.isArray(q['options']) ? (q['options'] as Json[]) : []).slice(0, 6)
      const block = document.createElement('div')
      block.className = 'loom-ask-q'
      block.dataset['q'] = String(qi)
      block.innerHTML =
        `<div class="loom-ask-q-head">${q['header'] ? `<span class="loom-ask-q-tag">${escapeHtml(String(q['header']))}</span>` : ''}<span class="loom-ask-q-text">${escapeHtml(String(q['question'] ?? ''))}</span>${multi ? '<span class="loom-ask-q-multi">pick any</span>' : ''}</div>` +
        `<div class="loom-ask-chips">` +
        opts
          .map(
            (o, oi) =>
              `<button type="button" class="loom-ask-chip" data-o="${oi}"${qi === 0 && oi === 0 ? ' data-autofocus' : ''} aria-pressed="false"><kbd>${oi + 1}</kbd><span class="l">${escapeHtml(String(o['label'] ?? ''))}</span>` +
              (o['description'] ? `<span class="d">${escapeHtml(String(o['description']))}</span>` : '') +
              `</button>`
          )
          .join('') +
        `</div>` +
        `<input class="loom-ask-other" type="text" spellcheck="false" placeholder="Other…" aria-label="Another answer">`
      body.appendChild(block)
    })
    el.appendChild(body)
    el.insertAdjacentHTML('beforeend', acts([['submit', 'Submit', true]], 'Enter submit · Esc dismiss', false))
    const single = qs.length === 1 && qs[0]!['multiSelect'] !== true
    const blocks = [...body.querySelectorAll<HTMLElement>('.loom-ask-q')]
    const answers = (): Record<string, string> => {
      const out: Record<string, string> = {}
      qs.forEach((q, qi) => {
        const opts = Array.isArray(q['options']) ? (q['options'] as Json[]) : []
        const other = blocks[qi]!.querySelector<HTMLInputElement>('.loom-ask-other')!.value.trim()
        const labels = [...picked[qi]!].sort((a, b) => a - b).map((i) => String(opts[i]?.['label'] ?? ''))
        const multi = q['multiSelect'] === true
        const value = multi ? [...labels, ...(other ? [other] : [])].join(', ') : other || labels[0] || ''
        if (value) out[String(q['question'] ?? '')] = value
      })
      return out
    }
    const submit = () => {
      const a = answers()
      if (!Object.keys(a).length) {
        blocks[0]?.querySelector<HTMLElement>('.loom-ask-chip')?.focus()
        return
      }
      this.reply(id, { behavior: 'allow', updatedInput: { ...input, answers: a } })
    }
    const toggle = (qi: number, oi: number) => {
      const multi = qs[qi]!['multiSelect'] === true
      const set = picked[qi]!
      if (multi) {
        if (set.has(oi)) set.delete(oi)
        else set.add(oi)
      } else {
        set.clear()
        set.add(oi)
        blocks[qi]!.querySelector<HTMLInputElement>('.loom-ask-other')!.value = ''
      }
      blocks[qi]!.querySelectorAll<HTMLElement>('.loom-ask-chip').forEach((c) => {
        const on = set.has(Number(c.dataset['o']))
        c.classList.toggle('is-on', on)
        c.setAttribute('aria-pressed', String(on))
      })
      // One question, one answer: picking it is answering.
      if (single) submit()
    }
    body.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('.loom-ask-chip')
      if (!chip) return
      toggle(Number(chip.closest<HTMLElement>('[data-q]')!.dataset['q']), Number(chip.dataset['o']))
    })
    body.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement
      if (!t.classList.contains('loom-ask-other')) return
      const qi = Number(t.closest<HTMLElement>('[data-q]')!.dataset['q'])
      // A typed answer replaces a single choice.
      if (qs[qi]!['multiSelect'] !== true && t.value.trim() && picked[qi]!.size) {
        picked[qi]!.clear()
        blocks[qi]!.querySelectorAll('.loom-ask-chip').forEach((c) => c.classList.remove('is-on'))
      }
    })
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button[data-a="submit"]')) submit()
    })
    /** The question the keys are for: the one with focus in it, else the first unanswered. */
    const current = (): number => {
      const f = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-q]')
      if (f && el.contains(f)) return Number(f.dataset['q'])
      const i = picked.findIndex((s) => s.size === 0)
      return i < 0 ? 0 : i
    }
    return {
      el,
      kind: 'question',
      no: () => this.reply(id, { behavior: 'deny', message: 'The user dismissed the question without answering.' }),
      key: (e) => {
        if (e.key === 'Enter') {
          submit()
          return true
        }
        if (isField(e.target)) return false
        if (/^[1-9]$/.test(e.key)) {
          const qi = current()
          const n = Number(e.key) - 1
          if (blocks[qi]?.querySelector(`.loom-ask-chip[data-o="${n}"]`)) toggle(qi, n)
          return true
        }
        return false
      },
    }
  }

  // ------------------------------------------------------------- the plan

  private plan(id: string, req: Json): Card {
    const input = (req['input'] ?? {}) as Json
    const text = String(input['plan'] ?? '')
    const el = card('Claude has a plan', 'is-plan')
    const body = document.createElement('div')
    body.className = 'loom-ask-plan'
    body.innerHTML = text.trim() ? renderMarkdown(text).html : '<p>(The plan is empty.)</p>'
    el.appendChild(body)
    el.insertAdjacentHTML(
      'beforeend',
      acts([
        ['edits', 'Yes, and accept edits', true],
        ['ask', 'Yes, ask before edits'],
        ['keep', 'Keep planning'],
      ], 'Enter approve · Esc keep planning') + `<input class="loom-ask-card-say" type="text" spellcheck="false" placeholder="Or say what to change in the plan, then Enter" aria-label="What to change">`
    )
    const approve = (mode: 'acceptEdits' | 'default') => {
      this.reply(id, { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] })
      this.ctx.setMode(mode)
    }
    const keep = (message = '') =>
      this.reply(id, { behavior: 'deny', message: message ? `The user wants changes to the plan: ${message}` : 'The user wants to keep planning. Do not start yet.' })
    const say = el.querySelector<HTMLInputElement>('.loom-ask-card-say')!
    say.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && say.value.trim()) {
        e.preventDefault()
        e.stopPropagation()
        keep(say.value.trim())
      }
    })
    const run = (a: string | undefined) => (a === 'edits' ? approve('acceptEdits') : a === 'ask' ? approve('default') : a === 'keep' ? keep() : undefined)
    el.addEventListener('click', (e) => run((e.target as HTMLElement).closest<HTMLElement>('button[data-a]')?.dataset['a']))
    return {
      el,
      kind: 'plan',
      no: () => keep(),
      key: (e) => {
        if (isField(e.target)) return false
        const order = ['edits', 'ask', 'keep']
        if (/^[1-3]$/.test(e.key)) {
          run(order[Number(e.key) - 1])
          return true
        }
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          approve('acceptEdits')
          return true
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) say.focus()
        return false
      },
    }
  }

  // ------------------------------------------------------------- an MCP server asks

  private elicitation(id: string, req: Json): Card {
    const server = String(req['display_name'] ?? req['mcp_server_name'] ?? 'An MCP server')
    const el = card(`<b>${escapeHtml(server)}</b> asks`, 'is-elicit')
    const message = String(req['message'] ?? '')
    if (message) el.insertAdjacentHTML('beforeend', `<div class="loom-ask-card-msg">${escapeHtml(message.slice(0, 1200))}</div>`)
    const url = String(req['url'] ?? '')
    const isUrl = req['mode'] === 'url' && /^https?:\/\//i.test(url)
    const schema = (req['requested_schema'] ?? {}) as Json
    const props = (schema['properties'] ?? {}) as Record<string, Json>
    const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as unknown[]).map(String) : [])
    const order = Array.isArray(req['property_order']) ? (req['property_order'] as unknown[]).map(String) : Object.keys(props)
    const keys = [...order.filter((k) => props[k]), ...Object.keys(props).filter((k) => !order.includes(k))]
    if (isUrl) {
      el.insertAdjacentHTML('beforeend', `<pre class="loom-ask-card-what">${escapeHtml(url)}</pre>`)
    } else if (keys.length) {
      const form = document.createElement('div')
      form.className = 'loom-ask-form'
      form.innerHTML = keys
        .map((k, i) => {
          const p = props[k]!
          const label = escapeHtml(String(p['title'] ?? k)) + (required.has(k) ? ' <i>*</i>' : '')
          const desc = p['description'] ? `<span class="d">${escapeHtml(String(p['description']))}</span>` : ''
          const auto = i === 0 ? ' data-autofocus' : ''
          const enums = Array.isArray(p['enum']) ? (p['enum'] as unknown[]).map(String) : null
          let field: string
          if (enums)
            field = `<select data-k="${escapeHtml(k)}"${auto}>${required.has(k) ? '' : '<option value=""></option>'}${enums.map((v) => `<option>${escapeHtml(v)}</option>`).join('')}</select>`
          else if (p['type'] === 'boolean') field = `<input type="checkbox" data-k="${escapeHtml(k)}"${p['default'] === true ? ' checked' : ''}${auto}>`
          else
            field = `<input type="${p['type'] === 'number' || p['type'] === 'integer' ? 'number' : 'text'}" spellcheck="false" data-k="${escapeHtml(k)}" value="${escapeHtml(String(p['default'] ?? ''))}"${auto}>`
          return `<label class="loom-ask-field"><span class="l">${label}</span>${desc}${field}</label>`
        })
        .join('')
      el.appendChild(form)
    }
    el.insertAdjacentHTML(
      'beforeend',
      acts(isUrl ? [['open', 'Open link', true], ['accept', 'Done'], ['decline', 'Decline']] : [['accept', keys.length ? 'Submit' : 'Accept', true], ['decline', 'Decline']], 'Enter submit · Esc decline', false)
    )
    const err = document.createElement('div')
    err.className = 'loom-ask-card-why is-err'
    const content = (): Json | null => {
      const out: Json = {}
      for (const k of keys) {
        const f = el.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-k="${CSS.escape(k)}"]`)
        if (!f) continue
        const p = props[k]!
        if (f instanceof HTMLInputElement && f.type === 'checkbox') out[k] = f.checked
        else if (f.value === '') {
          if (required.has(k)) {
            err.textContent = `${String(p['title'] ?? k)} is needed`
            el.appendChild(err)
            f.focus()
            return null
          }
        } else out[k] = p['type'] === 'number' || p['type'] === 'integer' ? Number(f.value) : f.value
      }
      return out
    }
    const accept = () => {
      if (isUrl) return this.reply(id, { action: 'accept' })
      const c = content()
      if (c) this.reply(id, { action: 'accept', content: c })
    }
    const decline = () => this.reply(id, { action: 'decline' })
    el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('button[data-a]')?.dataset['a']
      if (a === 'open') {
        window.open(url, '_blank', 'noopener')
        el.querySelector<HTMLElement>('button[data-a="accept"]')?.focus()
      } else if (a === 'accept') accept()
      else if (a === 'decline') decline()
    })
    return {
      el,
      kind: 'elicitation',
      no: decline,
      key: (e) => {
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          accept()
          return true
        }
        return false
      },
    }
  }
}

// ---------------------------------------------------------------- pieces

function card(head: string, cls = ''): HTMLElement {
  const el = document.createElement('div')
  el.className = `loom-ask-card${cls ? ` ${cls}` : ''}`
  el.innerHTML = `<div class="loom-ask-card-head"><span class="loom-ask-card-dot"></span><span>${head}</span></div>`
  return el
}

/** The buttons, numbered as their keys. The first is the one Enter presses. */
function acts(buttons: Array<[string, string, boolean?]>, keys = 'Enter allow · Esc no', numbered = true): string {
  return (
    `<div class="loom-ask-card-acts">` +
    buttons
      .map(([a, label, primary], i) => `<button type="button" data-a="${a}"${primary ? ' class="is-primary" data-autofocus' : ''}>${numbered ? `<kbd>${i + 1}</kbd>` : ''}${escapeHtml(label)}</button>`)
      .join('') +
    `<span class="loom-ask-card-keys">${escapeHtml(keys)}</span></div>`
  )
}

function isField(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
}

/** "Yes, and don't ask again for …", from what Claude Code suggests remembering. */
function alwaysLabel(suggestions: Json[]): string {
  const s = suggestions[0]!
  const where = s['destination'] === 'session' ? ' this session' : ''
  if (s['type'] === 'setMode' && s['mode'] === 'acceptEdits') return 'Yes, allow all edits this session'
  if (s['type'] === 'addDirectories') {
    const dirs = Array.isArray(s['directories']) ? (s['directories'] as unknown[]).map(String) : []
    return `Yes, and allow ${dirs[0] ? short(dirs[0]) : 'that folder'}${where}`
  }
  if (s['type'] === 'addRules' || s['type'] === 'replaceRules') {
    const rules = Array.isArray(s['rules']) ? (s['rules'] as Json[]) : []
    const r = rules[0]
    const what = r ? (r['ruleContent'] ? `${String(r['toolName'])}(${short(String(r['ruleContent']))})` : String(r['toolName'])) : 'this'
    return `Yes, and don't ask again for ${what}${where}`
  }
  return "Yes, and don't ask again"
}

function short(s: string): string {
  return s.length > 48 ? `${s.slice(0, 46)}…` : s
}

/** What the tool is about to do: the command, the file and its change, the address. */
function preview(tool: string, input: Json, description: string): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const pre = (t: string, cls = '') => `<pre class="loom-ask-card-what${cls}">${t}</pre>`
  if (s('command')) {
    return pre(escapeHtml(s('command').slice(0, 2000))) + (s('description') ? `<div class="loom-ask-card-why">${escapeHtml(s('description'))}</div>` : '')
  }
  const file = s('file_path') || s('notebook_path') || s('path')
  if (file && (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit')) {
    const edits = Array.isArray(input['edits']) ? (input['edits'] as Json[]) : [{ old_string: input['old_string'], new_string: input['new_string'] ?? input['new_source'] }]
    const lines: string[] = []
    for (const e of edits.slice(0, 4)) {
      const del = String(e['old_string'] ?? '').split('\n')
      const ins = String(e['new_string'] ?? '').split('\n')
      if (lines.length) lines.push('<span class="sep">⋯</span>')
      if (e['old_string']) for (const l of del.slice(0, 16)) lines.push(`<span class="del">- ${escapeHtml(l)}</span>`)
      for (const l of ins.slice(0, 16)) lines.push(`<span class="ins">+ ${escapeHtml(l)}</span>`)
    }
    return `<div class="loom-ask-card-file">${escapeHtml(file)}</div>` + pre(lines.join('\n'), ' is-diff')
  }
  if (file && tool === 'Write') {
    const content = s('content').split('\n')
    const head = content.slice(0, 14).map((l) => `<span class="ins">+ ${escapeHtml(l)}</span>`)
    if (content.length > 14) head.push(`<span class="sep">… ${content.length - 14} more lines</span>`)
    return `<div class="loom-ask-card-file">${escapeHtml(file)}</div>` + pre(head.join('\n'), ' is-diff')
  }
  if (file) return pre(escapeHtml(file))
  if (s('url')) return pre(escapeHtml(s('url'))) + (s('prompt') ? `<div class="loom-ask-card-why">${escapeHtml(s('prompt').slice(0, 300))}</div>` : '')
  if (description) return pre(escapeHtml(description))
  try {
    const json = JSON.stringify(input, null, 2)
    return json === '{}' ? '' : pre(escapeHtml(json.slice(0, 1200)))
  } catch {
    return ''
  }
}

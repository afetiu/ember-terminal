/**
 * Questions at the end of a reply, answered with a click.
 *
 * When Claude ends a turn by asking things — a numbered list under "Questions", or a last
 * sentence ending in `?` — the canvas puts an answer card right under them: each question
 * gets the options its own words name (Yes / No, "X or Y", "the other options are A, B
 * and C", "(A, B or C)") as chips, and a field for anything else. Send composes one line
 * ("1. Platform; 2. All repos; 3. Yes — ask him") and types it into the session as the
 * user would. The reply's text is left as it is; the card only adds to it.
 *
 * All of this is heuristics over the rendered reply. A question it cannot read options
 * from still gets a field, so the card is never worse than the prompt.
 */

export interface Question {
  /** The question as written, for the row's label. */
  text: string
  options: string[]
  /** The option the question says is set now ("Is X correct?"). */
  current?: string
}

const YESNO = /^(?:is|are|am|was|were|should|shall|can|could|do|does|did|will|would|have|has|had|may|might|must|want|ok|okay|need|any|anything)\b/i
const PREPS = new Set(['for', 'in', 'to', 'on', 'at', 'with', 'by', 'from', 'into', 'via', 'as', 'under', 'over', 'through'])
const ARTICLES = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'his', 'her', 'their', 'this', 'that', 'these', 'those'])

const clean = (s: string): string =>
  s
    .replace(/[`"“”‘’]/g, '')
    .replace(/^[\s'(]+|[\s')?.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** "A, B, C and D" / "A, B or C" — the names, or nothing if it does not read as a list of names. */
function names(list: string): string[] {
  const parts = list
    .replace(/\betc\.?$/i, '')
    .split(/\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+|\s*\/\s*/i)
    .map(clean)
    .filter(Boolean)
  if (parts.length < 2 || parts.length > 8) return []
  if (parts.some((p) => p.length > 40 || p.split(' ').length > 6)) return []
  return parts
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+(?=[A-Z0-9"'`(“])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean)
}

/** "for the 3 pilot repos, or for all repos" → the two sides, as the user would name them. */
function alternatives(q: string): string[] | 'yesno' | null {
  const body = q.replace(/\?\s*$/, '')
  const re = /,?\s+or\s+/gi
  let m: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((m = re.exec(body))) last = m
  if (!last) return null
  const right = body.slice(last.index + last[0].length).trim()
  if (/^not\b/i.test(right)) return 'yesno'
  if (/^(?:so|something|anything|other)\b/i.test(right) || words(right).length > 7) return null
  const segs = body.slice(0, last.index).split(/\s*,\s*/)
  const head = segs[0] ?? ''
  const middle = segs.slice(1)
  const w = (words(right)[0] ?? '').toLowerCase()
  let first: string
  let rest = [...middle, right]
  const at = head.toLowerCase().lastIndexOf(` ${w} `)
  if (w && PREPS.has(w) && at >= 0) {
    first = head.slice(at + w.length + 2)
    rest = rest.map((r) => (r.toLowerCase().startsWith(`${w} `) ? r.slice(w.length + 1) : r))
  } else if (w && ARTICLES.has(w) && at >= 0) {
    first = head.slice(at + 1)
  } else {
    const n = Math.max(1, Math.min(4, words(right).length))
    first = words(head).slice(-n).join(' ')
  }
  const out = [first, ...rest].map(clean).filter(Boolean)
  if (out.length < 2 || out.some((o) => o.split(' ').length > 8)) return null
  return out
}

/**
 * The options one question names. `codes` are the code spans in it, which is usually how
 * a value is marked ("Is Product Line `Platform` correct?").
 */
export function readQuestion(text: string, codes: string[] = []): Question {
  const all = text.replace(/\s+/g, ' ').trim()
  const ss = sentences(all)
  const q = ss.find((s) => /\?\s*$/.test(s)) ?? ss.find((s) => s.includes('?')) ?? all
  const base: Question = { text: q, options: [] }

  // "Is X correct? The other options are A, B and C."
  const others = /\b(?:the\s+)?(?:other|alternative)\s+(?:options|choices|values)\s+(?:are|would be|include)\s*:?\s*([^.?!]+)|\b(?:other\s+)?options\s*:\s*([^.?!]+)/i.exec(all)
  if (others) {
    const rest = names(others[1] ?? others[2] ?? '')
    if (rest.length) {
      const is = /^(?:is|are)\s+(.+?)\s+(?:correct|right|ok|okay|fine|good|the right one)\b/i.exec(q)
      let current: string | undefined
      if (is) {
        const x = is[1] ?? ''
        current = [...codes].reverse().find((c) => x.includes(c)) ?? /["“']([^"”']+)["”']/.exec(x)?.[1] ?? clean(x)
      }
      const opts = current ? [current, ...rest.filter((r) => r.toLowerCase() !== current!.toLowerCase())] : rest
      return { ...base, options: opts, current }
    }
  }

  // "(A, B or C)" or ": A, B or C?"
  const paren = /\(([^()]*(?:,|\bor\b)[^()]*)\)[^()]*$/.exec(q)
  if (paren) {
    const opts = names(paren[1] ?? '')
    if (opts.length) return { ...base, options: opts }
  }
  const colon = /:\s*([^:]+?)\?\s*$/.exec(q)
  if (colon && /,|\bor\b/.test(colon[1] ?? '')) {
    const opts = names(colon[1] ?? '')
    if (opts.length) return { ...base, options: opts }
  }

  const alt = alternatives(q)
  if (Array.isArray(alt)) return { ...base, options: alt }
  if (alt === 'yesno' || YESNO.test(q)) return { ...base, options: ['Yes', 'No'] }
  return base
}

/** First letter up, unless the word is already cased on purpose (iOS, npm's `x`). */
function label(s: string): string {
  return /^[a-z][a-z\s]/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s
}

interface Found {
  after: HTMLElement
  items: Array<{ text: string; codes: string[] }>
}

/** Where the questions are in a rendered reply, if it ends by asking. */
function find(say: HTMLElement): Found | null {
  const blocks = Array.from(say.children) as HTMLElement[]
  const codesOf = (e: HTMLElement): string[] => Array.from(e.querySelectorAll('code')).map((c) => c.textContent ?? '')
  const lists = blocks.filter((b) => b.tagName === 'OL' || b.tagName === 'UL')
  const list = lists[lists.length - 1]
  if (list) {
    const pos = blocks.indexOf(list)
    const prev = blocks[pos - 1]
    const titled = !!prev && /question/i.test(prev.textContent ?? '') && (prev.textContent ?? '').length < 80
    // Near the end: nothing after it but a line or two.
    const tail = blocks.slice(pos + 1)
    const nearEnd = tail.length <= 1 && tail.every((b) => b.tagName === 'P' && (b.textContent ?? '').length < 240)
    const lis = Array.from(list.children).filter((c) => c.tagName === 'LI') as HTMLElement[]
    const asks = lis.filter((li) => (li.textContent ?? '').includes('?'))
    if (asks.length && asks.length * 2 >= lis.length && (titled || nearEnd)) {
      return { after: list, items: asks.map((li) => ({ text: li.textContent ?? '', codes: codesOf(li) })) }
    }
  }
  // No list: the reply's last paragraph ends with a question.
  const last = blocks[blocks.length - 1]
  if (last && last.tagName === 'P' && /\?\s*$/.test(last.textContent ?? '')) {
    const ss = sentences((last.textContent ?? '').trim())
    return { after: last, items: [{ text: ss[ss.length - 1] ?? '', codes: codesOf(last) }] }
  }
  return null
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** The line a set of answers goes out as: numbered when there is more than one question. */
export function compose(answers: Array<{ n: number; choice: string; text: string }>, total: number): string {
  const one = (a: { choice: string; text: string }) => (a.choice && a.text ? `${a.choice} — ${a.text}` : a.choice || a.text)
  const given = answers.filter((a) => a.choice || a.text)
  if (total === 1) return given[0] ? one(given[0]) : ''
  return given.map((a) => `${a.n}. ${one(a)}`).join('; ')
}

/**
 * Put an answer card under the questions in `say`, if it asks any. Returns the card.
 * `send` is called with the composed line when the user presses Send.
 */
export function answerCard(say: HTMLElement, send: (text: string) => void): HTMLElement | null {
  const found = find(say)
  if (!found) return null
  const questions = found.items.map((i) => readQuestion(i.text, i.codes))
  const card = el('div', 'loom-answers')
  card.setAttribute('role', 'group')
  card.setAttribute('aria-label', 'Answer the questions')
  const total = questions.length
  const rows: Array<{ n: number; chosen: () => string; input: HTMLInputElement }> = []
  const go = el('button', 'loom-ans-send', 'Send')
  go.type = 'button'
  go.disabled = true
  const note = el('span', 'loom-ans-note', questions.some((q) => q.options.length) ? 'Pick or type, then send' : 'Type, then send')

  const value = () =>
    compose(
      rows.map((r) => ({ n: r.n, choice: r.chosen(), text: r.input.value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() })),
      total,
    )
  const update = () => {
    go.disabled = card.classList.contains('is-sent') || !value()
  }

  questions.forEach((q, i) => {
    const n = i + 1
    const row = el('div', 'loom-ans-row')
    row.dataset['n'] = String(n)
    row.title = q.text
    if (total > 1) row.appendChild(el('span', 'loom-ans-n', String(n)))
    const body = el('div', 'loom-ans-body')
    const chips: HTMLButtonElement[] = []
    for (const opt of q.options) {
      const chip = el('button', 'loom-ans-chip')
      chip.type = 'button'
      chip.dataset['value'] = label(opt)
      chip.setAttribute('aria-pressed', 'false')
      chip.appendChild(document.createTextNode(label(opt)))
      if (q.current && opt === q.current) {
        chip.classList.add('is-current')
        chip.appendChild(el('span', 'loom-ans-tag', 'now'))
      }
      chip.addEventListener('click', () => {
        const on = chip.getAttribute('aria-pressed') !== 'true'
        for (const c of chips) c.setAttribute('aria-pressed', 'false')
        chip.setAttribute('aria-pressed', on ? 'true' : 'false')
        update()
      })
      chips.push(chip)
      body.appendChild(chip)
    }
    const input = el('input', 'loom-ans-other')
    input.type = 'text'
    input.spellcheck = false
    input.placeholder = q.options.length ? 'Other…' : 'Your answer…'
    if (!q.options.length) input.classList.add('is-only')
    input.setAttribute('aria-label', `Answer ${n}: ${q.text}`)
    input.addEventListener('input', update)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        if (!go.disabled) go.click()
      }
    })
    body.appendChild(input)
    row.appendChild(body)
    card.appendChild(row)
    rows.push({ n, chosen: () => chips.find((c) => c.getAttribute('aria-pressed') === 'true')?.dataset['value'] ?? '', input })
  })

  const foot = el('div', 'loom-ans-foot')
  foot.append(note, go)
  card.appendChild(foot)
  go.addEventListener('click', () => {
    const text = value()
    if (!text || card.classList.contains('is-sent')) return
    card.classList.add('is-sent')
    for (const b of card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) b.disabled = true
    note.textContent = 'Sent'
    go.hidden = true
    send(text)
  })
  found.after.after(card)
  return card
}

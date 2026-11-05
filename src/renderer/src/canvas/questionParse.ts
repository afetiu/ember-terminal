/**
 * Reading the options out of a question Claude wrote in prose.
 *
 * In order of trust:
 *   1. options it lettered or numbered — "A, x; B, y; or C, z", "(A) x (B) y", "a) x",
 *      "1) x 2) y", "Option A: x", or as bullets under the question;
 *   2. options it named — "the other options are A, B and C", "(x, y or z)", ": x or y?",
 *      "x, y, or z?";
 *   3. Yes / No, only for a yes/no question that lists nothing.
 * When none of these reads cleanly the question gets no options (a free answer): a wrong
 * set of chips is worse than none. No DOM here, so node --test can run it
 * (scripts/test-questions.mjs).
 */

export interface Question {
  /** The question as written, without its listed options. */
  text: string
  options: string[]
  /** The keys the reply gave its options ("A", "B" or "1", "2"), when it lettered them. */
  keys?: string[]
  /** The option the question says is set now ("Is X correct?"). */
  current?: string
}

const YESNO = /^(?:is|are|am|was|were|should|shall|can|could|do|does|did|will|would|have|has|had|may|might|must|want|ok|okay|need|any|anything|ready)\b/i
/** Words a question starts with; never an option. */
const ASKING = /^(?:which|what|who|whom|whose|how|why|when|where|do you|did you|would you|should|shall|is it|are you|can you)\b/i
const PREPS = new Set(['for', 'in', 'to', 'on', 'at', 'with', 'by', 'from', 'into', 'via', 'as', 'under', 'over', 'through'])
const ARTICLES = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'his', 'her', 'their', 'this', 'that', 'these', 'those'])

const clean = (s: string): string =>
  s
    .replace(/[`"“”‘’*]/g, '')
    .replace(/^[\s'(]+|[\s')?.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** An option's words, without the glue round it ("…; or", "and …", "wait."). */
function optionText(s: string): string {
  let t = s.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 4; i++) {
    const before = t
    t = t
      .replace(/^(?:or|and)\s+/i, '')
      .replace(/\s+(?:or|and)$/i, '')
      .replace(/[\s;,.:!—–-]+$/, '')
      .replace(/^[\s;,:—–-]+/, '')
      .trim()
    if (t === before) break
  }
  return t
}

// --------------------------------------------------------------- 1. lettered options

interface Mark {
  index: number
  end: number
  key: string
  family: 'U' | 'L' | 'D'
  style: string
}

const MARK = /(?<=^|[\s:;,.?!—–(-])(?:(?:[Oo]ption|[Cc]hoice)\s+)?(?:\(([A-Ha-h]|[1-8])\)|([A-Ha-h]|[1-8])(\)|[.:,](?=\s)|\s+[-–—](?=\s)))/g

function marks(s: string): Mark[] {
  const out: Mark[] = []
  MARK.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MARK.exec(s))) {
    const key = (m[1] ?? m[2])!
    const style = m[1] ? ')' : m[3]!.trim() || '-'
    const family: Mark['family'] = /[A-H]/.test(key) ? 'U' : /[a-h]/.test(key) ? 'L' : 'D'
    // "a, b" and "1, 2 or 3" are words and numbers, not keys.
    if (style === ',' && family !== 'U') continue
    if (family === 'L' && style === '.') continue
    out.push({ index: m.index, end: m.index + m[0].length, key, family, style: style === ')' ? ')' : style })
  }
  return out
}

const next = (k: string): string => String.fromCharCode(k.charCodeAt(0) + 1)
const FIRST = { U: 'A', L: 'a', D: '1' }

/** The longest run of keys in order (A, B, C… of one kind and one style). */
function chain(ms: Mark[]): Mark[] {
  let best: Mark[] = []
  ms.forEach((start, i) => {
    if (start.key !== FIRST[start.family]) return
    const run = [start]
    for (let j = i + 1; j < ms.length; j++) {
      const c = ms[j]!
      const last = run[run.length - 1]!
      if (c.family === start.family && c.style === start.style && c.key === next(last.key) && c.index >= last.end) run.push(c)
    }
    if (run.length >= 2 && run.length > best.length) best = run
  })
  return best
}

/** "Which do you want? A, x; B, y; or C, z." → the question and its keyed options. */
function lettered(all: string): Question | null {
  const run = chain(marks(all))
  if (!run.length) return null
  const options: string[] = []
  let tail = ''
  for (let i = 0; i < run.length; i++) {
    let seg = all.slice(run[i]!.end, run[i + 1]?.index ?? all.length)
    if (i === run.length - 1) {
      // The last one ends where its sentence does.
      const stop = /\?|\.\s+(?=[A-Z])|\s+[—–]\s+(?=which|what|or\b)/i.exec(seg)
      if (stop) {
        tail = seg.slice(stop.index + stop[0].length)
        seg = seg.slice(0, stop.index)
      }
    }
    const t = optionText(seg)
    if (!t || t.length > 200 || ASKING.test(t)) return null
    options.push(t)
  }
  const before = all.slice(0, run[0]!.index).replace(/[\s:;,—–-]+$/, '').trim()
  const said = sentences(before)
  const text = said[said.length - 1] || sentences(tail).find((s) => s.includes('?')) || before
  return { text: text || all, options, keys: run.map((m) => m.key.toUpperCase()) }
}

/** Bullets under a question: "- A: x" (keyed) or "- x" (plain). */
function bulleted(subs: string[]): Pick<Question, 'options' | 'keys'> | null {
  if (subs.length < 2 || subs.length > 8) return null
  const lead = /^\s*(?:(?:option|choice)\s+)?(?:\(([A-Ha-h1-8])\)|([A-Ha-h1-8])(?:[).:]|\s+[-–—]))\s*[-–—:]?\s*/i
  const ms = subs.map((s) => lead.exec(s))
  const keys = ms.map((m) => (m ? (m[1] ?? m[2])!.toUpperCase() : ''))
  const ordered = keys.every((k, i) => k && k === (/\d/.test(keys[0]!) ? String(i + 1) : String.fromCharCode(65 + i)))
  const options = subs.map((s, i) => optionText(ordered ? s.slice(ms[i]![0].length) : s))
  if (options.some((o) => !o || o.length > 200)) return null
  return ordered ? { options, keys } : { options }
}

// --------------------------------------------------------------- 2. named options

/** "A, B, C and D" / "A, B or C" — the names, or nothing if it does not read as a list of names. */
function names(list: string): string[] {
  const parts = list
    .replace(/\betc\.?$/i, '')
    .split(/\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+|\s*\/\s*/i)
    .map(clean)
    .filter(Boolean)
  if (parts.length < 2 || parts.length > 8) return []
  if (parts.some((p) => p.length > 40 || p.split(' ').length > 6 || ASKING.test(p))) return []
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

/** "Should I", "Do you want me to" — the asking before the first alternative. */
const LEAD = /^(?:should|shall|can|could|would|will|do|does|did|may|must)\s+(?:i|we|you|it|they)\s+(?:want\s+(?:me|us)\s+to\s+|like\s+(?:me|us)\s+to\s+)?/i

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
  if (/^(?:so|something|anything|other|else)\b/i.test(right) || ASKING.test(right) || words(right).length > 7) return null
  const segs = body.slice(0, last.index).split(/\s*,\s*/)
  const head = segs[0] ?? ''
  const middle = segs.slice(1)
  const w = (words(right)[0] ?? '').toLowerCase()
  let first: string
  let rest = [...middle, right]
  const at = head.toLowerCase().lastIndexOf(` ${w} `)
  const stripped = head.replace(LEAD, '')
  if (w && PREPS.has(w) && at >= 0) {
    first = head.slice(at + w.length + 2)
    rest = rest.map((r) => (r.toLowerCase().startsWith(`${w} `) ? r.slice(w.length + 1) : r))
  } else if (w && ARTICLES.has(w) && at >= 0) {
    first = head.slice(at + 1)
  } else if (!middle.length && stripped !== head && words(stripped).length <= words(right).length + 1) {
    // "Should I merge now or wait for CI?" → merge now / wait for CI.
    first = stripped
  } else {
    const n = Math.max(1, Math.min(4, words(right).length))
    first = words(head).slice(-n).join(' ')
  }
  const out = [first, ...rest].map(clean).filter(Boolean)
  if (out.length < 2 || out.some((o) => o.split(' ').length > 8 || ASKING.test(o))) return null
  return out
}

/**
 * The options one question names. `codes` are the code spans in it, which is usually how
 * a value is marked ("Is Product Line `Platform` correct?"); `subs` are bullets under it.
 */
export function readQuestion(text: string, codes: string[] = [], subs: string[] = []): Question {
  const all = text.replace(/\s+/g, ' ').trim()

  const keyed = lettered(all)
  if (keyed) return keyed

  const ss = sentences(all)
  const asks = ss.filter((s) => /\?\s*$/.test(s))
  const q = asks[asks.length - 1] ?? ss.find((s) => s.includes('?')) ?? all
  const base: Question = { text: q, options: [] }

  const listed = bulleted(subs)
  if (listed) return { ...base, ...listed }

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

  // A code span is a value, not punctuation: `contents: write` holds no colon.
  const plain = codes.filter(Boolean).reduce((s, c) => s.split(c).join('§'.repeat(c.length)), q)

  // "(A, B or C)" or ": A, B or C?"
  const paren = /\(([^()]*(?:,|\bor\b)[^()]*)\)[^()]*$/.exec(plain)
  if (paren) {
    const opts = names(q.slice(paren.index + 1, paren.index + 1 + paren[1]!.length))
    if (opts.length) return { ...base, options: opts }
  }
  const colon = /:\s*([^:]+?)\?\s*$/.exec(plain)
  if (colon && /,|\bor\b/.test(colon[1] ?? '')) {
    const start = colon.index + colon[0].indexOf(colon[1]!)
    const opts = names(q.slice(start, start + colon[1]!.length))
    if (opts.length) return { ...base, options: opts }
  }

  const alt = alternatives(q)
  if (Array.isArray(alt)) return { ...base, options: alt }
  if (alt === 'yesno' || YESNO.test(q)) return { ...base, options: ['Yes', 'No'] }
  return base
}

/** First letter up, unless the word is already cased on purpose (iOS, npm's `x`). */
export function label(s: string): string {
  return /^[a-z][a-z\s,]/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s
}

export interface Answer {
  n: number
  /** The option's key when the reply lettered its options ("A"). */
  key?: string
  /** The option's words, or what was typed. */
  text: string
}

/** The line a set of answers goes out as: "1. A — yes, both; 2. …", unnumbered for one question. */
export function compose(answers: Answer[], total: number): string {
  const one = (a: Answer) => (a.key ? `${a.key} — ${a.text}` : a.text)
  const given = answers.filter((a) => a.text)
  if (total === 1) return given[0] ? one(given[0]) : ''
  return given.map((a) => `${a.n}. ${one(a)}`).join('; ')
}

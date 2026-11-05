/**
 * Questions at the end of a reply, answered on a card.
 *
 * When Claude ends a turn by asking things — a numbered list under "Questions", or a last
 * sentence ending in `?` — the canvas puts an answer card right under them, the same card
 * as Claude's own AskUserQuestion (questionDeck.ts): one question at a time, its options
 * as rows (the ones it lettered, A / B / C, or named, or Yes / No), "Other…" last, then a
 * review and Submit. Submit composes one line ("1. A — yes, both; 2. …") and types it into
 * the session as the user would. The reply's text is left as it is; the card only adds.
 *
 * Reading the options is heuristics over the rendered reply (questionParse.ts). A question
 * it cannot read options from gets a field only, so the card is never worse than the prompt.
 */
import { compose, label, readQuestion, type Question } from './questionParse'
import { questionDeck, type DeckQuestion } from './questionDeck'

interface Found {
  after: HTMLElement
  items: Array<{ text: string; codes: string[]; subs: string[] }>
}

/** A list item's own words, without the lists nested in it. */
function ownText(li: HTMLElement): string {
  const c = li.cloneNode(true) as HTMLElement
  c.querySelectorAll('ul, ol').forEach((l) => l.remove())
  return c.textContent ?? ''
}

function subItems(li: HTMLElement): string[] {
  const nested = li.querySelector(':scope > ul, :scope > ol')
  return nested ? (Array.from(nested.children).filter((c) => c.tagName === 'LI') as HTMLElement[]).map((c) => c.textContent ?? '') : []
}

const SENTENCE = /(?<=[.?!])\s+(?=[A-Z0-9"'`(“])/

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
    const asks = lis.filter((li) => ownText(li).includes('?'))
    if (asks.length && asks.length * 2 >= lis.length && (titled || nearEnd)) {
      return { after: list, items: asks.map((li) => ({ text: ownText(li), codes: codesOf(li), subs: subItems(li) })) }
    }
    // "Which one?" with its options as the list under it, at the very end.
    const lead = prev?.tagName === 'P' ? (prev.textContent ?? '').trim() : ''
    if (!tail.length && !asks.length && /\?\s*:?$/.test(lead) && lis.length >= 2 && lis.length <= 8) {
      const ss = lead.split(SENTENCE)
      return { after: list, items: [{ text: ss[ss.length - 1] ?? lead, codes: codesOf(prev!), subs: lis.map((li) => li.textContent ?? '') }] }
    }
  }
  // No list: the reply's last paragraph asks — ends with a question, or with its options.
  const last = blocks[blocks.length - 1]
  if (last && last.tagName === 'P') {
    const text = (last.textContent ?? '').trim()
    const whole = readQuestion(text, codesOf(last))
    if (whole.keys && whole.text.includes('?')) return { after: last, items: [{ text, codes: codesOf(last), subs: [] }] }
    if (/\?\s*$/.test(text)) {
      const ss = text.split(SENTENCE)
      return { after: last, items: [{ text: ss[ss.length - 1] ?? '', codes: codesOf(last), subs: [] }] }
    }
    const q = text.lastIndexOf('?')
    if (q > 0) {
      // "… Which do you want? A) x B) y." — the question sentence and its options after it.
      const ss = text.slice(0, q + 1).split(SENTENCE)
      const from = text.slice(0, q + 1).length - (ss[ss.length - 1] ?? '').length
      const asked = text.slice(from)
      if (readQuestion(asked, codesOf(last)).keys) return { after: last, items: [{ text: asked, codes: codesOf(last), subs: [] }] }
    }
  }
  return null
}

/** A read question as the deck shows it: the reply's own keys, else 1 2 3. */
function toDeck(q: Question): DeckQuestion {
  return {
    text: q.text,
    options: q.options.map((o, i) => ({
      label: label(o),
      key: q.keys?.[i] ?? String(i + 1),
      tag: q.current && o === q.current ? 'current' : undefined,
    })),
  }
}

/**
 * Put an answer card under the questions in `say`, if it asks any. Returns the card.
 * `send` is called with the composed line when the user submits.
 */
export function answerCard(say: HTMLElement, send: (text: string) => void): HTMLElement | null {
  const found = find(say)
  if (!found) return null
  const questions = found.items.map((i) => readQuestion(i.text, i.codes, i.subs))
  const card = document.createElement('div')
  card.className = 'loom-answers'
  const deck = questionDeck(questions.map(toDeck), {
    title: questions.length > 1 ? `${questions.length} questions` : 'Question',
    submit: (picks) => {
      if (card.classList.contains('is-sent')) return
      const text = compose(
        picks.map((p, i) => {
          const q = questions[i]!
          const o = p.picked[0]
          if (p.other || o === undefined) return { n: i + 1, text: p.other }
          // A lettered option goes as the reply wrote it, with its key; one read from prose by its label.
          return q.keys ? { n: i + 1, key: q.keys[o], text: q.options[o]! } : { n: i + 1, text: label(q.options[o]!) }
        }),
        questions.length,
      )
      if (!text) return
      card.classList.add('is-sent')
      deck.lock()
      send(text)
    },
  })
  card.appendChild(deck.el)
  card.addEventListener('keydown', (e) => {
    if (deck.key(e)) {
      e.preventDefault()
      e.stopPropagation()
    }
  })
  found.after.after(card)
  return card
}

/**
 * Questions, answered one at a time: the card Claude Code and Claude's apps use for
 * AskUserQuestion, shared by the canvas's two kinds of question — Claude's real
 * AskUserQuestion (Asks.ts) and the questions a reply ends with (questions.ts).
 *
 * Each question is a page: its text, its options as full-width rows (key at the left,
 * label and description, a check when chosen) and a last "Other…" row that is a field.
 * With more than one question a strip of tabs runs along the top (1 2 3 … Submit), picking
 * an option moves to the next one, and the last page is a review of the answers with
 * Submit. Keys: ↑/↓ move, Enter/Space pick, the option's key picks it, Tab/→ next,
 * Shift+Tab/← back; typing anything else starts "Other".
 *
 * The deck only draws and keeps the picks; the caller wires `key` to its keydown and
 * decides what Submit does with them.
 */

export interface DeckOption {
  label: string
  description?: string
  /** Shown at the row's left and pressed to pick it: "A", "1". */
  key: string
  /** A small note after the label ("current"). */
  tag?: string
}

export interface DeckQuestion {
  text: string
  /** A short name for the tab ("Color"); the number otherwise. */
  header?: string
  options: DeckOption[]
  multi?: boolean
}

export interface DeckPick {
  picked: number[]
  other: string
}

export interface DeckConfig {
  /** The card's title: "Claude asks", "Questions". */
  title: string
  /** The pulsing dot of a request that holds the turn. */
  live?: boolean
  /** One single-choice question: picking an option is answering. */
  quickSingle?: boolean
  submitLabel?: string
  submit(picks: DeckPick[]): void
}

export interface Deck {
  el: HTMLElement
  /** Handle a key pressed in the deck; true when it was the deck's. */
  key(e: KeyboardEvent): boolean
  /** Shown as answered: the review, nothing to press. */
  lock(): void
  focus(): void
  picks(): DeckPick[]
}

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.5 4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** The key after the last option's, for the "Other" row. */
function otherKey(opts: DeckOption[]): string {
  const last = opts[opts.length - 1]?.key ?? ''
  if (/^[A-Y]$/.test(last)) return String.fromCharCode(last.charCodeAt(0) + 1)
  if (/^\d$/.test(last) && last !== '9') return String(Number(last) + 1)
  return opts.length ? '' : '1'
}

const clip = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()

export function questionDeck(questions: DeckQuestion[], cfg: DeckConfig): Deck {
  const n = questions.length
  const many = n > 1
  const steps = many ? n + 1 : 1 // the review is the last step
  const picks: DeckPick[] = questions.map(() => ({ picked: [], other: '' }))
  let at = 0
  let locked = false

  const root = el('div', `loom-qd${many ? ' is-many' : ''}`)
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', cfg.title)

  // ---- the top: title and the tabs
  const top = el('div', 'loom-qd-top')
  if (cfg.live) top.appendChild(el('span', 'loom-qd-dot'))
  top.appendChild(el('span', 'loom-qd-title', cfg.title))
  const tabs = el('div', 'loom-qd-tabs')
  tabs.setAttribute('role', 'tablist')
  const tabEls: HTMLButtonElement[] = []
  if (many) {
    questions.forEach((q, i) => {
      const t = el('button', 'loom-qd-tab')
      t.type = 'button'
      t.tabIndex = -1
      t.dataset['step'] = String(i)
      t.setAttribute('role', 'tab')
      t.title = q.text
      t.innerHTML = `<span class="loom-qd-tab-mark">${CHECK}</span>`
      t.appendChild(el('span', 'loom-qd-tab-l', q.header ? q.header : String(i + 1)))
      tabEls.push(t)
      tabs.appendChild(t)
    })
    const t = el('button', 'loom-qd-tab is-submit', cfg.submitLabel ?? 'Submit')
    t.type = 'button'
    t.tabIndex = -1
    t.dataset['step'] = String(n)
    t.setAttribute('role', 'tab')
    tabEls.push(t)
    tabs.appendChild(t)
    top.appendChild(tabs)
  }
  root.appendChild(top)

  // ---- a page per question
  const pages: HTMLElement[] = []
  const others: HTMLInputElement[] = []
  questions.forEach((q, qi) => {
    const page = el('section', 'loom-qd-page')
    page.dataset['q'] = String(qi)
    const head = el('div', 'loom-qd-head')
    if (many) head.appendChild(el('span', 'loom-qd-count', `Question ${qi + 1} of ${n}`))
    if (q.multi) head.appendChild(el('span', 'loom-qd-multi', 'Pick any'))
    if (head.childElementCount) page.appendChild(head)
    page.appendChild(el('div', 'loom-qd-text', q.text))
    const list = el('div', 'loom-qd-opts')
    list.setAttribute('role', q.multi ? 'group' : 'radiogroup')
    list.setAttribute('aria-label', q.text)
    q.options.forEach((o, oi) => {
      const row = el('button', 'loom-qd-opt')
      row.type = 'button'
      row.dataset['o'] = String(oi)
      row.dataset['nav'] = ''
      row.setAttribute('role', q.multi ? 'checkbox' : 'radio')
      row.setAttribute('aria-checked', 'false')
      row.appendChild(el('span', 'loom-qd-key', o.key))
      const body = el('span', 'loom-qd-body')
      const l = el('span', 'loom-qd-label', o.label)
      if (o.tag) l.appendChild(el('span', 'loom-qd-tag', o.tag))
      body.appendChild(l)
      if (o.description) body.appendChild(el('span', 'loom-qd-desc', o.description))
      row.appendChild(body)
      row.insertAdjacentHTML('beforeend', `<span class="loom-qd-check">${CHECK}</span>`)
      list.appendChild(row)
    })
    const other = el('label', `loom-qd-opt is-other${q.options.length ? '' : ' is-only'}`)
    const ok = otherKey(q.options)
    other.appendChild(el('span', 'loom-qd-key', ok || '·'))
    other.dataset['key'] = ok
    const input = el('input', 'loom-qd-other')
    input.type = 'text'
    input.spellcheck = false
    input.dataset['nav'] = ''
    input.placeholder = q.options.length ? 'Other…' : 'Type your answer…'
    input.setAttribute('aria-label', q.options.length ? `Another answer to: ${q.text}` : `Answer: ${q.text}`)
    other.appendChild(input)
    other.insertAdjacentHTML('beforeend', `<span class="loom-qd-check">${CHECK}</span>`)
    list.appendChild(other)
    others.push(input)
    page.appendChild(list)
    pages.push(page)
    root.appendChild(page)
  })

  // ---- the review
  let review: HTMLElement | null = null
  const sums: HTMLElement[] = []
  if (many) {
    review = el('section', 'loom-qd-page is-review')
    review.appendChild(el('div', 'loom-qd-text', 'Review your answers'))
    const list = el('div', 'loom-qd-sum')
    questions.forEach((q, qi) => {
      const row = el('button', 'loom-qd-sum-row')
      row.type = 'button'
      row.dataset['step'] = String(qi)
      row.dataset['nav'] = ''
      row.appendChild(el('span', 'loom-qd-sum-n', String(qi + 1)))
      const body = el('span', 'loom-qd-sum-body')
      body.appendChild(el('span', 'loom-qd-sum-q', q.text))
      const a = el('span', 'loom-qd-sum-a')
      body.appendChild(a)
      row.appendChild(body)
      sums.push(a)
      list.appendChild(row)
    })
    review.appendChild(list)
    root.appendChild(review)
    pages.push(review)
  }

  // ---- the foot
  const foot = el('div', 'loom-qd-foot')
  const hint = el('span', 'loom-qd-hint')
  const back = el('button', 'loom-qd-btn is-back', 'Back')
  back.type = 'button'
  const go = el('button', 'loom-qd-btn is-primary')
  go.type = 'button'
  foot.append(hint, back, go)
  root.appendChild(foot)

  const answered = (qi: number) => picks[qi]!.picked.length > 0 || !!picks[qi]!.other
  const anyAnswered = () => picks.some((_, i) => answered(i))
  const onReview = () => many && at === n

  /** A pick, as the review line says it. */
  const said = (qi: number): string => {
    const q = questions[qi]!
    const p = picks[qi]!
    const labels = p.picked.map((i) => {
      const o = q.options[i]!
      return /^[A-Z]$/.test(o.key) ? `${o.key} — ${o.label}` : o.label
    })
    return [...labels, ...(p.other ? [p.other] : [])].join(', ')
  }

  function paint(): void {
    pages.forEach((p, i) => (p.hidden = i !== at))
    tabEls.forEach((t, i) => {
      t.classList.toggle('is-at', i === at)
      t.setAttribute('aria-selected', String(i === at))
      if (i < n) t.classList.toggle('is-done', answered(i))
    })
    questions.forEach((_, qi) => {
      const p = picks[qi]!
      pages[qi]!.querySelectorAll<HTMLElement>('.loom-qd-opt[data-o]').forEach((r) => {
        const on = p.picked.includes(Number(r.dataset['o']))
        r.classList.toggle('is-on', on)
        r.setAttribute('aria-checked', String(on))
      })
      others[qi]!.closest('.loom-qd-opt')!.classList.toggle('is-on', !!p.other)
    })
    sums.forEach((a, qi) => {
      const s = said(qi)
      a.textContent = s || 'Skipped'
      a.classList.toggle('is-skip', !s)
    })
    back.hidden = !many || at === 0 || locked
    if (locked) {
      go.hidden = true
      hint.textContent = 'Sent'
      hint.classList.add('is-sent')
      return
    }
    if (many && !onReview()) {
      go.textContent = 'Next'
      go.disabled = false
      go.classList.toggle('is-quiet', !answered(at))
      hint.textContent = '↑↓ choose · Enter pick · Tab next'
    } else {
      go.textContent = cfg.submitLabel ?? 'Submit'
      go.disabled = !anyAnswered()
      go.classList.remove('is-quiet')
      hint.textContent = many ? 'Click an answer to change it' : questions[0]!.options.length ? '↑↓ choose · Enter pick' : 'Enter to submit'
    }
  }

  const navs = (): HTMLElement[] => [...pages[at]!.querySelectorAll<HTMLElement>('[data-nav]')]

  function focusStep(): void {
    if (onReview()) {
      ;(go.disabled ? root.querySelector<HTMLElement>('.loom-qd-sum-row') : go)?.focus({ preventScroll: true })
      return
    }
    const page = pages[at]!
    const on = page.querySelector<HTMLElement>('.loom-qd-opt.is-on[data-o]')
    const first = on ?? (picks[at]!.other ? others[at] : null) ?? page.querySelector<HTMLElement>('[data-nav]')
    first?.focus({ preventScroll: true })
  }

  function show(step: number): void {
    if (locked) return
    at = Math.max(0, Math.min(steps - 1, step))
    paint()
    focusStep()
  }

  function submit(): void {
    if (locked || !anyAnswered()) return
    cfg.submit(picks.map((p) => ({ picked: [...p.picked], other: p.other })))
  }

  /** After an answer: the next question, or Submit / the answer itself for one question. */
  function onward(typed = false): void {
    if (many) {
      window.setTimeout(() => show(at + 1), 140)
      return
    }
    // One question: a typed answer, or a pick where picking is answering, goes at once.
    if (typed || (cfg.quickSingle && !questions[0]!.multi)) return submit()
    go.focus({ preventScroll: true })
  }

  function pick(qi: number, oi: number): void {
    if (locked) return
    const q = questions[qi]!
    const p = picks[qi]!
    if (q.multi) {
      p.picked = p.picked.includes(oi) ? p.picked.filter((x) => x !== oi) : [...p.picked, oi].sort((a, b) => a - b)
      paint()
      return
    }
    p.picked = [oi]
    p.other = ''
    others[qi]!.value = ''
    paint()
    onward()
  }

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const opt = t.closest<HTMLElement>('.loom-qd-opt[data-o]')
    if (opt) {
      e.preventDefault()
      return pick(Number(opt.closest<HTMLElement>('[data-q]')!.dataset['q']), Number(opt.dataset['o']))
    }
    const step = t.closest<HTMLElement>('.loom-qd-tab, .loom-qd-sum-row')
    if (step) return show(Number(step.dataset['step']))
    if (t.closest('.loom-qd-btn.is-back')) return show(at - 1)
    if (t.closest('.loom-qd-btn.is-primary')) return many && !onReview() ? show(at + 1) : submit()
  })
  others.forEach((input, qi) => {
    input.addEventListener('input', () => {
      const p = picks[qi]!
      p.other = clip(input.value)
      // A typed answer replaces a single choice.
      if (p.other && !questions[qi]!.multi) p.picked = []
      paint()
    })
  })

  function key(e: KeyboardEvent): boolean {
    if (locked || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return false
    const t = e.target as HTMLElement
    const field = t instanceof HTMLInputElement
    const nextStep = () => {
      if (!many || at >= steps - 1) return false
      show(at + 1)
      return true
    }
    const prevStep = () => {
      if (!many || at === 0) return false
      show(at - 1)
      return true
    }
    if (e.key === 'Tab') return e.shiftKey ? prevStep() : nextStep()
    if (field) {
      const qi = Number(t.closest<HTMLElement>('[data-q]')?.dataset['q'] ?? at)
      if (e.key === 'Enter' && !e.shiftKey) {
        if (picks[qi]!.other) onward(true)
        return true
      }
      if (e.key === 'ArrowUp') {
        const list = navs()
        list[list.indexOf(t) - 1]?.focus({ preventScroll: true })
        return true
      }
      return false
    }
    if (e.key === 'ArrowRight') return nextStep()
    if (e.key === 'ArrowLeft') return prevStep()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = navs()
      const i = list.indexOf(t)
      const j = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
      list[j]?.focus({ preventScroll: true })
      return true
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const opt = t.closest<HTMLElement>('.loom-qd-opt[data-o]')
      if (opt) {
        pick(Number(opt.closest<HTMLElement>('[data-q]')!.dataset['q']), Number(opt.dataset['o']))
        return true
      }
      if (t instanceof HTMLButtonElement && root.contains(t)) {
        t.click()
        return true
      }
      if (onReview() || !many) submit()
      else focusStep()
      return true
    }
    if (onReview() || e.key.length !== 1) return false
    const q = questions[at]!
    const k = e.key.toUpperCase()
    const oi = q.options.findIndex((o) => o.key.toUpperCase() === k)
    if (oi >= 0) {
      pick(at, oi)
      return true
    }
    const other = others[at]!
    if (k === (other.closest<HTMLElement>('.loom-qd-opt')!.dataset['key'] ?? '').toUpperCase()) {
      other.focus({ preventScroll: true })
      return true
    }
    // Anything else typed is the start of "Other".
    if (e.key !== ' ') other.focus({ preventScroll: true })
    return false
  }

  paint()
  // The first option row is where the keyboard starts (Asks focuses [data-autofocus]).
  pages[0]?.querySelector<HTMLElement>('[data-nav]')?.setAttribute('data-autofocus', '')

  return {
    el: root,
    key,
    picks: () => picks.map((p) => ({ picked: [...p.picked], other: p.other })),
    focus: focusStep,
    lock() {
      locked = true
      root.classList.add('is-sent')
      const head = review?.querySelector('.loom-qd-text')
      if (head) head.textContent = 'Your answers'
      if (many) at = n
      paint()
      pages.forEach((p, i) => (p.hidden = i !== at))
      for (const b of root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) b.disabled = true
    },
  }
}

export interface Command {
  id: string
  title: string
  hint?: string
  group: string
  /** The words that run it from the shell (`split right`); shown as the row's name. */
  cli?: string
  /** Shorter forms of the same words. */
  aliases?: string[]
  /** Provider already decided this item is relevant; skip fuzzy filtering. */
  skipFilter?: boolean
  /** Runs it; what was typed after the command words comes along as arguments. */
  run(args?: string[]): void
}

/** The word lists that name a command: its own words, then each alias. */
function forms(c: Command): string[][] {
  const own = (c.cli ?? '').split(' ').filter((w) => w && !/^[[<]/.test(w))
  if (!own.length) return []
  return [own, ...(c.aliases ?? []).map((a) => a.split(' ').filter(Boolean))]
}

interface Hit {
  c: Command
  s: number
  args: string[]
}

/**
 * Typed words against one command. An exact form (`split right`, `o`) wins outright and
 * what follows becomes arguments; a single typed word that starts a form (`sp`) is a
 * prefix match; anything else falls back to the fuzzy score over the title.
 */
function hit(tokens: string[], q: string, c: Command): Hit | null {
  const lower = tokens.map((t) => t.toLowerCase())
  let best: Hit | null = null
  for (const form of forms(c)) {
    if (form.length <= lower.length && form.every((w, i) => w === lower[i])) {
      const h = { c, s: 1000 + form.length * 10, args: tokens.slice(form.length) }
      if (!best || h.s > best.s) best = h
    } else if (lower.length === 1 && form[0]!.startsWith(lower[0]!)) {
      const h = { c, s: 500 - (form[0]!.length - lower[0]!.length), args: [] }
      if (!best || h.s > best.s) best = h
    }
  }
  if (best) return best
  const s = score(q, `${c.group} ${c.title} ${c.cli ?? ''}`)
  return s > 0 ? { c, s, args: [] } : null
}

/**
 * Ctrl+K command surface.
 *
 * Matching is subsequence-based rather than substring: typing "spd" should reach
 * "Split pane down", which is the whole point of a palette — you type the shape of
 * the command, not its prefix. Score favours earlier and more contiguous hits so
 * exact-ish matches float above scattered ones.
 */
function score(query: string, text: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let s = 0
  let streak = 0
  let firstHit = -1
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) {
      streak = 0
      continue
    }
    if (firstHit === -1) firstHit = i
    streak++
    s += 1 + streak * 2 + (i === 0 || t[i - 1] === ' ' ? 3 : 0)
    qi++
  }
  if (qi < q.length) return 0
  return s - firstHit * 0.15
}

export class Palette {
  readonly el: HTMLElement
  private readonly input: HTMLInputElement
  private readonly list: HTMLElement
  private filtered: Hit[] = []
  private cursor = 0
  private open = false
  /** Guards against an async provider resolving after a newer keystroke. */
  private token = 0

  constructor(private readonly provider: (query: string) => Command[] | Promise<Command[]>) {
    this.el = document.createElement('div')
    this.el.className = 'ember-palette'
    this.el.setAttribute('role', 'dialog')

    const panel = document.createElement('div')
    panel.className = 'ember-palette-panel'

    this.input = document.createElement('input')
    this.input.className = 'ember-palette-input'
    this.input.placeholder = 'command…'
    this.input.spellcheck = false
    this.input.autocomplete = 'off'

    this.list = document.createElement('div')
    this.list.className = 'ember-palette-list'

    panel.append(this.input, this.list)
    this.el.appendChild(panel)
    document.body.appendChild(this.el)

    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close()
    })
    this.input.addEventListener('input', () => {
      this.cursor = 0
      this.updateMode()
      void this.refresh()
    })
    this.input.addEventListener('keydown', (e) => this.onKey(e))
  }

  get isOpen(): boolean {
    return this.open
  }

  toggle(): void {
    if (this.open) this.close()
    else this.show()
  }

  show(prefill = ''): void {
    this.input.value = prefill
    this.cursor = 0
    this.open = true
    this.el.classList.add('is-open')
    this.updateMode()
    void this.refresh()
    // Focus after the class flips so the entrance animation actually plays.
    requestAnimationFrame(() => this.input.focus())
  }

  /** The leading character selects the mode, so one key opens three surfaces. */
  private updateMode(): void {
    const v = this.input.value
    const mode = v.startsWith('>')
      ? 'shell'
      : v.startsWith('@')
        ? 'project'
        : v.startsWith('#')
          ? 'theme'
          : 'command'
    this.el.dataset['mode'] = mode
    this.input.placeholder =
      mode === 'shell'
        ? 'Run in this pane…'
        : mode === 'project'
          ? 'Open a project…'
          : mode === 'theme'
            ? 'Pick a theme…'
            : 'command…   new · o · split · todo · note      > run   @ project   # theme'
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.el.classList.remove('is-open')
    this.input.blur()
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
      return
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      this.cursor = Math.min(this.filtered.length - 1, this.cursor + 1)
      this.paintSelection()
      return
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      this.cursor = Math.max(0, this.cursor - 1)
      this.paintSelection()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const h = this.filtered[this.cursor]
      if (!h) return
      this.close()
      h.c.run(h.args)
    }
  }

  private async refresh(): Promise<void> {
    const mine = ++this.token
    const raw = this.input.value
    const commands = await this.provider(raw)
    if (mine !== this.token) return

    const q = raw.trim()
    const tokens = q ? q.split(/\s+/) : []
    const passthrough: Hit[] = commands.filter((c) => c.skipFilter).map((c) => ({ c, s: 0, args: [] }))
    const scored: Hit[] = tokens.length
      ? commands
          .filter((c) => !c.skipFilter)
          .map((c) => hit(tokens, q, c))
          .filter((h): h is Hit => h !== null)
          // Once a command's own words match, rows that merely share letters with the
          // query are noise: `s` should list split, sidebar, search, not everything with an s.
          .filter((h, _i, all) => h.s >= 400 || !all.some((o) => o.s >= 400))
          .sort((a, b) => b.s - a.s)
      : commands.filter((c) => !c.skipFilter).map((c) => ({ c, s: 1, args: [] }))
    this.filtered = [...passthrough, ...scored].slice(0, 40)

    this.list.replaceChildren()
    for (const [i, { c: cmd, args }] of this.filtered.entries()) {
      const row = document.createElement('div')
      row.className = 'ember-palette-row'
      row.dataset['idx'] = String(i)
      // Cap the cascade so a long list does not take a second to finish arriving.
      row.style.setProperty('--i', String(Math.min(i, 12)))

      // The command's words are the row's name; the title says what they do. Rows
      // without words (a project, a session to go to) keep their group as the label.
      const name = document.createElement('span')
      name.className = cmd.cli ? 'ember-palette-cli' : 'ember-palette-group'
      name.textContent = cmd.cli ?? cmd.group
      if (cmd.cli && args.length) {
        const typed = document.createElement('b')
        typed.textContent = ` ${args.join(' ')}`
        name.appendChild(typed)
      }

      const title = document.createElement('span')
      title.className = 'ember-palette-title'
      title.textContent = cmd.title

      row.append(name, title)
      if (cmd.hint) {
        const hint = document.createElement('span')
        hint.className = 'ember-palette-hint'
        hint.textContent = cmd.hint
        row.appendChild(hint)
      }
      row.addEventListener('mouseenter', () => {
        this.cursor = i
        this.paintSelection()
      })
      row.addEventListener('click', () => {
        this.close()
        cmd.run(args)
      })
      this.list.appendChild(row)
    }

    if (this.filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'ember-palette-empty'
      empty.textContent = 'No matching command'
      this.list.appendChild(empty)
    }
    this.paintSelection()
  }

  private paintSelection(): void {
    const rows = [...this.list.querySelectorAll('.ember-palette-row')]
    rows.forEach((r, i) => r.classList.toggle('is-cursor', i === this.cursor))
    rows[this.cursor]?.scrollIntoView({ block: 'nearest' })
  }
}

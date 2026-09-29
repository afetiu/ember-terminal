import type { MapBundle, MapChange, MapEdge, MapFlow, MapHistoryEntry, MapJob, MapLiveSession, MapModel, MapNode, MapSummary } from '@shared/types'
import { clipEnd, clipStart, computeLayout, labelPoint, roundedPath, type LBox, type Layout } from './map/layout'
import { AREA_HUES, ICON, KIND_GLYPH, KIND_WORD, NOTE_GLYPH, NOTE_WORD, SESSION_HUES, ago, hueFor, md } from './map/glyphs'

/**
 * The map: a project's whole world as one zoomable picture, and nothing else on screen.
 *
 * Three states in one surface, like the notes: the projects, the form that sets one up,
 * and the map of one. The map is read-only and askable. Everything about a part or a
 * connection comes up in a card beside it when it is clicked; everything that is
 * *happening* — Claude sessions at work, changes landing, a flow being traced, what would
 * break — is drawn onto the map itself, as light, never as another panel.
 *
 * Rendering is keyed and incremental. Every part and every line is one element that lives
 * as long as the part does: an update moves it (animated), a zoom only changes a CSS
 * variable and a few classes, and hover and focus are classes too. Text is sized for the
 * screen through `--ik` (1/zoom), lines keep their width with non-scaling strokes, and so
 * a frame of panning touches one transform.
 */

export interface MapHooks {
  onTitle: (title: string) => void
  onClose?: () => void
  /** Open a Claude session with this brief, in this folder. */
  onChange: (brief: string, cwd: string, title: string) => void
  onShell: (cwd: string) => void
  onOpenUrl: (url: string) => void
  onRevealPath: (path: string) => void
  /** Switch to an Ember tab. */
  onFocusTab: (tabId: string) => void
  /** An Ember tab's name, for a live session running in it. */
  tabTitle: (tabId: string) => string | undefined
}

type Target = { kind: 'node' | 'edge'; id: string }

interface EdgeEl {
  g: SVGGElement
  halo: SVGPathElement
  line: SVGPathElement
  hit: SVGPathElement
  label: SVGTextElement
  dots: SVGGElement
  pts: Array<[number, number]>
  from: string
  to: string
}

interface LiveMark {
  session: MapLiveSession
  mode: 'edit' | 'read' | 'commit'
  at: number
  file: string
}

const NS = 'http://www.w3.org/2000/svg'
/** On-screen width at which a container opens into its parts. */
const OPEN_AT = 250
/** A session counts as working here if it touched the part this recently. */
const LIVE_MS = 12 * 60_000
const HOT_MS = 90_000

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  if (cls) e.setAttribute('class', cls)
  return e
}

function iconBtn(icon: string, label: string, cls = 'mbtn'): HTMLButtonElement {
  const b = el('button', cls)
  b.innerHTML = `<span class="mbtn-i">${icon}</span><span class="mbtn-t"></span>`
  ;(b.querySelector('.mbtn-t') as HTMLElement).textContent = label
  b.title = label
  return b
}

const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

export class MapView {
  readonly el: HTMLElement
  private readonly listEl: HTMLElement
  private readonly formEl: HTMLElement
  private readonly viewEl: HTMLElement

  // ---- list and form
  private rows!: HTMLElement
  private countEl!: HTMLElement
  private fName!: HTMLInputElement
  private fBrief!: HTMLTextAreaElement
  private fPoll!: HTMLSelectElement
  private fTitle!: HTMLElement
  private fSubmit!: HTMLButtonElement
  private editing: string | null = null
  private summaries: MapSummary[] = []

  // ---- the canvas
  private stage!: HTMLElement
  private world!: HTMLElement
  private nodesEl!: HTMLElement
  private edgesSvg!: SVGSVGElement
  private edgesG!: SVGGElement
  private virtualG!: SVGGElement
  private overlay!: SVGSVGElement
  private leader!: SVGPathElement
  private markers: SVGMarkerElement[] = []
  private building!: HTMLElement

  // ---- chrome on the canvas
  private titleEl!: HTMLElement
  private statusEl!: HTMLElement
  private crumbsEl!: HTMLElement
  private searchEl!: HTMLInputElement
  private flowsBtn!: HTMLButtonElement
  private timeBtn!: HTMLButtonElement
  private strip!: HTMLElement
  private stripLive!: HTMLElement
  private stripEvents!: HTMLElement
  private replayBtn!: HTMLButtonElement
  private flowbar!: HTMLElement
  private caption!: HTMLElement
  private timeline!: HTMLElement
  private legend!: HTMLElement
  private pastBanner!: HTMLElement

  // ---- state
  private bundle: MapBundle | null = null
  /** What is drawn: the current model, or a version from the past while scrubbing. */
  private model: MapModel | null = null
  private past: number | null = null
  private history: MapHistoryEntry[] = []
  private job: MapJob | null = null
  private jobLog: string[] = []
  private layout: Layout | null = null
  private layoutSeq = 0
  private nodeEls = new Map<string, HTMLElement>()
  private edgeEls = new Map<string, EdgeEl>()
  private openKey = ''

  private tx = 0
  private ty = 0
  private k = 1
  private fitted = false
  private anim: number | null = null
  private crumbTimer: number | null = null

  private hovered: Target | null = null
  private selected: Target | null = null
  private card: HTMLElement | null = null
  private menu: HTMLElement | null = null

  private flow: { flow: MapFlow; step: number; playing: boolean; timer: number | null } | null = null
  private blast: Map<string, number> | null = null
  private replay: { timer: number | null } | null = null

  private live: MapLiveSession[] = []
  private liveOn = false
  private liveByNode = new Map<string, LiveMark[]>()
  private pathIndex: Array<{ prefix: string; id: string }> = []

  /** When the user last looked, as of opening the map: what is newer than this is news. */
  private seenAt = 0
  private newIds = new Set<string>()
  private changedIds = new Map<string, number>()
  private born = new Set<string>()
  private lit = new Set<string>()

  private pending: { askId: string; out: HTMLElement; q: string; history: Array<{ q: string; a: string }>; go: HTMLButtonElement } | null = null
  private askHistory = new Map<string, Array<{ q: string; a: string }>>()
  private readonly unsubs: Array<() => void> = []
  private disposed = false

  constructor(private readonly hooks: MapHooks) {
    this.el = el('div', 'ember-map')
    this.listEl = this.buildList()
    this.formEl = this.buildForm()
    this.viewEl = this.buildView()
    this.el.append(this.listEl, this.formEl, this.viewEl)
    this.el.dataset['mode'] = 'list'
    this.unsubs.push(
      window.ember.map.onChanged((e) => void this.external(e.id, !!e.deleted)),
      window.ember.map.onJob((e) => this.onJob(e.id, e.job)),
      window.ember.map.onAsk((e) => this.onAskEvent(e)),
      window.ember.map.onLive((s) => this.onLive(s)),
    )
    this.el.addEventListener('keydown', (e) => this.onKey(e))
  }

  // =========================================================================
  // the list of projects
  // =========================================================================

  private buildList(): HTMLElement {
    const wrap = el('div', 'ember-map-list')
    const head = el('header', 'ember-map-head')
    const h = el('h2', undefined, 'Map')
    this.countEl = el('span', 'ember-map-count')
    const lede = el('span', 'ember-map-lede', 'The living architecture of your projects, kept by your agent')
    const add = el('button', 'ember-map-btn is-primary', 'New project')
    add.addEventListener('click', () => this.showForm(null))
    head.append(h, this.countEl, lede, add)
    if (this.hooks.onClose) {
      const leave = el('button', 'ember-map-btn', 'Back to shell')
      leave.addEventListener('click', () => this.hooks.onClose?.())
      head.append(leave)
    }
    this.rows = el('div', 'ember-map-rows')
    wrap.append(head, this.rows)
    return wrap
  }

  private renderRows(): void {
    this.countEl.textContent = this.summaries.length ? String(this.summaries.length) : ''
    this.rows.replaceChildren()
    if (!this.summaries.length) {
      const empty = el('div', 'ember-map-empty')
      empty.innerHTML =
        '<p><strong>No projects yet.</strong></p><p>Name a project and say what belongs to it — a few repos, where it runs, a domain, or just “everything about radix-platform”. Your agent surveys it once and draws the map; after that it only patches the map when something actually changes, and the map shows where your sessions are working as they work.</p>'
      const go = el('button', 'ember-map-btn is-primary', 'Set up the first project')
      go.addEventListener('click', () => this.showForm(null))
      empty.append(go)
      this.rows.append(empty)
      return
    }
    for (const s of this.summaries) {
      const row = el('button', 'ember-map-row')
      row.addEventListener('click', () => void this.openProject(s.project.id))
      const name = el('span', 'ember-map-row-name', s.project.name)
      const meta = el('span', 'ember-map-row-meta')
      meta.textContent = s.job ? s.job.line : s.version ? `${s.nodes} parts · updated ${ago(s.updatedAt)}` : s.lastError ? s.lastError : 'not mapped yet'
      if (s.job) row.classList.add('is-busy')
      if (s.lastError && !s.job) row.classList.add('is-error')
      const brief = el('span', 'ember-map-row-brief', s.project.brief.split('\n')[0] ?? '')
      row.append(name, meta, brief)
      if (s.unseen) row.append(el('span', 'ember-map-row-new', `${s.unseen} new`))
      this.rows.append(row)
    }
  }

  async showList(): Promise<void> {
    this.leaveMap()
    this.el.dataset['mode'] = 'list'
    this.hooks.onTitle('Map')
    await this.refreshList()
    ;(this.rows.querySelector('button') as HTMLButtonElement | null)?.focus()
  }

  private async refreshList(): Promise<void> {
    if (this.disposed) return
    this.summaries = await window.ember.map.list()
    this.renderRows()
  }

  // =========================================================================
  // the form
  // =========================================================================

  private buildForm(): HTMLElement {
    const wrap = el('div', 'ember-map-form')
    const card = el('div', 'ember-map-formcard')
    this.fTitle = el('h2', undefined, 'New project')
    const l1 = el('label', undefined, 'Name')
    this.fName = el('input')
    this.fName.placeholder = 'radix-platform'
    this.fName.spellcheck = false
    const l2 = el('label', undefined, 'What is it, and what belongs to it?')
    this.fBrief = el('textarea')
    this.fBrief.rows = 7
    this.fBrief.placeholder =
      'The Radix platform: the API in ~/radix-api, the Angular admin in ~/radix-admin, the marketing site at radix.example, a Postgres database, a payments provider. Anything else with radix in it too.\n\nMention whatever you know; your agent finds the rest.'
    const l3 = el('label', undefined, 'Check for changes')
    this.fPoll = el('select')
    for (const [v, t] of [
      ['5', 'every 5 minutes'],
      ['10', 'every 10 minutes'],
      ['30', 'every 30 minutes'],
      ['60', 'every hour'],
      ['0', 'only when I press Refresh'],
    ] as const) {
      const o = el('option', undefined, t)
      o.value = v
      this.fPoll.append(o)
    }
    this.fPoll.value = '10'
    const note = el(
      'p',
      'ember-map-formnote',
      'Checking is cheap — it compares commits, pushes, deploys and whether the site is up, with no AI. Your agent runs only when one of those moved, and it patches the map rather than redrawing it.',
    )
    const actions = el('div', 'ember-map-formactions')
    const cancel = el('button', 'ember-map-btn', 'Cancel')
    cancel.addEventListener('click', () => (this.editing ? void this.openProject(this.editing) : void this.showList()))
    this.fSubmit = el('button', 'ember-map-btn is-primary', 'Map it')
    this.fSubmit.addEventListener('click', () => void this.submitForm())
    actions.append(cancel, this.fSubmit)
    card.append(this.fTitle, l1, this.fName, l2, this.fBrief, l3, this.fPoll, note, actions)
    wrap.append(card)
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.target === this.fName)) {
        e.preventDefault()
        void this.submitForm()
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        cancel.click()
      }
    })
    return wrap
  }

  showForm(id: string | null): void {
    const p = id && this.bundle?.project.id === id ? this.bundle.project : null
    this.leaveMap()
    this.editing = id
    this.fTitle.textContent = p ? `Edit ${p.name}` : 'New project'
    this.fName.value = p?.name ?? ''
    this.fBrief.value = p?.brief ?? ''
    this.fPoll.value = String(p?.pollMinutes ?? 10)
    this.fSubmit.textContent = p ? 'Save' : 'Map it'
    this.el.dataset['mode'] = 'form'
    this.hooks.onTitle(p ? `Edit ${p.name}` : 'New project')
    this.fName.focus()
  }

  private async submitForm(): Promise<void> {
    const name = this.fName.value.trim()
    if (!name) {
      this.fName.focus()
      return
    }
    const brief = this.fBrief.value.trim()
    const pollMinutes = Number(this.fPoll.value)
    if (this.editing) {
      await window.ember.map.edit(this.editing, { name, brief, pollMinutes })
      await this.openProject(this.editing)
      return
    }
    const p = await window.ember.map.create({ name, brief, pollMinutes })
    await this.openProject(p.id)
  }

  // =========================================================================
  // the map: building the surface
  // =========================================================================

  private buildView(): HTMLElement {
    const wrap = el('div', 'ember-map-view')
    this.stage = el('div', 'mstage')
    this.stage.tabIndex = 0

    this.world = el('div', 'mworld')
    this.nodesEl = el('div', 'mnodes')
    this.edgesSvg = svgEl('svg', 'medges')
    const defs = svgEl('defs')
    for (const [id, cls] of [
      ['mk', 'mk'],
      ['mk-hot', 'mk is-hot'],
      ['mk-flow', 'mk is-flow'],
      ['mk-blast', 'mk is-blast'],
    ] as const) {
      const m = svgEl('marker')
      m.id = `ember-${id}`
      m.setAttribute('viewBox', '0 0 10 10')
      m.setAttribute('refX', '8.5')
      m.setAttribute('refY', '5')
      m.setAttribute('orient', 'auto')
      m.setAttribute('markerUnits', 'userSpaceOnUse')
      const p = svgEl('path', cls)
      p.setAttribute('d', 'M0,0.5 L10,5 L0,9.5 L2.6,5 z')
      m.append(p)
      defs.append(m)
      this.markers.push(m)
    }
    this.edgesG = svgEl('g')
    this.virtualG = svgEl('g', 'mvirtual')
    this.edgesSvg.append(defs, this.edgesG, this.virtualG)
    // Lines above the boxes: routed through the gaps, they never cross a box, and on top
    // they are never lost behind one either.
    this.world.append(this.nodesEl, this.edgesSvg)

    this.overlay = svgEl('svg', 'moverlay')
    this.leader = svgEl('path', 'mleader')
    this.overlay.append(this.leader)

    this.building = el('div', 'mbuilding')
    this.stage.append(this.world, this.overlay, this.building)
    this.wireStage()

    // ---- top left: where you are
    const tl = el('div', 'mhud mhud-tl')
    const back = iconBtn(ICON.back, 'Projects', 'mbtn is-icon')
    back.addEventListener('click', () => void this.showList())
    const titles = el('div', 'mhud-titles')
    const row1 = el('div', 'mhud-row')
    this.titleEl = el('h2', 'mtitle')
    this.statusEl = el('span', 'mstatus')
    row1.append(this.titleEl, this.statusEl)
    this.crumbsEl = el('div', 'mcrumbs')
    titles.append(row1, this.crumbsEl)
    tl.append(back, titles)

    // ---- top right: tools
    const tr = el('div', 'mhud mhud-tr')
    const search = el('label', 'msearch')
    search.innerHTML = ICON.search
    this.searchEl = el('input')
    this.searchEl.type = 'search'
    this.searchEl.placeholder = 'Find a part   /'
    this.searchEl.spellcheck = false
    search.append(this.searchEl)
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = this.searchEl.value.trim().toLowerCase()
        const hit = this.model?.nodes.find((n) => n.name.toLowerCase().includes(q) || n.id.includes(q))
        if (hit) {
          this.select({ kind: 'node', id: hit.id })
          this.flyTo(hit.id)
          this.stage.focus()
        }
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        this.searchEl.value = ''
        this.stage.focus()
      }
    })
    this.flowsBtn = iconBtn(ICON.flow, 'Flows')
    this.flowsBtn.addEventListener('click', () => this.openFlowsMenu())
    this.timeBtn = iconBtn(ICON.clock, 'Timeline')
    this.timeBtn.addEventListener('click', () => void this.toggleTimeline())
    const legend = iconBtn(ICON.legend, 'Legend  (L)', 'mbtn is-icon')
    legend.addEventListener('click', () => this.legend.classList.toggle('is-on'))
    const fit = iconBtn(ICON.fit, 'Fit  (F)', 'mbtn is-icon')
    fit.addEventListener('click', () => this.fit(true))
    const refresh = iconBtn(ICON.refresh, 'Refresh', 'mbtn is-icon')
    refresh.title = 'Check every source now and bring the map up to date'
    refresh.addEventListener('click', () => this.bundle && window.ember.map.check(this.bundle.project.id, true))
    const more = iconBtn(ICON.more, 'More', 'mbtn is-icon')
    more.addEventListener('click', () => {
      const r = more.getBoundingClientRect()
      this.openMoreMenu(r.right - 220, r.bottom + 6)
    })
    tr.append(search, this.flowsBtn, this.timeBtn, legend, fit, refresh, more)

    this.flowbar = el('div', 'mflowbar')
    this.caption = el('div', 'mcaption')
    this.pastBanner = el('div', 'mpast')
    this.timeline = el('div', 'mtimeline')
    this.legend = this.buildLegend()

    // ---- bottom: what is happening
    this.strip = el('div', 'mstrip')
    this.replayBtn = iconBtn(ICON.replay, 'Replay', 'mbtn is-accent')
    this.replayBtn.addEventListener('click', () => this.startReplay())
    this.stripLive = el('div', 'mstrip-live')
    this.stripEvents = el('div', 'mstrip-events')
    this.strip.append(this.replayBtn, this.stripLive, this.stripEvents)

    this.stage.append(tl, tr, this.flowbar, this.caption, this.pastBanner, this.timeline, this.legend, this.strip)
    wrap.append(this.stage)
    return wrap
  }

  private buildLegend(): HTMLElement {
    const l = el('div', 'mlegend')
    const kinds = el('div', 'mlegend-kinds')
    for (const k of ['app', 'service', 'repo', 'component', 'module', 'datastore', 'queue', 'infra', 'external', 'job', 'doc']) {
      const r = el('div', 'mlegend-row')
      const sw = el('span', `mlegend-sw k-${k}`)
      sw.innerHTML = KIND_GLYPH[k] ?? ''
      r.append(sw, el('span', undefined, KIND_WORD[k] ?? k))
      kinds.append(r)
    }
    const meaning = el('div', 'mlegend-meaning')
    meaning.innerHTML = `
      <div><span class="ml-dot is-ok"></span>healthy <span class="ml-dot is-warn"></span>needs attention <span class="ml-dot is-down"></span>down</div>
      <div><span class="ml-live"></span>a session is editing it, in that session's colour; a faint ring means reading</div>
      <div><span class="ml-new">NEW</span> appeared since you last looked · <span class="ml-delta">Δ2</span> changed</div>
      <div><span class="ml-ghost"></span>removed recently</div>
      <div><span class="ml-line"></span>uses → read left to right · hover a part to see only its connections</div>
      <div class="ml-keys">Scroll to zoom · drag to pan · click for details · right-click to ask · F fit · / find · Esc back</div>`
    l.append(el('div', 'mlegend-title', 'How to read the map'), kinds, meaning)
    return l
  }

  // =========================================================================
  // opening a project, and keeping up with it
  // =========================================================================

  async openProject(id: string): Promise<void> {
    const b = await window.ember.map.load(id)
    if (!b) return this.showList()
    const first = this.bundle?.project.id !== id || this.el.dataset['mode'] !== 'map'
    const before = this.model ? new Set(this.model.nodes.map((n) => n.id)) : null
    this.bundle = b
    this.job = b.state.job ?? null
    if (first) {
      this.closeCard()
      this.stopFlow()
      this.blast = null
      this.fitted = false
      this.selected = null
      this.jobLog = []
      this.past = null
      this.timeline.classList.remove('is-on')
      this.pastBanner.classList.remove('is-on')
      this.seenAt = b.state.lastViewedAt ? Date.parse(b.state.lastViewedAt) : 0
      this.born.clear()
      this.askHistory.clear()
    } else if (before && b.model && this.past === null) {
      // Arriving while watching: whatever is new is announced, not just drawn.
      for (const n of b.model.nodes) if (!before.has(n.id)) this.born.add(n.id)
      const latest = b.changes[b.changes.length - 1]
      if (latest && Date.now() - Date.parse(latest.at) < 60_000) this.announce(latest)
      window.setTimeout(() => {
        this.born.clear()
        this.decorate()
      }, 9000)
    }
    this.el.dataset['mode'] = 'map'
    if (!this.liveOn) {
      this.liveOn = true
      window.ember.map.watchLive(true)
    }
    this.hooks.onTitle(b.project.name)
    this.titleEl.textContent = b.project.name
    this.computeNews()
    this.renderStatus()
    if (this.past === null) await this.setModel(b.model, !first)
    this.renderStrip()
    if (first) this.stage.focus()
    void window.ember.map.history(id).then((h) => (this.history = h))
  }

  private leaveMap(): void {
    this.closeCard()
    this.closeMenu()
    this.stopFlow()
    this.stopReplay()
    if (this.bundle && this.el.dataset['mode'] === 'map') window.ember.map.viewed(this.bundle.project.id)
    if (this.liveOn) {
      this.liveOn = false
      window.ember.map.watchLive(false)
    }
  }

  private async external(id: string, deleted: boolean): Promise<void> {
    if (this.disposed) return
    if (this.el.dataset['mode'] === 'list') return this.refreshList()
    if (this.bundle?.project.id !== id) return
    if (deleted) return this.showList()
    if (this.el.dataset['mode'] === 'map') await this.openProject(id)
  }

  private onJob(id: string, job: MapJob | null): void {
    if (this.el.dataset['mode'] === 'list') {
      const s = this.summaries.find((x) => x.project.id === id)
      if (s) {
        s.job = job
        this.renderRows()
      }
      return
    }
    if (this.bundle?.project.id !== id) return
    this.job = job
    if (job?.line && this.jobLog[this.jobLog.length - 1] !== job.line) this.jobLog = [...this.jobLog, job.line].slice(-10)
    if (!job) this.jobLog = []
    this.renderStatus()
  }

  /** News since the user last looked: parts that appeared, parts that changed. */
  private computeNews(): void {
    this.newIds.clear()
    this.changedIds.clear()
    for (const c of this.unseenChanges()) {
      for (const a of c.added ?? []) this.newIds.add(a)
      for (const t of c.touched) if (!(c.added ?? []).includes(t)) this.changedIds.set(t, (this.changedIds.get(t) ?? 0) + 1)
    }
  }

  private unseenChanges(): MapChange[] {
    return (this.bundle?.changes ?? []).filter((c) => Date.parse(c.at) > this.seenAt && c.kind !== 'build')
  }

  private renderStatus(): void {
    const b = this.bundle
    if (!b) return
    const m = b.model
    this.statusEl.replaceChildren()
    this.statusEl.classList.toggle('is-busy', !!this.job)
    if (this.job) {
      const what = { build: 'Surveying', rebuild: 'Re-surveying', update: 'Updating', check: 'Checking' }[this.job.kind]
      this.statusEl.append(el('span', 'mspin'), el('span', 'mstatus-t', `${what} — ${this.job.line}`))
      if (this.job.kind !== 'check') {
        const stop = el('button', 'mlink', 'stop')
        stop.addEventListener('click', () => window.ember.map.cancel(b.project.id))
        this.statusEl.append(stop)
      }
    } else if (m) {
      const errs = Object.keys(b.state.watchErrors ?? {}).length
      this.statusEl.append(el('span', 'mstatus-t', `v${m.version} · updated ${ago(m.updatedAt)} · checked ${ago(b.state.lastCheckAt)} · watching ${m.watches.length}${errs ? ` (${errs} unreachable)` : ''}`))
    }
    if (b.state.lastError && !this.job) this.statusEl.append(el('span', 'merr', b.state.lastError))

    this.building.hidden = !!m
    if (!m) {
      this.building.replaceChildren()
      if (this.job) {
        this.building.append(
          el('div', 'mbuilding-title', `Surveying ${b.project.name}`),
          el('div', 'mbuilding-sub', 'Reading folders, repos, deploys and docs. The first map takes a few minutes; after that it is only ever patched.'),
        )
        const log = el('ol', 'mbuilding-log')
        for (const l of this.jobLog) log.append(el('li', undefined, l))
        this.building.append(log)
      } else {
        this.building.append(el('div', 'mbuilding-title', b.state.lastError ? 'The survey did not finish' : 'Not mapped yet'))
        if (b.state.lastError) this.building.append(el('div', 'mbuilding-sub', b.state.lastError))
        const go = el('button', 'ember-map-btn is-primary', 'Survey it now')
        go.addEventListener('click', () => window.ember.map.build(b.project.id))
        this.building.append(go)
      }
    }
  }

  // =========================================================================
  // layout and the keyed scene
  // =========================================================================

  /** Draw a model: the current one, or one from the timeline. Moves are animated. */
  private async setModel(model: MapModel | null, animate: boolean): Promise<void> {
    this.model = model
    this.flowsBtn.hidden = !model?.flows?.length
    if (!model) {
      this.layout = null
      this.reconcile(false)
      return
    }
    const present = new Set(model.nodes.map((n) => n.id))
    // Parts removed in the last day stay as outlines where they were, so nothing vanishes silently.
    const ghosts: Array<MapNode & { ghost: boolean }> = []
    if (this.past === null) {
      for (const c of this.bundle?.changes ?? []) {
        if (Date.now() - Date.parse(c.at) > 86_400_000) continue
        for (const r of c.removed ?? []) {
          if (present.has(r.id) || ghosts.some((g) => g.id === r.id)) continue
          const { parent, ...rest } = r
          ghosts.push({ ...rest, ...(parent && present.has(parent) ? { parent } : {}), ghost: true, summary: `Removed ${ago(c.at)}. ${r.summary}` })
        }
      }
    }
    const seq = ++this.layoutSeq
    const layout = await computeLayout([...model.nodes, ...ghosts], model.edges)
    if (seq !== this.layoutSeq || this.disposed) return
    this.layout = layout
    this.indexPaths()
    this.matchLive()
    this.reconcile(animate)
    if (!this.fitted) requestAnimationFrame(() => this.fit(false))
  }

  /** Bring the DOM in line with the layout: one element per part and per line, kept by id. */
  private reconcile(animate: boolean): void {
    const L = this.layout
    this.world.classList.toggle('is-moving', animate)
    const keep = new Set(L ? L.order : [])
    for (const [id, e] of this.nodeEls) {
      if (keep.has(id)) continue
      e.remove()
      this.nodeEls.delete(id)
    }
    if (!L) {
      for (const e of this.edgeEls.values()) e.g.remove()
      this.edgeEls.clear()
      return
    }
    this.world.style.width = `${L.w}px`
    this.world.style.height = `${L.h}px`
    this.edgesSvg.setAttribute('width', String(L.w))
    this.edgesSvg.setAttribute('height', String(L.h))
    this.edgesSvg.setAttribute('viewBox', `0 0 ${L.w} ${L.h}`)

    for (const id of L.order) {
      const b = L.boxes.get(id)!
      let e = this.nodeEls.get(id)
      if (!e) {
        e = el('div', 'mnode')
        e.dataset['id'] = id
        e.dataset['kind'] = 'node'
        this.nodesEl.append(e)
        this.nodeEls.set(id, e)
      }
      this.fillNode(e, b)
    }
    // Paint order: parents first, so a zone is always under its parts.
    for (const id of L.order) this.nodesEl.append(this.nodeEls.get(id)!)

    if (animate) {
      // Lines are redrawn once the parts have arrived; meanwhile they fade, not jump.
      window.setTimeout(() => {
        this.world.classList.remove('is-moving')
        this.openKey = ''
        this.applyView()
      }, 650)
    }
    this.openKey = ''
    this.applyView()
  }

  private fillNode(e: HTMLElement, b: LBox): void {
    const n = b.node
    const isContainer = b.kids.length > 0
    const keep = ['is-hidden', 'is-open', 'is-closed'].filter((c) => e.classList.contains(c))
    e.className = `mnode k-${n.kind}${isContainer ? ' is-container' : ' is-leaf'}${b.ghost ? ' is-ghost' : ''}${b.depth === 0 ? ' is-top' : ''}`
    for (const c of keep) e.classList.add(c)
    e.style.left = `${b.x}px`
    e.style.top = `${b.y}px`
    e.style.width = `${b.w}px`
    e.style.height = `${b.h}px`
    e.style.setProperty('--hue', AREA_HUES[b.area % AREA_HUES.length]!)
    e.style.setProperty('--cap', `${Math.max(12, isContainer ? Math.min(b.w * 0.075, b.h * 0.12, 64) : b.h * 0.2)}px`)
    if (n.status) e.dataset['status'] = n.status
    else delete e.dataset['status']

    const sig = JSON.stringify([n.name, n.kind, n.summary, n.status, n.deploy, n.notes, n.tech, b.kids.length, b.ghost])
    if (e.dataset['sig'] === sig) return
    e.dataset['sig'] = sig
    e.replaceChildren()
    const body = el('div', 'mnode-body')
    const head = el('div', 'mnode-head')
    const glyph = el('span', 'mnode-glyph')
    glyph.innerHTML = KIND_GLYPH[n.kind] ?? ''
    const name = el('span', 'mnode-name', n.name)
    const dot = el('span', 'mnode-dot')
    head.append(glyph, name, dot)
    body.append(head)
    if (!isContainer) {
      body.append(el('div', 'mnode-sum', n.summary))
      const meta = el('div', 'mnode-meta')
      if (n.deploy) meta.append(el('span', 'mnode-deploy', n.deploy))
      else meta.append(el('span', 'mnode-kindword', KIND_WORD[n.kind] ?? n.kind))
      const pips = this.notePips(n)
      if (pips) meta.append(pips)
      body.append(meta)
    } else {
      body.append(el('div', 'mnode-count'))
    }
    e.append(body, el('div', 'mnode-tags'), el('div', 'mnode-live'), el('div', 'mnode-steps'))
  }

  private notePips(n: MapNode): HTMLElement | null {
    if (!n.notes?.length) return null
    const counts = new Map<string, number>()
    for (const x of n.notes) counts.set(x.type, (counts.get(x.type) ?? 0) + 1)
    const wrap = el('span', 'mnode-pips')
    for (const [t, c] of counts) {
      const p = el('span', `mpip t-${t}`)
      p.innerHTML = `${NOTE_GLYPH[t] ?? ''}${c > 1 ? `<b>${c}</b>` : ''}`
      p.title = `${NOTE_WORD[t] ?? t}: ${n.notes.filter((x) => x.type === t).map((x) => x.text).join(' · ')}`
      wrap.append(p)
    }
    return wrap
  }

  // =========================================================================
  // the view: zoom, what is open, lines, decorations
  // =========================================================================

  /**
   * A container opens once its parts would be readable (a leaf ~100px on screen), or when
   * it is simply big on screen. Closed, it is a tile that says what is inside.
   */
  private isOpen(b: LBox): boolean {
    return b.kids.length > 0 && (240 * this.k >= 100 || b.w * this.k >= OPEN_AT * 2.4)
  }

  /** The part standing for `id` at this zoom: itself, or its closed ancestor. */
  private rep(id: string): LBox | null {
    const L = this.layout
    const b = L?.boxes.get(id) ?? null
    if (!b || !L) return null
    const chain: LBox[] = []
    for (let p: LBox | null = b; p; p = p.parent ? (L.boxes.get(p.parent) ?? null) : null) chain.unshift(p)
    for (const c of chain) if (!this.isOpen(c)) return c
    return b
  }

  private isAncestor(a: string, b: string): boolean {
    const L = this.layout
    for (let p = L?.boxes.get(b)?.parent; p; p = L?.boxes.get(p)?.parent ?? null) if (p === a) return true
    return false
  }

  /** Every frame the view moves: one transform, one variable; the rest only when zoom crosses a line. */
  private applyView(): void {
    const L = this.layout
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.k})`
    this.world.style.setProperty('--ik', String(1 / this.k))
    // Text: constant on screen while zoomed out, growing gently (to 1.35x) when zoomed in.
    const grow = this.k <= 1 ? 1 : Math.min(1.35, 1 + (this.k - 1) * 0.35)
    this.world.style.setProperty('--ts', String(grow / this.k))
    const leafPx = 240 * this.k
    this.world.dataset['lod'] = leafPx < 150 ? 'far' : leafPx < 265 ? 'mid' : 'near'
    const ms = 11 / this.k
    for (const m of this.markers) {
      m.setAttribute('markerWidth', String(ms))
      m.setAttribute('markerHeight', String(ms))
    }
    if (L) {
      const open: string[] = []
      for (const id of L.order) if (this.isOpen(L.boxes.get(id)!)) open.push(id)
      const key = open.join(',')
      if (key !== this.openKey) {
        this.openKey = key
        this.applyOpen()
        this.drawEdges()
        this.decorate()
      }
    }
    this.placeCard()
    this.scheduleCrumbs()
    this.scheduleLabels()
  }

  private labelTimer: number | null = null

  private scheduleLabels(): void {
    if (this.labelTimer !== null) return
    this.labelTimer = window.setTimeout(() => {
      this.labelTimer = null
      this.placeLabels()
    }, 120)
  }

  private applyOpen(): void {
    const L = this.layout
    if (!L) return
    for (const id of L.order) {
      const b = L.boxes.get(id)!
      const e = this.nodeEls.get(id)!
      let hidden = false
      for (let p = b.parent; p; p = L.boxes.get(p)?.parent ?? null) if (!this.isOpen(L.boxes.get(p)!)) hidden = true
      e.classList.toggle('is-hidden', hidden)
      if (b.kids.length) {
        const open = this.isOpen(b)
        e.classList.toggle('is-open', open)
        e.classList.toggle('is-closed', !open)
      }
    }
  }

  private drawEdges(): void {
    const L = this.layout
    const seen = new Set<string>()
    const drawn = new Map<string, EdgeEl>()
    if (L && this.model) {
      for (const [id, le] of L.edges) {
        const a = this.rep(le.edge.from)
        const b = this.rep(le.edge.to)
        let ee = this.edgeEls.get(id)
        const hide = !a || !b || a === b || this.isAncestor(a.id, b.id) || this.isAncestor(b.id, a.id)
        const key = a && b ? `${a.id}>${b.id}` : ''
        const dup = !hide && drawn.has(key)
        if (hide || dup) {
          if (ee) ee.g.classList.add('is-hidden')
          if (dup) {
            const first = drawn.get(key)!
            first.g.dataset['more'] = String(Number(first.g.dataset['more'] ?? '0') + 1)
          }
          seen.add(id)
          continue
        }
        let pts = le.pts
        if (a!.id !== le.edge.from) pts = clipStart(pts, a!)
        if (b!.id !== le.edge.to) pts = clipEnd(pts, b!)
        if (!ee) {
          ee = this.makeEdge(id)
          this.edgeEls.set(id, ee)
        }
        ee.g.classList.remove('is-hidden')
        delete ee.g.dataset['more']
        ee.pts = pts
        ee.from = a!.id
        ee.to = b!.id
        const d = roundedPath(pts, 14)
        ee.halo.setAttribute('d', d)
        ee.line.setAttribute('d', d)
        ee.hit.setAttribute('d', d)
        const [lx, ly] = labelPoint(pts)
        ee.label.setAttribute('x', String(lx))
        ee.label.setAttribute('y', String(ly))
        ee.label.textContent = le.edge.label ?? ''
        ee.dots.replaceChildren()
        drawn.set(key, ee)
        seen.add(id)
      }
    }
    for (const [id, ee] of this.edgeEls) {
      if (seen.has(id)) continue
      ee.g.remove()
      this.edgeEls.delete(id)
    }
    for (const ee of drawn.values()) {
      const more = Number(ee.g.dataset['more'] ?? '0')
      if (more) ee.label.textContent = `${ee.label.textContent || 'links'} +${more}`
    }
  }

  private makeEdge(id: string): EdgeEl {
    const g = svgEl('g', 'medge')
    g.dataset['id'] = id
    g.dataset['kind'] = 'edge'
    const halo = svgEl('path', 'medge-halo')
    const line = svgEl('path', 'medge-line')
    const hit = svgEl('path', 'medge-hit')
    const label = svgEl('text', 'medge-label')
    const dots = svgEl('g', 'medge-dots')
    g.append(halo, line, dots, hit, label)
    this.edgesG.append(g)
    return { g, halo, line, hit, label, dots, pts: [], from: '', to: '' }
  }

  /**
   * Every state that is light on the map, applied as classes: focus and its neighbours,
   * selection, flows, blast radius, live sessions, news. Called when any of them change.
   */
  private decorate(): void {
    const L = this.layout
    const model = this.model
    if (!L || !model) return

    // ---- what is in focus
    const focus = this.selected ?? this.hovered
    const focusNodes = new Set<string>()
    const hotEdges = new Set<string>()
    if (focus?.kind === 'node') {
      const inside = (id: string) => id === focus.id || this.isAncestor(focus.id, id)
      for (const [eid, le] of L.edges) {
        if (inside(le.edge.from) || inside(le.edge.to)) {
          hotEdges.add(eid)
          const a = this.rep(le.edge.from)
          const b = this.rep(le.edge.to)
          if (a) focusNodes.add(a.id)
          if (b) focusNodes.add(b.id)
        }
      }
      focusNodes.add(focus.id)
      for (const b of L.boxes.values()) if (this.isAncestor(focus.id, b.id)) focusNodes.add(b.id)
    } else if (focus?.kind === 'edge') {
      const le = L.edges.get(focus.id)
      if (le) {
        hotEdges.add(focus.id)
        for (const x of [this.rep(le.edge.from), this.rep(le.edge.to)]) if (x) focusNodes.add(x.id)
      }
    }
    for (const id of this.lit) focusNodes.add(this.rep(id)?.id ?? id)
    // Ancestors of anything in focus stay lit: a zone must not vanish around its part.
    for (const id of [...focusNodes]) for (let p = L.boxes.get(id)?.parent; p; p = L.boxes.get(p)?.parent ?? null) focusNodes.add(p)

    // ---- the flow
    const flowNodes = new Map<string, number[]>()
    const flowEdges = new Set<string>()
    let stepNode: string | null = null
    if (this.flow) {
      const steps = this.flow.flow.steps
      steps.forEach((s, i) => {
        const r = this.rep(s.node)?.id ?? s.node
        flowNodes.set(r, [...(flowNodes.get(r) ?? []), i + 1])
      })
      stepNode = this.rep(steps[this.flow.step]?.node ?? '')?.id ?? null
      for (let i = 0; i < Math.min(this.flow.step, steps.length - 1); i++) {
        const a = steps[i]!.node
        const b = steps[i + 1]!.node
        for (const [eid, le] of L.edges) if ((le.edge.from === a && le.edge.to === b) || (le.edge.from === b && le.edge.to === a)) flowEdges.add(eid)
      }
      for (const id of [...flowNodes.keys()]) for (let p = L.boxes.get(id)?.parent; p; p = L.boxes.get(p)?.parent ?? null) focusNodes.add(p)
    }
    this.drawVirtual()

    // ---- blast radius
    const blastEdges = new Set<string>()
    if (this.blast) {
      for (const [eid, le] of L.edges) if (this.blast.has(le.edge.from) && this.blast.has(le.edge.to)) blastEdges.add(eid)
      for (const id of this.blast.keys()) for (let p = L.boxes.get(id)?.parent; p; p = L.boxes.get(p)?.parent ?? null) focusNodes.add(p)
    }

    // ---- roll hidden parts' news and live marks up to what stands for them
    const liveAt = new Map<string, LiveMark[]>()
    for (const [id, marks] of this.liveByNode) {
      const r = this.rep(id)?.id ?? id
      liveAt.set(r, [...(liveAt.get(r) ?? []), ...marks])
    }
    const rolled = (set: Iterable<string>) => {
      const m = new Map<string, number>()
      for (const id of set) {
        const r = this.rep(id)?.id
        if (r && r !== id) m.set(r, (m.get(r) ?? 0) + 1)
      }
      return m
    }
    const newBelow = rolled(this.newIds)
    const changedBelow = rolled(this.changedIds.keys())
    const troubleBelow = rolled(model.nodes.filter((n) => n.status === 'warn' || n.status === 'down').map((n) => n.id))
    const blastBelow = new Map<string, number>()
    if (this.blast) for (const [id, d] of this.blast) {
      const r = this.rep(id)?.id ?? id
      blastBelow.set(r, Math.min(blastBelow.get(r) ?? 9, d))
    }

    this.world.classList.toggle('has-focus', (!!focus || this.lit.size > 0) && !this.flow && !this.blast)
    this.world.classList.toggle('in-flow', !!this.flow)
    this.world.classList.toggle('in-blast', !!this.blast)
    this.world.classList.toggle('in-past', this.past !== null)

    const now = Date.now()
    for (const [id, e] of this.nodeEls) {
      const b = L.boxes.get(id)
      if (!b) continue
      e.classList.toggle('is-focus', focusNodes.has(id))
      e.classList.toggle('is-selected', this.selected?.kind === 'node' && this.selected.id === id)
      e.classList.toggle('is-new', this.newIds.has(id))
      e.classList.toggle('is-born', this.born.has(id))
      e.classList.toggle('is-lit', this.lit.has(id) || [...this.lit].some((x) => this.rep(x)?.id === id))
      e.classList.toggle('is-flow', flowNodes.has(id))
      e.classList.toggle('is-step', stepNode === id)
      const bl = blastBelow.get(id)
      if (bl === undefined) delete e.dataset['blast']
      else e.dataset['blast'] = String(Math.min(bl, 3))

      // tags above the part
      const tags = e.querySelector('.mnode-tags') as HTMLElement
      tags.replaceChildren()
      if (b.ghost) tags.append(el('span', 'mtag is-ghost', 'removed'))
      if (this.newIds.has(id) || this.born.has(id)) tags.append(el('span', 'mtag is-new', 'NEW'))
      const ch = this.changedIds.get(id)
      if (ch) {
        const t = el('span', 'mtag is-delta', `Δ${ch}`)
        t.title = this.lastChangeText(id)
        tags.append(t)
      }
      if (bl !== undefined) tags.append(el('span', 'mtag is-blast', bl === 0 ? 'goes down' : bl === 1 ? 'breaks' : 'affected'))

      // flow step numbers
      const steps = e.querySelector('.mnode-steps') as HTMLElement
      steps.replaceChildren()
      for (const s of flowNodes.get(id) ?? []) steps.append(el('span', `mstep${this.flow && s === this.flow.step + 1 ? ' is-now' : s <= (this.flow?.step ?? 0) ? ' is-done' : ''}`, String(s)))

      // live
      const marks = liveAt.get(id) ?? []
      const liveBox = e.querySelector('.mnode-live') as HTMLElement
      liveBox.replaceChildren()
      const editing = marks.filter((m) => m.mode !== 'read')
      const reading = marks.filter((m) => m.mode === 'read')
      const lead = editing[0] ?? reading[0]
      e.classList.toggle('is-live', !!editing.length)
      e.classList.toggle('is-live-read', !editing.length && !!reading.length)
      e.classList.toggle('is-live-hot', marks.some((m) => now - m.at < HOT_MS))
      e.classList.toggle('is-pending', marks.some((m) => m.mode === 'commit' && m.at > Date.parse(model.updatedAt)))
      if (lead) e.style.setProperty('--live', this.sessionHue(lead.session))
      const bySession = new Map<string, LiveMark>()
      for (const m of [...editing, ...reading]) if (!bySession.has(m.session.sessionId)) bySession.set(m.session.sessionId, m)
      for (const m of bySession.values()) {
        const chip = el('button', `mlive-chip${m.mode === 'read' ? ' is-read' : ''}`)
        chip.style.setProperty('--c', this.sessionHue(m.session))
        chip.append(el('span', 'mlive-dot'), el('span', undefined, `${this.sessionName(m.session)} · ${m.mode === 'edit' ? 'editing' : m.mode === 'commit' ? 'committed' : 'reading'}`))
        chip.title = `${m.file}\n${m.session.lastText}`
        chip.dataset['session'] = m.session.sessionId
        liveBox.append(chip)
      }

      // counts on a closed container
      const count = e.querySelector('.mnode-count') as HTMLElement | null
      if (count) {
        count.replaceChildren()
        count.append(el('span', undefined, `${b.kids.length} part${b.kids.length === 1 ? '' : 's'}`))
        const nb = newBelow.get(id)
        const cb = changedBelow.get(id)
        const tb = troubleBelow.get(id)
        if (nb) count.append(el('span', 'is-new', `${nb} new`))
        if (cb) count.append(el('span', 'is-delta', `${cb} changed`))
        if (tb) count.append(el('span', 'is-trouble', `${tb} need${tb === 1 ? 's' : ''} attention`))
      }
    }

    for (const [eid, ee] of this.edgeEls) {
      const hot = hotEdges.has(eid)
      const inFlow = flowEdges.has(eid)
      const inBlast = blastEdges.has(eid)
      ee.g.classList.toggle('is-hot', hot)
      ee.g.classList.toggle('is-selected', this.selected?.kind === 'edge' && this.selected.id === eid)
      ee.g.classList.toggle('is-flow', inFlow)
      ee.g.classList.toggle('is-blast', inBlast)
      ee.line.setAttribute('marker-end', `url(#ember-${inBlast ? 'mk-blast' : inFlow ? 'mk-flow' : hot ? 'mk-hot' : 'mk'})`)
      // Moving dots show direction on the lines that matter right now.
      const wantDots = (hot || inFlow || inBlast) && !ee.g.classList.contains('is-hidden')
      if (wantDots && !ee.dots.childElementCount) {
        const d = ee.line.getAttribute('d') ?? ''
        let len = 0
        for (let i = 1; i < ee.pts.length; i++) len += Math.hypot(ee.pts[i]![0] - ee.pts[i - 1]![0], ee.pts[i]![1] - ee.pts[i - 1]![1])
        const dur = Math.max(1.2, Math.min(4, len / 260))
        for (let i = 0; i < 3; i++) {
          const c = svgEl('circle', 'medge-dot')
          const m = svgEl('animateMotion')
          m.setAttribute('dur', `${dur}s`)
          m.setAttribute('repeatCount', 'indefinite')
          m.setAttribute('begin', `${(-dur * i) / 3}s`)
          m.setAttribute('path', d)
          c.append(m)
          ee.dots.append(c)
        }
      } else if (!wantDots && ee.dots.childElementCount) ee.dots.replaceChildren()
    }
    this.placeLabels()
  }

  /**
   * Labels on the lit lines, but never on top of one another: placed greedily in screen
   * space, and a label that would land on one already placed is left to its hover.
   */
  private placeLabels(): void {
    const placed: Array<{ x: number; y: number; w: number }> = []
    for (const ee of this.edgeEls.values()) {
      const lit = ee.g.classList.contains('is-hot') || ee.g.classList.contains('is-flow') || ee.g.classList.contains('is-selected')
      let show = false
      if (lit && !ee.g.classList.contains('is-hidden') && ee.label.textContent) {
        const x = Number(ee.label.getAttribute('x')) * this.k + this.tx
        const y = Number(ee.label.getAttribute('y')) * this.k + this.ty
        const w = ee.label.textContent.length * 6.6 + 12
        show = !placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - y) < 17)
        if (show) placed.push({ x, y, w })
      }
      ee.g.classList.toggle('show-label', show)
    }
  }

  /** Flow steps with no line between them get a dashed one, drawn only while the flow is shown. */
  private drawVirtual(): void {
    this.virtualG.replaceChildren()
    const L = this.layout
    if (!this.flow || !L) return
    const steps = this.flow.flow.steps
    for (let i = 0; i < Math.min(this.flow.step, steps.length - 1); i++) {
      const a = steps[i]!.node
      const b = steps[i + 1]!.node
      const direct = [...L.edges.values()].some((le) => (le.edge.from === a && le.edge.to === b) || (le.edge.from === b && le.edge.to === a))
      if (direct) continue
      const A = this.rep(a)
      const B = this.rep(b)
      if (!A || !B || A === B) continue
      const p = svgEl('path', 'mvirtual-line')
      const ax = A.x + A.w / 2
      const ay = A.y + A.h / 2
      const bx = B.x + B.w / 2
      const by = B.y + B.h / 2
      p.setAttribute('d', `M${ax},${ay} C${(ax + bx) / 2},${ay} ${(ax + bx) / 2},${by} ${bx},${by}`)
      p.setAttribute('marker-end', 'url(#ember-mk-flow)')
      this.virtualG.append(p)
    }
  }

  private lastChangeText(id: string): string {
    const c = [...(this.bundle?.changes ?? [])].reverse().find((x) => x.touched.includes(id))
    if (!c) return ''
    return c.items.find((i) => i.node === id)?.text ?? c.summary
  }

  // =========================================================================
  // live sessions
  // =========================================================================

  /** Paths on the map, longest first, so a touched file lands on the most specific part. */
  private indexPaths(): void {
    const out: Array<{ prefix: string; id: string }> = []
    for (const n of this.model?.nodes ?? []) {
      if (n.path) out.push({ prefix: norm(n.path), id: n.id })
      for (const s of n.sources ?? []) if (s.path) out.push({ prefix: norm(s.path), id: n.id })
    }
    this.pathIndex = out.sort((a, b) => b.prefix.length - a.prefix.length)
  }

  private nodeForPath(p: string): string | null {
    const q = norm(p)
    for (const x of this.pathIndex) if (q === x.prefix || q.startsWith(x.prefix + '\\')) return x.id
    return null
  }

  private onLive(sessions: MapLiveSession[]): void {
    this.live = sessions
    if (this.el.dataset['mode'] !== 'map') return
    this.matchLive()
    this.decorate()
    this.renderStrip()
    this.refreshCard()
  }

  private matchLive(): void {
    this.liveByNode.clear()
    if (this.past !== null) return
    const now = Date.now()
    const rank = (m: string) => (m === 'commit' ? 2 : m === 'edit' ? 1 : 0)
    for (const s of this.live) {
      const latest = new Map<string, LiveMark>()
      for (const t of s.touches) {
        if (now - t.at > LIVE_MS) continue
        const id = this.nodeForPath(t.path)
        if (!id) continue
        const cur = latest.get(id)
        if (!cur || rank(t.mode) > rank(cur.mode) || (rank(t.mode) === rank(cur.mode) && t.at > cur.at)) {
          latest.set(id, { session: s, mode: t.mode, at: t.at, file: t.path.split(/[\\/]/).pop() ?? t.path })
        }
      }
      for (const [id, m] of latest) this.liveByNode.set(id, [...(this.liveByNode.get(id) ?? []), m])
    }
  }

  private sessionHue(s: MapLiveSession): string {
    return hueFor(s.sessionId, SESSION_HUES)
  }

  private sessionName(s: MapLiveSession): string {
    const t = s.tabId ? this.hooks.tabTitle(s.tabId) : undefined
    if (t) return t.slice(0, 22)
    // Outside Ember (a phone session, another terminal): say it is Claude, and where.
    const folder = s.cwd.split(/[\\/]/).filter(Boolean).pop()
    return `Claude${folder ? ` · ${folder}` : ''}`.slice(0, 26)
  }

  // =========================================================================
  // the strip: what is happening
  // =========================================================================

  private renderStrip(): void {
    const unseen = this.unseenChanges()
    this.replayBtn.hidden = !unseen.length
    ;(this.replayBtn.querySelector('.mbtn-t') as HTMLElement).textContent = `Replay ${unseen.length} change${unseen.length === 1 ? '' : 's'} since you looked`

    this.stripLive.replaceChildren()
    const now = Date.now()
    const onMap = new Map<string, { id: string; m: LiveMark }>()
    for (const [id, marks] of this.liveByNode) {
      for (const m of marks) {
        const cur = onMap.get(m.session.sessionId)
        if (!cur || m.at > cur.m.at) onMap.set(m.session.sessionId, { id, m })
      }
    }
    for (const { id, m } of [...onMap.values()].sort((a, b) => b.m.at - a.m.at)) {
      const chip = el('button', `mstrip-live-chip${now - m.at < HOT_MS ? ' is-hot' : ''}`)
      chip.style.setProperty('--c', this.sessionHue(m.session))
      const node = this.model?.nodes.find((n) => n.id === id)
      chip.append(
        el('span', 'mlive-dot'),
        el('strong', undefined, this.sessionName(m.session)),
        el('span', undefined, ` ${m.mode === 'edit' ? 'editing' : m.mode === 'commit' ? 'committed in' : 'reading'} ${node?.name ?? ''} · ${ago(m.at)}`),
      )
      chip.title = `${m.file} — ${m.session.lastText}`
      chip.addEventListener('click', () => {
        this.select({ kind: 'node', id })
        this.flyTo(id)
      })
      this.stripLive.append(chip)
    }
    if (!onMap.size) this.stripLive.append(el('span', 'mstrip-quiet', 'No session is working in this project right now'))

    this.stripEvents.replaceChildren()
    const byId = new Map((this.model?.nodes ?? []).map((n) => [n.id, n]))
    const events: Array<{ at: string; text: string; node?: string; fresh: boolean; impact?: string }> = []
    for (const c of [...(this.bundle?.changes ?? [])].reverse().slice(0, 12)) {
      const fresh = Date.parse(c.at) > this.seenAt && c.kind !== 'build'
      if (c.items.length) for (const i of c.items.slice(0, 4)) events.push({ at: c.at, text: i.text, ...(i.node ? { node: i.node } : {}), fresh, ...(i.impact ? { impact: i.impact } : {}) })
      else events.push({ at: c.at, text: c.summary, fresh })
    }
    for (const ev of events.slice(0, 24)) {
      const chip = el('button', `mstrip-ev${ev.fresh ? ' is-fresh' : ''}${ev.impact === 'major' ? ' is-major' : ''}`)
      const nodeName = ev.node ? byId.get(ev.node)?.name : undefined
      chip.append(el('span', 'mstrip-when', ago(ev.at)), el('span', 'mstrip-text', nodeName ? `${nodeName}: ${ev.text}` : ev.text))
      chip.title = ev.text
      if (ev.node && byId.has(ev.node)) {
        const node = ev.node
        chip.addEventListener('click', () => {
          this.select({ kind: 'node', id: node })
          this.flyTo(node)
        })
      } else chip.addEventListener('click', () => this.showCaption(ev.text, 8000))
      this.stripEvents.append(chip)
    }
  }

  /** A change arrived while watching: say it on the map, briefly. */
  private announce(c: MapChange): void {
    this.showCaption(c.summary, 8000)
    this.lit = new Set(c.touched)
    this.decorate()
    window.setTimeout(() => {
      this.lit.clear()
      this.decorate()
    }, 8000)
  }

  private captionTimer: number | null = null

  private showCaption(text: string, ms: number, actions?: HTMLElement[]): void {
    this.caption.replaceChildren(el('span', 'mcaption-t', text), ...(actions ?? []))
    this.caption.classList.add('is-on')
    if (this.captionTimer !== null) window.clearTimeout(this.captionTimer)
    this.captionTimer = ms ? window.setTimeout(() => this.caption.classList.remove('is-on'), ms) : null
  }

  // =========================================================================
  // replay: what changed since you last looked
  // =========================================================================

  private startReplay(): void {
    const changes = this.unseenChanges()
    if (!changes.length) return
    this.closeCard()
    this.stopFlow()
    this.replay = { timer: null }
    let i = 0
    const stop = el('button', 'mlink', 'stop')
    stop.addEventListener('click', () => this.stopReplay())
    const step = () => {
      if (!this.replay) return
      const c = changes[i]
      if (!c) {
        this.stopReplay()
        this.fit(true)
        return
      }
      this.lit = new Set(c.touched)
      this.decorate()
      if (c.touched.length) this.flyToAll(c.touched)
      this.showCaption(`${i + 1} of ${changes.length} · ${ago(c.at)} — ${c.summary}`, 0, [stop])
      i++
      this.replay.timer = window.setTimeout(step, 4600)
    }
    step()
  }

  private stopReplay(): void {
    if (!this.replay) return
    if (this.replay.timer !== null) window.clearTimeout(this.replay.timer)
    this.replay = null
    this.lit.clear()
    this.caption.classList.remove('is-on')
    this.decorate()
  }

  // =========================================================================
  // flows
  // =========================================================================

  private openFlowsMenu(): void {
    const flows = this.model?.flows ?? []
    const r = this.flowsBtn.getBoundingClientRect()
    this.openMenuAt(r.left, r.bottom + 6, (item, _sep, title) => {
      title('Trace a flow through the system')
      for (const f of flows) item(f.name, () => this.startFlow(f), `${f.steps.length} steps`, f.summary)
      if (!flows.length) item('No flows yet — Re-survey to find them', () => {})
    })
  }

  startFlow(f: MapFlow, from = 0): void {
    this.stopFlow()
    this.stopReplay()
    this.select(null)
    this.blast = null
    this.flow = { flow: f, step: from, playing: true, timer: null }
    this.flyToAll(f.steps.map((s) => s.node))
    this.renderFlowbar()
    this.decorate()
    this.scheduleFlow()
  }

  private flowGo(step: number, playing: boolean): void {
    if (!this.flow) return
    this.flow.step = Math.max(0, Math.min(this.flow.flow.steps.length - 1, step))
    this.flow.playing = playing
    this.renderFlowbar()
    this.decorate()
    this.scheduleFlow()
  }

  private scheduleFlow(): void {
    const f = this.flow
    if (!f) return
    if (f.timer !== null) window.clearTimeout(f.timer)
    f.timer = null
    if (!f.playing) return
    f.timer = window.setTimeout(() => {
      if (!this.flow) return
      if (this.flow.step >= this.flow.flow.steps.length - 1) return this.flowGo(this.flow.step, false)
      this.flowGo(this.flow.step + 1, true)
    }, 1800)
  }

  private renderFlowbar(): void {
    const f = this.flow
    this.flowbar.classList.toggle('is-on', !!f)
    this.flowbar.replaceChildren()
    if (!f) return
    const step = f.flow.steps[f.step]!
    const node = this.model?.nodes.find((n) => n.id === step.node)
    const prev = iconBtn(ICON.prev, 'Previous step  (←)', 'mbtn is-icon')
    prev.addEventListener('click', () => this.flowGo(f.step - 1, false))
    const play = iconBtn(f.playing ? ICON.pause : ICON.play, f.playing ? 'Pause' : 'Play', 'mbtn is-icon')
    play.addEventListener('click', () => {
      const atEnd = f.step >= f.flow.steps.length - 1
      this.flowGo(atEnd && !f.playing ? 0 : f.step, !f.playing)
    })
    const next = iconBtn(ICON.next, 'Next step  (→)', 'mbtn is-icon')
    next.addEventListener('click', () => this.flowGo(f.step + 1, false))
    const close = iconBtn(ICON.close, 'Stop tracing  (Esc)', 'mbtn is-icon')
    close.addEventListener('click', () => this.stopFlow())
    const text = el('div', 'mflowbar-text')
    text.append(
      el('div', 'mflowbar-name', `${f.flow.name} · step ${f.step + 1} of ${f.flow.steps.length}`),
      el('div', 'mflowbar-step', `${node?.name ?? step.node}${step.text ? ` — ${step.text}` : ''}`),
    )
    const dots = el('div', 'mflowbar-dots')
    f.flow.steps.forEach((_, i) => {
      const d = el('button', `mflowbar-dot${i === f.step ? ' is-now' : i < f.step ? ' is-done' : ''}`)
      d.title = `Step ${i + 1}`
      d.addEventListener('click', () => this.flowGo(i, false))
      dots.append(d)
    })
    this.flowbar.append(prev, play, next, text, dots, close)
  }

  private stopFlow(): void {
    if (!this.flow) return
    if (this.flow.timer !== null) window.clearTimeout(this.flow.timer)
    this.flow = null
    this.renderFlowbar()
    this.decorate()
  }

  // =========================================================================
  // blast radius
  // =========================================================================

  /** What breaks if `id` goes down: everything that uses it, and what uses those, in rings. */
  private showBlast(id: string): void {
    const model = this.model
    if (!model) return
    this.stopFlow()
    this.select(null)
    const level = new Map<string, number>([[id, 0]])
    // A part inside the one going down goes down with it.
    for (const n of model.nodes) if (this.isAncestor(id, n.id)) level.set(n.id, 0)
    let frontier = [...level.keys()]
    for (let d = 1; frontier.length && d < 6; d++) {
      const next: string[] = []
      for (const e of model.edges) {
        if (frontier.includes(e.to) && !level.has(e.from)) {
          level.set(e.from, d)
          next.push(e.from)
        }
      }
      frontier = next
    }
    this.blast = level
    this.decorate()
    const hit = [...level.entries()].filter(([, d]) => d > 0)
    const name = model.nodes.find((n) => n.id === id)?.name ?? id
    const clear = el('button', 'mlink', 'clear')
    clear.addEventListener('click', () => this.clearBlast())
    this.showCaption(
      hit.length
        ? `If ${name} goes down, ${hit.length} part${hit.length === 1 ? '' : 's'} that depend on it break — red first, then what depends on those.`
        : `Nothing on the map depends on ${name}.`,
      0,
      [clear],
    )
    this.flyToAll([...level.keys()])
  }

  private clearBlast(): void {
    this.blast = null
    this.caption.classList.remove('is-on')
    this.decorate()
  }

  // =========================================================================
  // timeline
  // =========================================================================

  private async toggleTimeline(): Promise<void> {
    if (this.timeline.classList.contains('is-on')) {
      this.timeline.classList.remove('is-on')
      this.timeBtn.classList.remove('is-on')
      await this.backToNow()
      return
    }
    if (!this.bundle) return
    this.history = await window.ember.map.history(this.bundle.project.id)
    this.timeline.replaceChildren()
    if (this.history.length < 2) {
      this.timeline.append(el('span', 'mtimeline-empty', 'Only one version so far. Every update is kept, so the map can be scrubbed back through time as it changes.'))
    } else {
      const range = el('input')
      range.type = 'range'
      range.min = '0'
      range.max = String(this.history.length - 1)
      range.value = range.max
      const label = el('span', 'mtimeline-label')
      const show = (i: number) => {
        const h = this.history[i]!
        label.textContent =
          i === this.history.length - 1
            ? `Now · v${h.version}`
            : `v${h.version} · ${new Date(h.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      }
      show(this.history.length - 1)
      let timer: number | null = null
      range.addEventListener('input', () => {
        const i = Number(range.value)
        show(i)
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(() => void this.viewVersion(i === this.history.length - 1 ? null : this.history[i]!.version), 180)
      })
      this.timeline.append(el('span', 'mtimeline-title', 'Timeline'), range, label)
    }
    this.timeline.classList.add('is-on')
    this.timeBtn.classList.add('is-on')
  }

  private async viewVersion(v: number | null): Promise<void> {
    if (!this.bundle) return
    if (v === null) return this.backToNow()
    const m = await window.ember.map.version(this.bundle.project.id, v)
    if (!m) return
    this.past = v
    this.select(null)
    this.stopFlow()
    const now = el('button', 'mlink', 'Back to now')
    now.addEventListener('click', () => {
      this.timeline.classList.remove('is-on')
      this.timeBtn.classList.remove('is-on')
      void this.backToNow()
    })
    this.pastBanner.replaceChildren(
      el('span', undefined, `The map as it was: v${m.version}, ${new Date(m.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`),
      now,
    )
    this.pastBanner.classList.add('is-on')
    const c = this.bundle.changes.find((x) => x.version === v)
    this.lit = new Set(c?.touched ?? [])
    await this.setModel(m, true)
    this.decorate()
  }

  private async backToNow(): Promise<void> {
    if (this.past === null) return
    this.past = null
    this.lit.clear()
    this.pastBanner.classList.remove('is-on')
    await this.setModel(this.bundle?.model ?? null, true)
    this.matchLive()
    this.decorate()
  }

  // =========================================================================
  // moving around
  // =========================================================================

  private wireStage(): void {
    let drag: { x: number; y: number; tx: number; ty: number; moved: boolean; target: Target | null } | null = null
    this.stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.isChrome(e.target)) return
      this.closeMenu()
      drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false, target: this.targetAt(e.target) }
      this.stage.setPointerCapture(e.pointerId)
    })
    this.stage.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x
        const dy = e.clientY - drag.y
        if (!drag.moved && Math.hypot(dx, dy) < 4) return
        drag.moved = true
        this.stage.classList.add('is-panning')
        this.stopAnim()
        this.tx = drag.tx + dx
        this.ty = drag.ty + dy
        this.applyView()
        return
      }
      if (this.isChrome(e.target)) return
      const t = this.targetAt(e.target)
      if (t?.kind !== this.hovered?.kind || t?.id !== this.hovered?.id) {
        this.hovered = t
        if (!this.selected) this.decorate()
      }
    })
    this.stage.addEventListener('pointerleave', () => {
      if (this.hovered && !this.selected) {
        this.hovered = null
        this.decorate()
      }
    })
    // The target is read at pointerdown: once the stage has captured the pointer, every
    // later event's target is the stage itself.
    this.stage.addEventListener('pointerup', () => {
      const d = drag
      drag = null
      this.stage.classList.remove('is-panning')
      if (!d || d.moved) return
      if (d.target) this.select(d.target)
      else {
        this.select(null)
        if (this.blast) this.clearBlast()
      }
    })
    this.stage.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest('.mlive-chip') as HTMLElement | null
      if (!chip) return
      const s = this.live.find((x) => x.sessionId === chip.dataset['session'])
      if (s?.tabId) this.hooks.onFocusTab(s.tabId)
    })
    this.stage.addEventListener('dblclick', (e) => {
      if (this.isChrome(e.target)) return
      const t = this.targetAt(e.target)
      if (t?.kind === 'node') this.flyTo(t.id)
      else if (!t) this.fit(true)
    })
    this.stage.addEventListener(
      'wheel',
      (e) => {
        if (this.isChrome(e.target)) return
        e.preventDefault()
        this.stopAnim()
        const r = this.stage.getBoundingClientRect()
        const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))
        this.zoomAround(e.clientX - r.left, e.clientY - r.top, f)
      },
      { passive: false },
    )
    this.stage.addEventListener('contextmenu', (e) => {
      if (this.isChrome(e.target)) return
      e.preventDefault()
      this.openContextMenu(e.clientX, e.clientY, this.targetAt(e.target))
    })
    new ResizeObserver(() => {
      if (this.el.dataset['mode'] !== 'map') return
      if (!this.fitted) this.fit(false)
      else this.applyView()
    }).observe(this.stage)
  }

  /** The HUD, the card, the strip: things on the stage that are not the map. */
  private isChrome(t: EventTarget | null): boolean {
    return !!(t as HTMLElement | null)?.closest?.('.mhud, .mcard, .mstrip, .mflowbar, .mcaption, .mtimeline, .mlegend, .mpast, .mbuilding, .mlive-chip')
  }

  private targetAt(t: EventTarget | null): Target | null {
    const x = (t as Element | null)?.closest?.('[data-kind]') as HTMLElement | SVGElement | null
    if (!x) return null
    const kind = x.dataset['kind'] as 'node' | 'edge'
    const id = x.dataset['id']
    if (!id) return null
    // A ghost is only an outline; there is nothing behind it to open.
    if (kind === 'node' && this.layout?.boxes.get(id)?.ghost) return null
    return { kind, id }
  }

  private zoomAround(mx: number, my: number, f: number): void {
    const k = Math.min(5, Math.max(0.02, this.k * f))
    const wx = (mx - this.tx) / this.k
    const wy = (my - this.ty) / this.k
    this.k = k
    this.tx = mx - wx * k
    this.ty = my - wy * k
    this.applyView()
  }

  private viewFor(x: number, y: number, w: number, h: number, margin = 70): { k: number; tx: number; ty: number } {
    const vw = Math.max(100, this.stage.clientWidth)
    const vh = Math.max(100, this.stage.clientHeight)
    // The HUD takes the top and the strip the bottom; fit into what is left.
    const top = 76
    const bottom = 60
    const k = Math.min(2.2, Math.max(0.02, Math.min((vw - margin * 2) / w, (vh - top - bottom - margin) / h)))
    return { k, tx: (vw - w * k) / 2 - x * k, ty: top + (vh - top - bottom - h * k) / 2 - y * k }
  }

  fit(animate: boolean): void {
    const L = this.layout
    if (!L || !this.stage.clientWidth) return
    this.fitted = true
    this.animateTo(this.viewFor(0, 0, L.w, L.h, 24), animate)
  }

  private flyTo(id: string): void {
    const b = this.layout?.boxes.get(id)
    if (!b) return
    const pad = b.kids.length ? 20 : Math.max(b.w, b.h) * 1.1
    this.animateTo(this.viewFor(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2), true)
  }

  private flyToAll(ids: string[]): void {
    const L = this.layout
    if (!L) return
    const boxes = ids.map((id) => L.boxes.get(id)).filter((b): b is LBox => !!b)
    if (!boxes.length) return
    const x = Math.min(...boxes.map((b) => b.x))
    const y = Math.min(...boxes.map((b) => b.y))
    const r = Math.max(...boxes.map((b) => b.x + b.w))
    const btm = Math.max(...boxes.map((b) => b.y + b.h))
    const pad = 80
    this.animateTo(this.viewFor(x - pad, y - pad, r - x + pad * 2, btm - y + pad * 2), true)
  }

  private stopAnim(): void {
    if (this.anim !== null) cancelAnimationFrame(this.anim)
    this.anim = null
  }

  private animateTo(v: { k: number; tx: number; ty: number }, animate: boolean): void {
    this.stopAnim()
    if (!animate) {
      this.k = v.k
      this.tx = v.tx
      this.ty = v.ty
      this.applyView()
      return
    }
    const from = { k: this.k, tx: this.tx, ty: this.ty }
    const t0 = performance.now()
    const dur = 560
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur)
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      this.k = Math.exp(Math.log(from.k) + (Math.log(v.k) - Math.log(from.k)) * e)
      this.tx = from.tx + (v.tx - from.tx) * e
      this.ty = from.ty + (v.ty - from.ty) * e
      this.applyView()
      this.anim = t < 1 ? requestAnimationFrame(step) : null
    }
    this.anim = requestAnimationFrame(step)
  }

  private scheduleCrumbs(): void {
    if (this.crumbTimer !== null) return
    this.crumbTimer = window.setTimeout(() => {
      this.crumbTimer = null
      this.renderCrumbs()
    }, 160)
  }

  /** Where the middle of the screen is, as a path: Whole project › Area › Repo. */
  private renderCrumbs(): void {
    const L = this.layout
    this.crumbsEl.replaceChildren()
    if (!L) return
    const cx = (this.stage.clientWidth / 2 - this.tx) / this.k
    const cy = (this.stage.clientHeight / 2 - this.ty) / this.k
    let deepest: LBox | null = null
    for (const id of L.order) {
      const b = L.boxes.get(id)!
      if (!b.kids.length || !this.isOpen(b)) continue
      if (this.nodeEls.get(id)?.classList.contains('is-hidden')) continue
      if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) deepest = b
    }
    const chain: LBox[] = []
    for (let p: LBox | null = deepest; p; p = p.parent ? (L.boxes.get(p.parent) ?? null) : null) chain.unshift(p)
    const all = el('button', 'mcrumb', 'Whole project')
    all.addEventListener('click', () => this.fit(true))
    this.crumbsEl.append(all)
    for (const b of chain) {
      this.crumbsEl.append(el('span', 'mcrumb-sep', '›'))
      const c = el('button', 'mcrumb', b.node.name)
      c.addEventListener('click', () => this.flyTo(b.id))
      this.crumbsEl.append(c)
    }
  }

  private onKey(e: KeyboardEvent): void {
    const mode = this.el.dataset['mode']
    if (mode === 'list') {
      if (e.key === 'Escape' && this.hooks.onClose) {
        e.stopPropagation()
        this.hooks.onClose()
      }
      return
    }
    if (mode !== 'map') return
    const typing = (e.target as HTMLElement).closest('input, textarea')
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (this.menu) this.closeMenu()
      else if (typing) this.stage.focus()
      else if (this.card) this.select(null)
      else if (this.replay) this.stopReplay()
      else if (this.flow) this.stopFlow()
      else if (this.blast) this.clearBlast()
      else if (this.past !== null) {
        this.timeline.classList.remove('is-on')
        this.timeBtn.classList.remove('is-on')
        void this.backToNow()
      } else if (this.legend.classList.contains('is-on')) this.legend.classList.remove('is-on')
      else void this.showList()
      return
    }
    if (typing) return
    if (e.key === 'f' || e.key === 'F') this.fit(true)
    else if (e.key === '/') {
      e.preventDefault()
      this.searchEl.focus()
    } else if (e.key === 'l' || e.key === 'L') this.legend.classList.toggle('is-on')
    else if (e.key === '+' || e.key === '=') this.zoomAround(this.stage.clientWidth / 2, this.stage.clientHeight / 2, 1.3)
    else if (e.key === '-') this.zoomAround(this.stage.clientWidth / 2, this.stage.clientHeight / 2, 1 / 1.3)
    else if (this.flow && e.key === 'ArrowRight') this.flowGo(this.flow.step + 1, false)
    else if (this.flow && e.key === 'ArrowLeft') this.flowGo(this.flow.step - 1, false)
  }

  // =========================================================================
  // the card: everything about one part or one connection, beside it
  // =========================================================================

  private select(t: Target | null): void {
    const same = t && this.selected && t.kind === this.selected.kind && t.id === this.selected.id
    this.selected = t
    this.decorate()
    if (!t) return this.closeCard()
    if (same && this.card) return
    this.openCard()
  }

  private closeCard(): void {
    if (this.pending) {
      window.ember.map.cancelAsk(this.pending.askId)
      this.pending = null
    }
    this.card?.remove()
    this.card = null
    this.leader.setAttribute('d', '')
  }

  /** Live activity changed: redraw the card, unless an answer is on its way or something is being typed. */
  private refreshCard(): void {
    if (!this.card || !this.selected || this.pending || this.card.querySelector('.mcard-input')) return
    const body = this.card.querySelector('.mcard-body') as HTMLElement | null
    const scroll = body?.scrollTop ?? 0
    this.openCard()
    const nb = this.card?.querySelector('.mcard-body') as HTMLElement | null
    if (nb) nb.scrollTop = scroll
  }

  private openCard(): void {
    this.closeCard()
    const t = this.selected
    const model = this.model
    if (!t || !model) return
    const card = el('div', 'mcard')
    card.addEventListener('click', (e) => this.onLinkClick(e))
    if (t.kind === 'node') {
      const n = model.nodes.find((x) => x.id === t.id)
      if (!n) return
      this.fillNodeCard(card, n)
    } else {
      const e = model.edges.find((x) => x.id === t.id)
      if (!e) return
      this.fillEdgeCard(card, e)
    }
    this.stage.append(card)
    this.card = card
    this.placeCard()
  }

  private fillNodeCard(card: HTMLElement, n: MapNode): void {
    const model = this.model!
    const byId = new Map(model.nodes.map((x) => [x.id, x]))
    const box = this.layout?.boxes.get(n.id)
    card.style.setProperty('--hue', AREA_HUES[(box?.area ?? 0) % AREA_HUES.length]!)

    const head = el('div', 'mcard-head')
    const trail: MapNode[] = []
    for (let p = n.parent ? byId.get(n.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) trail.unshift(p)
    const x = el('button', 'mcard-x')
    x.innerHTML = ICON.close
    x.title = 'Close  (Esc)'
    x.addEventListener('click', () => this.select(null))
    head.append(x)
    if (trail.length) {
      const crumbs = el('div', 'mcard-crumbs')
      trail.forEach((p, i) => {
        const c = el('button', 'mlink', p.name)
        c.addEventListener('click', () => {
          this.select({ kind: 'node', id: p.id })
          this.flyTo(p.id)
        })
        crumbs.append(c)
        if (i < trail.length - 1) crumbs.append(el('span', undefined, ' › '))
      })
      head.append(crumbs)
    }
    const kind = el('div', 'mcard-kind')
    const g = el('span', `mcard-glyph k-${n.kind}`)
    g.innerHTML = KIND_GLYPH[n.kind] ?? ''
    kind.append(g, el('span', undefined, KIND_WORD[n.kind] ?? n.kind))
    if (n.deploy) kind.append(el('span', 'mcard-deploy', n.deploy))
    head.append(kind, el('h3', 'mcard-title', n.name))
    if (n.status) {
      const st = el('div', `mcard-health s-${n.status}`)
      st.textContent = `${{ ok: 'Healthy', warn: 'Needs attention', down: 'Down', unknown: 'Health unknown' }[n.status]}${n.statusNote ? ` — ${n.statusNote}` : ''}`
      head.append(st)
    }

    const body = el('div', 'mcard-body')
    // live, first: it is the one thing on the card that is about right now
    const allMarks = [...this.liveByNode.entries()].filter(([id]) => id === n.id || this.isAncestor(n.id, id)).flatMap(([, m]) => m)
    if (allMarks.length) {
      const sec = this.section(body, 'An agent is working here', undefined, 'is-live')
      const seen = new Set<string>()
      for (const m of allMarks.sort((a, b) => b.at - a.at)) {
        if (seen.has(m.session.sessionId)) continue
        seen.add(m.session.sessionId)
        const row = el('button', 'mcard-live')
        row.style.setProperty('--c', this.sessionHue(m.session))
        const top = el('div', 'mcard-live-top')
        top.append(el('span', 'mlive-dot'), el('strong', undefined, this.sessionName(m.session)), el('span', 'mcard-live-what', `${m.mode === 'edit' ? 'editing' : m.mode === 'commit' ? 'committed' : 'reading'} ${m.file} · ${ago(m.at)}`))
        row.append(top)
        if (m.session.lastText) row.append(el('div', 'mcard-live-said', m.session.lastText))
        row.title = m.session.tabId ? 'Go to this session' : 'Running outside Ember'
        row.addEventListener('click', () => m.session.tabId && this.hooks.onFocusTab(m.session.tabId))
        sec.append(row)
      }
    }

    body.append(el('p', 'mcard-summary', n.summary))
    if (n.tech?.length) {
      const chips = el('div', 'mcard-chips')
      for (const t of n.tech) chips.append(el('span', 'mchip', t))
      body.append(chips)
    }

    const hist = (this.bundle?.changes ?? []).filter((c) => c.touched.includes(n.id) && c.kind !== 'build').slice(-4).reverse()
    if (hist.length) {
      const sec = this.section(body, this.newIds.has(n.id) ? 'New since you looked' : 'Recent changes')
      for (const c of hist) {
        const own = c.items.filter((i) => i.node === n.id)
        const row = el('div', `mcard-hist${Date.parse(c.at) > this.seenAt ? ' is-fresh' : ''}`)
        row.append(el('span', 'mcard-when', ago(c.at)), el('span', undefined, own.map((i) => i.text).join(' ') || c.summary))
        sec.append(row)
      }
    }

    if (n.notes?.length) {
      const groups = new Map<string, NonNullable<MapNode['notes']>>()
      for (const x of n.notes) groups.set(x.type, [...(groups.get(x.type) ?? []), x])
      for (const [type, items] of groups) {
        const sec = this.section(body, NOTE_WORD[type] ?? type, NOTE_GLYPH[type], `t-${type}`)
        for (const it of items) {
          const row = el('div', 'mcard-note')
          if (it.url) {
            const a = el('button', 'mlink', it.text)
            a.addEventListener('click', () => this.hooks.onOpenUrl(it.url!))
            row.append(a)
          } else row.textContent = it.text
          sec.append(row)
        }
      }
    }

    const out = model.edges.filter((e) => e.from === n.id)
    const inn = model.edges.filter((e) => e.to === n.id)
    if (out.length || inn.length) {
      const sec = this.section(body, 'Connections')
      const row = (label: string, other: MapNode | undefined, edge: MapEdge) => {
        if (!other) return
        const b = el('button', 'mcard-conn')
        b.append(el('span', 'mcard-conn-dir', label), el('strong', undefined, other.name), el('span', 'mcard-conn-l', edge.label ? ` · ${edge.label}` : ''))
        b.addEventListener('mouseenter', () => {
          this.lit = new Set([other.id])
          this.decorate()
        })
        b.addEventListener('mouseleave', () => {
          this.lit.clear()
          this.decorate()
        })
        b.addEventListener('click', () => {
          this.lit.clear()
          this.select({ kind: 'edge', id: edge.id })
        })
        sec.append(b)
      }
      for (const e of out) row('uses →', byId.get(e.to), e)
      for (const e of inn) row('← used by', byId.get(e.from), e)
    }

    const kids = model.nodes.filter((x) => x.parent === n.id)
    if (kids.length) {
      const sec = this.section(body, `Parts (${kids.length})`)
      const wrap = el('div', 'mcard-parts')
      for (const k of kids) {
        const b = el('button', 'mcard-part')
        if (k.status) b.dataset['status'] = k.status
        b.innerHTML = `<span class="mcard-part-g k-${k.kind}">${KIND_GLYPH[k.kind] ?? ''}</span>`
        b.append(el('span', undefined, k.name))
        b.title = k.summary
        b.addEventListener('click', () => {
          this.select({ kind: 'node', id: k.id })
          this.flyTo(k.id)
        })
        wrap.append(b)
      }
      sec.append(wrap)
    }

    const flows = (model.flows ?? []).filter((f) => f.steps.some((s) => s.node === n.id))
    if (flows.length) {
      const sec = this.section(body, 'Flows through it')
      for (const f of flows) {
        const b = el('button', 'mcard-flow')
        b.innerHTML = ICON.flow
        b.append(el('span', undefined, f.name))
        b.title = f.summary
        b.addEventListener('click', () => this.startFlow(f, Math.max(0, f.steps.findIndex((s) => s.node === n.id))))
        sec.append(b)
      }
    }

    if (n.details) {
      const det = el('details', 'mcard-details')
      const d = el('div', 'mmd')
      d.innerHTML = md(n.details)
      det.append(el('summary', undefined, 'How it works'), d)
      body.append(det)
    }
    if (n.sources?.length) {
      const sec = this.section(body, 'Sources')
      for (const s of n.sources) {
        const a = el('button', 'mcard-src')
        a.innerHTML = ICON.link
        a.append(el('span', undefined, s.label))
        a.title = s.url ?? s.path ?? ''
        a.addEventListener('click', () => (s.url ? this.hooks.onOpenUrl(s.url) : s.path && this.hooks.onRevealPath(s.path)))
        sec.append(a)
      }
    }

    const acts = el('div', 'mcard-acts')
    const ask = iconBtn(ICON.ask, 'Ask', 'mbtn is-accent')
    ask.addEventListener('click', () => this.openAsk(card))
    const change = iconBtn(ICON.change, 'Change it')
    change.addEventListener('click', () => this.openChange(card))
    const blast = iconBtn(ICON.blast, 'If it goes down', 'mbtn')
    blast.title = 'What breaks if it goes down'
    blast.addEventListener('click', () => this.showBlast(n.id))
    acts.append(ask, change, blast)
    const where = this.pathFor(n)
    if (where) {
      const sh = iconBtn(ICON.shell, 'Shell here', 'mbtn is-icon')
      sh.addEventListener('click', () => this.hooks.onShell(where))
      acts.append(sh)
    }
    card.append(head, body, this.threadFor(`node:${n.id}`), acts)
  }

  private fillEdgeCard(card: HTMLElement, e: MapEdge): void {
    const model = this.model!
    const byId = new Map(model.nodes.map((x) => [x.id, x]))
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    card.classList.add('is-edge')
    const head = el('div', 'mcard-head')
    const x = el('button', 'mcard-x')
    x.innerHTML = ICON.close
    x.addEventListener('click', () => this.select(null))
    const kind = el('div', 'mcard-kind')
    kind.append(el('span', undefined, 'connection'))
    if (e.protocol) kind.append(el('span', 'mcard-deploy', e.protocol))
    const ends = el('div', 'mcard-ends')
    const end = (n: MapNode | undefined) => {
      const btn = el('button', 'mcard-end')
      if (!n) return btn
      btn.innerHTML = `<span class="mcard-part-g k-${n.kind}">${KIND_GLYPH[n.kind] ?? ''}</span>`
      btn.append(el('span', undefined, n.name))
      btn.addEventListener('click', () => {
        this.select({ kind: 'node', id: n.id })
        this.flyTo(n.id)
      })
      return btn
    }
    ends.append(end(a), el('span', 'mcard-ends-arrow', e.label ? `${e.label} →` : '→'), end(b))
    head.append(x, kind, ends)
    const body = el('div', 'mcard-body')
    body.append(el('p', 'mcard-summary', e.detail || `${a?.name ?? e.from} ${e.label ?? 'uses'} ${b?.name ?? e.to}.`))
    const flows = (model.flows ?? []).filter((f) =>
      f.steps.some((s, i) => {
        const nx = f.steps[i + 1]?.node
        return (s.node === e.from && nx === e.to) || (s.node === e.to && nx === e.from)
      }),
    )
    if (flows.length) {
      const sec = this.section(body, 'Flows along it')
      for (const f of flows) {
        const btn = el('button', 'mcard-flow')
        btn.innerHTML = ICON.flow
        btn.append(el('span', undefined, f.name))
        btn.addEventListener('click', () => this.startFlow(f))
        sec.append(btn)
      }
    }
    if (e.sources?.length) {
      const sec = this.section(body, 'Where it is wired')
      for (const s of e.sources) {
        const btn = el('button', 'mcard-src')
        btn.innerHTML = ICON.link
        btn.append(el('span', undefined, s.label))
        btn.title = s.url ?? s.path ?? ''
        btn.addEventListener('click', () => (s.url ? this.hooks.onOpenUrl(s.url) : s.path && this.hooks.onRevealPath(s.path)))
        sec.append(btn)
      }
    }
    const acts = el('div', 'mcard-acts')
    const ask = iconBtn(ICON.ask, 'Ask about this connection', 'mbtn is-accent')
    ask.addEventListener('click', () => this.openAsk(card))
    acts.append(ask)
    card.append(head, body, this.threadFor(`edge:${e.id}`), acts)
  }

  private threadFor(key: string): HTMLElement {
    const thread = el('div', 'mcard-thread')
    for (const h of this.askHistory.get(key) ?? []) {
      const a = el('div', 'mcard-a mmd')
      a.innerHTML = md(h.a)
      thread.append(el('div', 'mcard-q', h.q), a)
    }
    return thread
  }

  private section(body: HTMLElement, title: string, glyph?: string, cls = ''): HTMLElement {
    const sec = el('div', `mcard-sec ${cls}`)
    const h = el('div', 'mcard-sec-h')
    if (glyph) h.innerHTML = glyph
    h.append(el('span', undefined, title))
    sec.append(h)
    body.append(sec)
    return sec
  }

  /** Beside the target, on whichever side has room, with a leader line to it. */
  private placeCard(): void {
    const card = this.card
    const t = this.selected
    const L = this.layout
    if (!card || !t || !L) return
    let rect: { x: number; y: number; w: number; h: number }
    if (t.kind === 'node') {
      const b = this.rep(t.id) ?? L.boxes.get(t.id)
      if (!b) return
      rect = { x: b.x * this.k + this.tx, y: b.y * this.k + this.ty, w: b.w * this.k, h: b.h * this.k }
    } else {
      const ee = this.edgeEls.get(t.id)
      if (!ee?.pts.length) return
      const [lx, ly] = labelPoint(ee.pts)
      rect = { x: lx * this.k + this.tx - 4, y: ly * this.k + this.ty - 4, w: 8, h: 8 }
    }
    const vw = this.stage.clientWidth
    const vh = this.stage.clientHeight
    const cw = card.offsetWidth
    const ch = card.offsetHeight
    const gap = 40
    // A container fills much of the screen once open: then the card sits at the right edge.
    const vis = { x: Math.max(0, rect.x), r: Math.min(vw, rect.x + rect.w) }
    let x: number
    let anchorX: number
    let edgeX: number
    if (vis.r + gap + cw < vw - 14) {
      x = vis.r + gap
      anchorX = vis.r
      edgeX = x
    } else if (vis.x - gap - cw > 14) {
      x = vis.x - gap - cw
      anchorX = vis.x
      edgeX = x + cw
    } else {
      x = vw - cw - 14
      anchorX = Math.min(vis.r, x - 10)
      edgeX = x
    }
    const midY = Math.max(0, rect.y) / 2 + Math.min(vh, rect.y + rect.h) / 2
    const y = Math.max(70, Math.min(midY - Math.min(ch / 2, 110), vh - ch - 66))
    card.style.left = `${x}px`
    card.style.top = `${y}px`
    const anchorY = Math.max(rect.y + 8, Math.min(midY, rect.y + rect.h - 8))
    const cardY = Math.max(y + 22, Math.min(anchorY, y + ch - 22))
    const onScreen = anchorX > -10 && anchorX < vw + 10 && anchorY > 0 && anchorY < vh
    this.leader.setAttribute('d', onScreen ? `M${anchorX},${anchorY} C${(anchorX + edgeX) / 2},${anchorY} ${(anchorX + edgeX) / 2},${cardY} ${edgeX},${cardY}` : '')
  }

  private openAsk(card: HTMLElement, question?: string): void {
    const t = this.selected
    const b = this.bundle
    if (!t || !b?.model) return
    card.querySelector('.mcard-input')?.remove()
    const key = `${t.kind}:${t.id}`
    const history = this.askHistory.get(key) ?? []
    this.askHistory.set(key, history)
    const thread = card.querySelector('.mcard-thread') as HTMLElement
    const row = el('div', 'mcard-input')
    const box = el('textarea')
    box.rows = 2
    box.placeholder = 'Ask anything about it — how it works, what changed, what would break…'
    const go = el('button', 'mbtn is-accent', 'Ask')
    row.append(box, go)
    card.querySelector('.mcard-acts')?.before(row)
    const submit = () => {
      const q = box.value.trim()
      if (!q || this.pending) return
      box.value = ''
      const out = el('div', 'mcard-a is-thinking')
      out.append(el('span', 'mspin'), el('span', 'mcard-progress', 'Thinking…'))
      thread.append(el('div', 'mcard-q', q), out)
      thread.scrollTop = thread.scrollHeight
      const askId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      go.disabled = true
      this.pending = { askId, out, q, history, go }
      let full = history.length ? `${history.map((h) => `Earlier he asked: ${h.q}\nYou answered: ${h.a}`).join('\n\n')}\n\nNow: ${q}` : q
      let nodeId: string | null = t.id
      if (t.kind === 'edge') {
        const e = b.model!.edges.find((x) => x.id === t.id)
        nodeId = e?.from ?? null
        const other = b.model!.nodes.find((n) => n.id === e?.to)
        full = `About the connection from this part to ${other?.name ?? e?.to} (${e?.label ?? ''}${e?.protocol ? `, ${e.protocol}` : ''}${e?.detail ? `: ${e.detail}` : ''}). ${full}`
      }
      window.ember.map.ask(b.project.id, nodeId, full, askId)
      this.placeCard()
    }
    go.addEventListener('click', submit)
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        row.remove()
        this.stage.focus()
      }
    })
    box.focus()
    this.placeCard()
    if (question) {
      box.value = question
      submit()
    }
  }

  private openChange(card: HTMLElement): void {
    const t = this.selected
    const b = this.bundle
    if (!t || t.kind !== 'node' || !b?.model) return
    const n = b.model.nodes.find((x) => x.id === t.id)
    if (!n) return
    card.querySelector('.mcard-input')?.remove()
    const row = el('div', 'mcard-input is-change')
    const box = el('textarea')
    box.rows = 3
    box.placeholder = `What should change in ${n.name}? A new agent session opens in its folder, briefed with this and what the map knows about it.`
    const go = el('button', 'mbtn is-accent', 'Open a session')
    row.append(box, go)
    card.querySelector('.mcard-acts')?.before(row)
    const submit = () => {
      const q = box.value.trim()
      if (!q) return
      const ctx = `The part, as the architecture map describes it: ${n.name} (${n.kind}) — ${n.summary}${n.details ? `\n\n${n.details.slice(0, 1500)}` : ''}`
      const brief = `In the project "${b.project.name}", I want this change to ${n.name}: ${q}\n\n${ctx}\n\nWork it through. If it needs a decision only I can make, stop and ask.`
      this.hooks.onChange(brief, this.pathFor(n), `${n.name}: ${q}`.slice(0, 40))
      row.remove()
      this.showCaption(`A session is starting on ${n.name}. It lights up here as it works.`, 6000)
    }
    go.addEventListener('click', submit)
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        row.remove()
      }
    })
    box.focus()
    this.placeCard()
  }

  private onAskEvent(e: { askId: string; kind: 'progress' | 'done' | 'error'; text: string }): void {
    const p = this.pending
    if (!p || p.askId !== e.askId) return
    if (e.kind === 'progress') {
      const line = p.out.querySelector('.mcard-progress')
      if (line) line.textContent = e.text
      return
    }
    p.out.classList.remove('is-thinking')
    p.go.disabled = false
    this.pending = null
    if (e.kind === 'error') {
      p.out.classList.add('is-error')
      p.out.textContent = e.text
    } else {
      p.out.classList.add('mmd')
      p.out.innerHTML = md(e.text)
      p.history.push({ q: p.q, a: e.text })
    }
    const thread = p.out.parentElement
    if (thread) thread.scrollTop = thread.scrollHeight
    this.placeCard()
  }

  private onLinkClick(e: MouseEvent): void {
    const a = (e.target as HTMLElement).closest('a[data-href]') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    const href = a.dataset['href']!
    if (/^https?:/.test(href)) this.hooks.onOpenUrl(href)
    else this.hooks.onRevealPath(href)
  }

  private pathFor(n: MapNode): string {
    const byId = new Map((this.model?.nodes ?? []).map((x) => [x.id, x]))
    for (let p: MapNode | undefined = n; p; p = p.parent ? byId.get(p.parent) : undefined) if (p.path) return p.path
    return ''
  }

  // =========================================================================
  // menus
  // =========================================================================

  private closeMenu(): void {
    this.menu?.remove()
    this.menu = null
  }

  private openMenuAt(
    x: number,
    y: number,
    build: (item: (label: string, run: () => void, hint?: string, tip?: string) => void, sep: () => void, title: (t: string) => void) => void,
  ): void {
    this.closeMenu()
    const m = el('div', 'mmenu')
    build(
      (label, run, hint, tip) => {
        const b = el('button', 'mmenu-item')
        b.append(el('span', undefined, label))
        if (hint) b.append(el('span', 'mmenu-hint', hint))
        if (tip) b.title = tip
        b.addEventListener('click', () => {
          this.closeMenu()
          run()
        })
        m.append(b)
      },
      () => m.append(el('div', 'mmenu-sep')),
      (t) => m.append(el('div', 'mmenu-title', t)),
    )
    document.body.append(m)
    this.menu = m
    const r = m.getBoundingClientRect()
    m.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`
    m.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`
    const off = (e: PointerEvent) => {
      if (!m.contains(e.target as Node)) {
        if (this.menu === m) this.closeMenu()
        window.removeEventListener('pointerdown', off, true)
      }
    }
    window.addEventListener('pointerdown', off, true)
  }

  private openContextMenu(x: number, y: number, t: Target | null): void {
    const model = this.model
    if (!model) return
    const node = t?.kind === 'node' ? model.nodes.find((n) => n.id === t.id) : null
    const edge = t?.kind === 'edge' ? model.edges.find((e) => e.id === t.id) : null
    const askNow = (q?: string) => {
      this.select(t)
      if (this.card) this.openAsk(this.card, q)
    }
    this.openMenuAt(x, y, (item, sep, title) => {
      if (node) {
        title(node.name)
        item('Ask about it…', () => askNow())
        item('What does it do, and how?', () => askNow('What does this do, and how does it work? Point me at the key files.'))
        item('What changed here lately?', () => askNow('What changed here recently, and why does it matter?'))
        item('Is it healthy?', () => askNow('Is this healthy right now? Check what you can — deploys, CI, the live endpoint, recent errors.'))
        sep()
        item('What breaks if it goes down', () => this.showBlast(node.id))
        for (const f of (model.flows ?? []).filter((f) => f.steps.some((s) => s.node === node.id)).slice(0, 3)) item(`Trace “${f.name}”`, () => this.startFlow(f))
        sep()
        item('Change it…', () => {
          this.select(t)
          if (this.card) this.openChange(this.card)
        })
        const where = this.pathFor(node)
        if (where) item('Open a shell here', () => this.hooks.onShell(where))
        item('Zoom to it', () => this.flyTo(node.id), 'double-click')
      } else if (edge) {
        title(edge.label ?? 'Connection')
        item('Ask about this connection…', () => askNow())
        item('What travels along it?', () => askNow('What exactly travels along this connection, how is it wired in code, and what happens when it fails?'))
      } else {
        title(this.bundle?.project.name ?? 'Map')
        item('What changed this week?', () => this.askProject('Summarise what changed in this project over the last 7 days, in terms of the architecture, not the commits.'))
        item('What needs my attention?', () => this.askProject('What in this project needs my attention right now? Broken, stale, risky, blocked — most important first.'))
        item('Where is the work happening?', () => this.askProject('Which parts of this project are being worked on right now or were most recently, and what is the state of that work?'))
        sep()
        if (this.unseenChanges().length) item('Replay what changed since I looked', () => this.startReplay())
        for (const f of (model.flows ?? []).slice(0, 4)) item(`Trace “${f.name}”`, () => this.startFlow(f))
        item('Fit the whole map', () => this.fit(true), 'F')
        item('Refresh from the sources', () => this.bundle && window.ember.map.check(this.bundle.project.id, true))
      }
    })
  }

  /** A question about the whole project: the card anchors to the first top-level area. */
  private askProject(q: string): void {
    const top = this.model?.nodes.find((n) => !n.parent)
    if (!top) return
    this.select({ kind: 'node', id: top.id })
    if (this.card) {
      const title = this.card.querySelector('.mcard-title')
      if (title) title.textContent = `${this.bundle?.project.name ?? ''} — the whole project`
      this.openAsk(this.card, `(About the whole project, not only this area.) ${q}`)
    }
  }

  private openMoreMenu(x: number, y: number): void {
    const b = this.bundle
    if (!b) return
    this.openMenuAt(x, y, (item, sep) => {
      item('Re-survey the whole project', () => window.ember.map.build(b.project.id, true), '', 'Surveys everything again, keeping every part it still finds')
      item('Edit the project', () => this.showForm(b.project.id))
      sep()
      item('Delete this map…', () => {
        window.setTimeout(() =>
          this.openMenuAt(x, y, (i2, _s, t2) => {
            t2(`Delete the map of ${b.project.name}? Its history goes too.`)
            i2('Delete', () => {
              void window.ember.map.remove(b.project.id).then(async () => {
                this.bundle = null
                await this.showList()
              })
            })
            i2('Keep it', () => {})
          }),
        )
      })
    })
  }

  // =========================================================================

  focus(): void {
    const mode = this.el.dataset['mode']
    if (mode === 'map') this.stage.focus()
    else if (mode === 'form') this.fName.focus()
    else (this.rows.querySelector('button') as HTMLButtonElement | null)?.focus()
  }

  /** `map <name>`: open a project by a unique part of its name. */
  async openNamed(q: string): Promise<string> {
    await this.refreshList()
    const want = q.trim().toLowerCase()
    const hits = this.summaries.filter((s) => s.project.name.toLowerCase().includes(want) || s.project.id.includes(want))
    if (!hits.length) throw new Error(`no project matches "${q}"`)
    const exact = hits.find((s) => s.project.name.toLowerCase() === want)
    const hit = exact ?? (hits.length === 1 ? hits[0] : null)
    if (!hit) throw new Error(`"${q}" matches ${hits.map((h) => h.project.name).join(', ')}`)
    await this.openProject(hit.project.id)
    return hit.project.name
  }

  leave(): void {
    if (this.el.dataset['mode'] === 'map' || this.el.dataset['mode'] === 'form') void this.showList()
    else this.hooks.onClose?.()
  }

  dispose(): void {
    this.leaveMap()
    this.disposed = true
    this.stopAnim()
    for (const u of this.unsubs) u()
    this.el.remove()
  }
}

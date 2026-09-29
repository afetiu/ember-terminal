import type { ActivityState, AttentionKind } from '../core/Activity'

/**
 * Cinder, Ember's session sprite: a small ember spirit. A round-bottomed coal
 * with a live flame for hair, two bright eyes and a pair of stick arms, sitting at a
 * key bar.
 *
 * It is drawn on a 19x19 cell grid (2px per cell on a 38px card). Each frame is put
 * together on that grid from small string sprites (body, flame, eyes, arms), then
 * painted as snapped rectangles, one per run of a colour, so it stays hard-edged
 * pixel art at any DPR instead of going soft.
 *
 * The sprite is the *only* thing saying what a session is doing, since the card no
 * longer prints "Working" next to it, so each state has to be legible at 38px from
 * across the room. The flame does most of that work:
 *   working:   tall flickering flame, eyes down on the keys, arms tapping, keys lit
 *   idle:      dimmed coal, low flame, looks around, then dozes off with z's
 *   question:  flared bright flame, wide eyes on you, one hand up
 *   handoff:   steady warm flame, happy eyes, waving and bobbing
 *   exited:    grey ash, no flame, a wisp of smoke
 * Poses are whole-cell changes to the grid plus whole-pixel offsets of the sprite;
 * nothing here is a tween.
 */

const GRID = 19

type Sprite = readonly string[]

/**
 * The coal. `b` body, `l` lit edge, `s` shade. Rows 6..15, columns 3..15: a gumdrop
 * that is widest at the face and rounds off underneath, with the top narrowing into
 * the flame.
 */
const BODY: Sprite = [
  '....bbbbb....',
  '..bbbbbbbbb..',
  '.blbbbbbbbbb.',
  '.lbbbbbbbbbbb',
  'blbbbbbbbbbbb',
  'bbbbbbbbbbbbb',
  'bbbbbbbbbbbbs',
  'sbbbbbbbbbbbs',
  '.sbbbbbbbbbs.',
  '...sssssss...',
]
const BODY_X = 3
const BODY_Y = 6

/**
 * Flames, 9 cells wide (columns 5..13), bottom row on grid row 8 so the base tucks
 * behind the top of the coal. `f` flame, `c` hot core. Two frames each; flicker is
 * swapping between them.
 */
const FLAME_TALL: [Sprite, Sprite] = [
  [
    '.....f...',
    '....ff...',
    '....fff..',
    '...ffcf.f',
    '..fffcff.',
    '..fccccf.',
    '.ffcccff.',
    '.fccccff.',
    '.fffffff.',
  ],
  [
    '...f.....',
    '...ff....',
    '..fff....',
    'f.fcff...',
    '.ffcfff..',
    '.fccccf..',
    '.ffcccff.',
    '.ffccccf.',
    '.fffffff.',
  ],
]
const FLAME_FLARE: [Sprite, Sprite] = [
  [
    '....f....',
    'f...ff..f',
    '...fff...',
    '.f.fcf.f.',
    '..ffcff..',
    '.ffcccff.',
    'ffccccff.',
    'fccccccff',
    'ffcccccff',
    '.fffffff.',
  ],
  [
    '....f....',
    'f..ff...f',
    '...fff...',
    '.f.fcf.f.',
    '..ffcff..',
    '.ffcccff.',
    '.ffccccff',
    'ffccccccf',
    'ffcccccff',
    '.fffffff.',
  ],
]
const FLAME_MID: [Sprite, Sprite] = [
  [
    '....f....',
    '....ff...',
    '...fcf...',
    '...fccf..',
    '..fcccf..',
    '.fffffff.',
    '.fffffff.',
  ],
  [
    '....f....',
    '...ff....',
    '...fcf...',
    '..fccf...',
    '..fcccf..',
    '.fffffff.',
    '.fffffff.',
  ],
]
// The coal's crown covers rows 6..8, so only the top two rows of these show.
const FLAME_LOW: [Sprite, Sprite] = [
  ['....f....', '...fcf...', '...fff...', '...fff...', '..fffff..'],
  ['...f.....', '...fcf...', '...fff...', '...fff...', '..fffff..'],
]
/** What is left of the flame while it dozes: a glow on the crown. */
const FLAME_EMBER: Sprite = ['...fcf...', '...fff...', '...fff...', '..fffff..']
const FLAME_X = 5
const FLAME_BASE = 8

/** A small Z, drifting up and away from a dozing coal. */
const ZED: Sprite = ['zzzz', '..z.', '.z..', 'zzzz']

interface Palette {
  /** body, lit edge, shade */
  b: string
  l: string
  s: string
  /** flame, flame core */
  f: string
  c: string
}

const PALETTE: Record<ActivityState, Palette> = {
  working: { b: '#FF7A33', l: '#FFB066', s: '#C4461F', f: '#FFA629', c: '#FFE58A' },
  // Duller than working on purpose: a resting session should look like it has
  // banked down a little, not like it is mid-thought.
  idle: { b: '#C0582C', l: '#DB7B45', s: '#7F3320', f: '#D9722B', c: '#F2A64A' },
  attention: { b: '#FF8A3D', l: '#FFCB8C', s: '#D1522A', f: '#FFC23D', c: '#FFF6CF' },
  exited: { b: '#6E625E', l: '#877B76', s: '#4C4341', f: '#6E625E', c: '#877B76' },
}
/** A finished turn is not an alarm: normal body, steady flame, calm glow. */
const HANDOFF_PALETTE: Palette = { b: '#FF8440', l: '#FFB877', s: '#C94C24', f: '#FFAE45', c: '#FFE7A6' }
const OK_BODY = { b: '#7BE3A8', l: '#B8F4D2', s: '#3FAF74' }
const FAIL_BODY = { b: '#FF6B6B', l: '#FFA0A0', s: '#C23B4A' }
const EYE_INK = '#2A1432'
const ASH_INK = '#3A3236'
const GLINT = '#FFF3E0'

/** What the mascot is being asked to portray. */
export interface MascotMood {
  state: ActivityState
  attention: AttentionKind | null
}

/** A short-lived response to the command that just finished. */
export interface Reaction {
  kind: 'ok' | 'fail'
  /** Seconds since it fired; reactions fade out after REACTION_S. */
  age: number
}

export const REACTION_S = 1.6

export function drawMascot(
  ctx: CanvasRenderingContext2D,
  size: number,
  mood: MascotMood,
  t: number,
  seed: number,
  reaction: Reaction | null = null,
): void {
  ctx.clearRect(0, 0, size, size)

  const { state } = mood
  const wanted = state === 'attention'
  const urgent = wanted && mood.attention !== 'handoff'
  const handoff = wanted && !urgent
  const still = state === 'exited'
  const live = reaction && reaction.age < REACTION_S ? reaction : null
  const cheer = live?.kind === 'ok'
  const wince = live?.kind === 'fail'

  const cell = size / GRID
  const snap = (v: number) => Math.round(v)
  // Whole-pixel offsets keep the pixel-art feel; smooth sub-pixel drift would read as
  // a blurry vector sprite instead.
  const unit = Math.max(1, Math.round(cell / 2))

  // ---- the frame, composed on the grid ---------------------------------------
  const grid: string[][] = Array.from({ length: GRID }, () => new Array<string>(GRID).fill('.'))
  const put = (x: number, y: number, ch: string) => {
    if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = ch
  }
  const stamp = (sprite: Sprite, x: number, y: number) => {
    sprite.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) if (row[c] !== '.') put(x + c, y + r, row[c])
    })
  }

  // Idle sessions doze: every few seconds the flame banks down to a glow, the eyes
  // close and the coal settles onto the bar, then it wakes. Offset by seed so a
  // column of idle cards never nods off in unison.
  const dozePhase = (t * 0.09 + seed * 0.41) % 1
  const dozing = state === 'idle' && dozePhase > 0.62

  // Flicker: which of the two flame frames is showing. Faster the busier it is.
  const flick = (rate: number) => (Math.floor(t * rate + seed * 0.7) % 2 === 0 ? 0 : 1)
  let flame: Sprite | null = null
  if (still) flame = null
  else if (cheer && live && live.age < REACTION_S * 0.6) flame = FLAME_FLARE[flick(10)]
  else if (urgent) flame = FLAME_FLARE[flick(8)]
  else if (handoff) flame = FLAME_MID[flick(3)]
  else if (state === 'working') flame = FLAME_TALL[flick(9)]
  else if (dozing) flame = FLAME_EMBER
  else flame = FLAME_LOW[flick(1.6)]
  if (flame) stamp(flame, FLAME_X, FLAME_BASE - flame.length + 1)

  stamp(BODY, BODY_X, BODY_Y)

  // Eyes. Left eye starts at column 6, right at column 11.
  /** Paint cells from flat x, y pairs. */
  const dots = (ch: string, ...xy: number[]) => {
    for (let i = 0; i + 1 < xy.length; i += 2) put(xy[i], xy[i + 1], ch)
  }
  const blink = !still && !wanted && !live && (t * 0.5 + seed * 0.37) % 1 > 0.955
  const eye = (x: number, y: number, h: number) => {
    for (let r = 0; r < h; r++) dots('k', x, y + r, x + 1, y + r)
    put(x, y, 'w')
  }
  const shut = () => dots('k', 6, 11, 7, 11, 11, 11, 12, 11)
  if (still) {
    shut()
  } else if (wince) {
    // Squeezed shut, > <, and a flat mouth.
    dots('k', 6, 9, 7, 10, 6, 11, 12, 9, 11, 10, 12, 11)
    dots('k', 8, 13, 9, 13, 10, 13)
  } else if (cheer || handoff) {
    // Happy ^ ^ eyes and a small smile.
    dots('k', 5, 11, 6, 10, 7, 11, 11, 11, 12, 10, 13, 11)
    dots('k', 8, 13, 9, 14, 10, 13)
  } else if (blink || dozing) {
    shut()
  } else if (urgent) {
    // Wide open and looking straight at you, mouth open.
    eye(6, 9, 3)
    eye(11, 9, 3)
    dots('k', 9, 13, 9, 14)
  } else if (state === 'working') {
    // Eyes down on the keys.
    eye(6, 11, 2)
    eye(11, 11, 2)
  } else {
    // Bored: looking around, a column at a time.
    const g = Math.sin(t * 0.35 + seed * 2.1)
    const glance = g > 0.5 ? 1 : g < -0.5 ? -1 : 0
    eye(6 + glance, 10, 2)
    eye(11 + glance, 10, 2)
  }

  // Hands. Paws in front on the keys while typing; a stick arm in the shade colour,
  // with a hand on the end, when it has something to tell you.
  if (state === 'working' && !live) {
    // Tapping in alternation, which is what reads as busy.
    const tap = Math.sin(t * 12 + seed) > 0
    const left = tap ? 15 : 16
    const right = tap ? 16 : 15
    dots('h', 5, left, 6, left, 12, right, 13, right)
  } else if (urgent) {
    // A hand held up and still, like a raised hand in a room.
    dots('a', 16, 11, 17, 10, 17, 9, 17, 8, 17, 7)
    dots('b', 17, 5, 18, 5, 17, 6, 18, 6)
  } else if (handoff) {
    // Waving: the hand rocks between upright and tipped out.
    dots('a', 16, 11, 17, 10, 17, 9)
    if (Math.sin(t * 6) > 0) dots('b', 18, 8, 18, 7, 18, 6)
    else {
      dots('a', 17, 8)
      dots('b', 16, 7, 17, 7, 16, 6, 17, 6)
    }
  }

  // Dozing: z's float up off the crown, one at a time.
  if (dozing) {
    const p = (((dozePhase - 0.62) / 0.38) * 2.2) % 1
    stamp(ZED, 14 + Math.floor(p * 2), 5 - Math.floor(p * 5))
  }

  // Working throws the odd spark.
  if (state === 'working' && !live) {
    for (let i = 0; i < 2; i++) {
      const p = (t * 1.1 + i * 0.5 + seed * 0.13) % 1
      if (p > 0.6) continue
      put(i === 0 ? 4 - Math.floor(p * 3) : 14 + Math.floor(p * 3), 3 - Math.floor(p * 6), 'c')
    }
  }

  // A finished session has gone to ash: one wisp of smoke where the flame was.
  if (still) dots('m', 9, 5, 10, 4, 10, 3, 9, 2, 9, 1)

  // ---- motion ---------------------------------------------------------------
  let bob = 0
  if (state === 'idle') bob = dozing ? unit : Math.sin(t * 1.2 + seed) > 0 ? -unit : 0
  else if (state === 'working') bob = Math.sin(t * 5 + seed) > 0 ? -unit : 0
  else if (wanted) {
    // Question: an insistent hop. Handoff: up on its toes and rocking gently, because
    // it is only telling you it is done.
    const speed = urgent ? 7 : 3.2
    const height = urgent ? 2.4 : 1.4
    bob = -Math.round((0.5 + 0.5 * Math.sin(t * speed)) * unit * height) - (urgent ? 0 : unit)
  }
  // A bored session drifts side to side.
  const sway = state === 'idle' && !dozing ? Math.round(Math.sin(t * 0.6 + seed) * unit * 0.6) : 0

  // Reactions ride on top of the resting state: a hop for success, a shudder plus a
  // downward flinch for failure. Both decay so the card returns to normal.
  let shake = 0
  if (reaction) {
    const decay = Math.max(0, 1 - reaction.age / REACTION_S)
    if (reaction.kind === 'ok') {
      bob -= Math.round(Math.abs(Math.sin(reaction.age * 9)) * unit * 2.2 * decay)
    } else {
      bob += Math.round(unit * 1.2 * decay)
      shake = Math.round(Math.sin(reaction.age * 34) * unit * decay)
    }
  }
  const dx = sway + shake

  // ---- paint ----------------------------------------------------------------
  // The glow goes down before the sprite does. Painted on top it washes the face out,
  // and at 38px that costs the eyes, which is most of what the pose is.
  if (wanted) {
    const gx = size * 0.5
    const gy = cell * 9 + bob
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, size * 0.46)
    glow.addColorStop(0, urgent ? 'rgba(255, 199, 87, 0.85)' : 'rgba(124, 231, 196, 0.62)')
    glow.addColorStop(1, urgent ? 'rgba(255, 199, 87, 0)' : 'rgba(124, 231, 196, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, size, size)
  }

  const pal = { ...(handoff ? HANDOFF_PALETTE : PALETTE[state]) }
  if (cheer) Object.assign(pal, OK_BODY)
  else if (wince) Object.assign(pal, FAIL_BODY)
  const colour: Record<string, string> = {
    b: pal.b,
    l: pal.l,
    s: pal.s,
    a: pal.s,
    h: pal.l,
    f: pal.f,
    c: pal.c,
    k: still ? ASH_INK : EYE_INK,
    w: GLINT,
    z: 'rgba(214, 200, 255, 0.8)',
    m: 'rgba(160, 150, 156, 0.55)',
  }

  // Snap both edges, not the position and size separately. Rounding a rect's top and
  // its height independently lets neighbouring runs land on different pixels, which
  // leaves 1px transparent seams through the sprite.
  const rect = (cx: number, cy: number, w: number, h: number, ox: number, oy: number) => {
    const x0 = snap(cx * cell + ox)
    const x1 = snap((cx + w) * cell + ox)
    const y0 = snap(cy * cell + oy)
    const y1 = snap((cy + h) * cell + oy)
    ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0))
  }

  // One rectangle per horizontal run of a colour.
  for (let y = 0; y < GRID; y++) {
    const row = grid[y]
    let x = 0
    while (x < GRID) {
      const ch = row[x]
      let end = x + 1
      while (end < GRID && row[end] === ch) end++
      if (ch !== '.') {
        ctx.fillStyle = colour[ch]
        rect(x, y, end - x, 1, dx, bob)
      }
      x = end
    }
  }

  // ---- key bar ----------------------------------------------------------------
  // A bar it sits at, with keys that light up while typing. Keeps the "coding" read
  // without a laptop big enough to swallow the character at this size. It does not
  // bob with the sprite: it is the floor.
  ctx.fillStyle = still ? '#4A4050' : state === 'working' ? '#7A6A8C' : '#665A78'
  rect(1, 17, 17, 1, 0, 0)
  if (state === 'working') {
    ctx.fillStyle = '#FFD9A8'
    for (let i = 0; i < 4; i++) {
      if (Math.sin(t * 14 + i * 1.9) <= 0.35) continue
      rect(3 + i * 4, 17, 2, 1, 0, 0)
    }
  }

  // No exclamation mark anywhere: the flare, the raised hand, the hop, the glow behind
  // it and the card's own tint already say it. Amber for a question that is blocking,
  // a cooler green for "your turn", which is good news rather than a demand.
}


/**
 * Badge for a notes tab: a page with a folded corner and a few lines of writing.
 *
 * Still, on purpose. The other two badges animate because they report something that
 * changes — a shell working, a Claude waiting on you. A note has no such state, and a
 * page that fidgeted would be claiming one.
 */
export function drawNoteBadge(ctx: CanvasRenderingContext2D, s: number, accent: string): void {
  ctx.clearRect(0, 0, s, s)
  const x = 0.24 * s
  const y = 0.16 * s
  const w = 0.52 * s
  const h = 0.68 * s
  const fold = 0.16 * s
  const r = 0.06 * s

  // The sheet, with the top-right corner cut for the fold.
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - fold, y)
  ctx.lineTo(x + w, y + fold)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
  ctx.strokeStyle = accent
  ctx.lineWidth = 0.05 * s
  ctx.lineJoin = 'round'
  ctx.globalAlpha = 0.85
  ctx.stroke()

  // The fold itself.
  ctx.beginPath()
  ctx.moveTo(x + w - fold, y)
  ctx.lineTo(x + w - fold, y + fold)
  ctx.lineTo(x + w, y + fold)
  ctx.globalAlpha = 0.6
  ctx.stroke()

  // Three lines of writing, the last one short — a page with words on it, not a form.
  ctx.lineCap = 'round'
  ctx.lineWidth = 0.045 * s
  ctx.globalAlpha = 0.7
  const lx = x + 0.12 * s
  for (const [i, len] of [0.28, 0.28, 0.16].entries()) {
    const ly = y + 0.3 * s + i * 0.13 * s
    ctx.beginPath()
    ctx.moveTo(lx, ly)
    ctx.lineTo(lx + len * s, ly)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Badge for the todo list: a ticked box with a line beside it, and an empty one under. */
export function drawTodoBadge(ctx: CanvasRenderingContext2D, s: number, accent: string): void {
  ctx.clearRect(0, 0, s, s)
  ctx.strokeStyle = accent
  ctx.fillStyle = accent
  ctx.lineWidth = 0.05 * s
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const box = (x: number, y: number, ticked: boolean) => {
    const w = 0.2 * s
    ctx.globalAlpha = ticked ? 1 : 0.55
    ctx.beginPath()
    ctx.roundRect(x, y, w, w, 0.04 * s)
    if (ticked) {
      ctx.fill()
      ctx.strokeStyle = '#1a0e2e'
      ctx.beginPath()
      ctx.moveTo(x + w * 0.25, y + w * 0.55)
      ctx.lineTo(x + w * 0.45, y + w * 0.75)
      ctx.lineTo(x + w * 0.78, y + w * 0.3)
      ctx.stroke()
      ctx.strokeStyle = accent
    } else {
      ctx.stroke()
    }
    ctx.globalAlpha = ticked ? 0.9 : 0.5
    ctx.beginPath()
    ctx.moveTo(x + w + 0.1 * s, y + w / 2)
    ctx.lineTo(x + w + 0.42 * s, y + w / 2)
    ctx.stroke()
  }
  box(0.2 * s, 0.24 * s, true)
  box(0.2 * s, 0.56 * s, false)
  ctx.globalAlpha = 1
}

/** Badge for the overview: three rows, each a dot and a line — sessions at a glance. */
export function drawOverviewBadge(ctx: CanvasRenderingContext2D, s: number, accent: string): void {
  ctx.clearRect(0, 0, s, s)
  ctx.strokeStyle = accent
  ctx.fillStyle = accent
  ctx.lineWidth = 0.06 * s
  ctx.lineCap = 'round'
  const rows = [
    { y: 0.26, alpha: 1, len: 0.42 },
    { y: 0.5, alpha: 0.7, len: 0.34 },
    { y: 0.74, alpha: 0.45, len: 0.38 },
  ]
  for (const r of rows) {
    ctx.globalAlpha = r.alpha
    ctx.beginPath()
    ctx.arc(0.26 * s, r.y * s, 0.06 * s, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(0.4 * s, r.y * s)
    ctx.lineTo((0.4 + r.len) * s, r.y * s)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Badge for the architecture map: three boxes joined by lines, one of them larger. */
export function drawMapBadge(ctx: CanvasRenderingContext2D, s: number, accent: string): void {
  ctx.clearRect(0, 0, s, s)
  ctx.strokeStyle = accent
  ctx.fillStyle = accent
  ctx.lineWidth = 0.05 * s
  ctx.lineJoin = 'round'
  ctx.globalAlpha = 0.55
  ctx.beginPath()
  ctx.moveTo(0.38 * s, 0.29 * s)
  ctx.lineTo(0.62 * s, 0.29 * s)
  ctx.moveTo(0.28 * s, 0.4 * s)
  ctx.lineTo(0.4 * s, 0.6 * s)
  ctx.stroke()
  ctx.globalAlpha = 1
  const box = (x: number, y: number, w: number, h: number) => {
    ctx.beginPath()
    ctx.roundRect(x * s, y * s, w * s, h * s, 0.05 * s)
    ctx.stroke()
  }
  box(0.14, 0.18, 0.24, 0.22)
  box(0.62, 0.18, 0.24, 0.22)
  box(0.3, 0.6, 0.4, 0.24)
  ctx.globalAlpha = 0.45
  ctx.fillRect(0.38 * s, 0.68 * s, 0.24 * s, 0.03 * s)
  ctx.fillRect(0.38 * s, 0.75 * s, 0.16 * s, 0.03 * s)
  ctx.globalAlpha = 1
}

/**
 * Badge for a plain shell session: a small terminal with a prompt and a caret that
 * behaves like the app's real one — travelling when busy, resting when not.
 */
export function drawShellBadge(ctx: CanvasRenderingContext2D, s: number, state: ActivityState, t: number): void {
  ctx.clearRect(0, 0, s, s)
  const still = state === 'exited'
  const body = state === 'attention' ? '#FFC857' : state === 'working' ? '#C74EFF' : '#9A7BC0'
  const glow = state === 'attention' ? '#FFE3A0' : state === 'working' ? '#E08BFF' : '#B79BDA'

  ctx.strokeStyle = body
  ctx.globalAlpha = still ? 0.45 : 0.75
  ctx.lineWidth = 0.05 * s
  ctx.beginPath()
  ctx.roundRect(0.16 * s, 0.2 * s, 0.68 * s, 0.6 * s, 0.12 * s)
  ctx.stroke()
  ctx.globalAlpha = 1

  ctx.strokeStyle = glow
  ctx.lineWidth = 0.055 * s
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.globalAlpha = still ? 0.45 : 1
  ctx.beginPath()
  ctx.moveTo(0.3 * s, 0.4 * s)
  ctx.lineTo(0.42 * s, 0.5 * s)
  ctx.lineTo(0.3 * s, 0.6 * s)
  ctx.stroke()

  // The caret sweeps while output is flowing and rests at the prompt otherwise.
  const sweep = state === 'working' ? 0.5 + 0.5 * Math.sin(t * 6) : 0
  const cx = 0.48 * s + sweep * 0.2 * s
  ctx.globalAlpha = still ? 0.35 : state === 'idle' ? 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(t * 2)) : 1
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.roundRect(cx, 0.42 * s, 0.055 * s, 0.18 * s, 0.028 * s)
  ctx.fill()
  ctx.globalAlpha = 1
}

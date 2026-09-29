import ELK from 'elkjs/lib/elk.bundled.js'
import type { MapEdge, MapNode } from '@shared/types'

/**
 * Where everything goes, computed here and never by the model.
 *
 * ELK's layered algorithm, run over the whole tree at once (INCLUDE_CHILDREN), so a
 * connection between two modules in two different repos is routed as one line through
 * the gaps between boxes rather than straight across them. Direction is left to right:
 * the model is told to point edges from the part that uses to the part being used, so
 * reading the map left to right reads "uses", and datastores settle on the right.
 *
 * Stability comes from order. ELK is deterministic and is asked to respect the model's
 * order of nodes and edges, and the model only ever appends, so an update moves things
 * as little as the new structure allows — and what does move is animated, not jumped.
 */

export interface LBox {
  id: string
  node: MapNode
  x: number
  y: number
  w: number
  h: number
  depth: number
  parent: string | null
  kids: string[]
  /** Index of its top-level area, for the area's hue. */
  area: number
  ghost: boolean
}

export interface LEdge {
  edge: MapEdge
  pts: Array<[number, number]>
}

export interface Layout {
  boxes: Map<string, LBox>
  order: string[]
  edges: Map<string, LEdge>
  w: number
  h: number
}

const elk = new ELK()

export function leafSize(kind: string): { w: number; h: number } {
  switch (kind) {
    case 'datastore':
      return { w: 210, h: 112 }
    case 'queue':
      return { w: 230, h: 76 }
    case 'external':
      return { w: 220, h: 88 }
    case 'doc':
      return { w: 200, h: 88 }
    default:
      return { w: 240, h: 96 }
  }
}

const CONTAINER_PAD = '[top=62,left=26,bottom=26,right=26]'

export async function computeLayout(nodes: Array<MapNode & { ghost?: boolean }>, edges: MapEdge[]): Promise<Layout> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const kids = new Map<string, string[]>()
  const tops: string[] = []
  for (const n of nodes) {
    if (n.parent && byId.has(n.parent)) {
      const l = kids.get(n.parent) ?? []
      l.push(n.id)
      kids.set(n.parent, l)
    } else tops.push(n.id)
  }
  const ancestors = (id: string): Set<string> => {
    const out = new Set<string>()
    for (let p = byId.get(id)?.parent; p && byId.has(p); p = byId.get(p)?.parent) out.add(p)
    return out
  }

  type ElkNode = { id: string; width?: number; height?: number; children?: ElkNode[]; layoutOptions?: Record<string, string>; x?: number; y?: number }
  const make = (id: string): ElkNode => {
    const n = byId.get(id)!
    const ch = kids.get(id) ?? []
    if (ch.length) return { id, children: ch.map(make), layoutOptions: { 'elk.padding': CONTAINER_PAD } }
    const s = leafSize(n.kind)
    const opts: Record<string, string> = {}
    if (n.kind === 'datastore') opts['elk.layered.layering.layerConstraint'] = 'LAST'
    return { id, width: s.w, height: s.h, layoutOptions: opts }
  }

  // An edge between a container and something inside it is containment, not a line.
  const usable = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to && !ancestors(e.from).has(e.to) && !ancestors(e.to).has(e.from))

  const graph = {
    id: '__root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.json.edgeCoords': 'ROOT',
      'elk.json.shapeCoords': 'ROOT',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.mergeEdges': 'true',
      'elk.layered.spacing.nodeNodeBetweenLayers': '84',
      'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
      'elk.spacing.nodeNode': '40',
      'elk.spacing.edgeNode': '24',
      'elk.spacing.edgeEdge': '12',
      'elk.spacing.componentComponent': '70',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.padding': '[top=30,left=30,bottom=30,right=30]',
    },
    children: tops.map(make),
    edges: usable.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  }

  const boxes = new Map<string, LBox>()
  const order: string[] = []
  const out = new Map<string, LEdge>()
  let W = 0
  let H = 0
  try {
    const res = (await elk.layout(graph as never)) as unknown as ElkNode & {
      edges?: Array<{ id: string; sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }> }>
      width?: number
      height?: number
    }
    const walk = (en: ElkNode, parent: string | null, depth: number, area: number) => {
      const n = byId.get(en.id)!
      boxes.set(en.id, {
        id: en.id,
        node: n,
        x: en.x ?? 0,
        y: en.y ?? 0,
        w: en.width ?? 0,
        h: en.height ?? 0,
        depth,
        parent,
        kids: (en.children ?? []).map((c) => c.id),
        area,
        ghost: !!(n as { ghost?: boolean }).ghost,
      })
      order.push(en.id)
      for (const c of en.children ?? []) walk(c, en.id, depth + 1, area)
    }
    ;(res.children ?? []).forEach((c, i) => walk(c, null, 0, i))
    W = res.width ?? 0
    H = res.height ?? 0
    const edgeById = new Map(usable.map((e) => [e.id, e]))
    for (const e of res.edges ?? []) {
      const sec = e.sections?.[0]
      const me = edgeById.get(e.id)
      if (!sec || !me) continue
      const pts: Array<[number, number]> = [[sec.startPoint.x, sec.startPoint.y], ...(sec.bendPoints ?? []).map((b) => [b.x, b.y] as [number, number]), [sec.endPoint.x, sec.endPoint.y]]
      out.set(e.id, { edge: me, pts })
    }
  } catch (err) {
    console.error('[map] layout failed, falling back to a grid', err)
    return gridLayout(nodes, usable)
  }
  return { boxes, order, edges: out, w: Math.max(W, 1), h: Math.max(H, 1) }
}

/** If ELK ever fails: a plain grid with straight lines, so the map still shows. */
function gridLayout(nodes: MapNode[], edges: MapEdge[]): Layout {
  const boxes = new Map<string, LBox>()
  const order: string[] = []
  const cols = Math.ceil(Math.sqrt(nodes.length))
  nodes.forEach((n, i) => {
    const s = leafSize(n.kind)
    boxes.set(n.id, { id: n.id, node: n, x: 40 + (i % cols) * 300, y: 40 + Math.floor(i / cols) * 160, w: s.w, h: s.h, depth: 0, parent: null, kids: [], area: i, ghost: false })
    order.push(n.id)
  })
  const out = new Map<string, LEdge>()
  for (const e of edges) {
    const a = boxes.get(e.from)
    const b = boxes.get(e.to)
    if (a && b) out.set(e.id, { edge: e, pts: [[a.x + a.w, a.y + a.h / 2], [b.x, b.y + b.h / 2]] })
  }
  return { boxes, order, edges: out, w: 40 + cols * 300, h: 40 + Math.ceil(nodes.length / cols) * 160 }
}

/** Where a polyline, walked from its start, first leaves `r`. Used to end lines at a closed tile. */
export function clipStart(pts: Array<[number, number]>, r: { x: number; y: number; w: number; h: number }): Array<[number, number]> {
  const inside = (p: [number, number]) => p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h
  if (!inside(pts[0]!)) return pts
  for (let i = 1; i < pts.length; i++) {
    if (inside(pts[i]!)) continue
    const [ax, ay] = pts[i - 1]!
    const [bx, by] = pts[i]!
    // Orthogonal segments: the exit is on a vertical or a horizontal side.
    let px = bx
    let py = by
    if (ax === bx) py = by > ay ? r.y + r.h : r.y
    else px = bx > ax ? r.x + r.w : r.x
    return [[px, py], ...pts.slice(i)]
  }
  return pts
}

export function clipEnd(pts: Array<[number, number]>, r: { x: number; y: number; w: number; h: number }): Array<[number, number]> {
  return clipStart([...pts].reverse(), r).reverse()
}

/** An orthogonal polyline as a path with softened corners. */
export function roundedPath(pts: Array<[number, number]>, radius: number): string {
  if (pts.length < 2) return ''
  let d = `M${pts[0]![0]},${pts[0]![1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]!
    const [x, y] = pts[i]!
    const [nx, ny] = pts[i + 1]!
    const l1 = Math.hypot(x - px, y - py)
    const l2 = Math.hypot(nx - x, ny - y)
    const r = Math.min(radius, l1 / 2, l2 / 2)
    const ax = x - ((x - px) / (l1 || 1)) * r
    const ay = y - ((y - py) / (l1 || 1)) * r
    const bx = x + ((nx - x) / (l2 || 1)) * r
    const by = y + ((ny - y) / (l2 || 1)) * r
    d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`
  }
  const last = pts[pts.length - 1]!
  return `${d} L${last[0]},${last[1]}`
}

/** Midpoint of the longest segment: where a label reads best. */
export function labelPoint(pts: Array<[number, number]>): [number, number] {
  let best = 0
  let at: [number, number] = pts[0] ?? [0, 0]
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!
    const [bx, by] = pts[i]!
    const l = Math.hypot(bx - ax, by - ay)
    if (l > best) {
      best = l
      at = [(ax + bx) / 2, (ay + by) / 2]
    }
  }
  return at
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

/**
 * Images a Claude session sees, for the tab's panel — what a hook script (resources/image-hook.mjs, now gone) did in
 * a node process of its own for every Read and every MCP tool call, done here instead: the
 * hook is now an http hook (Claude Code POSTs the event to the bridge), so a tool call costs
 * one request rather than a process.
 *
 *   PostToolUse  Read of an image file → its path; any other tool whose result carries
 *                image data (Playwright and Chrome screenshots via MCP) → the bytes.
 *   Stop         images pasted into the prompt, swept out of the part of the transcript
 *                written since the last sweep.
 *
 * Every failure is silent: a picture that does not reach the panel is a missing picture,
 * never an error in someone's session.
 */

export interface SeenImage {
  path?: string
  data?: string
  mime?: string
  source: string
  caption?: string
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
/** Below this an "image" is an icon or a tracking pixel, not something to look at. */
const MIN_BYTES = 1200
const MAX_BYTES = 25_000_000

export async function imagesFromHook(input: Record<string, unknown>, take: (image: SeenImage) => void): Promise<void> {
  try {
    const event = input['hook_event_name']
    if (event === 'PostToolUse') await afterTool(input, take)
    else if (event === 'Stop' || event === 'SubagentStop') await sweepPasted(input, take)
  } catch {
    /* silent by design */
  }
}

async function afterTool(input: Record<string, unknown>, take: (image: SeenImage) => void): Promise<void> {
  const tool = String(input['tool_name'] ?? '')
  const args = (input['tool_input'] ?? {}) as Record<string, unknown>
  if (tool === 'Read') {
    const file = String(args['file_path'] ?? '')
    if (!IMAGE_EXT.has(extname(file).toLowerCase())) return
    try {
      const size = (await stat(file)).size
      if (size >= MIN_BYTES && size <= MAX_BYTES) take({ path: file, source: 'Read', caption: file.split(/[\\/]/).pop() ?? '' })
    } catch {
      /* gone */
    }
    return
  }
  const found: Array<{ data: string; mime: string }> = []
  collect(input['tool_response'], found)
  for (const img of found.slice(0, 6)) take({ data: img.data, mime: img.mime, source: label(tool) })
}

/** `mcp__plugin_playwright_playwright__browser_take_screenshot` → `playwright · browser take screenshot`. */
function label(tool: string): string {
  const m = /^mcp__(?:plugin_)?([^_]+(?:_[^_]+)?)__(.+)$/.exec(tool)
  if (!m) return tool
  const server = m[1]!.split('_').pop()
  return `${server} · ${m[2]!.replace(/_/g, ' ')}`
}

/**
 * Every base64 image anywhere in a tool's result, whatever shape the server chose: MCP
 * content blocks (`{type:'image', data, mimeType}`), API-style blocks
 * (`{source:{type:'base64', media_type, data}}`), or a plain `{base64, type}`.
 */
function collect(node: unknown, out: Array<{ data: string; mime: string }>, depth = 0): void {
  if (!node || depth > 8 || out.length >= 6) return
  if (typeof node === 'string') {
    // Some tools return their content as a JSON string.
    if (node.length > 200 && (node[0] === '[' || node[0] === '{')) {
      try {
        collect(JSON.parse(node), out, depth + 1)
      } catch {
        /* not JSON */
      }
    }
    return
  }
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  const o = node as Record<string, unknown>
  const type = String(o['type'] ?? '')
  const mime = String(o['mimeType'] ?? o['media_type'] ?? o['mime'] ?? (type.startsWith('image/') ? type : ''))
  const data = o['data'] ?? o['base64']
  if (typeof data === 'string' && data.length > MIN_BYTES && /^image\//.test(mime)) {
    out.push({ data, mime })
    return
  }
  if (type === 'image' && o['source'] && typeof o['source'] === 'object') {
    collect(o['source'], out, depth + 1)
    return
  }
  for (const k of Object.keys(o)) if (k !== 'data' && k !== 'base64') collect(o[k], out, depth + 1)
}

/**
 * Images the user pasted, read out of the transcript: only the bytes appended since the
 * last sweep of this session (the offset lives in a small file in the temp folder), and
 * only `user` entries holding an image block directly — a tool's images came by PostToolUse.
 */
async function sweepPasted(input: Record<string, unknown>, take: (image: SeenImage) => void): Promise<void> {
  const transcript = String(input['transcript_path'] ?? '')
  if (!transcript || !existsSync(transcript)) return
  const dir = join(tmpdir(), 'ember-image-hook')
  mkdirSync(dir, { recursive: true })
  const mark = join(dir, `${String(input['session_id'] ?? 'session').replace(/[^\w-]/g, '')}.offset`)
  let from = 0
  const marked = existsSync(mark)
  try {
    from = Number(readFileSync(mark, 'utf8')) || 0
  } catch {
    /* first sweep */
  }
  const size = (await stat(transcript)).size
  if (size < from) from = 0
  // The first sweep of a resumed session would replay its whole history; start at the end.
  if (!marked && size > 2_000_000) from = size
  writeFileSync(mark, String(size))
  if (size === from) return
  const h = await open(transcript, 'r')
  let text = ''
  try {
    const buf = Buffer.alloc(size - from)
    await h.read(buf, 0, buf.length, from)
    text = buf.toString('utf8')
  } finally {
    await h.close()
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"image"')) continue
    let entry: { type?: string; isMeta?: boolean; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'user' || entry.isMeta) continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; source?: { type?: string; data?: string; media_type?: string } }>) {
      if (block?.type !== 'image' || block.source?.type !== 'base64') continue
      take({ data: block.source.data ?? '', mime: block.source.media_type ?? '', source: 'pasted', caption: 'You pasted' })
    }
  }
}

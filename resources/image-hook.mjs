#!/usr/bin/env node
/**
 * Images a Claude session sees, handed to the tab's panel.
 *
 * Claude Code in a terminal cannot draw an image, so the screenshots it takes and the
 * pictures it reads stay invisible to the person it is working for — the desktop and web
 * apps show them beside the text. Ember's panel can. This is a Claude Code hook, reached
 * through the same `--settings` file as the status line (so it only exists inside Ember),
 * and it runs `async`: Claude never waits for it.
 *
 *   PostToolUse  Read of an image file → its path; any other tool whose result carries
 *                image data (Playwright and Chrome screenshots, desk shots via MCP) →
 *                the bytes, written to a file.
 *   Stop         images pasted into the prompt. They exist only in the transcript, so the
 *                part written since the last turn is swept for user-pasted image blocks.
 *
 * Every failure is silent: an image that does not reach the panel is a missing picture,
 * never an error in someone's session. Hand-rolled like statusline.mjs — no node_modules.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

const BRIDGE = process.env.EMBER_BRIDGE_URL
const TOKEN = process.env.EMBER_BRIDGE_TOKEN
const TAB = process.env.EMBER_TAB_ID

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
/** Below this an "image" is an icon or a tracking pixel, not something to look at. */
const MIN_BYTES = 1200
const MAX_BYTES = 25_000_000

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  main(Buffer.concat(chunks).toString('utf8')).finally(() => process.exit(0))
})

async function main(raw) {
  if (!BRIDGE || !TOKEN || !TAB) return
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }
  try {
    if (input.hook_event_name === 'PostToolUse') await afterTool(input)
    else if (input.hook_event_name === 'Stop' || input.hook_event_name === 'SubagentStop') await sweepPasted(input)
  } catch {
    /* silent by design */
  }
}

async function afterTool(input) {
  const tool = String(input.tool_name ?? '')
  const args = input.tool_input ?? {}
  if (tool === 'Read') {
    const file = String(args.file_path ?? '')
    if (IMAGE_EXT.has(extname(file).toLowerCase()) && existsSync(file)) {
      await send({ path: file, source: 'Read', caption: file.split(/[\\/]/).pop() })
    }
    return
  }
  const found = []
  collect(input.tool_response, found)
  for (const img of found.slice(0, 6)) {
    await send({ data: img.data, mime: img.mime, source: label(tool) })
  }
}

/** `mcp__plugin_playwright_playwright__browser_take_screenshot` → `playwright · browser take screenshot`. */
function label(tool) {
  const m = /^mcp__(?:plugin_)?([^_]+(?:_[^_]+)?)__(.+)$/.exec(tool)
  if (!m) return tool
  const server = m[1].split('_').pop()
  return `${server} · ${m[2].replace(/_/g, ' ')}`
}

/**
 * Every base64 image anywhere in a tool's result, whatever shape the server chose:
 * MCP content blocks (`{type:'image', data, mimeType}`), API-style blocks
 * (`{source:{type:'base64', media_type, data}}`), or a plain `{base64, type}`.
 */
function collect(node, out, depth = 0) {
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
  const mime = String(node.mimeType ?? node.media_type ?? node.mime ?? (String(node.type ?? '').startsWith('image/') ? node.type : ''))
  const data = node.data ?? node.base64
  if (typeof data === 'string' && data.length > MIN_BYTES && /^image\//.test(mime)) {
    out.push({ data, mime })
    return
  }
  if (node.type === 'image' && node.source && typeof node.source === 'object') {
    collect(node.source, out, depth + 1)
    return
  }
  for (const k of Object.keys(node)) if (k !== 'data' && k !== 'base64') collect(node[k], out, depth + 1)
}

/**
 * Images the user pasted, read out of the transcript.
 *
 * Only the bytes appended since the last sweep of this session, so a long session is not
 * re-read every turn; the offset lives in a small file in the temp folder. Only `user`
 * entries whose content holds an image block directly — a tool result's images already
 * arrived through PostToolUse.
 */
async function sweepPasted(input) {
  const transcript = String(input.transcript_path ?? '')
  if (!transcript || !existsSync(transcript)) return
  const dir = join(tmpdir(), 'ember-image-hook')
  mkdirSync(dir, { recursive: true })
  const mark = join(dir, `${String(input.session_id ?? 'session').replace(/[^\w-]/g, '')}.offset`)
  let from = 0
  try {
    from = Number(readFileSync(mark, 'utf8')) || 0
  } catch {
    /* first sweep */
  }
  const size = statSync(transcript).size
  if (size < from) from = 0
  // The first sweep of a resumed session would replay its whole history; start at the end.
  if (!existsSync(mark) && size > 2_000_000) from = size
  writeFileSync(mark, String(size))
  if (size === from) return

  const text = await readRange(transcript, from, size)
  for (const line of text.split('\n')) {
    if (!line.includes('"image"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'user' || entry.isMeta) continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'image' || block.source?.type !== 'base64') continue
      await send({ data: block.source.data, mime: block.source.media_type, source: 'pasted', caption: 'You pasted' })
    }
  }
}

function readRange(file, start, end) {
  return new Promise((resolve, reject) => {
    const parts = []
    createReadStream(file, { start, end: end - 1 })
      .on('data', (c) => parts.push(c))
      .on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      .on('error', reject)
  })
}

async function send(image) {
  if (image.path) {
    const size = statSync(image.path).size
    if (size < MIN_BYTES || size > MAX_BYTES) return
  }
  await fetch(`${BRIDGE}/image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': TOKEN },
    body: JSON.stringify({ ...image, tabId: TAB, auto: true }),
    signal: AbortSignal.timeout(5000),
  })
}

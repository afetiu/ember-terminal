/**
 * Serve site/ for local testing of the phone app: `node site/app/dev/serve.mjs [port]`.
 * /vendor/* gets Access-Control-Allow-Origin: * because object frames are sandboxed
 * without an origin, and module scripts (pdf.js) are CORS fetches.
 */
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = Number(process.argv[2] || 8790)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.ico': 'image/x-icon',
}

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (path.endsWith('/')) path += 'index.html'
  const file = normalize(join(root, path))
  if (!file.startsWith(root)) return res.writeHead(403).end()
  let st
  try {
    st = statSync(file)
  } catch {
    return res.writeHead(404).end('not found')
  }
  if (st.isDirectory()) return res.writeHead(301, { location: path + '/' }).end()
  const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }
  if (path.startsWith('/vendor/')) headers['access-control-allow-origin'] = '*'
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`))

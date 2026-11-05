// Prints a recorded stream readable: escapes as ⎋, one chunk per block. node scripts/dump-stream.mjs <file> [from] [to]
import { readFileSync } from 'node:fs'
const [f, a = 0, b = 1e9] = process.argv.slice(2)
const L = readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse)
const esc = (s) => s.replace(/\x1b/g, '⎋').replace(/\x07/g, '^G').replace(/\r/g, '\r').replace(/\n/g, '\n\n')
L.forEach((l, i) => {
  if (i < +a || i > +b) return
  if (l.o) console.log(`--- #${i} t=${l.t} len=${l.o.length}\n${esc(l.o)}`)
  if (l.i) console.log(`>>> #${i} IN ${JSON.stringify(l.i)}`)
  if (l.resize) console.log(`<<< #${i} RESIZE ${l.resize}`)
  if (l.mark) console.log(`### #${i} MARK ${l.mark} cursor=${l.cursor}\n${l.screen.map((r, y) => y + '|' + r).filter((r) => !/^\d+\|$/.test(r)).join('\n')}`)
})

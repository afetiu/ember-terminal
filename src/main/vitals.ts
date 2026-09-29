import { cpus, freemem, totalmem } from 'node:os'
import type { VitalsState } from '../shared/types.js'

const POLL_MS = 2000

/**
 * CPU and memory load, straight from the kernel's counters — no helper process,
 * and unlike the Windows-only widgets this works everywhere. CPU is the busy
 * share of all cores since the previous sample, which is the same number Task
 * Manager's overall graph shows.
 */
export class VitalsWatcher {
  private timer: NodeJS.Timeout | null = null
  private prev = VitalsWatcher.sample()

  state: VitalsState = { cpu: 0, mem: 0 }

  constructor(private readonly onState: (s: VitalsState) => void) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), POLL_MS)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private static sample(): { idle: number; total: number } {
    let idle = 0
    let total = 0
    for (const c of cpus()) {
      idle += c.times.idle
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
    }
    return { idle, total }
  }

  private tick(): void {
    const now = VitalsWatcher.sample()
    const dTotal = now.total - this.prev.total
    const dIdle = now.idle - this.prev.idle
    this.prev = now

    const cpu = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0
    const mem = Math.round((1 - freemem() / totalmem()) * 100)
    if (cpu === this.state.cpu && mem === this.state.mem) return
    this.state = { cpu, mem }
    this.onState(this.state)
  }
}

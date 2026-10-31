/**
 * A line diff for the canvas's edit cards.
 *
 * Only used when the transcript has no structured patch of its own — Claude Code usually
 * records the real hunks, with line numbers, and those are preferred. This covers the
 * rest: an Edit's old and new strings, which are small. LCS is quadratic, so past a size
 * where that would show it falls back to "all of this out, all of that in", which is
 * still a true diff, only a less useful one.
 */

export interface DiffLine {
  kind: ' ' | '-' | '+'
  text: string
  /** Line number in the old text, for '-' and ' '. */
  oldNo?: number
  /** Line number in the new text, for '+' and ' '. */
  newNo?: number
}

const LIMIT = 400

export function diffLines(before: string, after: string, oldStart = 1, newStart = 1): DiffLine[] {
  const a = before.replace(/\r\n?/g, '\n').split('\n')
  const b = after.replace(/\r\n?/g, '\n').split('\n')
  if (before === '') a.length = 0
  if (after === '') b.length = 0

  if (a.length > LIMIT || b.length > LIMIT || a.length * b.length > 90_000) {
    return [
      ...a.map((text, i) => ({ kind: '-' as const, text, oldNo: oldStart + i })),
      ...b.map((text, i) => ({ kind: '+' as const, text, newNo: newStart + i })),
    ]
  }

  // Classic LCS table, then walk it back.
  const n = a.length
  const m = b.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]!, oldNo: oldStart + i, newNo: newStart + j })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: '-', text: a[i]!, oldNo: oldStart + i })
      i++
    } else {
      out.push({ kind: '+', text: b[j]!, newNo: newStart + j })
      j++
    }
  }
  while (i < n) out.push({ kind: '-', text: a[i]!, oldNo: oldStart + i++ })
  while (j < m) out.push({ kind: '+', text: b[j]!, newNo: newStart + j++ })
  return out
}

/**
 * Claude Code's structured patch, as recorded in the transcript's toolUseResult: hunks
 * whose lines carry their own ' ', '-' or '+' prefix.
 */
export function fromPatch(patch: unknown): DiffLine[] | null {
  if (!Array.isArray(patch) || !patch.length) return null
  const out: DiffLine[] = []
  for (const hunk of patch as Array<Record<string, unknown>>) {
    const lines = hunk['lines']
    if (!Array.isArray(lines)) return null
    let oldNo = Number(hunk['oldStart'] ?? 1)
    let newNo = Number(hunk['newStart'] ?? 1)
    if (out.length) out.push({ kind: ' ', text: '⋯' })
    for (const raw of lines as unknown[]) {
      const s = String(raw)
      const kind = s[0] === '-' ? '-' : s[0] === '+' ? '+' : ' '
      const text = s.slice(1)
      if (kind === '-') out.push({ kind, text, oldNo: oldNo++ })
      else if (kind === '+') out.push({ kind, text, newNo: newNo++ })
      else out.push({ kind, text, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return out
}

/** Counts, for the card's header. */
export function tally(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === '+') added++
    else if (l.kind === '-') removed++
  }
  return { added, removed }
}

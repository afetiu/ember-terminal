/**
 * One table of what the app can do.
 *
 * The palette lists it, every button runs one row of it, and `ember <words>` in a shell
 * runs one row of it — the same function, so the three can never drift apart. A row
 * with `cli` has a shell form; the words before any `[arg]` or `<arg>` are what the
 * command line has to type, the rest is how the CLI help describes it.
 */
export interface CommandSpec {
  id: string
  group: string
  title: string
  /** Keyboard shortcut, shown in the palette. */
  hint?: string
  /** Shell form, e.g. `split right`, `rename <name>`, `panel [show|hide]`. */
  cli?: string
  /** Shorter ways to type the same row: `o` for `orch`, `sd` for `split down`. */
  aliases?: string[]
  /** Shell only: not offered in the palette (it needs an argument to mean anything). */
  hidden?: boolean
  /** What it does. A returned string is printed by the CLI; the palette ignores it. */
  run(args: string[]): void | string | Promise<void | string>
}

/** The words a shell has to type for this row: `panel [show|hide]` -> ['panel']. */
export function cliWords(spec: CommandSpec): string[] {
  return (spec.cli ?? '').split(' ').filter((w) => w && !/^[[<]/.test(w))
}

/** Every way to type this row: its words, then each alias, as word lists. */
export function cliForms(spec: CommandSpec): string[][] {
  const own = cliWords(spec)
  if (!own.length) return []
  return [own, ...(spec.aliases ?? []).map((a) => a.split(' ').filter(Boolean))]
}

/**
 * The row whose words (or alias) are the longest prefix of what was typed, and what is
 * left over as its arguments. Earlier rows win a tie, which is what lets a context row
 * (`del` inside a note) shadow a general one.
 */
export function matchCli(specs: CommandSpec[], words: string[]): { spec: CommandSpec; args: string[] } | null {
  let best: { spec: CommandSpec; args: string[]; n: number } | null = null
  const typed = words.map((w) => w.toLowerCase())
  for (const spec of specs) {
    for (const form of cliForms(spec)) {
      if (form.length > typed.length) continue
      if (form.every((w, i) => w === typed[i]) && (!best || form.length > best.n)) {
        best = { spec, args: words.slice(form.length), n: form.length }
      }
    }
  }
  return best ? { spec: best.spec, args: best.args } : null
}

/** The CLI help, from the table, so it lists what the app actually has. */
export function helpText(specs: CommandSpec[]): string {
  const rows = specs.filter((s) => s.cli)
  const width = Math.max(...rows.map((s) => s.cli!.length)) + 2
  const groups = new Map<string, string[]>()
  for (const s of rows) {
    const line = `  ember ${s.cli!.padEnd(width)}${s.title}${s.aliases?.length ? `  = ${s.aliases.join(', ')}` : ''}${s.hint ? `  (${s.hint})` : ''}`
    groups.set(s.group, [...(groups.get(s.group) ?? []), line])
  }
  const out = ['ember <command> [args]   the same table Ctrl+K takes, without the word ember', '']
  for (const [group, lines] of groups) out.push(group, ...lines, '')
  out.push('  ember set <path> <value>   write one setting (ember set window.opacity 60)', '  ember get <path>           read one', '', 'notes, note and todo are commands of their own.')
  return out.join('\n')
}

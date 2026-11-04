/**
 * Is what the person typed in the canvas's ask box a question (answered there, by a short
 * run of its own) rather than a change to make? A question mark at the end, or a question
 * word at the start. `\b` keeps "issue…" or "doing…" from reading as "is" / "do".
 */
export function isQuestion(q: string): boolean {
  const s = q.trim()
  return /\?\s*$/.test(s) || /^(what|why|how|when|where|who|which|is|are|was|were|can|could|does|do|did|should|would|will|explain|tell me|describe|summari[sz]e|compare)\b/i.test(s)
}

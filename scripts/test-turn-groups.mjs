/**
 * Ember turns (src/shared/turnGroups.ts): which prompts carry on the turn on screen and
 * which start one of their own, over realistic sequences.
 *
 *   node --test scripts/test-turn-groups.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupSteps, joinsTurn } from '../src/shared/turnGroups.ts'

const MIN = 60_000
/** A tiny script: `> text` a prompt, `/x` a command, `!x` a shell command, `<` a reply (`<?` one with questions), `^C` an interrupt, `+N` minutes pass, `CLEAR`. */
function steps(script) {
  let t = Date.parse('2026-11-09T10:00:00Z')
  const out = []
  for (const raw of script) {
    const s = raw.trim()
    if (s.startsWith('+')) t += Number(s.slice(1)) * MIN
    else if (s === 'CLEAR') out.push({ kind: 'clear' })
    else if (s === '<') out.push({ kind: 'reply', at: (t += 20_000) })
    else if (s === '<?') out.push({ kind: 'reply', at: (t += 20_000), questions: true })
    else if (s === '^C') out.push({ kind: 'interrupt', at: (t += 5_000) })
    else if (s.startsWith('/')) out.push({ kind: 'command', text: s, at: (t += 5_000) })
    else if (s.startsWith('!')) out.push({ kind: 'shell', text: s.slice(1), at: (t += 5_000) })
    else if (s.startsWith('> ')) out.push({ kind: 'prompt', text: s.slice(2), at: (t += 10_000) })
    else throw new Error(`bad step ${s}`)
  }
  return out
}
const LONG = 'Build a settings page for the notifications service with toggles per channel, a quiet hours range picker, and a preview of how each notification will look on the phone and the desktop.'

const CASES = [
  ['the owner: request, /model, "yes do it", long new topic', ['> refactor the auth middleware so it uses the new session store', '<', '/model', '> yes do it', '<', `> ${LONG}`, '<'], [0, 0, 0, 1]],
  ['go ahead / continue / again', ['> add a dark mode toggle to the header', '<', '> go ahead', '<', '> continue', '<', '> again', '<'], [0, 0, 0, 0]],
  ['try again after an error', ['> run the migrations against the staging db', '<', '> try again', '<'], [0, 0]],
  ['"and the other one?"', ['> rename the first helper to parseRow', '<', '> and the other one?', '<'], [0, 0]],
  ['also / now / make it / same for', ['> make the card title bold', '<', '> also make the subtitle grey', '<', '> now make it smaller', '<', '> make it 13px', '<', '> same for the sidebar cards', '<'], [0, 0, 0, 0, 0]],
  ['what about / fix it / looks good', ['> why does the build fail on windows', '<', '> what about linux?', '<', '> fix it', '<', '> looks good', '<'], [0, 0, 0, 0]],
  ['numbered answers to questions', ['> plan the release', '<?', '> 1. B; 2. A', '<'], [0, 0]],
  ['single letter pick', ['> which db should we use', '<?', '> B', '<'], [0, 0]],
  ['a longer answer to the questions still joins', ['> plan the release', '<?', '> 1. the second option, but keep the old flag for a week; 2. yes ship it on friday after the review is done', '<'], [0, 0]],
  ['a single reference', ['> show me the two drafts', '<', '> that one', '<'], [0, 0]],
  ['short and soon joins', ['> write the changelog for 1.9.2', '<', '> mention the box fix', '<'], [0, 0]],
  ['short after a long pause starts afresh', ['> write the changelog for 1.9.2', '<', '+25', '> mention the box fix', '<'], [0, 1]],
  ['even "yes" after 30 minutes is a new turn', ['> deploy it', '<', '+30', '> yes', '<'], [0, 1]],
  ['short but neither soon nor a follow-up word: new', ['> write the changelog for 1.9.2', '<', '+6', '> check disk usage on the box', '<'], [0, 1]],
  ['long prompt is always new', ['> fix the typo', '<', `> ${LONG}`, '<'], [0, 1]],
  ['saying it is new', ['> fix the typo', '<', '> new task: count the open issues', '<'], [0, 1]],
  ['slash commands join, even after a pause', ['> fix the typo', '<', '+40', '/compact', '/rename typo fix', '/effort high'], [0, 0, 0, 0]],
  ['! shell joins', ['> start the dev server', '<', '!npm run dev', '> open it', '<'], [0, 0, 0]],
  ['interrupted then resent', ['> summarise the last 20 commits in a table', '^C', '> summarise the last 20 commits in a table, newest first please', '<'], [0, 0]],
  ['interrupted then corrected', ['> rewrite the parser', '^C', '> no, only the tokenizer part, keep the parser as it is because the tests rely on it', '<'], [0, 0]],
  ['/clear always starts fresh', ['> fix the typo', '<', 'CLEAR', '> yes', '<'], [0, 1]],
  ['the very first prompt is a turn', ['> yes'], [0]],
  ['three requests, three turns', [`> ${LONG}`, '<', '+4', '> Look at the failing CI job on main and tell me what broke', '<', '+30', '> ok', '<'], [0, 1, 2]],
]

for (const [name, script, want] of CASES) {
  test(name, () => assert.deepEqual(groupSteps(steps(script)), want))
}

test('no timestamps: words decide alone', () => {
  const st = { askAt: NaN, lastAt: NaN, prompt: 'x', interrupted: false, questions: false }
  assert.equal(joinsTurn('yes', NaN, 'prompt', st).join, true)
  assert.equal(joinsTurn('check disk usage on the box', NaN, 'prompt', st).join, false)
})

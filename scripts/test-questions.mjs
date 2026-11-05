// node --test scripts/test-questions.mjs — reading options out of the questions a reply ends with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readQuestion, compose } from '../src/renderer/src/canvas/questionParse.ts'

const opts = (text, codes, subs) => readQuestion(text, codes, subs).options

test('the four questions of the real reply', () => {
  const q1 = readQuestion('May I start Wave 1 now in both repos? A, yes, both; B, radix-assistant only; or C, wait.')
  assert.deepEqual(q1.options, ['yes, both', 'radix-assistant only', 'wait'])
  assert.deepEqual(q1.keys, ['A', 'B', 'C'])
  assert.equal(q1.text, 'May I start Wave 1 now in both repos?')
  assert.deepEqual(
    opts('For the status updates, which do you want? A, one post per thread that the bot edits in place; B, emoji reactions only, with a post only at done; or C, batched posts.'),
    ['one post per thread that the bot edits in place', 'emoji reactions only, with a post only at done', 'batched posts'],
  )
  assert.deepEqual(opts('Do you want quiet hours for channel posts? A, 20:00 to 08:00 Europe/Belgrade; B, no quiet hours.'), ['20:00 to 08:00 Europe/Belgrade', 'no quiet hours'])
  const q4 = readQuestion('For the GitHub App contents: write permission, which do you want? A, read-only; B, write only on the 3 repos the bot works in; or C, no change.', ['contents: write'])
  assert.deepEqual(q4.options, ['read-only', 'write only on the 3 repos the bot works in', 'no change'])
  assert.equal(q4.text, 'For the GitHub App contents: write permission, which do you want?')
})

test('the earlier reply: named options, two sides, yes / no', () => {
  const q = readQuestion('Is Product Line Platform correct? The other options are Analytics, Underwriting, RealRents, Data Platform and Intelligence.', ['Platform'])
  assert.deepEqual(q.options, ['Platform', 'Analytics', 'Underwriting', 'RealRents', 'Data Platform', 'Intelligence'])
  assert.equal(q.current, 'Platform')
  assert.equal(q.keys, undefined)
  assert.deepEqual(opts('Is the 50% target for the 3 pilot repos, or for all repos?'), ['the 3 pilot repos', 'all repos'])
  assert.deepEqual(opts('Your account cannot set the assignee in UP. Should the Kyle message ask him to assign the 4 ideas to you?'), ['Yes', 'No'])
})

test('lettered and numbered shapes', () => {
  const cases = [
    ['Which approach do you prefer: (A) rewrite the parser (B) patch the regex (C) leave it?', ['rewrite the parser', 'patch the regex', 'leave it'], ['A', 'B', 'C']],
    ['Pick one: A) Postgres B) SQLite', ['Postgres', 'SQLite'], ['A', 'B']],
    ['Which format? a) JSON b) YAML c) TOML', ['JSON', 'YAML', 'TOML'], ['A', 'B', 'C']],
    ['How should I name it? 1) ember-cli 2) ember-tools', ['ember-cli', 'ember-tools'], ['1', '2']],
    ['Option A: ship today. Option B: wait for review. Which one?', ['ship today', 'wait for review'], ['A', 'B']],
    ['Should it be A. strict or B. lenient?', ['strict', 'lenient'], ['A', 'B']],
    ['Which plan? A — fast but costly; B — slow and cheap.', ['fast but costly', 'slow and cheap'], ['A', 'B']],
    ['Where should logs go? (1) stdout (2) a file (3) both', ['stdout', 'a file', 'both'], ['1', '2', '3']],
  ]
  for (const [text, want, keys] of cases) {
    const q = readQuestion(text)
    assert.deepEqual(q.options, want, text)
    assert.deepEqual(q.keys, keys, text)
  }
  assert.equal(readQuestion('Option A: ship today. Option B: wait for review. Which one?').text, 'Which one?')
})

test('bullets under the question', () => {
  const k = readQuestion('Which database should we use?', [], ['A: Postgres', 'B: SQLite'])
  assert.deepEqual(k.options, ['Postgres', 'SQLite'])
  assert.deepEqual(k.keys, ['A', 'B'])
  const p = readQuestion('Which database should we use?', [], ['Postgres', 'SQLite', 'DuckDB'])
  assert.deepEqual(p.options, ['Postgres', 'SQLite', 'DuckDB'])
  assert.equal(p.keys, undefined)
})

test('named alternatives', () => {
  assert.deepEqual(opts('Should we use Postgres, MySQL, or SQLite?'), ['Postgres', 'MySQL', 'SQLite'])
  assert.deepEqual(opts('Should I merge now or wait for CI?'), ['merge now', 'wait for CI'])
  assert.deepEqual(opts('Do you want me to push it or keep it local?'), ['push it', 'keep it local'])
  assert.deepEqual(opts('Which runtime should the worker use (Node, Bun or Deno)?'), ['Node', 'Bun', 'Deno'])
  assert.deepEqual(opts('Which do you want: the dark theme or the light one?'), ['the dark theme', 'the light one'])
})

test('yes / no only for a yes/no question that lists nothing', () => {
  assert.deepEqual(opts('Do you want me to push it to main?'), ['Yes', 'No'])
  assert.deepEqual(opts('Ready to deploy, or not yet?'), ['Yes', 'No'])
  assert.deepEqual(opts('May I start Wave 1 now in both repos?'), ['Yes', 'No'])
})

test('unsure: a free answer, never question words as chips', () => {
  assert.deepEqual(opts('What should the new service be called?'), [])
  assert.deepEqual(opts('Which do you want?'), [])
  assert.deepEqual(opts('For the GitHub App contents: write permission, which do you want?', ['contents: write']), [])
  assert.deepEqual(opts('How should we split the work, or which part do you want first?'), [])
})

test('the answer line', () => {
  assert.equal(
    compose([{ n: 1, key: 'A', text: 'yes, both' }, { n: 2, key: 'A', text: 'one post per thread' }, { n: 3, text: '' }, { n: 4, text: 'ask me later' }], 4),
    '1. A — yes, both; 2. A — one post per thread; 4. ask me later',
  )
  assert.equal(compose([{ n: 1, text: 'Yes' }], 1), 'Yes')
})

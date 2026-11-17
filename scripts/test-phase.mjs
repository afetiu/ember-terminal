/**
 * The live status in plain words (src/renderer/src/canvas/phase.ts).
 *
 *   node --test scripts/test-phase.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyStep, shellPhase, Progress, firstSentence, elapsed } from '../src/renderer/src/canvas/phase.ts'

test('shell commands fall into plain stages', () => {
  const cases = [
    ['npm run build', '', 'build'],
    ['npx tsc --noEmit', '', 'build'],
    ['node --test scripts/test-phase.mjs', '', 'test'],
    ['pytest -q', '', 'test'],
    ['npm install zod', '', 'install'],
    ['pip install requests', '', 'install'],
    ['git commit -m "x"', '', 'save'],
    ['git push -u origin main', '', 'save'],
    ['npm run site:deploy', '', 'ship'],
    ['git status --short', '', 'read'],
    ['ls src', '', 'read'],
    ['curl -s https://example.com', '', 'check'],
    ['python scripts/make_report.py', '', 'run'],
    ['node x.mjs', 'Verify the tab title updates', 'check'],
  ]
  for (const [c, d, want] of cases) assert.equal(shellPhase(c, d), want, c)
})

test('tools read as a stage and a sentence', () => {
  assert.deepEqual(classifyStep('Read', { file_path: 'C:/a/b/LoomView.ts' }), { phase: 'read', what: 'Reading LoomView.ts', file: 'LoomView.ts' })
  assert.equal(classifyStep('WebSearch', { query: 'codex thread names' }).what, 'Searching the web for “codex thread names”')
  assert.equal(classifyStep('WebFetch', { url: 'https://www.example.com/x' }).what, 'Reading a page on example.com')
  assert.equal(classifyStep('Edit', { file_path: 'x/Feed.ts' }).what, 'Changing Feed.ts')
  assert.equal(classifyStep('Bash', { command: 'npm test', description: 'run the unit tests' }).what, 'Run the unit tests')
  assert.equal(classifyStep('Agent', { description: 'Find where tabs are named' }).what, 'A helper is find where tabs are named')
  assert.equal(classifyStep('mcp__ember-panel__show_panel', {}).phase, 'canvas')
  assert.equal(classifyStep('mcp__claude_ai_Gmail__search_threads', {}).what, 'Using Gmail: search threads')
  assert.equal(classifyStep('mcp__plugin_playwright_playwright__browser_take_screenshot', {}).phase, 'check')
})

test('what is done so far, in words', () => {
  const p = new Progress()
  for (const s of [
    classifyStep('Read', { file_path: 'a.ts' }),
    classifyStep('Read', { file_path: 'a.ts' }),
    classifyStep('Read', { file_path: 'b.ts' }),
    classifyStep('Edit', { file_path: 'a.ts' }),
    classifyStep('Bash', { command: 'npm test' }),
    classifyStep('Bash', { command: 'npm test' }),
  ])
    p.add(s)
  assert.equal(p.summary(), 'read 2 files · changed 1 file · ran the tests twice')
})

test('small helpers', () => {
  assert.equal(firstSentence('Now I will update the tests. Then build.'), 'Now I will update the tests.')
  assert.equal(elapsed('1m 12s · ↓ 3.2k tokens'), '1m 12s')
  assert.equal(elapsed('esc to interrupt'), '')
})

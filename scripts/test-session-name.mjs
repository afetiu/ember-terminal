/**
 * The name a tab running an agent shows (src/renderer/src/canvas/sessionName.ts).
 *
 *   node --test scripts/test-session-name.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionName, terminalName, firstPrompt } from '../src/renderer/src/canvas/sessionName.ts'
import { agentFromTitle } from '../src/shared/agents.ts'

const isAgent = (t) => !!agentFromTitle(t)
const base = { named: '', ai: '', terminal: '', first: '', agent: 'Claude Code', folder: 'C:/Users/me/ember-terminal', isAgent }

test('a name you gave wins', () => {
  assert.equal(sessionName({ ...base, named: 'ember enh', ai: 'Fix tabs', terminal: '✳ Something', first: 'hello there' }), 'ember enh')
})
test('then the title the agent gave it', () => {
  assert.equal(sessionName({ ...base, ai: 'Planets and their moon counts', first: 'how many moons' }), 'Planets and their moon counts')
})
test('then the terminal title, when it says more than the agent name', () => {
  assert.equal(sessionName({ ...base, terminal: '✳ Fix tab naming', first: 'x y z' }), 'Fix tab naming')
  assert.equal(sessionName({ ...base, terminal: '✳ Claude Code', first: 'fix the build on windows' }), 'fix the build on windows')
})
test('terminal titles that name nothing are skipped', () => {
  for (const t of ['codex', 'cursor-agent', 'Cursor Agent', 'C:\Windows\System32\cmd.exe', 'pwsh', 'ember-terminal', '⠋', 'Codex'])
    assert.equal(terminalName(t, 'Codex', 'C:/x/ember-terminal', isAgent), '', t)
})
test('the first prompt, cut at a word', () => {
  assert.equal(firstPrompt('for ember: the fact that we have made turns intelligent, in the sense that the model decides'), 'for ember: the fact that we have made turns…')
  assert.equal(firstPrompt('\n\n  short one\nsecond line'), 'short one')
})
test('nothing yet: empty, so the card says agent · folder', () => {
  assert.equal(sessionName(base), '')
})

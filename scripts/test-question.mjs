// node scripts/test-question.mjs — the ask box's "is this a question?" check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQuestion } from '../src/renderer/src/canvas/loom/question.ts'

test('a question word at the start is a question', () => {
  for (const q of ['what does this do', 'Why is it red', 'explain the flow', 'tell me more', 'summarise it', 'Is it fast'])
    assert.equal(isQuestion(q), true, q)
})
test('a question mark at the end is a question', () => assert.equal(isQuestion('make it blue?'), true))
test('a change is not a question, and words only starting with one do not count', () => {
  for (const q of ['make it blue', 'issue a fix for the title', 'doing better: bigger font', 'however you like', 'whichever is shorter', 'add a row'])
    assert.equal(isQuestion(q), false, q)
})

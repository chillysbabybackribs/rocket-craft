import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeActivityText, mergeLabel, promptPath, type TaskMerge } from './orchestrator.ts'

const merge = (fields: Partial<TaskMerge>): { merge: TaskMerge } => ({
  merge: { verdict: 'accept', status: 'queued', at: 0, files: [], reason: null, message: null, commit: null, ...fields }
})

test('a task in the main folder, or a worktree task with no verdict yet, shows no merge state', () => {
  assert.equal(mergeLabel({ merge: null }), null)
})

test('a merge shows its state in a few words, with the short commit once merged', () => {
  assert.equal(mergeLabel(merge({ status: 'queued' }))?.text, 'Merge queued')
  assert.equal(mergeLabel(merge({ status: 'merging' }))?.text, 'Merging…')
  assert.equal(mergeLabel(merge({ status: 'queued', verdict: 'reject' }))?.text, 'Discard queued')
  assert.equal(mergeLabel(merge({ status: 'merging', verdict: 'reject' }))?.text, 'Discarding…')
  const merged = mergeLabel(merge({ status: 'merged', commit: '0123456789abcdef', files: ['auth.js', 'notes.md'], message: 'Merged task 0001 (2 files) as 0123456.' }))
  assert.deepEqual(merged, { text: 'Merged 0123456', title: 'Merged task 0001 (2 files) as 0123456.\nauth.js\nnotes.md', tone: 'ok' })
  assert.equal(mergeLabel(merge({ status: 'merged' }))?.text, 'Merged', 'without committing there is no commit to show')
  assert.equal(mergeLabel(merge({ status: 'discarded', verdict: 'reject' }))?.text, 'Discarded')
})

test('merge activity lines name the task and how the merge finished', () => {
  const task = { id: '0007', title: 'Worker title', merge: merge({ status: 'merged', at: 1, files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], commit: 'abc1234def5678' }).merge }
  assert.equal(mergeActivityText(task), 'Merged 0007 Worker title (4 files, abc1234)')
  assert.equal(mergeActivityText({ ...task, merge: merge({ status: 'refused', at: 2, reason: 'conflict', files: ['src/a.ts'] }).merge }), 'Refused 0007: conflict (a.ts)')
  assert.equal(mergeActivityText({ ...task, merge: merge({ status: 'discarded', at: 3, verdict: 'reject' }).merge }), 'Discarded 0007')
  assert.equal(mergeActivityText({ id: '0001', title: 'T', merge: null }), null)
})

test('promptPath wraps spaced paths in backticks', () => {
  assert.equal(promptPath('/tmp/no-space/file'), '/tmp/no-space/file')
  assert.equal(promptPath('/home/dp/.config/Craft Studio/worktrees/x'), '`/home/dp/.config/Craft Studio/worktrees/x`')
})

test('a refusal names its reason, and its sentence and files are on hover', () => {
  const refused = mergeLabel(merge({
    status: 'refused', reason: 'conflict', files: ['auth.js'],
    message: 'Task 0002 was not merged: auth.js changed in both the main folder and the worker.\ncheck output'
  }))
  assert.deepEqual(refused, { text: 'Refused: conflict', title: 'Task 0002 was not merged: auth.js changed in both the main folder and the worker.\nauth.js', tone: 'warn' })
  assert.equal(mergeLabel(merge({ status: 'refused' }))?.text, 'Refused: error')
})

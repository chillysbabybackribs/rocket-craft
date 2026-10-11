import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Orchestration, PlanItem } from '../shared/orchestrator.ts'
import { isQuietReview, pendingChangesText } from '../shared/orchestrator.ts'
import { applyPlanEdit, checkLockedUpdate, deriveTitle, fileEdits, firstSentence, parsePlanSection, planChecklist, undoChange } from './orchestrator-plan.ts'

function item(id: string, status: PlanItem['status'] = 'planned', text = `Step ${id}`): PlanItem {
  return { id, text, status, tasks: [], from: null, by: null }
}

function run(plan: PlanItem[]): Orchestration {
  return { plan, changes: [] } as unknown as Orchestration
}

test('first sentence ends at punctuation followed by a space, so file names stay whole', () => {
  assert.equal(firstSentence('The user chose to improve progress.md for the loop. Then more.'), 'The user chose to improve progress.md for the loop.')
  assert.equal(firstSentence('Board mockup accepted (docs/mockups/worker-board-review.html).'), 'Board mockup accepted (docs/mockups/worker-board-review.html).')
  assert.equal(firstSentence('No punctuation here\nsecond line'), 'No punctuation here')
})

test('derived worker titles are short and cut at a word', () => {
  assert.equal(deriveTitle('Remove Fill with Craft Studio. Keep cookie import.'), 'Remove Fill with Craft Studio')
  const long = deriveTitle('Investigate the intermittent browser single page application timeout seen in the UI check suite')
  assert.ok(long.length <= 60, long)
  assert.match(long, /…$/)
  assert.doesNotMatch(long, / …$/)
})

test('user edits are recorded, lock the item, and cancel when put back', () => {
  const r = run([item('a'), item('b'), item('c', 'done')])
  const kept = applyPlanEdit(r, { type: 'status', item: 'b', status: 'kept' }, 'view', 1)!
  assert.match(kept.text, /^Kept b \(do not do or remove it\)/)
  assert.equal(r.plan[1]!.by, 'user')
  assert.equal(applyPlanEdit(r, { type: 'status', item: 'b', status: 'planned' }, 'view', 2), null)
  assert.equal(r.changes.length, 0, 'a change put back leaves nothing to acknowledge')
  assert.equal(r.plan[1]!.by, null)

  applyPlanEdit(r, { type: 'status', item: 'c', status: 'planned' }, 'view', 3)
  assert.match(r.changes.at(-1)!.text, /^Reopened c/)
  applyPlanEdit(r, { type: 'reword', item: 'a', text: 'Do the first step well' }, 'view', 4)
  assert.equal(r.plan[0]!.text, 'Do the first step well')
  assert.throws(() => applyPlanEdit(r, { type: 'reword', item: 'a', text: 'x'.repeat(141) }, 'view', 5), /140 characters/)
  const added = applyPlanEdit(r, { type: 'add', text: 'A step of mine' }, 'view', 6)!
  assert.equal(added.item, 'u1')
  assert.equal(r.plan.at(-1)!.by, 'user')
  assert.match(pendingChangesText(r), /- c\d: Added u1 "A step of mine"/)
})

test('moves pass open neighbours only and undo puts the order back', () => {
  const r = run([item('a'), item('d', 'done'), item('b'), item('c')])
  const moved = applyPlanEdit(r, { type: 'move', item: 'b', delta: -1 }, 'view', 1)!
  assert.deepEqual(r.plan.map(each => each.id), ['b', 'a', 'd', 'c'])
  assert.equal(applyPlanEdit(r, { type: 'move', item: 'b', delta: -1 }, 'view', 2), null, 'already first among open steps')
  assert.throws(() => applyPlanEdit(r, { type: 'move', item: 'd', delta: 1 }, 'view', 3), /still to do/)
  undoChange(r, moved.id)
  assert.deepEqual(r.plan.map(each => each.id), ['a', 'd', 'b', 'c'])
  assert.equal(r.plan[2]!.by, null)
})

test('undo removes an added step and refuses acknowledged changes', () => {
  const r = run([item('a')])
  const added = applyPlanEdit(r, { type: 'add', text: 'Mine' }, 'view', 1)!
  applyPlanEdit(r, { type: 'reword', item: added.item, text: 'Mine, reworded' }, 'view', 2)
  undoChange(r, added.id)
  assert.deepEqual(r.plan.map(each => each.id), ['a'])
  assert.equal(r.changes.length, 0)
  const done = applyPlanEdit(r, { type: 'status', item: 'a', status: 'done' }, 'view', 3)!
  done.ack = { cycle: 2, at: 4, text: 'Checked.' }
  assert.throws(() => undoChange(r, done.id), /already acknowledged/)
})

test('a locked item may only move forward and keep its wording', () => {
  const locked = { ...item('a'), by: 'user' as const }
  assert.doesNotThrow(() => checkLockedUpdate(locked, locked.text, 'active'))
  assert.doesNotThrow(() => checkLockedUpdate(locked, locked.text, 'done'))
  assert.throws(() => checkLockedUpdate(locked, 'Other words', undefined), /wording stays/)
  assert.throws(() => checkLockedUpdate(locked, locked.text, 'dropped'), /only move forward/)
  assert.throws(() => checkLockedUpdate({ ...locked, status: 'kept' }, locked.text, 'planned'), /only move forward/)
  assert.doesNotThrow(() => checkLockedUpdate(item('b'), 'Anything', 'dropped'))
})

test('the checklist round-trips and hand edits become plan edits', () => {
  const r = run([{ ...item('01-goals', 'done', 'Remove Goals'), tasks: ['0001', '0008'] }, { ...item('06-layouts', 'planned', 'Remove layouts'), from: 2 }, item('07', 'active', 'Board host')])
  const written = parsePlanSection(`## Plan\n${planChecklist(r)}`)!
  assert.deepEqual(written.map(line => [line.mark, line.id, line.text]), [['x', '01-goals', 'Remove Goals'], [' ', '06-layouts', 'Remove layouts'], ['~', '07', 'Board host']])
  const file = `# Orchestrator progress\n\n## Plan\n\n- [x] 01-goals · Remove Goals (0001, 0008)\n- [k] 06-layouts · Remove layouts (added)\n- [ ] 07 · Board host and transport\n- [ ] Write the release notes\n\n## Now\n\n- [ ] not a plan line`
  const edits = fileEdits(r, parsePlanSection(file)!, written)
  assert.deepEqual(edits, [
    { type: 'status', item: '06-layouts', status: 'kept' },
    { type: 'reword', item: '07', text: 'Board host and transport' },
    { type: 'add', text: 'Write the release notes' }
  ])
})

test('host changes since the last write are never read back as hand edits', () => {
  const r = run([item('a'), item('b')])
  const written = parsePlanSection(`## Plan\n${planChecklist(r)}`)!
  const file = `## Plan\n${planChecklist(r)}`
  r.plan[0]!.status = 'done'
  r.plan[1]!.text = 'Reworded by the orchestrator'
  assert.deepEqual(fileEdits(r, parsePlanSection(file)!, written), [])
})

test('reviews with nothing new are quiet, including old ones', () => {
  assert.equal(isQuietReview({ at: 1, summary: 'Review 14: no new reports.', next: '' }), true)
  assert.equal(isQuietReview({ at: 1, summary: 'Review 18: no reports yet.', next: '' }), true)
  assert.equal(isQuietReview({ at: 1, summary: 'Passes 1–4 are complete.', next: '' }), false)
  assert.equal(isQuietReview({ at: 1, summary: 'Waiting.', next: '', quiet: true }), true)
})

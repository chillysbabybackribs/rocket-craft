import type { Orchestration, PlanChange, PlanEdit, PlanItem, PlanItemStatus } from '../shared/orchestrator.ts'
import { PLAN_ITEM_TEXT_MAX, TASK_TITLE_MAX, firstSentence } from '../shared/orchestrator.ts'

// The plan as the user and the orchestrator share it. Every user change, from the progress view
// or from editing progress.md by hand, goes through `applyPlanEdit`, so each one is recorded the
// same way, locks the item, and waits for the orchestrator's acknowledgement. Pure functions over
// a run, so the rules can be tested without a host.

export { firstSentence }

/** A worker's title when the orchestrator gave none: the assignment's first sentence, cut at a word. */
export function deriveTitle(task: string): string {
  const sentence = firstSentence(task).replace(/[.!?]$/, '')
  if (sentence.length <= TASK_TITLE_MAX) return sentence
  const cut = sentence.slice(0, TASK_TITLE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > TASK_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '')}…`
}

const OPEN: PlanItemStatus[] = ['planned', 'active']
const isOpen = (item: PlanItem): boolean => OPEN.includes(item.status)

function find(run: Orchestration, id: string): PlanItem {
  const item = run.plan.find(each => each.id === id)
  if (!item) throw new Error(`There is no plan item "${id}". Reload the progress view and try again.`)
  return item
}

function checkText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Describe the step in a few words.')
  if (trimmed.length > PLAN_ITEM_TEXT_MAX) throw new Error(`Keep a plan step to ${PLAN_ITEM_TEXT_MAX} characters; this one is ${trimmed.length}.`)
  return trimmed
}

function nextUserId(run: Orchestration): string {
  const used = run.plan.map(item => /^u(\d+)$/.exec(item.id)?.[1]).filter(Boolean).map(Number)
  return `u${Math.max(0, ...used) + 1}`
}

function nextChangeId(run: Orchestration): string {
  const used = run.changes.map(change => /^c(\d+)$/.exec(change.id)?.[1]).filter(Boolean).map(Number)
  return `c${Math.max(0, ...used) + 1}`
}

/** Short, so the orchestrator reads the change and the step at once. */
const quote = (text: string): string => `"${text.length > 70 ? `${text.slice(0, 69)}…` : text}"`

function statusText(item: PlanItem, before: PlanItemStatus, after: PlanItemStatus): string {
  if (after === 'done') return `Marked ${item.id} done ${quote(item.text)}`
  if (after === 'kept') return `Kept ${item.id} (do not do or remove it) ${quote(item.text)}`
  if (after === 'dropped') return `Dropped ${item.id} ${quote(item.text)}`
  if (before === 'done') return `Reopened ${item.id} ${quote(item.text)}`
  return `Put ${item.id} back in the plan ${quote(item.text)}`
}

/** An item stays locked while any change of the user's, acknowledged or not, is on it. */
function relock(run: Orchestration, item: PlanItem): void {
  item.by = run.changes.some(change => change.item === item.id) ? 'user' : null
}

/**
 * Apply one user change and record it. A change that puts an item back the way an unacknowledged
 * change found it cancels that change instead, so a check and an uncheck leave nothing to read.
 * Returns the change recorded, or null when nothing changed.
 */
export function applyPlanEdit(run: Orchestration, edit: PlanEdit, source: PlanChange['source'], at: number): PlanChange | null {
  if (edit.type === 'undo') {
    undoChange(run, edit.change)
    return null
  }
  const record = (item: PlanItem, kind: PlanChange['kind'], text: string, undo: PlanChange['undo'], other: PlanChange['other'] = null): PlanChange => {
    const change: PlanChange = { id: nextChangeId(run), at, item: item.id, text, kind, other, source, undo, ack: null }
    run.changes.push(change)
    item.by = 'user'
    return change
  }
  const cancels = (item: PlanItem, type: 'status' | 'text', value: string): boolean => {
    const earlier = run.changes.find(change => change.item === item.id && change.ack === null && change.undo.type === type
      && (change.undo.type === 'status' ? change.undo.before : change.undo.type === 'text' ? change.undo.before : null) === value)
    if (!earlier) return false
    run.changes.splice(run.changes.indexOf(earlier), 1)
    relock(run, item)
    return true
  }
  if (edit.type === 'add') {
    const text = checkText(edit.text)
    const item: PlanItem = { id: nextUserId(run), text, status: 'planned', tasks: [], from: null, by: 'user' }
    run.plan.push(item)
    return record(item, 'add', `Added ${item.id} ${quote(text)}`, { type: 'add' })
  }
  const item = find(run, edit.item)
  if (edit.type === 'status') {
    const before = item.status
    if (before === edit.status) return null
    item.status = edit.status
    if (cancels(item, 'status', edit.status)) return null
    const kind = edit.status === 'done' ? 'done' : edit.status === 'kept' ? 'keep' : edit.status === 'dropped' ? 'drop' : before === 'done' ? 'reopen' : 'restore'
    return record(item, kind, statusText(item, before, edit.status), { type: 'status', before })
  }
  if (edit.type === 'reword') {
    const text = checkText(edit.text)
    const before = item.text
    if (before === text) return null
    item.text = text
    if (cancels(item, 'text', text)) return null
    return record(item, 'reword', `Reworded ${item.id} to ${quote(text)}`, { type: 'text', before })
  }
  // A move passes the next open step, never a finished one, so the order reads as the work's order.
  if (!isOpen(item)) throw new Error('Only steps still to do can be moved.')
  const open = run.plan.filter(isOpen)
  const other = open[open.indexOf(item) + edit.delta]
  if (!other) return null
  const before = run.plan.indexOf(item)
  run.plan.splice(before, 1)
  const at2 = run.plan.indexOf(other)
  run.plan.splice(edit.delta < 0 ? at2 : at2 + 1, 0, item)
  return record(item, 'move', `Moved ${item.id} ${edit.delta < 0 ? 'before' : 'after'} ${other.id}`, { type: 'move', before }, { item: other.id, before: edit.delta < 0 })
}

/** Take back a change the orchestrator has not seen. Undoing an added step removes it. */
export function undoChange(run: Orchestration, id: string): void {
  const change = run.changes.find(each => each.id === id)
  if (!change) throw new Error('That change is no longer in the plan. Reload the progress view.')
  if (change.ack) throw new Error('The orchestrator has already acknowledged this change, so it cannot be undone. Change the step again instead.')
  const item = run.plan.find(each => each.id === change.item)
  const { undo } = change
  if (undo.type === 'add') {
    run.plan = run.plan.filter(each => each.id !== change.item)
    run.changes = run.changes.filter(each => each.item !== change.item)
    return
  }
  run.changes.splice(run.changes.indexOf(change), 1)
  if (!item) return
  if (undo.type === 'status') item.status = undo.before
  if (undo.type === 'text') item.text = undo.before
  if (undo.type === 'move') {
    run.plan.splice(run.plan.indexOf(item), 1)
    run.plan.splice(Math.min(undo.before, run.plan.length), 0, item)
  }
  relock(run, item)
}

const ADVANCES: Partial<Record<PlanItemStatus, PlanItemStatus[]>> = { planned: ['active', 'done'], active: ['done'] }

/** The orchestrator may carry a user's step forward, but not reword, drop or reopen it. */
export function checkLockedUpdate(item: PlanItem, text: string, status: PlanItemStatus | undefined): void {
  if (item.by !== 'user') return
  if (text !== item.text) throw new Error(`Plan item "${item.id}" was set by the user, so its wording stays "${item.text}". Send that text unchanged, or ask the user in your summary before changing it.`)
  if (status !== undefined && status !== item.status && !ADVANCES[item.status]?.includes(status)) {
    throw new Error(`Plan item "${item.id}" was set by the user (${item.status}), so it can only move forward to active or done. Leave its status, or ask the user in your summary before changing it.`)
  }
}

const MARK: Record<PlanItemStatus, string> = { done: 'x', active: '~', planned: ' ', kept: 'k', dropped: '-' }

export const PLAN_LEGEND = 'Marks: [x] done · [~] in progress · [ ] to do · [k] kept, not doing · [-] dropped. To change the plan here, change a mark or a step\'s wording, or add a line "- [ ] your step"; the orchestrator is told and must acknowledge it.'

/** The Plan section of progress.md, in the plan's order, with the user's pending changes under it. */
export function planChecklist(run: Pick<Orchestration, 'plan' | 'changes'>): string {
  if (!run.plan.length) return `No plan items yet. Add one with a line "- [ ] your step".`
  const lines = run.plan.map(item => {
    const tasks = item.tasks.length ? ` (${item.tasks.join(', ')})` : ''
    const added = item.from !== null ? ' (added)' : ''
    const yours = item.by === 'user' ? ' (yours)' : ''
    return `- [${MARK[item.status]}] ${item.id} · ${item.text}${tasks}${added}${yours}`
  })
  const pending = run.changes.filter(change => change.ack === null)
  const unseen = pending.length ? `\n\nNot yet seen by the orchestrator:\n${pending.map(change => `  ${change.id} · ${change.text}`).join('\n')}` : ''
  return `${lines.join('\n')}\n\n${PLAN_LEGEND}${unseen}`
}

export type PlanLine = { mark: string; id: string | null; text: string }

const SUFFIX = /\s*\((?:yours|added|\d{4}(?:, \d{4})*)\)\s*$/

/** The checklist lines of progress.md's Plan section, or null when the file has no Plan section. */
export function parsePlanSection(markdown: string): PlanLine[] | null {
  const start = markdown.search(/^## Plan[ \t]*$/m)
  if (start < 0) return null
  const body = markdown.slice(start).split('\n').slice(1)
  const end = body.findIndex(line => line.startsWith('## '))
  const lines: PlanLine[] = []
  for (const line of end < 0 ? body : body.slice(0, end)) {
    const match = /^- \[(.)\] (.*)$/.exec(line.trimEnd())
    if (!match) continue
    const named = /^(\S+) · (.*)$/.exec(match[2]!)
    let text = named ? named[2]! : match[2]!
    while (SUFFIX.test(text)) text = text.replace(SUFFIX, '')
    lines.push({ mark: match[1]!, id: named ? named[1]! : null, text: text.trim() })
  }
  return lines
}

const FROM_MARK: Record<string, PlanItemStatus> = { x: 'done', X: 'done', k: 'kept', K: 'kept', '-': 'dropped' }

/**
 * The edits a hand-edited Plan section asks for. Only what differs from `written`, the section as
 * the host last wrote it, counts. A changed mark is a status change ("[ ]" reopens or restores,
 * "[~]" is the orchestrator's and ignored), changed wording is a reword, and a line with no id the
 * host wrote is a new step. A deleted line changes nothing.
 */
export function fileEdits(run: Pick<Orchestration, 'plan'>, lines: PlanLine[], written: PlanLine[]): PlanEdit[] {
  const before = new Map(written.filter(line => line.id).map(line => [line.id!, line]))
  const edits: PlanEdit[] = []
  for (const line of lines) {
    const was = line.id ? before.get(line.id) : undefined
    if (!was) {
      if (line.text && !run.plan.some(item => item.id === line.id)) edits.push({ type: 'add', text: line.text })
      continue
    }
    const item = run.plan.find(each => each.id === line.id)
    if (!item) continue
    if (line.mark !== was.mark) {
      const wanted = FROM_MARK[line.mark] ?? (line.mark === ' ' && !isOpen(item) ? 'planned' : undefined)
      if (wanted && wanted !== item.status) edits.push({ type: 'status', item: item.id, status: wanted as 'planned' | 'done' | 'kept' | 'dropped' })
    }
    if (line.text && line.text !== was.text && line.text !== item.text) edits.push({ type: 'reword', item: item.id, text: line.text })
  }
  return edits
}

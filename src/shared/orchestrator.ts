import type { ProviderId } from './types.ts'

/**
 * Max running workers per provider within one orchestration run.
 * Claude, Codex, and Cursor each register a per-chat MCP tool URL, so their worker chats can run side by side.
 * Antigravity uses one shared tool URL for every chat, so only one Antigravity worker may run at a time.
 * These counts are usage guards; the machine-wide running cap usually binds first (see machineWorkerLimit).
 */
export const MAX_ACTIVE_PER_PROVIDER: Record<ProviderId, number> = {
  claude: 6,
  codex: 6,
  cursor: 6,
  antigravity: 1
}

export function maxActiveForProvider(provider: ProviderId): number {
  return MAX_ACTIVE_PER_PROVIDER[provider]
}

/** One running worker per 0.75 GiB of available memory, capped by core count, at least one. */
const WORKER_MEMORY_BYTES = 0.75 * 1024 ** 3

export function machineWorkerLimit({ cores, availableBytes }: { cores: number; availableBytes: number }): number {
  const byMemory = Math.floor(availableBytes / WORKER_MEMORY_BYTES)
  return Math.max(1, Math.min(cores, byMemory))
}

/** After a worker's report exists, stop a turn held open only by background tasks. */
export const HELD_OPEN_LIMIT_MS = 3 * 60 * 1000

/** `kept` is the user's "keep this, don't do it": a step the plan meant to remove stays as it is. */
export type PlanItemStatus = 'planned' | 'active' | 'done' | 'kept' | 'dropped'

export type PlanItem = {
  id: string
  text: string
  status: PlanItemStatus
  tasks: string[]
  /** Index into run.updates for the user message that added this item, or null for original scope. */
  from: number | null
  /**
   * 'user' once the user has changed the item. It is locked: the orchestrator may only carry it
   * forward (planned, active, done) and must ask the user before rewording or dropping it.
   */
  by: 'user' | null
}

/** One change the user makes to the plan, from the progress view or by editing progress.md. */
export type PlanEdit =
  | { type: 'status'; item: string; status: 'planned' | 'done' | 'kept' | 'dropped' }
  | { type: 'reword'; item: string; text: string }
  | { type: 'move'; item: string; delta: -1 | 1 }
  | { type: 'add'; text: string }
  /** Take back a change the orchestrator has not acknowledged yet. */
  | { type: 'undo'; change: string }

/**
 * A user change to the plan, kept until the orchestrator acknowledges it. Until then the host
 * refuses its dispatches and any checkpoint that does not acknowledge it, so no change is missed.
 */
export type PlanChange = {
  id: string
  at: number
  item: string
  /** What the orchestrator is told, in a few words: "Kept 06-layouts (do not remove)". */
  text: string
  kind: 'done' | 'reopen' | 'restore' | 'keep' | 'drop' | 'reword' | 'move' | 'add'
  /** For a move, the step it now stands before or after. */
  other: { item: string; before: boolean } | null
  source: 'view' | 'file'
  /** How Undo puts it back; only offered while unacknowledged. */
  undo: { type: 'status'; before: PlanItemStatus } | { type: 'text'; before: string } | { type: 'move'; before: number } | { type: 'add' }
  ack: { cycle: number; at: number; text: string } | null
}

/** Something work cannot continue without (access, permission, a missing input), asked at a checkpoint. */
export type OrchestratorNeed = {
  id: string
  text: string
  /** Who is blocked, in a few words: "Worker 0024 cannot start". */
  from: string | null
  /** The answers offered; the first is the one the orchestrator would pick. */
  options: string[]
  at: number
  answer: string | null
  answeredAt: number | null
}

export type CheckCount = { passed: number; total: number }
/** The latest check results the orchestrator reported, shown in the progress header. */
export type OrchestratorChecks = { at: number; typecheck: 'pass' | 'fail' | null; tests: CheckCount | null; ui: CheckCount | null }

export type OrchestratorDecision = { at: number; text: string }

export const CHECKPOINT_SUMMARY_MAX = 600
export const CHECKPOINT_NEXT_MAX = 400
export const PLAN_ITEM_TEXT_MAX = 140
export const DECISION_TEXT_MAX = 200
/** A worker's title in the progress view and the board; set by the orchestrator at dispatch. */
export const TASK_TITLE_MAX = 60
export const NEED_TEXT_MAX = 200
export const ACK_TEXT_MAX = 200

export type OrchestratorStatus = 'running' | 'draining' | 'paused' | 'stopped'

/** A code worker's private checkout, made when the task starts (docs/worktree-plan.md). */
export type TaskWorktree = { folder: string; branch: string; base: string }

/**
 * What the host did with a worktree task after the leader's verdict: an accept queues a merge,
 * a reject queues a discard. Both run after the checkpoint saves, one at a time.
 */
export type TaskMerge = {
  /** Null when the host marked the task itself, as when its folder went missing. */
  verdict: 'accept' | 'reject' | null
  status: 'queued' | 'merging' | 'merged' | 'refused' | 'discarded'
  at: number
  /** The worker's files: those merged, or those a refusal names. */
  files: string[]
  /** Why a merge was refused: conflict, dirty, moved, check failed, in progress, missing or error. */
  reason: string | null
  /** A full sentence for the leader; a failed check's output follows it on later lines. */
  message: string | null
  /** The squashed commit a merge made, when the app commits. */
  commit: string | null
}

export type OrchestratorTask = {
  id: string
  chatId: string
  turnId: string | null
  provider: ProviderId
  /** null uses the provider default; explicit IDs come from its live model list. */
  model: string | null
  task: string
  /** A short name for the work (at most TASK_TITLE_MAX); derived from the assignment when not given. */
  title: string
  /** The plan step this worker serves, or null. */
  planItem: string | null
  report: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  result: string
  review: string | null
  /** Null for a worker in the main folder, and for a worktree task until it starts. */
  worktree: TaskWorktree | null
  /** True when the task asked for a worktree; it is made at start. */
  wantsWorktree: boolean
  merge: TaskMerge | null
  /** The refused task this one fixes up; its merge marks that one merged too. */
  fixes: string | null
}

export type Orchestration = {
  id: string
  chatId: string
  cwd: string
  provider: ProviderId
  task: string
  progressFile: string
  status: OrchestratorStatus
  reason: string | null
  summary: string
  next: string
  notes: string
  updates: string[]
  /** Parallel to updates; backfilled with run creation time for legacy runs. */
  updateTimes: number[]
  plan: PlanItem[]
  decisions: OrchestratorDecision[]
  /** `quiet` marks a checkpoint that changed nothing but its summary; the view and file leave it out. */
  history: Array<{ at: number; summary: string; next: string; taskId?: string | null; quiet?: boolean }>
  changes: PlanChange[]
  needs: OrchestratorNeed[]
  checks: OrchestratorChecks | null
  tasks: OrchestratorTask[]
  checkpointCycle: number
  cycle: number
  leaderTurnId: string | null
  createdAt: number
  updatedAt: number
}

/** One Activity line for a finished merge; null while queued, merging, or when there is no merge. */
export function mergeActivityText(task: Pick<OrchestratorTask, 'id' | 'title' | 'merge'>): string | null {
  const merge = task.merge
  if (!merge || !['merged', 'refused', 'discarded'].includes(merge.status)) return null
  switch (merge.status) {
    case 'merged': {
      const count = merge.files.length
      const sha = merge.commit?.slice(0, 7)
      let detail = ''
      if (count && sha) detail = ` (${count} files, ${sha})`
      else if (count) detail = ` (${count} ${count === 1 ? 'file' : 'files'})`
      else if (sha) detail = ` (${sha})`
      return `Merged ${task.id} ${task.title}${detail}`
    }
    case 'refused': {
      const reason = merge.reason ?? 'error'
      const names = merge.files.map((file) => file.replace(/^.*[/\\]/, ''))
      const files = names.length === 1 ? ` (${names[0]})` : names.length ? ` (${names.slice(0, 3).join(', ')})` : ''
      return `Refused ${task.id}: ${reason}${files}`
    }
    case 'discarded':
      return `Discarded ${task.id}`
    default:
      return null
  }
}

/**
 * A worktree task's merge state in a few words, for the progress view's Workers table and the
 * board's worker windows. Null until the task has a verdict, and always for a task run in the
 * main folder. `files` and the refusal's sentence go in `title`, shown on hover.
 */
export function mergeLabel(task: Pick<OrchestratorTask, 'merge'>): { text: string; title: string; tone: 'ok' | 'wait' | 'warn' } | null {
  const merge = task.merge
  if (!merge) return null
  const files = merge.files.join('\n')
  const message = merge.message?.split('\n')[0] ?? ''
  const discarding = merge.verdict === 'reject'
  switch (merge.status) {
    case 'queued': return { text: discarding ? 'Discard queued' : 'Merge queued', title: 'Waiting for the merges before it to finish.', tone: 'wait' }
    case 'merging': return { text: discarding ? 'Discarding…' : 'Merging…', title: discarding ? 'Removing its worktree and branch.' : 'Merging and checking typecheck and unit tests.', tone: 'wait' }
    case 'merged': return { text: merge.commit ? `Merged ${merge.commit.slice(0, 7)}` : 'Merged', title: [message, files].filter(Boolean).join('\n'), tone: 'ok' }
    case 'refused': return { text: `Refused: ${merge.reason ?? 'error'}`, title: [message, files].filter(Boolean).join('\n'), tone: 'warn' }
    case 'discarded': return { text: 'Discarded', title: message, tone: 'ok' }
  }
}

/** A filesystem path in a model prompt; backticks keep spaces from breaking Markdown links the model copies. */
export function promptPath(path: string): string {
  return path.includes(' ') ? `\`${path}\`` : path
}

/** A Markdown link to a file; angle brackets keep a spaced path a valid link destination. */
export function promptFileLink(path: string, label?: string): string {
  const text = label ?? path.replace(/^.*[/\\]/, '')
  return path.includes(' ') ? `[${text}](<${path}>)` : `[${text}](${path})`
}

export function pendingChanges(run: Pick<Orchestration, 'changes'>): PlanChange[] {
  return run.changes.filter(change => change.ack === null)
}

/** What the orchestrator is told about the user's plan changes; the progress view shows the same text. */
export function pendingChangesText(run: Pick<Orchestration, 'changes'>): string {
  const pending = pendingChanges(run)
  if (!pending.length) return ''
  return [
    'The user changed the plan since your last review. Acknowledge each change in your next checkpoint (acknowledge: change id and one short sentence on what you will do) before dispatching. Items the user set are locked: carry them forward, but ask before rewording, dropping or reopening them.',
    ...pending.map(change => `- ${change.id}: ${change.text}`)
  ].join('\n')
}

/** A review that found nothing new, from before quiet checkpoints were marked. */
const LEGACY_QUIET = /^Review \d+: no (?:new )?reports?\b/i

export function isQuietReview(entry: Orchestration['history'][number]): boolean {
  return entry.quiet === true || (!entry.taskId && LEGACY_QUIET.test(entry.summary))
}

/** The first sentence, ending at punctuation followed by a space or the end, so "progress.md" stays whole. */
export function firstSentence(text: string): string {
  const line = text.split('\n').find(each => each.trim())?.trim() ?? text.trim()
  const match = line.match(/^.*?[.!?](?=\s|$)/)
  return (match ? match[0] : line).trim()
}

/** A change as the progress view words it: by the steps' wording, without plan ids. */
export function changeLabel(change: PlanChange, plan: PlanItem[]): string {
  const name = (id: string) => `"${plan.find(item => item.id === id)?.text ?? id}"`
  const step = name(change.item)
  switch (change.kind) {
    case 'done': return `Marked ${step} done`
    case 'reopen': return `Reopened ${step}`
    case 'restore': return `Put ${step} back in the plan`
    case 'keep': return `Kept ${step}: do not do or remove it`
    case 'drop': return `Dropped ${step}`
    case 'reword': return `Reworded a step to ${step}`
    case 'add': return `Added ${step}`
    case 'move': return change.other ? `Moved ${step} ${change.other.before ? 'before' : 'after'} ${name(change.other.item)}` : `Moved ${step}`
  }
}

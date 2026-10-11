import { randomUUID } from 'node:crypto'
import { cpus, freemem } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Chat, Item, ModelInfo, ProviderId, Turn } from '../shared/types.ts'
import type { CheckCount, Orchestration, OrchestratorChecks, OrchestratorTask, PlanEdit, PlanItem, TaskMerge } from '../shared/orchestrator.ts'
import {
  ACK_TEXT_MAX,
  CHECKPOINT_NEXT_MAX,
  CHECKPOINT_SUMMARY_MAX,
  DECISION_TEXT_MAX,
  HELD_OPEN_LIMIT_MS,
  NEED_TEXT_MAX,
  PLAN_ITEM_TEXT_MAX,
  TASK_TITLE_MAX,
  isQuietReview,
  machineWorkerLimit,
  maxActiveForProvider,
  pendingChanges,
  pendingChangesText,
  promptPath
} from '../shared/orchestrator.ts'
import { PROVIDERS } from '../shared/types.ts'
import { repoRoot } from './git.ts'
import { messageOf } from './json.ts'
import type { Worktrees } from './worktrees.ts'
import { worktreeHome, type WorktreeHome } from './worktree-home.ts'
import { applyPlanEdit, checkLockedUpdate, deriveTitle, fileEdits, firstSentence, parsePlanSection, planChecklist, type PlanLine } from './orchestrator-plan.ts'

export const NOTES_MARKER = '<!-- rocket-orchestrator:user-notes -->'
const NOTES_DEFAULT = '\n## User notes\n\nEdit this section to steer the next review, or message the orchestrator chat.\n'

/** Local time, minute precision, so the progress file reads the way the user's clock does. */
function localStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatAddedSince(run: Orchestration): string {
  if (!run.updates.length) return 'No chat updates yet.'
  return run.updates.map((text, index) => {
    const linked = run.plan.filter(item => item.from === index).map(item => item.id)
    const planLine = linked.length ? linked.join(', ') : 'not yet taken up'
    const at = run.updateTimes[index] ?? run.createdAt
    return `- ${localStamp(at)} — ${text}\n  Plan items: ${planLine}`
  }).join('\n\n')
}

/** How many unreviewed or running workers appear in leader review and tool status before an omission line. */
export const PENDING_WORKERS_SHOWN = 20

export type CompactWorkerRecord = {
  id: string
  /** The worker's chat and current turn, so the leader can reply to, expand or release it. */
  chatId: string
  turnId: string | null
  title: string
  provider: ProviderId
  model: string | null
  status: OrchestratorTask['status']
  planItem: string | null
  report: string
  startedAt: number | null
  endedAt: number | null
  result: string
  reviewed: boolean
  /** Whether the worker edits in its own worktree rather than the main folder. */
  worktree: boolean
  merge: { verdict: TaskMerge['verdict']; status: TaskMerge['status']; files: string[]; message: string | null } | null
}

function compactWorkerResult(task: OrchestratorTask): string {
  const result = task.result.trim()
  if (!result) return ''
  if (task.status === 'failed' || task.status === 'interrupted') {
    const providerTail = result.match(/Provider's last reply:\s*([\s\S]*)$/)?.[1]?.trim()
    const focus = providerTail || result
    let kept = firstSentence(focus)
    if (kept.length < focus.length && focus.length <= 1000) kept = focus
    return kept.length <= 1000 ? kept : kept.slice(0, 1000)
  }
  return result.length <= 300 ? result : result.slice(0, 300)
}

export function compactWorkerRecord(task: OrchestratorTask): CompactWorkerRecord {
  return {
    id: task.id,
    chatId: task.chatId,
    turnId: task.turnId,
    title: task.title,
    provider: task.provider,
    model: task.model,
    status: task.status,
    planItem: task.planItem,
    report: task.report,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    result: compactWorkerResult(task),
    reviewed: task.review !== null,
    worktree: task.wantsWorktree,
    merge: task.merge ? { verdict: task.merge.verdict, status: task.merge.status, files: task.merge.files.slice(0, 10), message: task.merge.message?.split('\n')[0] ?? null } : null
  }
}

export function pendingWorkersForLeader(tasks: OrchestratorTask[]): {
  workers: CompactWorkerRecord[]
  omittedPendingTasks: number
  omittedTaskIds: string[]
} {
  const pending = tasks.filter(task => !task.review || task.status === 'running')
  const omittedPendingTasks = Math.max(0, pending.length - PENDING_WORKERS_SHOWN)
  const omittedTaskIds = pending.slice(0, pending.length - PENDING_WORKERS_SHOWN).map(task => task.id)
  const workers = pending.slice(-PENDING_WORKERS_SHOWN).map(compactWorkerRecord)
  return { workers, omittedPendingTasks, omittedTaskIds }
}

export function formatWorkersPrompt(tasks: OrchestratorTask[]): string {
  const { workers, omittedPendingTasks, omittedTaskIds } = pendingWorkersForLeader(tasks)
  const lines = [`Workers: ${JSON.stringify(workers)}`]
  if (omittedPendingTasks > 0) lines.push(`Omitted workers (${omittedPendingTasks} more): ${omittedTaskIds.join(', ')}`)
  return lines.join('\n\n')
}

const MERGES_SHOWN = 5

/**
 * Merges the leader has to act on (refused), is waiting for (queued, merging), and the latest
 * that finished. A refusal keeps its full sentence and a failed check's output, so the leader
 * can brief a fix-up worker without opening anything.
 */
export function formatMergesPrompt(tasks: OrchestratorTask[]): string {
  const open = tasks.filter(task => task.merge && ['queued', 'merging', 'refused'].includes(task.merge.status))
  const done = tasks.filter(task => task.merge && (task.merge.status === 'merged' || task.merge.status === 'discarded'))
    .sort((a, b) => a.merge!.at - b.merge!.at).slice(-MERGES_SHOWN)
  if (!open.length && !done.length) return ''
  const line = (task: OrchestratorTask) => {
    const merge = task.merge!
    const files = merge.files.length ? ` (${merge.files.slice(0, 10).join(', ')}${merge.files.length > 10 ? `, +${merge.files.length - 10} more` : ''})` : ''
    const fixer = tasks.find(each => each.fixes === task.id && !(each.merge && ['refused', 'discarded'].includes(each.merge.status)))
    const after = merge.status !== 'refused' ? '' : fixer
      ? ` Fix-up ${fixer.id} is working on it.`
      : ` Dispatch a fix-up with fixes: "${task.id}", or checkpoint taskId "${task.id}" with verdict reject to discard it.`
    return `- ${task.id} ${task.title}: ${merge.status}${files}${merge.message ? `. ${merge.message}` : ''}${after}`
  }
  return ['Merges (accept merges a worktree task into the main folder; reject discards it):', ...open.map(line), ...done.map(line)].join('\n')
}

/** Compact orchestrator tool and status payloads: short worker rows, bounded history, indexed updates. */
export function serializeOrchestrationState(run: Orchestration, limits?: { machineWorkerLimit: number }) {
  const { workers, omittedPendingTasks, omittedTaskIds } = pendingWorkersForLeader(run.tasks)
  const updateStart = Math.max(0, run.updates.length - 10)
  return {
    ...run,
    history: run.history.slice(-3),
    updates: run.updates.slice(-10).map((text, offset) => ({ index: updateStart + offset, text })),
    decisions: run.decisions.slice(-8),
    tasks: workers,
    totalTasks: run.tasks.length,
    omittedPendingTasks,
    ...(omittedPendingTasks > 0 ? { omittedTaskIds } : {}),
    ...(limits ? { machineWorkerLimit: limits.machineWorkerLimit } : {}),
    instruction: 'Full progress, history and reports are in progressFile. Use orchestrator detail for a worker\'s full assignment. Review evidence before checkpointing.'
  }
}

function availableMemoryBytes(): number {
  try {
    const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m)
    if (match) return Number(match[1]) * 1024
  } catch { /* not Linux or unreadable */ }
  return freemem()
}

export function detectMachineWorkerLimit(): number {
  return machineWorkerLimit({ cores: cpus().length, availableBytes: availableMemoryBytes() })
}

function workerVerdict(task: OrchestratorTask): string {
  if (task.review) return (task.review.trim().split(/\s+/)[0] ?? '').replace(/[^\w-]/g, '') || task.review.trim().slice(0, 20)
  if (!['running', 'queued'].includes(task.status)) return 'awaiting review'
  return ''
}

/** Where the worker edits, and what became of its worktree: the Workers table's merge column. */
function mergeCell(task: OrchestratorTask): string {
  if (!task.wantsWorktree) return 'main'
  const merge = task.merge
  if (!merge) return task.worktree ? 'worktree' : task.status === 'queued' || task.status === 'running' ? 'worktree at start' : 'no worktree'
  const files = (names: string[]) => names.slice(0, 3).map(name => basename(name)).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '')
  switch (merge.status) {
    case 'queued': return merge.verdict === 'reject' ? 'discard queued' : 'merge queued'
    case 'merging': return merge.verdict === 'reject' ? 'discarding' : 'merging'
    case 'merged': return `merged${merge.commit ? ` ${merge.commit.slice(0, 7)}` : ''} · ${merge.files.length} files`
    case 'refused': return `refused: ${merge.reason ?? 'error'}${merge.files.length ? ` (${files(merge.files)})` : ''}`
    case 'discarded': return 'discarded'
  }
}

function formatWorkersTable(tasks: OrchestratorTask[]): string {
  if (!tasks.length) return 'No workers dispatched yet.'
  const header = '| id | provider | model | status | verdict | merge | title | step | report |'
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  const rows = tasks.map(task => {
    const model = task.model ?? 'default'
    const report = `[${basename(task.report)}](${basename(task.report)})`
    const cells = [task.id, task.provider, model, task.status, workerVerdict(task), mergeCell(task).replace(/\|/g, '/'), task.title.replace(/\|/g, '/'), task.planItem ?? '', report]
    return `| ${cells.join(' | ')} |`
  })
  return [header, sep, ...rows].join('\n')
}

function formatDecisions(run: Orchestration): string {
  if (!run.decisions.length) return 'No recorded decisions yet.'
  return run.decisions.map(entry => `- ${localStamp(entry.at)} — ${entry.text}`).join('\n')
}

function formatNeeds(run: Orchestration): string {
  const open = run.needs.filter(need => need.answer === null)
  if (!open.length) return 'Nothing is waiting on you.'
  return open.map(need => `- ${need.text}${need.from ? ` (${need.from})` : ''}${need.options.length ? `\n  Answers: ${need.options.join(' · ')}` : ''}`).join('\n')
}

function formatChecks(checks: OrchestratorChecks | null): string {
  if (!checks) return ''
  const count = (name: string, value: CheckCount | null) => value ? `${name} ${value.passed}/${value.total}` : ''
  const parts = [checks.typecheck ? `typecheck ${checks.typecheck === 'pass' ? '✓' : '✗'}` : '', count('tests', checks.tests), count('UI', checks.ui)].filter(Boolean)
  return parts.length ? `Checks: ${parts.join(' · ')} (${localStamp(checks.at)})` : ''
}

function formatReviews(history: Orchestration['history']): string {
  const shown = history.filter(entry => !isQuietReview(entry))
  if (!shown.length) return 'No checkpoints yet.'
  return shown.map(entry => {
    const taskPart = entry.taskId ? `task ${entry.taskId}` : 'no task review'
    return `- ${localStamp(entry.at)} — ${taskPart} — ${firstSentence(entry.summary)}`
  }).join('\n')
}

type CheckedPlanItem = { partial: Partial<PlanItem>; id: string; text: string }

function validateUpsertPlan(run: Orchestration, items: Partial<PlanItem>[]): CheckedPlanItem[] {
  return items.map(partial => {
    const id = partial.id?.trim()
    const text = partial.text?.trim()
    if (!id) throw new Error('Each plan item needs an id.')
    if (!text) throw new Error(`Plan item "${id}" needs text.`)
    if (text.length > PLAN_ITEM_TEXT_MAX) throw new Error(`Plan item text must be at most ${PLAN_ITEM_TEXT_MAX} characters.`)
    if (partial.status === 'kept') throw new Error('Only the user keeps a step. Use planned, active, done or dropped.')
    const existing = run.plan.find(item => item.id === id)
    if (existing) checkLockedUpdate(existing, text, partial.status)
    return { partial, id, text }
  })
}

function applyUpsertPlan(run: Orchestration, checked: CheckedPlanItem[]): void {
  for (const { partial, id, text } of checked) {
    const existing = run.plan.find(item => item.id === id)
    if (existing) {
      existing.text = text
      if (partial.status !== undefined) existing.status = partial.status
      // Dispatch links workers to their step, so a checkpoint's list adds to those links rather than replacing them.
      if (partial.tasks !== undefined) existing.tasks = [...new Set([...existing.tasks, ...partial.tasks])]
      if (partial.from !== undefined) existing.from = partial.from
    } else {
      run.plan.push({ id, text, status: partial.status ?? 'planned', tasks: partial.tasks ?? [], from: partial.from ?? null, by: null })
    }
  }
}

function validateCheckpointChecks(checks: CheckpointExtra['checks']): void {
  if (!checks) return
  const count = (name: string, value: CheckCount | undefined) => {
    if (value === undefined) return
    if (!Number.isInteger(value.passed) || !Number.isInteger(value.total) || value.passed < 0 || value.passed > value.total) {
      throw new Error(`Give ${name} check counts as whole numbers, with passed no more than total.`)
    }
  }
  count('tests', checks.tests)
  count('ui', checks.ui)
}

export type CheckpointExtra = {
  /** With taskId and review: accept merges a worktree task's work, reject discards it. */
  verdict?: 'accept' | 'reject'
  acknowledge?: Array<{ change: string; text: string }>
  needs?: Array<{ id: string; text: string; from?: string; options?: string[] }>
  checks?: { typecheck?: 'pass' | 'fail'; tests?: CheckCount; ui?: CheckCount }
}

/** The parts of the worktrees service (worktrees.ts) the orchestrator uses. */
export type WorktreeService = Pick<Worktrees, 'create' | 'merge' | 'discard' | 'reconcile'>

export type OrchestratorOptions = {
  /** Override the machine-derived running-worker cap (tests). */
  machineWorkerLimit?: number
  now?: () => number
  /** Code workers' private checkouts, by the run's folder. Without it every worker runs in the main folder. */
  worktrees?: (cwd: string) => WorktreeService
  /** Commits a reviewed task's report, evidence and the progress file, which no turn's commit takes. */
  commitReport?: (cwd: string, paths: string[], message: string) => Promise<unknown>
  /**
   * Called once a worktree task's merge lands in the main folder, with the repository root the
   * files are relative to and the files the merge wrote. A fix-up's merge reports its own files.
   */
  merged?: (task: OrchestratorTask, main: string, files: string[]) => void | Promise<void>
  warn?: (message: string) => void
}

type OrchestratorStore = { chat(id: string): Chat | null }
export type OrchestratorHub = {
  createChat(cwd: string, title: string): Chat
  send(chatId: string, provider: ProviderId, model: string | null, text: string): string
  post(chatId: string, provider: ProviderId, model: string | null, text: string): Promise<void>
  models(provider: ProviderId): Promise<ModelInfo[]>
  working(): Array<{ chatId: string; provider: ProviderId }>
  liveTurn(chatId: string): Turn | null
  turnItems(chatId: string, turnId: string): Item[]
  stop(chatId: string): Promise<void>
  /** Moves a worker's chat into its worktree once that exists. */
  setCwd(chatId: string, cwd: string): Chat
}

const HELD_OPEN_ACTIVITY = /^Waiting for \d+ background tasks?$/
export const HELD_OPEN_RESULT = 'The host ended this worker after its report was written because background work kept the turn open.'

/** The host schedules turns; the owning model reviews evidence and chooses deeper work. */
export class Orchestrator {
  private readonly runs = new Map<string, Orchestration>()
  private readonly modelCache = new Map<string, { at: number; models: Promise<ModelInfo[]> }>()
  private readonly wake = new Set<string>()
  private readonly heldOpenSince = new Map<string, number>()
  /** The Plan section as last written, by run, so a hand edit is told apart from the host's own changes. */
  private readonly writtenPlan = new Map<string, { lines: PlanLine[]; mtime: number }>()
  private readonly hub: OrchestratorHub
  private timer: NodeJS.Timeout | null = null
  private closing = false
  stateError: string | null = null
  readonly machineWorkerLimit: number
  private readonly now: () => number
  private readonly worktrees: ((cwd: string) => WorktreeService) | null
  /** `run:task` of worktree tasks whose slot is reserved while their worktree is being made. */
  private readonly starting = new Set<string>()
  /** Merges and discards run one at a time, in verdict order. */
  private mergeChain: Promise<void> = Promise.resolve()
  /** Async work in flight (worktree starts, merges, report commits), so tests and shutdown can wait for it. */
  private readonly inFlight = new Set<Promise<unknown>>()
  /** Startup reconciliation of saved worktrees; nothing makes a new worktree before it ends. */
  private recovered: Promise<void> = Promise.resolve()

  constructor(
    private readonly stateFile: string,
    private readonly store: OrchestratorStore,
    hub: Omit<OrchestratorHub, 'liveTurn' | 'setCwd'> & Partial<Pick<OrchestratorHub, 'liveTurn' | 'setCwd'>>,
    private readonly emit: (run: Orchestration) => void,
    private readonly options: OrchestratorOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.machineWorkerLimit = options.machineWorkerLimit ?? detectMachineWorkerLimit()
    this.worktrees = options.worktrees ?? null
    this.hub = {
      createChat: (...args) => hub.createChat(...args),
      send: (...args) => hub.send(...args),
      post: (...args) => hub.post(...args),
      models: provider => hub.models(provider),
      working: () => hub.working(),
      liveTurn: chatId => hub.liveTurn?.(chatId) ?? null,
      turnItems: (...args) => hub.turnItems(...args),
      stop: chatId => hub.stop(chatId),
      setCwd: (chatId, cwd) => {
        if (!hub.setCwd) throw new Error('This host cannot move a chat into a worktree. Dispatch without a worktree.')
        return hub.setCwd(chatId, cwd)
      }
    }
    if (existsSync(stateFile)) {
      let saved: Orchestration[]
      try {
        saved = JSON.parse(readFileSync(stateFile, 'utf8')) as Orchestration[]
        if (!Array.isArray(saved) || saved.some(run => !run || typeof run.chatId !== 'string' || typeof run.progressFile !== 'string' || !Array.isArray(run.tasks))) throw new Error('Invalid orchestration state')
      } catch (error) {
        this.stateError = `Cannot read saved orchestration state at ${stateFile}: ${messageOf(error)}. The file was preserved.`
        return
      }
      for (const run of saved) {
        // Restart never silently spends usage or assumes a killed provider stopped cleanly.
        if (run.status === 'running' || run.status === 'draining') {
          run.status = 'paused'
          run.reason = 'Craft Studio restarted. Review the saved work and resume when ready.'
        }
        run.leaderTurnId = null
        run.history ??= []
        run.plan ??= []
        run.decisions ??= []
        run.changes ??= []
        run.needs ??= []
        run.checks ??= null
        for (const item of run.plan) item.by ??= null
        run.updateTimes ??= run.updates.map(() => run.createdAt)
        if (run.updateTimes.length < run.updates.length) {
          run.updateTimes.push(...run.updates.slice(run.updateTimes.length).map(() => run.createdAt))
        }
        for (const task of run.tasks) {
          task.model ??= null
          task.title ??= deriveTitle(task.task)
          task.planItem ??= run.plan.find(item => item.tasks.includes(task.id))?.id ?? null
          task.createdAt ??= run.createdAt
          task.startedAt ??= task.status === 'queued' || task.status === 'cancelled' ? null : task.createdAt
          task.endedAt ??= task.status === 'queued' || task.status === 'running' ? null : run.updatedAt
          task.worktree ??= null
          task.wantsWorktree ??= task.worktree !== null
          task.merge ??= null
          task.fixes ??= null
          // A merge cut off by the restart starts again from the top; it wrote nothing until its last step.
          if (task.merge?.status === 'merging') task.merge.status = 'queued'
          if (task.status === 'running') {
            task.status = 'interrupted'
            task.endedAt = this.now()
            // The worktree is kept, edits and all: the leader can reply to continue, or give a verdict.
            task.result = task.worktree
              ? `Interrupted by host restart; its worktree at ${task.worktree.folder} keeps its edits. Inspect the report, then reply to continue it or checkpoint a verdict.`
              : 'Interrupted by host restart; inspect the report before retrying.'
          }
        }
        this.runs.set(run.chatId, run)
        // The saved state and the file were written together, so any difference is the user's edit while Craft Studio was closed.
        this.writtenPlan.set(run.id, { lines: parsePlanSection(`## Plan\n${planChecklist(run)}`) ?? [], mtime: 0 })
        this.save(run)
      }
      if (this.worktrees) this.recovered = this.track(this.reconcileWorktrees())
    }
  }

  startMonitoring(): void {
    this.timer ??= setInterval(() => this.tick(), 2_000)
    this.timer.unref()
  }

  list(): Orchestration[] { return structuredClone([...this.runs.values()]) }
  get(chatId: string): Orchestration | null { return structuredClone(this.runs.get(chatId) ?? null) }

  /** Saved ownership is authoritative even for finished, reopened and restarted workers. */
  roleOf(chatId: string): 'leader' | 'worker' | 'ordinary' {
    if (this.runs.has(chatId)) return 'leader'
    return this.workerTitle(chatId) ? 'worker' : 'ordinary'
  }

  /** The main folder and start time when `cwd` is inside a task's worktree; null otherwise. */
  worktreeOf(cwd: string): WorktreeHome | null { return worktreeHome(this.runs.values(), cwd) }

  workerTitle(chatId: string): string | null {
    for (const run of this.runs.values()) {
      const task = run.tasks.find(task => task.chatId === chatId)
      if (task) return `worker ${task.id}: ${task.title}`
    }
    return null
  }

  start(chatId: string, provider: ProviderId, task: string): Orchestration {
    if (this.stateError) throw new Error(this.stateError)
    if (this.runs.has(chatId)) throw new Error('This chat already owns an orchestration. Resume it or use a new chat.')
    if ([...this.runs.values()].some(run => run.tasks.some(each => each.chatId === chatId))) throw new Error('Workers cannot start nested orchestrations.')
    const chat = this.store.chat(chatId)
    if (!chat) throw new Error('Open a chat with a working folder first.')
    if (!task.trim()) throw new Error('Give the orchestrator a task.')
    const id = randomUUID()
    const run: Orchestration = {
      id, chatId, provider, cwd: chat.cwd, task: task.trim(),
      progressFile: join(chat.cwd, 'docs', 'orchestrator', id, 'progress.md'),
      status: 'running', reason: null, summary: 'Starting the task and choosing the first investigations.',
      next: 'Review the task and dispatch focused work.', notes: NOTES_DEFAULT, updates: [], updateTimes: [], plan: [], decisions: [], history: [], changes: [], needs: [], checks: null, tasks: [],
      checkpointCycle: 0, cycle: 0, leaderTurnId: null, createdAt: this.now(), updatedAt: this.now()
    }
    this.runs.set(chatId, run)
    this.save(run)
    this.wake.add(chatId)
    return this.get(chatId)!
  }

  /** Model discovery is shared per run for three minutes; failures are retried next time. */
  async models(chatId: string, provider?: ProviderId): Promise<Array<{ provider: ProviderId; models: ModelInfo[]; warning?: string }>> {
    const run = this.require(chatId)
    return Promise.all((provider ? [provider] : PROVIDERS.map(entry => entry.id)).map(async id => {
      try { return { provider: id, models: await this.readModels(run.id, id) } }
      catch (error) { return { provider: id, models: [], warning: `The model list for ${id} could not be read: ${messageOf(error)}. Dispatch without a model to use the provider default.` } }
    }))
  }

  private readModels(runId: string, provider: ProviderId): Promise<ModelInfo[]> {
    const key = `${runId}:${provider}`
    const cached = this.modelCache.get(key)
    if (cached && this.now() - cached.at < 180_000) return cached.models
    const models = Promise.resolve().then(() => this.hub.models(provider)).then(list => {
      if (!list.length) throw new Error('The provider returned no available models.')
      return list
    })
    this.modelCache.set(key, { at: this.now(), models })
    void models.catch(() => { if (this.modelCache.get(key)?.models === models) this.modelCache.delete(key) })
    return models
  }

  async dispatch(
    chatId: string,
    provider: ProviderId,
    task: string,
    model: string | null = null,
    options: { title?: string; planItem?: string; worktree?: boolean; fixes?: string } = {}
  ): Promise<Orchestration> {
    const run = this.require(chatId)
    const title = options.title?.trim() || deriveTitle(task.trim())
    const planItem = options.planItem?.trim() || null
    const fixes = options.fixes?.trim() || null
    // Every worker that may edit gets a worktree; the leader opts out for read-only research.
    let worktree = options.worktree ?? (provider !== 'antigravity' && this.worktrees !== null)
    const check = () => {
      if (run.status !== 'running') throw new Error('Resume the orchestrator before dispatching work.')
      if (!task.trim()) throw new Error('Give the worker a focused assignment.')
      if (title.length > TASK_TITLE_MAX) throw new Error(`Keep the worker title to ${TASK_TITLE_MAX} characters; this one is ${title.length}.`)
      const unseen = pendingChanges(run)
      if (unseen.length) throw new Error(`The user changed the plan (${unseen.map(change => `${change.id}: ${change.text}`).join('; ')}). Acknowledge each change in a checkpoint before dispatching.`)
      if (planItem) {
        const step = run.plan.find(item => item.id === planItem)
        if (!step) throw new Error(`There is no plan item "${planItem}". Add it at a checkpoint first, or dispatch without planItem.`)
        if (step.status === 'kept' || step.status === 'dropped' || step.status === 'done') throw new Error(`Plan item "${planItem}" is ${step.status}, so no worker should be sent for it. Choose an open step.`)
      }
      if (provider === 'antigravity' && (run.provider === 'antigravity' || this.hub.working().some(turn => turn.provider === provider && !run.tasks.some(each => each.chatId === turn.chatId)))) throw new Error('Antigravity uses shared tool identity and is already reserved or running. Choose another available worker provider.')
      if (run.tasks.some(each => !['running', 'queued', 'cancelled'].includes(each.status) && !each.review)) throw new Error('Review the finished worker evidence with checkpoint before dispatching deeper work.')
      if (options.worktree === true && provider === 'antigravity') throw new Error('Antigravity can only write inside its own folder, so it always works in the main folder. Dispatch it without worktree, or choose Claude, Codex or Cursor for code changes.')
      if (options.worktree === true && !this.worktrees) throw new Error('Worktrees are not available in this session of Craft Studio. Dispatch with worktree false.')
      if (fixes) {
        const target = run.tasks.find(each => each.id === fixes)
        if (!target) throw new Error(`There is no task "${fixes}" to fix up. Name a task whose merge was refused.`)
        if (target.merge?.status !== 'refused') throw new Error(`Task ${fixes} has no refused merge, so it needs no fix-up. Only a refused merge is fixed up.`)
        if (!worktree) throw new Error('A fix-up changes code, so it needs a worktree. Dispatch it with Claude, Codex or Cursor and leave worktree on.')
      }
    }
    check()
    if (worktree && !(await repoRoot(run.cwd).catch(() => null))) {
      if (options.worktree === true) throw new Error(`${run.cwd} is not inside a git repository, so no worktree can be made. Dispatch with worktree false.`)
      worktree = false
    }
    let warning: string | null = null
    if (model !== null) {
      let available: ModelInfo[] | null = null
      // Dispatch consults Hub at acceptance time; Hub owns the provider discovery cache.
      try {
        available = await this.hub.models(provider)
        if (!available.length) throw new Error('The provider returned no available models.')
      } catch (error) {
        warning = `The model list for ${provider} could not be read: ${messageOf(error)}. Using the provider default instead of requested model ${model}.`
        model = null
      }
      if (model !== null && available && !available.some(entry => entry.id === model)) {
        throw new Error(`Model "${model}" is not available for ${provider}. Choose one of the available model IDs: ${available.map(entry => entry.id).join(', ')}.`)
      }
    }
    check()
    if (warning) run.updates.push(warning)
    const id = String(run.tasks.length + 1).padStart(4, '0')
    const chat = this.hub.createChat(run.cwd, `Orchestrator ${id}: ${title}`)
    const report = join(dirname(run.progressFile), `task-${id}-${provider}.md`)
    // A worktree task's chat starts in the main folder and moves into its worktree when that is made at start.
    const worker: OrchestratorTask = {
      id, chatId: chat.id, turnId: null, provider, model, task: task.trim(), title, planItem, report, status: 'queued', createdAt: this.now(), startedAt: null, endedAt: null, result: '', review: null,
      worktree: null, wantsWorktree: worktree, merge: null, fixes
    }
    run.tasks.push(worker)
    const step = planItem ? run.plan.find(item => item.id === planItem) : undefined
    if (step) {
      if (!step.tasks.includes(id)) step.tasks.push(id)
      if (step.status === 'planned') step.status = 'active'
    }
    // A queued chat has ownership and a report path, but no provider turn or usage yet.
    this.save(run)
    this.startQueued(run)
    return this.get(chatId)!
  }

  /** Dispatch approval survives waiting; only capacity and shared identity gate queued starts. */
  private startQueued(run: Orchestration): void {
    if (this.closing || run.status !== 'running') return
    for (const worker of run.tasks) {
      if (run.status !== 'running') break
      if (worker.status !== 'queued') continue
      const active = run.tasks.filter(each => each.status === 'running')
      if (active.length >= this.machineWorkerLimit) continue
      const cap = maxActiveForProvider(worker.provider)
      if (active.filter(each => each.provider === worker.provider).length >= cap) continue
      if (worker.provider === 'antigravity' && (run.provider === 'antigravity' || this.hub.working().some(turn => turn.provider === 'antigravity'))) continue
      worker.status = 'running'
      worker.startedAt = this.now()
      // Persist the reservation before send; a synchronous failure releases it below.
      this.save(run)
      if (run.status !== 'running') {
        worker.status = 'queued'
        worker.startedAt = null
        this.save(run)
        break
      }
      if (worker.wantsWorktree) {
        // The slot is held while the worktree is made, so its base is the main folder as it is now.
        this.starting.add(`${run.id}:${worker.id}`)
        this.track(this.startInWorktree(run, worker))
        continue
      }
      this.sendWorker(run, worker)
    }
  }

  private sendWorker(run: Orchestration, worker: OrchestratorTask): void {
    try {
      worker.turnId = this.hub.send(worker.chatId, worker.provider, worker.model, this.workerPrompt(run, worker))
    } catch (error) {
      worker.status = 'failed'
      worker.endedAt = this.now()
      worker.result = messageOf(error)
      this.wake.add(run.chatId)
    }
    this.save(run)
  }

  private workerPrompt(run: Orchestration, worker: OrchestratorTask): string {
    const evidence = join(dirname(worker.report), `task-${worker.id}-evidence`)
    const fixed = worker.fixes ? run.tasks.find(each => each.id === worker.fixes) : undefined
    return [
      '<rocket-orchestration>\nYou are one worker in a continuous orchestration. Complete this assignment, write the report, and end your turn. The owning chat reviews your evidence and chooses the next task.',
      'End your turn as soon as the report is written and stop any background command or watcher you started, because the host holds the turn open while one runs.',
      'Never wait for an answer; make the call, state the assumption in the report\'s open questions, and let the orchestrator reply if it disagrees.',
      `User task: ${run.task}`, `Assignment: ${worker.task}`,
      worker.worktree ? [
        `You work in your own git worktree at ${promptPath(worker.worktree.folder)}: a private copy of ${promptPath(run.cwd)} made when you started, uncommitted work included. Make your code changes there, and run builds and tests there.`,
        `Your changes reach ${promptPath(run.cwd)} only when the orchestrator accepts your work; the host then merges them. Do not edit files in ${promptPath(run.cwd)} other than your report and evidence. Do not run npm install or npm run dev, and do not run git commands that change anything.`
      ].join(' ') : '',
      fixed?.worktree && fixed.merge ? [
        `This is a fix-up for task ${fixed.id} ("${fixed.title}"), whose merge was refused: ${fixed.merge.message ?? 'no reason was recorded.'}`,
        fixed.merge.files.length ? `Files named: ${fixed.merge.files.join(', ')}.` : '',
        `Its intended change is in ${promptPath(fixed.worktree.folder)}, on branch ${fixed.worktree.branch} from base ${fixed.worktree.base.slice(0, 12)}. Read it there, then make that change work against the main folder as it is now, which your worktree holds. When your work is merged, task ${fixed.id} counts as merged too.`
      ].filter(Boolean).join(' ') : '',
      `Write your report to ${promptPath(worker.report)}. Keep isolated evidence beside it in ${promptPath(`${evidence}/`)}.`,
      `Latest reviewed summary: ${run.summary}`, `User updates: ${run.updates.join('\n')}`, `User notes: ${run.notes}`,
      'Follow the user task’s scope. Do not expand research into implementation without authorization. Respect other workers’ files. State what was observed, what remains uncertain, and how to reproduce checks. Open primary sources for uncertain external facts.',
      'Do not create other workers, control the orchestrator, modify its progress file, or operate other chats. Do not restart or close Craft Studio. Finish with the report path and unresolved questions.'
    ].filter(Boolean).join('\n\n')
  }

  /**
   * The asynchronous start of a worktree task: make the worktree, move the chat into it, send.
   * A failure fails the task with the sentence and frees the slot. A task cancelled or stopped
   * while its worktree was being made never ran, so its worktree is discarded.
   */
  private async startInWorktree(run: Orchestration, worker: OrchestratorTask): Promise<void> {
    const key = `${run.id}:${worker.id}`
    const service = this.worktrees!(run.cwd)
    try {
      await this.recovered
      if (worker.status !== 'running' || this.closing) return
      let made: OrchestratorTask['worktree']
      try {
        made = await service.create(run.id, worker.id)
      } catch (error) {
        if (worker.status !== 'running') return
        worker.status = 'failed'
        worker.endedAt = this.now()
        worker.result = messageOf(error)
        this.wake.add(run.chatId)
        this.save(run)
        this.startQueued(run)
        return
      }
      worker.worktree = made
      // Shutting down: keep it; the restart marks the task interrupted and keeps its worktree.
      if (this.closing) return this.persist()
      if (worker.status !== 'running') {
        await service.discard({ run: run.id, task: worker.id }).catch(error => this.options.warn?.(`Task ${worker.id}'s worktree could not be removed: ${messageOf(error)}`))
        worker.worktree = null
        this.save(run)
        return
      }
      try {
        this.hub.setCwd(worker.chatId, made.folder)
      } catch (error) {
        worker.status = 'failed'
        worker.endedAt = this.now()
        worker.result = messageOf(error)
        this.wake.add(run.chatId)
      }
      if (worker.status === 'running') this.sendWorker(run, worker)
      if (worker.status === 'failed') {
        await service.discard({ run: run.id, task: worker.id }).catch(() => {})
        worker.worktree = null
        this.save(run)
        this.startQueued(run)
      }
    } finally {
      this.starting.delete(key)
    }
  }

  checkpoint(
    chatId: string,
    summary: string,
    next: string,
    taskId?: string,
    review?: string,
    plan?: Partial<PlanItem>[],
    decisions?: string[],
    extra: CheckpointExtra = {}
  ): Orchestration {
    const run = this.require(chatId)
    if (!summary.trim() || !next.trim()) throw new Error('Give a readable progress summary and the next question or action.')
    const trimmedSummary = summary.trim()
    const trimmedNext = next.trim()
    if (trimmedSummary.length > CHECKPOINT_SUMMARY_MAX) {
      throw new Error(`The checkpoint summary must be at most ${CHECKPOINT_SUMMARY_MAX} characters.`)
    }
    if (trimmedNext.length > CHECKPOINT_NEXT_MAX) {
      throw new Error(`The checkpoint next step must be at most ${CHECKPOINT_NEXT_MAX} characters.`)
    }
    const acks = new Map<string, string>()
    for (const entry of extra.acknowledge ?? []) {
      const text = entry.text.trim()
      if (!run.changes.some(change => change.id === entry.change && change.ack === null)) throw new Error(`There is no unacknowledged user change "${entry.change}". The pending ones are: ${pendingChanges(run).map(change => change.id).join(', ') || 'none'}.`)
      if (!text) throw new Error(`Say in one short sentence what you will do about user change ${entry.change}.`)
      if (text.length > ACK_TEXT_MAX) throw new Error(`Each acknowledgement must be at most ${ACK_TEXT_MAX} characters.`)
      acks.set(entry.change, text)
    }
    const missed = pendingChanges(run).filter(change => !acks.has(change.id))
    if (missed.length) throw new Error(`The user changed the plan: ${missed.map(change => `${change.id}: ${change.text}`).join('; ')}. Acknowledge each one in this checkpoint (acknowledge: [{ change, text }]) and plan around it; nothing was saved.`)
    const needs = (extra.needs ?? []).map(need => {
      const text = need.text.trim()
      if (!need.id.trim() || !text) throw new Error('Each open question needs an id and readable text.')
      if (text.length > NEED_TEXT_MAX) throw new Error(`Each open question must be at most ${NEED_TEXT_MAX} characters.`)
      const options = (need.options ?? []).map(option => option.trim()).filter(Boolean)
      if (options.length > 4 || options.some(option => option.length > 40)) throw new Error('Offer at most four answers to a question, each at most 40 characters.')
      return { id: need.id.trim(), text, from: need.from?.trim() || null, options }
    })
    const planChecked = plan?.length ? validateUpsertPlan(run, plan) : undefined
    let reviewTask: OrchestratorTask | undefined
    const trimmedReview = review?.trim()
    if (taskId) {
      reviewTask = run.tasks.find(each => each.id === taskId)
      if (!reviewTask || reviewTask.status === 'running' || reviewTask.status === 'queued') throw new Error('Review a finished task from this orchestration.')
      if (!trimmedReview) throw new Error('Describe the evidence accepted, rejected, and still uncertain.')
    }
    const verdict = extra.verdict
    if (verdict !== undefined) {
      if (verdict !== 'accept' && verdict !== 'reject') throw new Error('Give verdict as accept or reject.')
      if (!reviewTask || !trimmedReview) throw new Error('A verdict goes with taskId and review: name the task and say what you accepted or rejected.')
      const status = reviewTask.merge?.status
      if (status === 'queued' || status === 'merging') throw new Error(`Task ${reviewTask.id} is already being merged or discarded. Its result arrives in your next review.`)
      if (status === 'merged' || status === 'discarded') throw new Error(`Task ${reviewTask.id} was already ${status}. Dispatch a follow-up for further changes.`)
    }
    const trimmedDecisions: string[] = []
    if (decisions?.length) {
      for (const text of decisions) {
        const trimmed = text.trim()
        if (!trimmed) throw new Error('Each decision needs readable text.')
        if (trimmed.length > DECISION_TEXT_MAX) throw new Error(`Each decision must be at most ${DECISION_TEXT_MAX} characters.`)
        trimmedDecisions.push(trimmed)
      }
    }
    validateCheckpointChecks(extra.checks)

    if (planChecked) applyUpsertPlan(run, planChecked)
    if (taskId && reviewTask && trimmedReview) {
      reviewTask.review = trimmedReview
      writeFileSync(join(dirname(reviewTask.report), `task-${reviewTask.id}-review.md`), reviewTask.review)
    }
    // A task without a worktree has nothing to merge, so its verdict is only the review.
    const merging = verdict && reviewTask?.worktree ? reviewTask : null
    if (merging) merging.merge = { verdict: verdict!, status: 'queued', at: this.now(), files: [], reason: null, message: null, commit: null }
    if (trimmedDecisions.length) {
      for (const trimmed of trimmedDecisions) run.decisions.push({ at: this.now(), text: trimmed })
    }
    for (const change of run.changes) {
      const text = acks.get(change.id)
      if (text) change.ack = { cycle: run.cycle, at: this.now(), text }
    }
    if (extra.needs) {
      // The list given is every open question; one left out is resolved. Answered ones stay as the record.
      const asked = new Set(needs.map(need => need.id))
      run.needs = run.needs.filter(need => need.answer !== null || asked.has(need.id))
      for (const need of needs) {
        const existing = run.needs.find(each => each.id === need.id)
        if (existing?.answer != null) continue
        if (existing) Object.assign(existing, need)
        else run.needs.push({ ...need, at: this.now(), answer: null, answeredAt: null })
      }
    }
    if (extra.checks) {
      const { typecheck, tests, ui } = extra.checks
      run.checks = {
        at: this.now(),
        typecheck: typecheck ?? run.checks?.typecheck ?? null,
        tests: tests ?? run.checks?.tests ?? null,
        ui: ui ?? run.checks?.ui ?? null
      }
    }
    const quiet = !taskId && !plan?.length && !decisions?.length && !acks.size && !extra.needs && !extra.checks
    run.checkpointCycle = run.cycle
    run.summary = trimmedSummary
    run.next = trimmedNext
    run.history.push({ at: this.now(), summary: run.summary, next: run.next, taskId: taskId ?? null, ...(quiet ? { quiet } : {}) })
    this.save(run)
    // Git work happens after the save, never inside it, so a checkpoint is all or nothing.
    if (reviewTask && trimmedReview) this.commitReviewed(run, reviewTask)
    if (merging) this.queueVerdict(run, merging)
    return this.get(chatId)!
  }

  /** User messages are recorded before Hub posts them, so the next dispatch sees the update. */
  userMessage(chatId: string, text: string): void {
    if ([...this.runs.values()].some(run => run.tasks.some(task => task.chatId === chatId && task.status === 'queued'))) {
      throw new Error('This worker is waiting in the queue; it starts when a slot frees. Cancel it or wait.')
    }
    const run = this.runs.get(chatId)
    if (!run || run.status === 'stopped') return
    run.updates.push(text)
    run.updateTimes.push(this.now())
    this.save(run)
  }

  /** A user change to the plan from the progress view. The orchestrator is woken to acknowledge it. */
  planEdit(runId: string, edit: PlanEdit): Orchestration {
    const run = this.byId(runId)
    applyPlanEdit(run, edit, 'view', this.now())
    if (run.status === 'running') this.wake.add(run.chatId)
    this.save(run)
    return this.get(run.chatId)!
  }

  /** The user's answer to an open question; it reaches the orchestrator as a user update. */
  answer(runId: string, needId: string, answer: string): Orchestration {
    const run = this.byId(runId)
    const need = run.needs.find(each => each.id === needId)
    if (!need) throw new Error('That question is no longer open. Reload the progress view.')
    if (need.answer !== null) throw new Error('That question has already been answered.')
    const text = answer.trim()
    if (!text) throw new Error('Choose an answer or type one.')
    need.answer = text
    need.answeredAt = this.now()
    run.updates.push(`Answered "${need.text}": ${text}`)
    run.updateTimes.push(this.now())
    if (run.status === 'running') this.wake.add(run.chatId)
    this.save(run)
    return this.get(run.chatId)!
  }

  wrapUp(runId: string): Orchestration {
    const run = this.controlRun(runId)
    if (run.status !== 'running' && run.status !== 'paused') throw new Error('Wrap up is available only while this orchestration is running or paused.')
    return this.stop(run.chatId, true)!
  }

  resumeRun(runId: string): Orchestration {
    const run = this.controlRun(runId)
    if (run.status !== 'paused') throw new Error('Resume is available only while this orchestration is paused.')
    return this.resume(run.chatId)
  }

  private controlRun(runId: string): Orchestration {
    if (this.stateError) throw new Error(this.stateError)
    if (typeof runId !== 'string' || !runId.trim()) throw new Error('Give the run ID shown on the worker board.')
    return this.byId(runId)
  }

  resume(chatId: string): Orchestration {
    const run = this.require(chatId)
    if (run.status === 'draining') throw new Error('Let the current workers finish before resuming.')
    run.status = 'running'
    run.reason = null
    this.wake.add(chatId)
    this.save(run)
    this.startQueued(run)
    return this.get(chatId)!
  }

  stop(chatId: string, drain = false): Orchestration | null {
    const run = this.runs.get(chatId)
    if (!run) return null
    run.status = drain ? 'draining' : 'stopped'
    run.reason = drain ? 'No new work. Letting current workers finish.' : 'Stopped by the user. No further work will be dispatched.'
    this.wake.delete(chatId)
    for (const task of run.tasks) if (task.status === 'queued') {
      task.status = 'cancelled'
      task.endedAt = this.now()
      task.result = 'Cancelled before starting because the orchestration was stopped.'
      this.save(run)
    }
    this.save(run)
    if (!drain) for (const task of run.tasks) if (task.status === 'running' && this.starting.has(`${run.id}:${task.id}`)) {
      // Its worktree is still being made and it never ran: the start discards the worktree.
      task.status = 'cancelled'
      task.endedAt = this.now()
      task.result = 'Cancelled before starting because the orchestration was stopped.'
      this.save(run)
    }
    if (!drain) for (const task of run.tasks) if (task.status === 'running') {
      // A stop request is not proof of stopped work. Keep status running until the actual event.
      void this.hub.stop(task.chatId).catch(error => {
        task.result = `Stop request failed: ${messageOf(error)}`
        this.save(run)
      })
    }
    return this.get(chatId)
  }

  cancelTask(runId: string, taskId: string): Orchestration {
    const run = this.byId(runId)
    const task = run.tasks.find(each => each.id === taskId)
    if (!task) throw new Error('This worker does not belong to this orchestration.')
    if (task.status !== 'queued' && task.status !== 'running') throw new Error('This worker has already finished and cannot be cancelled.')
    if (task.status === 'queued' || this.starting.has(`${run.id}:${task.id}`)) {
      task.status = 'cancelled'
      task.endedAt = this.now()
      task.result = 'Cancelled by the user before starting.'
      this.save(run)
    } else {
      task.result = 'Cancellation requested by the user; waiting for the worker to stop.'
      this.save(run)
      void this.hub.stop(task.chatId).catch(error => {
        task.result = `Stop request failed: ${messageOf(error)}`
        this.save(run)
      })
    }
    return this.get(run.chatId)!
  }

  async reply(chatId: string, taskId: string, text: string): Promise<Orchestration> {
    const run = this.require(chatId)
    const task = run.tasks.find(each => each.id === taskId)
    if (!task) throw new Error('This worker does not belong to this orchestration.')
    if (task.status === 'queued') throw new Error('This worker is waiting in the queue; it starts when a slot frees. Cancel it or wait.')
    if (this.starting.has(`${run.id}:${task.id}`)) throw new Error(`Worker ${task.id}'s worktree is still being made; it starts in a moment. Wait for it.`)
    const merge = task.merge?.status
    if (merge === 'queued' || merge === 'merging') throw new Error(`Task ${task.id} is being ${task.merge!.verdict === 'reject' ? 'discarded' : 'merged'}. Its result arrives in your next review.`)
    if (merge === 'merged' || merge === 'discarded') throw new Error(`Task ${task.id}'s worktree was ${merge}, so its chat has no folder to work in. Dispatch a follow-up instead.`)
    if (task.wantsWorktree && !task.worktree) throw new Error(`Task ${task.id} never got its worktree, so a reply would run it in the main folder. Dispatch the work again.`)
    if (task.worktree && !existsSync(task.worktree.folder)) throw new Error(`Task ${task.id}'s worktree at ${task.worktree.folder} is gone. Dispatch the work again.`)
    const message = text.trim()
    if (!message) throw new Error('Give the worker something to read.')
    if (task.status === 'running') {
      const live = this.hub.liveTurn(task.chatId)
      if (live && live.id === task.turnId) await this.hub.post(task.chatId, task.provider, task.model, message)
      else task.turnId = this.hub.send(task.chatId, task.provider, task.model, message)
    } else {
      task.status = 'running'
      task.review = null
      // A refused merge is tried again only after a new review and verdict.
      task.merge = null
      task.endedAt = null
      task.result = ''
      task.startedAt ??= this.now()
      task.turnId = this.hub.send(task.chatId, task.provider, task.model, message)
      this.wake.add(run.chatId)
    }
    this.save(run)
    return this.get(chatId)!
  }

  turnEnded(turn: Turn): void {
    for (const run of this.runs.values()) {
      const task = run.tasks.find(each => each.turnId === turn.id)
      if (task) {
        if (task.status !== 'running') {
          this.wake.add(run.chatId)
          this.save(run)
          this.startQueued(run)
          continue
        }
        this.heldOpenSince.delete(task.id)
        task.endedAt = this.now()
        task.status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed'
        const reply = this.hub.turnItems(task.chatId, turn.id).filter((item): item is Extract<Item, { type: 'assistant' }> => item.type === 'assistant').at(-1)?.text ?? ''
        task.result = turn.error ?? reply.slice(-8_000)
        let delivered = false
        try { delivered = !!readFileSync(task.report, 'utf8').trim() } catch { /* Missing/unreadable reports need review. */ }
        if (task.status === 'completed' && !delivered) {
          task.status = 'failed'
          task.result = `No report was delivered. Provider's last reply: ${task.result}`
        }
        this.wake.add(run.chatId)
        this.save(run)
        this.startQueued(run)
      }
      if (run.chatId === turn.chatId && turn.id === run.leaderTurnId) {
        run.leaderTurnId = null
        if (turn.status !== 'completed' && run.status === 'running') {
          run.status = 'paused'
          run.reason = turn.error ?? 'The orchestrator turn was interrupted. Resume when ready.'
        }
        if (run.status === 'running' && turn.status === 'completed' && run.checkpointCycle !== run.cycle) {
          run.status = 'paused'
          run.reason = 'The review ended without a progress checkpoint. Inspect its reply and resume; no empty retry loop was started.'
        }
        if (run.status === 'draining' && !run.tasks.some(task => task.status === 'running')) {
          run.status = 'stopped'
          run.reason = turn.status === 'completed' && run.checkpointCycle === run.cycle
            ? 'Current work and final review finished. No new work will be dispatched.'
            : 'Workers finished, but the final review did not complete with a checkpoint. Inspect the saved reports before resuming.'
        }
        this.save(run)
      }
    }
  }

  /** Deterministic scheduling entry point, also used by tests. */
  tick(): void {
    if (this.closing) return
    for (const run of this.runs.values()) {
      // A hand edit to the plan is taken whatever the run's state, so a paused run reads it on resume.
      if (this.planFileChanged(run)) { this.save(run); if (run.status === 'running') this.wake.add(run.chatId) }
      if (run.status !== 'running' && run.status !== 'draining') continue
      try {
        const notes = this.readNotes(run)
        if (notes !== run.notes) { run.notes = notes; this.wake.add(run.chatId); this.save(run) }
        this.startQueued(run)
        this.enforceHeldOpenLimits(run)
        if (run.status !== 'running' && run.status !== 'draining') continue
        if (this.hub.working().some(turn => turn.chatId === run.chatId || (run.provider === 'antigravity' && turn.provider === 'antigravity'))) continue
        // A merge or discard in flight is unfinished work too: its result wakes the leader.
        const unfinished = run.tasks.some(task => task.status === 'running' || task.status === 'queued' || task.merge?.status === 'queued' || task.merge?.status === 'merging')
        if (run.status === 'draining' && unfinished) continue
        if (unfinished && !this.wake.has(run.chatId)) continue
        this.wake.delete(run.chatId)
        run.cycle++
        run.leaderTurnId = this.hub.send(run.chatId, run.provider, null, this.prompt(run))
        this.save(run)
      } catch (error) {
        run.status = 'paused'
        run.reason = `Orchestration paused: ${messageOf(error)}`
        // Do not overwrite an externally edited file whose user-notes boundary was removed.
        this.persist()
        this.emit(structuredClone(run))
      }
    }
  }

  async wait(chatId: string, seconds = 20): Promise<Orchestration> {
    const before = this.require(chatId).updatedAt
    const deadline = Date.now() + Math.min(25, Math.max(1, seconds)) * 1000
    while (!this.closing && Date.now() < deadline) {
      const run = this.require(chatId)
      if (run.updatedAt !== before || run.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return this.get(chatId)!
  }

  shutdown(): void {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.persist()
  }

  /** Resolves once no worktree start, merge or report commit is in flight. */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
  }

  /**
   * Folders no turn's commit may take: every run's folder, with its progress file, reports and
   * evidence. The host commits those itself when a task is reviewed.
   */
  reservedFolders(): string[] {
    return [...this.runs.values()].map(run => dirname(run.progressFile))
  }

  /**
   * The leader's chat was deleted: its run is over, so the worktrees it still holds go, except a
   * worker's that is running now (its task keeps it until it ends).
   */
  discardRun(chatId: string): void {
    const run = this.runs.get(chatId)
    if (!run || !this.worktrees) return
    for (const task of run.tasks) {
      if (!task.worktree || task.status === 'running' || task.status === 'queued') continue
      if (task.merge && task.merge.status !== 'refused') continue
      task.merge = { verdict: 'reject', status: 'queued', at: this.now(), files: [], reason: null, message: null, commit: null }
      this.queueVerdict(run, task)
    }
    this.save(run)
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work)
    void work.finally(() => this.inFlight.delete(work)).catch(() => {})
    return work
  }

  /** The reviewed report, its evidence, the review and the progress file, in one commit of their own. */
  private commitReviewed(run: Orchestration, task: OrchestratorTask): void {
    if (!this.options.commitReport) return
    const folder = dirname(task.report)
    const paths = [task.report, join(folder, `task-${task.id}-evidence`), join(folder, `task-${task.id}-review.md`), run.progressFile]
    this.track(this.options.commitReport(run.cwd, paths, `Task ${task.id} report: ${task.title}`).catch(error => this.options.warn?.(`Task ${task.id}'s report was not committed: ${messageOf(error)}`)))
  }

  private queueVerdict(run: Orchestration, task: OrchestratorTask): void {
    const work = this.mergeChain.then(() => this.applyVerdict(run, task))
    this.mergeChain = work.catch(() => {})
    this.track(work)
  }

  /** Merge (accept) or discard (reject) a reviewed worktree task, and wake the leader with the result. */
  private async applyVerdict(run: Orchestration, task: OrchestratorTask): Promise<void> {
    const merge = task.merge
    if (!merge || merge.status !== 'queued' || !task.worktree || this.closing) return
    merge.status = 'merging'
    merge.at = this.now()
    this.save(run)
    const service = this.worktrees!(run.cwd)
    const where = { run: run.id, task: task.id }
    try {
      if (merge.verdict === 'reject') {
        await service.discard(where)
        Object.assign(merge, { status: 'discarded', message: `Task ${task.id} was discarded: its worktree and branch were deleted, and its report and transcript stay.` })
      } else {
        const outcome = await service.merge({ ...where, base: task.worktree.base, title: task.title })
        if (outcome.status === 'merged') {
          Object.assign(merge, {
            status: 'merged', files: outcome.files, commit: outcome.commit, reason: null,
            message: outcome.files.length ? `Merged task ${task.id} (${outcome.files.length} files)${outcome.commit ? ` as ${outcome.commit.slice(0, 7)}` : ''}.` : `Task ${task.id} changed no files, so there was nothing to merge.`
          })
          await this.fixedBy(run, task, service)
          await this.reportMerged(run, task, outcome.files)
        } else {
          Object.assign(merge, { status: 'refused', reason: outcome.reason, files: outcome.files, message: outcome.output ? `${outcome.message}\n${outcome.output}` : outcome.message })
        }
      }
    } catch (error) {
      Object.assign(merge, { status: 'refused', reason: 'error', message: `Task ${task.id} was not ${merge.verdict === 'reject' ? 'discarded' : 'merged'}: ${messageOf(error)}` })
    }
    merge.at = this.now()
    if (run.status === 'running' || run.status === 'draining') this.wake.add(run.chatId)
    this.save(run)
  }

  /** Tells the host what a merge wrote, so the shelf can show it. A failing hook never fails the merge. */
  private async reportMerged(run: Orchestration, task: OrchestratorTask, files: string[]): Promise<void> {
    if (!this.options.merged) return
    const main = await repoRoot(run.cwd) ?? run.cwd
    await Promise.resolve(this.options.merged(task, main, files)).catch(error => this.options.warn?.(`Task ${task.id}'s merged files could not be reported: ${messageOf(error)}`))
  }

  /** A merged fix-up settles the task it fixed: that one counts as merged, and its worktree goes. */
  private async fixedBy(run: Orchestration, fixer: OrchestratorTask, service: WorktreeService): Promise<void> {
    const fixed = fixer.fixes ? run.tasks.find(each => each.id === fixer.fixes) : undefined
    if (!fixed?.merge || fixed.merge.status !== 'refused') return
    await service.discard({ run: run.id, task: fixed.id }).catch(error => this.options.warn?.(`Task ${fixed.id}'s worktree could not be removed: ${messageOf(error)}`))
    Object.assign(fixed.merge, { status: 'merged', at: this.now(), commit: fixer.merge?.commit ?? null, message: `Merged through fix-up task ${fixer.id}.` })
  }

  /**
   * Startup: match the worktrees on disk with the tasks that name them. A kept worktree (an
   * interrupted worker's, or one waiting for a verdict) stays; one no task names is removed; a
   * task whose folder is gone is told so; a merge the restart cut off is queued again.
   */
  private async reconcileWorktrees(): Promise<void> {
    const runs = [...this.runs.values()]
    const held = (task: OrchestratorTask) => task.worktree !== null && task.merge?.status !== 'merged' && task.merge?.status !== 'discarded'
    // Every run's tasks at once: the worktrees folder is shared by all runs, so a run sees only its own as orphans otherwise.
    const known = runs.flatMap(run => run.tasks.filter(held).map(task => ({ run: run.id, task: task.id })))
    const tops = new Map<string, string>()
    for (const run of runs) {
      const top = await repoRoot(run.cwd).catch(() => null)
      if (top && !tops.has(top)) tops.set(top, run.cwd)
    }
    for (const cwd of tops.values()) {
      try {
        const outcome = await this.worktrees!(cwd).reconcile(known)
        for (const warning of outcome.warnings) this.options.warn?.(warning)
      } catch (error) { this.options.warn?.(`Worktrees in ${cwd} could not be reconciled: ${messageOf(error)}`) }
    }
    for (const run of runs) {
      let changed = false
      for (const task of run.tasks) {
        if (!held(task)) continue
        if (!existsSync(task.worktree!.folder)) {
          changed = true
          if (task.merge?.verdict === 'reject') { Object.assign(task.merge, { status: 'discarded', at: this.now(), message: `Task ${task.id} was discarded.` }); continue }
          task.merge = {
            verdict: task.merge?.verdict ?? null, status: 'refused', reason: 'missing', at: this.now(), files: [], commit: null,
            message: `Task ${task.id} was not merged: its worktree at ${task.worktree!.folder} is gone, so its work cannot be merged. Dispatch the work again.`
          }
        } else if (task.merge?.status === 'queued') this.queueVerdict(run, task)
      }
      if (changed) this.save(run)
    }
  }

  private enforceHeldOpenLimits(run: Orchestration): void {
    for (const task of run.tasks) {
      if (task.status !== 'running' || !task.turnId) {
        this.heldOpenSince.delete(task.id)
        continue
      }
      const turn = this.hub.liveTurn(task.chatId)
      if (!turn || turn.id !== task.turnId || !HELD_OPEN_ACTIVITY.test(turn.activity ?? '')) {
        this.heldOpenSince.delete(task.id)
        continue
      }
      let delivered = false
      try { delivered = !!readFileSync(task.report, 'utf8').trim() } catch { /* no report yet */ }
      if (!delivered) {
        this.heldOpenSince.delete(task.id)
        continue
      }
      if (!this.heldOpenSince.has(task.id)) {
        this.heldOpenSince.set(task.id, this.now())
        continue
      }
      if (this.now() - this.heldOpenSince.get(task.id)! < HELD_OPEN_LIMIT_MS) continue
      this.heldOpenSince.delete(task.id)
      task.status = 'completed'
      task.endedAt = this.now()
      task.result = HELD_OPEN_RESULT
      this.wake.add(run.chatId)
      this.save(run)
      void this.hub.stop(task.chatId).catch(error => {
        task.result = `${HELD_OPEN_RESULT} Stop request failed: ${messageOf(error)}`
        this.save(run)
      })
    }
  }

  private prompt(run: Orchestration): string {
    return [
      '<rocket-orchestration>',
      run.status === 'draining' ? 'Final review: workers have finished. Review their results, checkpoint a final summary and next steps, then finish. Do not dispatch new work.' : `Continue the user’s orchestration (review ${run.cycle}).`,
      `Task: ${run.task}`,
      `Read and maintain ${promptPath(run.progressFile)} using orchestrator checkpoint. Read the actual worker reports and evidence before accepting claims.`,
      `Current summary: ${run.summary}`, `Next: ${run.next}`, `Plan (${run.plan.length} items, in the order to do them): ${JSON.stringify(run.plan)}`, `Decisions: ${JSON.stringify(run.decisions.slice(-8))}`, `User updates: ${run.updates.join('\n')}`, `User notes: ${run.notes}`,
      pendingChangesText(run),
      `Open questions to the user: ${JSON.stringify(run.needs.filter(need => need.answer === null).map(({ id, text, options }) => ({ id, text, options })))}`,
      `At every checkpoint, keep plan current: upsert items by id (never delete—mark dropped instead), set status as work lands, link new scope with from set to the user-update index (0-based). Plan item text at most ${PLAN_ITEM_TEXT_MAX} characters. Items with by "user" were set by the user: carry them forward to active or done, keep their wording, never drop or reopen them, and treat status "kept" as "do not do or remove this". The user can change the plan at any time from the progress view; each change must be acknowledged before you dispatch. Record decisions as short strings (at most ${DECISION_TEXT_MAX} characters). Summary at most ${CHECKPOINT_SUMMARY_MAX} characters; next at most ${CHECKPOINT_NEXT_MAX}. Report check results in checks (typecheck pass or fail; tests and ui as passed and total) when you have run them. Put only what work cannot continue without (access, a permission, a missing input) in needs, as the full list of open questions with up to four short answers, the one you would pick first; answers arrive as user updates. Next steps belong in the plan, not in needs. A review with nothing new needs only summary and next, and is left out of the record. Full task reviews go in checkpoint review and are saved beside the report; progress.md stays terse.`,
      `When dispatching, give a title of at most ${TASK_TITLE_MAX} characters naming the work, and planItem: the id of the plan step it serves, so the user sees who works on each step.`,
      formatWorkersPrompt(run.tasks),
      formatMergesPrompt(run.tasks),
      this.worktrees ? 'Code workers edit in their own git worktrees, made from the main folder when they start; their reports stay in the run folder. Dispatch with worktree false only for read-only research. Antigravity always works in the main folder. When you review a worktree task, give verdict accept to merge it into the main folder or reject to discard it. The host merges after the checkpoint saves, one task at a time, and checks typecheck and unit tests first. A refused merge comes back in your next review with its files and reason: dispatch a fix-up with fixes set to that task id, or reject it. Split work by file area so workers do not conflict.' : '',
      `Use the orchestrator tool: checkpoint the evidence accepted/rejected and next question; dispatch fresh focused tasks based on those findings; wait for workers when needed. At most ${this.machineWorkerLimit} workers run at once on this machine (one per core and one per 0.75 GB available memory, read at startup). Each provider also has its own limit (Claude, Codex and Cursor up to ${maxActiveForProvider('claude')} each; Antigravity one at a time because its tool connection is shared). Excess tasks queue FIFO per provider. Dispatch accepts any number; the queue starts them when a slot frees. The leader uses the provider default. For workers, choose models efficiently: Cursor should usually use Composer 2.5 and rarely change models, though changes are allowed; Claude should use Haiku 5.5 for fast, reliable, easy tasks and stronger models when warranted; choose Codex models as you see fit. Available IDs come from models.list; use orchestrator models to read those live lists with defaults marked. Never guess an ID. Name the model picked (or provider default) and why in each dispatch assignment. Give concise user-facing progress updates.`,
      'Keep deepening the user’s task without a fixed round limit. Follow its scope; do not treat report existence or completed status as proof of correctness. If a provider fails or hits quota, record it and continue useful work with available providers without a rapid retry loop.',
      'A user message can redirect the work. On a request to stop or wrap up, call stop with drain=true to finish current workers, or drain=false to request their cancellation. Do not dispatch further work. If information only the user can supply blocks all progress, explain it and stop rather than generating empty rounds.'
    ].filter(Boolean).join('\n\n')
  }

  private byId(runId: string): Orchestration {
    const run = [...this.runs.values()].find(each => each.id === runId)
    if (!run) throw new Error('This orchestration does not exist.')
    return run
  }

  private require(chatId: string): Orchestration {
    const run = this.runs.get(chatId)
    if (!run) throw new Error('This chat does not own an orchestration. Start one here first.')
    return run
  }

  private readNotes(run: Orchestration): string {
    if (!existsSync(run.progressFile)) return run.notes
    const text = readFileSync(run.progressFile, 'utf8')
    const index = text.indexOf(NOTES_MARKER)
    if (index < 0) throw new Error('The progress file’s user-notes marker was removed. Restore it before resuming; your file was preserved.')
    return text.slice(index + NOTES_MARKER.length)
  }

  /** Whether progress.md was written by someone else since the host last wrote it. */
  private planFileChanged(run: Orchestration): boolean {
    const written = this.writtenPlan.get(run.id)
    if (!written) return false
    try { return statSync(run.progressFile).mtimeMs !== written.mtime } catch { return false }
  }

  /**
   * Take the user's hand edits to the Plan section, through the same edit the progress view makes.
   * Only lines that differ from what the host last wrote count, so the host's own changes since
   * that write are never read back as the user's. An edit the plan refuses (a step over the
   * length cap) is left out, and the rewrite shows the step as it was.
   */
  private absorbPlanEdits(run: Orchestration): void {
    const written = this.writtenPlan.get(run.id)
    if (!written || !existsSync(run.progressFile)) return
    const lines = parsePlanSection(readFileSync(run.progressFile, 'utf8'))
    if (!lines) return
    for (const edit of fileEdits(run, lines, written.lines)) {
      try { applyPlanEdit(run, edit, 'file', this.now()) } catch { /* refused; see above */ }
    }
  }

  private save(run: Orchestration): void {
    try {
      run.notes = this.readNotes(run)
      this.absorbPlanEdits(run)
      run.updatedAt = Math.max(this.now(), run.updatedAt + 1)
      const checklist = planChecklist(run)
      const text = [
        '# Orchestrator progress',
        `Status: **${run.status}** · Updated: ${localStamp(run.updatedAt)} · Review: ${run.cycle}`,
        formatChecks(run.checks), run.reason ?? '', '## Task', run.task, '## Needs you', formatNeeds(run), '## Plan', checklist, '## Added since the start', formatAddedSince(run),
        '## Now', run.summary, run.next, '## Workers', formatWorkersTable(run.tasks), '## Decisions', formatDecisions(run),
        '## Reviews', formatReviews(run.history),
        '---', 'The orchestrator maintains the sections above. Edit the User notes section below to steer it; those notes are preserved. Stop from the owning chat to prevent further dispatch.',
        NOTES_MARKER + run.notes
      ].filter(Boolean).join('\n\n')
      mkdirSync(dirname(run.progressFile), { recursive: true })
      writeFileSync(run.progressFile, text)
      this.writtenPlan.set(run.id, { lines: parsePlanSection(`## Plan\n${checklist}`) ?? [], mtime: statSync(run.progressFile).mtimeMs })
    } catch (error) {
      if (run.status === 'running' || run.status === 'draining') run.status = 'paused'
      run.reason = `Progress file could not be updated: ${messageOf(error)}`
    }
    this.persist()
    this.emit(structuredClone(run))
  }

  private persist(): void {
    if (this.stateError) return
    mkdirSync(dirname(this.stateFile), { recursive: true })
    writeFileSync(`${this.stateFile}.tmp`, JSON.stringify([...this.runs.values()], null, 2))
    renameSync(`${this.stateFile}.tmp`, this.stateFile)
  }
}

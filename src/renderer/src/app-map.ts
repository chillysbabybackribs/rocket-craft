import { ACTIONS, PLACES, isAction, isPlace, type ActionName, type PlaceName } from '../../shared/app-map.ts'
import { firstSentence, pendingChanges, type Orchestration, type PlanEdit } from '../../shared/orchestrator.ts'
import type { UiMapResult, UiWhere } from '../../shared/types.ts'
import { filterEntries, parseFilters } from '../../shared/library.ts'
import {
  PROGRESS_SECTIONS, answerNeed, boardRun, closeArtifact, editPlan, expandWorker, loadLibrary, openChat,
  openLibraryEntry, openProgress, patchLibrary, peekState, progressRun, refreshTools, setBrowserOpen, setLibraryOpen, setToolsOpen, stepWorker,
  wrapUpRun, resumeRun, workerStatus, type AppState, type ProgressSection
} from './store.ts'

// The one dispatcher behind the app map. The dashboard's buttons call `go` and `act`, and so do
// main's `uiMap` ops for the host's studio_ui_* tools, so a model's navigation is a click's
// navigation. Every place and action in `src/shared/app-map.ts` has its handler here; the
// `Record<PlaceName | ActionName, …>` types make a missing one a type error.

type Params = Record<string, unknown>

function placeOf(state: AppState): PlaceName {
  if (progressRun(state)) return 'progress'
  if (state.artifact) return 'chat'
  if (state.libraryOpen) return 'library'
  if (state.toolsOpen) return 'tools'
  if (state.browserOpen) return 'browser'
  return 'chat'
}

function libraryWhere(state: AppState): NonNullable<UiWhere['library']> {
  const { library } = state
  const title = (chatId: string): string => state.chats.find((chat) => chat.id === chatId)?.title ?? ''
  return { filters: library.filters, view: library.view, shown: filterEntries(library.entries, library.filters, title).length, total: library.entries.length }
}

function boardWhere(state: AppState): UiWhere['board'] {
  const run = boardRun(state)
  if (!run) return null
  return {
    // Titles, not whole assignments: a run of twenty workers would otherwise make every answer tens of thousands of characters.
    run: { id: run.id, chatId: run.chatId, status: run.status, task: firstSentence(run.task), reason: run.reason, canWrapUp: run.status === 'running' || run.status === 'paused', canResume: run.status === 'paused', actionPending: state.board.runAction?.runId === run.id },
    filter: state.board.filter,
    expanded: state.board.expanded,
    workers: run.tasks.map((task) => ({ chatId: task.chatId, taskId: task.id, provider: task.provider, status: workerStatus(state, run, task), title: task.title }))
  }
}

function progressWhere(state: AppState): UiWhere['progress'] {
  const run = progressRun(state)
  if (!run) return null
  return {
    runId: run.id,
    chatId: run.chatId,
    section: state.progress.section,
    plan: run.plan.map((item) => ({ id: item.id, text: item.text, status: item.status, byUser: item.by === 'user' })),
    pending: pendingChanges(run).map((change) => ({ id: change.id, text: change.text })),
    needs: run.needs.filter((need) => need.answer === null).map((need) => ({ id: need.id, text: need.text, options: need.options }))
  }
}

/** The run the progress place shows: the one on screen, else the orchestrator column's, else the orchestrator chat's. */
function progressTarget(state: AppState): Orchestration {
  const own = state.panes[0]?.chatId
  const run = progressRun(state) ?? boardRun(state) ?? (own ? state.orchestrations[own] : undefined)
  if (!run) throw new Error('No chat on screen owns an orchestration, so there is no progress to show. Open the chat that started the run first.')
  return run
}

/** Where the shell is now, in the map's words. */
export function where(): UiWhere {
  const state = peekState()
  return {
    place: placeOf(state),
    panes: state.panes.map((pane, index) => {
      const chat = state.chats.find((entry) => entry.id === pane.chatId)
      return {
        index,
        chatId: pane.chatId,
        title: chat?.title ?? 'New chat',
        provider: pane.provider,
        running: pane.chatId !== null && state.running.has(pane.chatId),
        planOpen: pane.chatId !== null && state.views[pane.chatId]?.planTurnId != null
      }
    }),
    side: state.artifact ? 'artifact' : state.libraryOpen ? 'library' : state.toolsOpen ? 'tools' : state.browserOpen ? 'browser' : 'chat',
    artifact: state.artifact ? { kind: state.artifact.kind, path: state.artifact.kind === 'artifact' ? state.artifact.path : null } : null,
    library: state.libraryOpen ? libraryWhere(state) : null,
    progress: progressWhere(state),
    board: boardWhere(state)
  }
}

// ── Parameter reading ─────────────────────────────────────────────────

function text(params: Params, name: string): string | undefined {
  const value = params[name]
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

function integer(params: Params, name: string, min: number): number | undefined {
  const value = params[name]
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}.`)
  return n
}

/** The chat actions keep an optional pane for older callers; the orchestrator column is the only pane, 0. */
function paneIndex(params: Params): 0 {
  const n = integer(params, 'pane', 0)
  if (n !== undefined && n !== 0) throw new Error(`There is no pane ${n}. The orchestrator column is the only pane, 0.`)
  return 0
}

/** Two frames, so what the store changed is painted before a capture or a read. */
async function painted(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

// ── Places ────────────────────────────────────────────────────────────

const places: Record<PlaceName, (params: Params) => Promise<void>> = {
  chat: async () => {
    closeArtifact()
    if (peekState().toolsOpen) setToolsOpen(false)
    if (peekState().browserOpen) setBrowserOpen(false)
    if (peekState().libraryOpen) setLibraryOpen(false)
  },
  library: async (params) => {
    const view = text(params, 'view')
    if (view !== undefined && view !== 'grid' && view !== 'list') throw new Error('view is "grid" or "list".')
    const filtering = ['source', 'kind', 'chat', 'added', 'q'].some((name) => params[name] !== undefined)
    const filters = filtering ? parseFilters(params) : undefined
    if (filters?.chat && !peekState().chats.some((chat) => chat.id === filters.chat)) throw new Error(`There is no chat "${filters.chat}". studio_ui_where lists the chats on screen; library_list shows each file's chat.`)
    if (!peekState().libraryOpen || peekState().artifact) setLibraryOpen(true)
    if (!peekState().library.loaded) await loadLibrary()
    patchLibrary({ ...(filters ? { filters } : {}), ...(view ? { view } : {}) })
  },
  browser: async () => { setBrowserOpen(true) },
  tools: async () => { if (!peekState().toolsOpen || peekState().artifact) setToolsOpen(true) },
  progress: async (params) => {
    const section = text(params, 'section')
    if (section !== undefined && !(PROGRESS_SECTIONS as readonly string[]).includes(section)) throw new Error(`section is one of ${PROGRESS_SECTIONS.join(', ')}.`)
    openProgress(progressTarget(peekState()), section as ProgressSection | undefined)
  }
}

const PLAN_STATUS = { done: 'done', reopen: 'planned', restore: 'planned', keep: 'kept', drop: 'dropped' } as const

function planEditOf(params: Params): PlanEdit {
  const change = text(params, 'change')
  const item = text(params, 'item')
  const words = text(params, 'text')
  if (change === 'add') {
    if (!words) throw new Error('Give text: the new step\'s wording.')
    return { type: 'add', text: words }
  }
  if (change === 'undo') {
    const id = text(params, 'changeId')
    if (!id) throw new Error('Give changeId: one of progress.pending in studio_ui_where.')
    return { type: 'undo', change: id }
  }
  if (!item) throw new Error('Give item: a plan step id from progress.plan in studio_ui_where.')
  if (change && Object.hasOwn(PLAN_STATUS, change)) return { type: 'status', item, status: PLAN_STATUS[change as keyof typeof PLAN_STATUS] }
  if (change === 'up' || change === 'down') return { type: 'move', item, delta: change === 'up' ? -1 : 1 }
  if (change === 'reword') {
    if (!words) throw new Error('Give text: the step\'s new wording.')
    return { type: 'reword', item, text: words }
  }
  throw new Error('change is one of done, reopen, keep, drop, restore, up, down, reword, add or undo.')
}

// ── Actions ───────────────────────────────────────────────────────────

const actions: Record<ActionName, (params: Params) => Promise<unknown>> = {
  'chat.open': async (params) => {
    const chatId = text(params, 'chatId')
    if (!chatId) throw new Error('Give chatId: the chat to show.')
    if (!peekState().chats.some((chat) => chat.id === chatId)) throw new Error(`There is no chat "${chatId}".`)
    await openChat(chatId, paneIndex(params))
  },
  'chat.new': async (params) => { await openChat(null, paneIndex(params)) },
  'tools.refresh': async () => { refreshTools() },
  'library.clear': async () => { patchLibrary({ filters: {} }) },
  'library.open': async (params) => {
    const id = text(params, 'id')
    if (!id) throw new Error('Give id: a file id from library_list.')
    await loadLibrary()
    await openLibraryEntry(id)
  },
  'plan.edit': async (params) => {
    const edit = planEditOf(params)
    const run = progressTarget(peekState())
    if (edit.type !== 'add' && edit.type !== 'undo' && !run.plan.some((item) => item.id === edit.item)) {
      throw new Error(`There is no plan step "${edit.item}". The steps are ${run.plan.map((item) => item.id).join(', ') || 'none yet'}.`)
    }
    if (!(await editPlan(run, edit))) throw new Error(peekState().error ?? 'The plan change was refused.')
  },
  'need.answer': async (params) => {
    const need = text(params, 'need')
    const answer = text(params, 'answer')
    const run = progressTarget(peekState())
    const open = run.needs.filter((entry) => entry.answer === null).map((entry) => entry.id)
    if (!need || !open.includes(need)) throw new Error(`Give need: one of the open questions, ${open.join(', ') || 'none'}.`)
    if (!answer) throw new Error('Give answer: one of its answers or your own words.')
    if (!(await answerNeed(run, need, answer))) throw new Error(peekState().error ?? 'The answer was refused.')
  },
  'run.wrapUp': async () => { await wrapUpRun(controlRun().id) },
  'run.resume': async () => { await resumeRun(controlRun().id) },
  'worker.expand': async (params) => {
    const chatId = text(params, 'chatId')
    const run = boardRun(peekState())
    if (!run) throw new Error('The orchestrator chat owns no run, so the board has no workers. Open the chat that started the run first.')
    const ids = run.tasks.map((task) => task.chatId)
    if (!chatId) throw new Error(`Give chatId: one of the board's workers, ${ids.join(', ') || 'none yet'}.`)
    if (!ids.includes(chatId)) throw new Error(`Chat "${chatId}" is not a worker on the board. Its workers are ${ids.join(', ') || 'none yet'}.`)
    expandWorker(chatId)
  },
  'worker.collapse': async () => {
    if (!peekState().board.expanded) throw new Error('No worker is expanded.')
    expandWorker(null)
  },
  'worker.next': async () => { if (!stepWorker(1)) throw new Error('The board has no workers to move between.') },
  'worker.previous': async () => { if (!stepWorker(-1)) throw new Error('The board has no workers to move between.') }
}

// ── Entry points ──────────────────────────────────────────────────────

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Show a place. Parameters choose what it shows; a wrong one is refused with the right choices. */
export async function go(place: string, params: Params = {}): Promise<UiMapResult> {
  if (!isPlace(place)) return { ok: false, error: `There is no place "${place}". The places are ${Object.keys(PLACES).join(', ')}.`, where: where() }
  try {
    await places[place](params)
    await painted()
    return { ok: true, value: null, where: where() }
  } catch (error) {
    return { ok: false, error: message(error), where: where() }
  }
}

/** Do an action, going to its place first when that is not on screen. */
export async function act(action: string, params: Params = {}): Promise<UiMapResult> {
  if (!isAction(action)) return { ok: false, error: `There is no action "${action}". The actions are ${Object.keys(ACTIONS).join(', ')}.`, where: where() }
  try {
    const home = (ACTIONS[action] as { place?: PlaceName }).place
    if (home && where().place !== home) await places[home]({})
    const value = await actions[action](params)
    await painted()
    return { ok: true, value: value ?? null, where: where() }
  } catch (error) {
    return { ok: false, error: message(error), where: where() }
  }
}

export const rocketMap = { where, go, act }

function controlRun(): Orchestration {
  const run = boardRun(peekState())
  if (!run) throw new Error('The orchestrator chat owns no run. Open the chat that started the run first.')
  return run
}

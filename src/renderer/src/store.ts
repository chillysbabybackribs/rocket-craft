import { executeRunControl, type RunControlState } from './run-control.ts'
import { RunNotificationObserver, submitNotices } from './notifications.ts'
import type { Orchestration, OrchestratorTask, PlanEdit } from '../../shared/orchestrator.ts'
import { collectAttachments, restoreDraft, updateDraft } from './drafts.ts'
import { useSyncExternalStore } from 'react'
import type { ChatLinkTarget, Chat, Attachment, AttachmentPreview, FileAttachment, MessageDraft, HostEvent, Item, ModelInfo, ProviderId, QueuedMessage, Turn, TurnPatch, UsageSnapshot } from '../../shared/types.ts'

export type ArtifactView =
  | Extract<ChatLinkTarget, { kind: 'artifact' }>
  | { kind: 'changes'; chatId: string; turnId: string; patch: TurnPatch }
  /** An attached PDF or text file; `preview` is null while it loads. */
  | { kind: 'attachment'; attachment: FileAttachment; preview: AttachmentPreview | null; error: string | null }
  /** A file opened from the library; `view` is null while it loads. */
  | { kind: 'library'; entry: LibraryEntry; view: LibraryView | null; error: string | null }
import { PROVIDERS, TURN_PAGE, planItemId } from '../../shared/types.ts'
import type { LibraryEntry, LibraryFilters, LibraryPreview, LibraryView } from '../../shared/library.ts'
import { call, connectHost } from './host.ts'
import { clampSpeed } from '../../shared/reading.ts'
import { craft, type CraftAppInfo, type CraftState } from './craft.ts'

// Client state. Two kinds of subscription keep a fast token stream cheap: components that care
// about structure (which chats, which turns, which items exist) read `useApp`, and each
// transcript row reads its own item with `useItem`. A text delta therefore re-renders exactly
// one row, never the list around it.
//
// The chat card holds one pane: the orchestrator's chat with its own tabs and composer. What it
// shows is in `panes[0]`; what a shown chat holds (its turns, their items, what is waiting) is in
// `views`, keyed by chat, so the column and the worker board share one copy of a chat.

export type Pane = {
  /** Stable for the column's life, so a new-chat draft keeps its `new:<key>` identity. */
  key: number
  /** The chat on screen, or null for a new chat that has not been sent to yet. */
  chatId: string | null
  /** The chats open as tabs over this pane's composer, in the order they were opened. */
  tabs: string[]
  /** The provider chosen in this pane's chat, or for the next new one. */
  provider: ProviderId
  /** The model chosen per provider, in the same place; a provider absent here runs its own default. */
  modelChoice: ModelChoices
  /** Text handed back to the composer (a waiting message taken back); `at` tells one hand-back from the next. */
  restored: { text: string; at: number } | null
}

export type ChatView = {
  turns: Turn[]
  /** turnId → its item ids, in order. */
  turnItems: Record<string, string[]>
  /** Messages waiting for the chat's turn in flight to end. */
  queued: QueuedMessage[]
  /**
   * The turn whose plan shows in the drawer beside the chat, or null while it is closed. It opens
   * by itself on the first plan of a running turn unless this chat has closed it before.
   */
  planTurnId: string | null
  /** Whether the chat has turns before the first one loaded, which come as the reader scrolls up (`loadOlder`). */
  hasOlder: boolean
}

const EMPTY_VIEW: ChatView = { turns: [], turnItems: {}, queued: [], planTurnId: null, hasOlder: false }

export type AppState = {
  ready: boolean
  chats: Chat[]
  panes: Pane[]
  /** Each chat on screen, keyed by chat id. */
  views: Record<string, ChatView>
  /** Chats with a turn in flight, including ones not on screen. */
  running: ReadonlySet<string>
  /** Orchestration runs by the chat that owns them. */
  orchestrations: Record<string, Orchestration>
  /** The worker board beside the orchestrator chat; see `boardRun` and OrchestratorShell.tsx. */
  board: BoardState
  usage: Partial<Record<ProviderId, UsageSnapshot>>
  /** Each provider's models, once read. A provider absent here has not been asked yet. */
  models: Partial<Record<ProviderId, ModelInfo[]>>
  /** What the panel beside the chat shows: a file a link opened, or what a turn changed. */
  artifact: ArtifactView | null
  /**
   * The progress view (ProgressView.tsx), shown whenever the artifact is a run's progress.md: the
   * section in view, and a counter bumped when a section is asked for, so the view scrolls to it.
   */
  progress: { section: ProgressSection; jump: number }
  /** Hands-free reading's speed, one for web pages and files alike (shared/reading.ts). */
  readingSpeed: number
  /**
   * What the right side shows under the artifact, if one is open: an installed app, the shelf, the
   * browser or the library. It is never empty; the dock under it switches between them.
   */
  side: Side
  /** The app last shown, which the side returns to when the browser or library is toggled off. */
  lastApp: string | null
  /** The Craft apps: the catalog, each app's install and run state, and the dock's order. */
  craft: CraftStore
  /** The library's shelf of every file the chats touched (docs/library-plan.md). */
  library: LibraryState
  /** The width of the side pane beside a chat (the plan drawer), in pixels. */
  sideWidth: number
  /** The folder a new chat starts in: the last one the user chose, or their home folder. */
  defaultCwd: string
  error: string | null
}

/**
 * The worker board's own state. It lives here rather than in the shell's components so the app
 * map can expand and collapse a worker by name, as a click does.
 */
export type BoardState = RunControlState & {
  /** The worker chat shown large over the board, or null while every worker is in its window. */
  expanded: string | null
  filter: WorkerFilter
  /** The orchestrator column's width in pixels, or null for its share of the window. */
  width: number | null
  /** Worker chats the user stopped from the board, so an interrupted one reads as cancelled. */
  stopped: Record<string, true>
  /** With the board folded to a rail (too narrow beside a side panel), whether it is open over the shell. */
  railOpen: boolean
  focusTarget: { runId: string; kind: 'run' | 'worker'; chatId: string | null } | null
}

export type WorkerFilter = 'all' | 'running' | 'done'

export type Side = { kind: 'app'; id: string } | { kind: 'shelf' } | { kind: 'browser' } | { kind: 'library' }

export type CraftStore = {
  apps: CraftAppInfo[]
  /** Whether the catalog has been read; until then the shelf says it is loading. */
  loaded: boolean
  /** Why the catalog could not be read, as a full sentence. */
  error: string | null
  /** Each app's latest state from main, by id; an app absent here is as its catalog entry says. */
  states: Record<string, CraftState>
  /** Installed apps in the order the user installed them, which is the dock's order. */
  order: string[]
}

export const PROGRESS_SECTIONS = ['now', 'needs', 'plan', 'workers', 'activity'] as const
export type ProgressSection = typeof PROGRESS_SECTIONS[number]

/**
 * A worker window's status: the run task's own, with `done` for completed, and `cancelled` too for
 * an interrupted worker the user stopped from the board or by stopping its run.
 */
export type WorkerStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled'

export type ModelChoices = Partial<Record<ProviderId, { id: string; label: string }>>

/** The library panel's shelf, filters and card pictures. Filters live here, not in the panel, because the app map sets them too. */
export type LibraryState = {
  entries: LibraryEntry[]
  loaded: boolean
  error: string | null
  filters: LibraryFilters
  view: 'grid' | 'list'
  /** The card last opened, outlined when the grid comes back. */
  selected: string | null
  /** A card's picture: absent until asked for, null while it is made. */
  previews: Record<string, LibraryPreview | null>
}

// Each chat keeps its own provider and models, so a change in one never shows up in another. The
// empty screen has a choice of its own, which a chat takes with it when it is created there.
type Selection = { provider: ProviderId; modelChoice: ModelChoices }

const PREFS_KEY = 'rocket.prefs'
type Prefs = {
  /** The empty screen's choice, and what a chat with none of its own falls back to. */
  provider?: ProviderId
  modelChoice?: ModelChoices
  /** chatId → that chat's choice. */
  selections?: Record<string, Selection>
  side?: Side
  lastApp?: string | null
  dockOrder?: string[]
  readingSpeed?: number
  libraryView?: 'grid' | 'list'
  sideWidth?: number
  orchWidth?: number | null
  /** Chats whose plan drawer the user closed; it no longer opens by itself there. */
  planClosed?: Record<string, true>
  /** The panes as they were; only the first is read, as the orchestrator column. */
  panes?: { chatId: string | null; tabs: string[]; key?: number }[]
  /** Before panes, the one chat and its tabs; read once to become the first pane. */
  activeChatId?: string | null
  tabs?: string[]
  cwd?: string
}

function readPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Prefs
  } catch {
    return {}
  }
}

function writePrefs(patch: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }))
  } catch {
    // Preferences are a convenience; the app works without them.
  }
}

const prefs = readPrefs()

function selectionFor(chatId: string | null): Selection {
  const saved = readPrefs()
  const own = chatId ? saved.selections?.[chatId] : undefined
  const provider = own?.provider ?? saved.provider
  const modelChoice = { ...(own?.modelChoice ?? saved.modelChoice) }
  // A remembered model the provider no longer offers would fail the turn; fall back to default.
  for (const entry of PROVIDERS) {
    const offered = state.models[entry.id]
    const chosen = modelChoice[entry.id]
    if (offered?.length && chosen && !offered.some((model) => model.id === chosen.id)) delete modelChoice[entry.id]
  }
  return { provider: PROVIDERS.some((entry) => entry.id === provider) ? provider! : 'claude', modelChoice }
}

function saveSelection(chatId: string | null, selection: Selection): void {
  if (chatId) writePrefs({ selections: { ...readPrefs().selections, [chatId]: selection } })
  else writePrefs(selection)
}

function forgetSelection(chatId: string): void {
  const saved = readPrefs()
  const { [chatId]: _gone, ...selections } = saved.selections ?? {}
  const { [chatId]: _closed, ...planClosed } = saved.planClosed ?? {}
  writePrefs({ selections, planClosed })
}

let nextPaneKey = 1

function newPane(chatId: string | null = null, tabs: string[] = []): Pane {
  return { key: nextPaneKey++, chatId, tabs, restored: null, ...selectionFor(chatId) }
}

let state: AppState = {
  artifact: null,
  progress: { section: 'now', jump: 0 },
  ready: false,
  chats: [],
  panes: [],
  views: {},
  running: new Set(),
  orchestrations: {},
  board: { expanded: null, filter: 'all', width: typeof prefs.orchWidth === 'number' ? prefs.orchWidth : null, stopped: {}, railOpen: false, runAction: null, runActionError: null, focusTarget: null },
  usage: {},
  models: {},
  readingSpeed: clampSpeed(prefs.readingSpeed ?? 1),
  side: savedSide(prefs.side),
  lastApp: typeof prefs.lastApp === 'string' ? prefs.lastApp : null,
  craft: { apps: [], loaded: false, error: null, states: {}, order: Array.isArray(prefs.dockOrder) ? prefs.dockOrder.filter((id) => typeof id === 'string') : [] },
  library: { entries: [], loaded: false, error: null, filters: {}, view: prefs.libraryView === 'list' ? 'list' : 'grid', selected: null, previews: {} },
  sideWidth: prefs.sideWidth ?? 400,
  defaultCwd: prefs.cwd || window.rocket.homeDir,
  error: null
}
// The first pane exists before anything is loaded, so the composer has somewhere to be.
state.panes = [newPane()]
const items = new Map<string, Item>()
const stateListeners = new Set<() => void>()
const itemListeners = new Map<string, Set<() => void>>()

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch }
  for (const listener of stateListeners) listener()
}

function notifyItem(id: string): void {
  for (const listener of itemListeners.get(id) ?? []) listener()
}

export function useApp<T>(select: (state: AppState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      stateListeners.add(listener)
      return () => { stateListeners.delete(listener) }
    },
    () => select(state)
  )
}

/** An item as it stands, without subscribing. For what never changes about it, such as its type. */
export function peekItem(id: string): Item | undefined {
  return items.get(id)
}

export function useItem(id: string): Item | undefined {
  return useSyncExternalStore(
    (listener) => {
      let set = itemListeners.get(id)
      if (!set) itemListeners.set(id, set = new Set())
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) itemListeners.delete(id)
      }
    },
    () => items.get(id)
  )
}

// ── Reading panes ─────────────────────────────────────────────────────

export function paneAt(state: AppState, pane: number): Pane {
  return state.panes[pane] ?? state.panes[0]!
}

export function chatIdOf(state: AppState, pane: number): string | null {
  return paneAt(state, pane).chatId
}

/** The chat the orchestrator column shows: what the toolbar means by "the open chat". */
export function currentChatId(state: AppState): string | null {
  return chatIdOf(state, 0)
}

export function viewOf(state: AppState, chatId: string | null): ChatView {
  return (chatId && state.views[chatId]) || EMPTY_VIEW
}

/** The folder a pane's chat works in, or the one new chats start in. */
export function cwdOf(state: AppState, pane: number): string {
  const chatId = chatIdOf(state, pane)
  return state.chats.find((chat) => chat.id === chatId)?.cwd ?? state.defaultCwd
}

function patchPane(pane: number, patch: Partial<Pane>): void {
  setState({ panes: state.panes.map((entry, index) => (index === pane ? { ...entry, ...patch } : entry)) })
}

function patchView(chatId: string, patch: Partial<ChatView>): void {
  const view = state.views[chatId]
  if (view) setState({ views: { ...state.views, [chatId]: { ...view, ...patch } } })
}

function savePanes(): void {
  writePrefs({ panes: state.panes.map((pane) => ({ chatId: pane.chatId, tabs: pane.tabs, key: pane.key })) })
}

// ── Events ────────────────────────────────────────────────────────────

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
}

function putItem(chatId: string, item: Item): void {
  const known = items.has(item.id)
  items.set(item.id, item)
  if (known) {
    notifyItem(item.id)
    return
  }
  const view = state.views[chatId]!
  const list = view.turnItems[item.turnId] ?? []
  patchView(chatId, { turnItems: { ...view.turnItems, [item.turnId]: [...list, item.id] } })
}

const notificationObserver = new RunNotificationObserver()

function applyEvents(events: HostEvent[]): void {
  const notices: import('../../shared/types.ts').OrchestratorNotification[] = []
  for (const event of events) {
    switch (event.type) {
      case 'orchestrator':
        notices.push(...notificationObserver.observe(event.run))
        // A shown progress.md is the progress view, drawn from the run itself, so it needs no reload.
        setState({ orchestrations: { ...state.orchestrations, [event.run.chatId]: event.run } })
        break
      case 'item':
        if (!state.views[event.chatId]) break
        putItem(event.chatId, event.item)
        if (event.item.type === 'plan') openPlanIfNew(event.chatId, event.item.turnId)
        break
      case 'delta': {
        const item = state.views[event.chatId] ? items.get(event.itemId) : undefined
        if (!item) break
        if (item.type === 'assistant' || item.type === 'reasoning') items.set(item.id, { ...item, text: item.text + event.delta })
        else if (item.type === 'tool') items.set(item.id, { ...item, output: item.output + event.delta })
        notifyItem(item.id)
        break
      }
      case 'turn': {
        const { turn } = event
        const running = new Set(state.running)
        if (turn.status === 'running') running.add(turn.chatId)
        else running.delete(turn.chatId)
        setState({ running })
        const view = state.views[turn.chatId]
        // A turn above the loaded ones changed; it is read as it stands when the reader gets there.
        const above = view && view.hasOlder && !view.turns.some((entry) => entry.id === turn.id) && turn.startedAt < (view.turns[0]?.startedAt ?? 0)
        if (view && !above) {
          patchView(turn.chatId, {
            turns: view.turns.some((entry) => entry.id === turn.id)
              ? view.turns.map((entry) => (entry.id === turn.id ? turn : entry))
              : [...view.turns, turn]
          })
        }
        break
      }
      case 'chat': {
        const rest = state.chats.filter((chat) => chat.id !== event.chat.id)
        setState({ chats: sortChats([...rest, event.chat]) })
        break
      }
      case 'chatDeleted':
        updateDraft(event.chatId, { text: '', attachments: [] })
        setState({ chats: state.chats.filter((chat) => chat.id !== event.chatId) })
        forgetSelection(event.chatId)
        closeTab(event.chatId, 0)
        break
      case 'usage':
        setState({ usage: { ...state.usage, [event.snapshot.provider]: event.snapshot } })
        break
      case 'queue':
        if (state.views[event.chatId]) patchView(event.chatId, { queued: event.queued })
        break
      case 'library':
        if (state.library.loaded) scheduleLibraryLoad()
        break
    }
  }
  void submitNotices(notices, notice => window.rocket.notifications.show(notice))
}

// ── Showing chats ─────────────────────────────────────────────────────

/**
 * Drop the views of chats the column and the board have not open any more, and the items that were theirs. A chat open
 * as a tab keeps its view, which live events keep current, so going back to it asks the host for
 * nothing.
 */
function pruneViews(panes: Pane[]): Record<string, ChatView> {
  const open = new Set([...panes.flatMap((pane) => [pane.chatId, ...pane.tabs]), ...workerChatIds({ ...state, panes })])
  const views: Record<string, ChatView> = {}
  for (const [chatId, view] of Object.entries(state.views)) {
    if (open.has(chatId)) views[chatId] = view
    else dropItems(view.turnItems)
  }
  return views
}

function dropItems(turnItems: Record<string, string[]>): void {
  for (const ids of Object.values(turnItems)) for (const id of ids) items.delete(id)
}

/**
 * A kept chat cut back to its newest page as it comes back on screen, so returning to it costs
 * the same however far up it was read. Not for a worker on the board, which would lose its place there.
 */
function newestPage(view: ChatView): ChatView {
  if (view.turns.length <= TURN_PAGE) return view
  const turns = view.turns.slice(-TURN_PAGE)
  const kept = new Set(turns.map((turn) => turn.id))
  const turnItems: Record<string, string[]> = {}
  for (const [turnId, ids] of Object.entries(view.turnItems)) {
    if (kept.has(turnId)) turnItems[turnId] = ids
    else dropItems({ [turnId]: ids })
  }
  return { ...view, turns, turnItems, hasOlder: true }
}

/** What `chat.open` gave for a chat; without one, the chat's kept view is shown. */
type Page = { turns: Turn[]; items: Item[]; queued: QueuedMessage[]; hasOlder: boolean }

function showChat(pane: number, chatId: string | null, page?: Page, keepArtifact = false): void {
  if (!keepArtifact) {
    linkRequest++
    setState({ artifact: null })
  }
  const running = new Set(state.running)
  for (const turn of page?.turns ?? []) if (turn.status === 'running') running.add(turn.chatId)
  const current = paneAt(state, pane)
  const tabs = chatId && !current.tabs.includes(chatId) ? [...current.tabs, chatId] : current.tabs
  const panes = state.panes.map((entry, index) => (index === pane ? { ...entry, chatId, tabs, restored: null, ...selectionFor(chatId) } : entry))
  const views = pruneViews(panes)
  if (chatId && page) {
    // A fresh snapshot replaces whatever the board loaded of the same chat; it is the newer.
    if (views[chatId]) dropItems(views[chatId].turnItems)
    const turnItems: Record<string, string[]> = {}
    for (const item of page.items) {
      items.set(item.id, item)
      ;(turnItems[item.turnId] ??= []).push(item.id)
    }
    views[chatId] = { turns: page.turns, turnItems, queued: page.queued, planTurnId: null, hasOlder: page.hasOlder }
  } else if (chatId && views[chatId] && !workerChatIds(state).includes(chatId)) {
    views[chatId] = newestPage(views[chatId])
  }
  setState({ panes, views, running })
  savePanes()
  // Coming back to a chat whose turn is still planning shows the plan again, as it did when it started.
  const planning = chatId ? views[chatId]?.turns.findLast((turn) => turn.status === 'running' && items.has(planItemId(turn.id))) : undefined
  if (chatId && planning) openPlanIfNew(chatId, planning.id)
}

/** The drawer opens itself for a running turn's plan, once per chat, until the user closes it there. */
function openPlanIfNew(chatId: string, turnId: string): void {
  const view = state.views[chatId]
  if (!view || view.planTurnId !== null || readPrefs().planClosed?.[chatId]) return
  if (view.turns.find((turn) => turn.id === turnId)?.status !== 'running') return
  patchView(chatId, { planTurnId: turnId })
}

/** Show a turn's plan beside its chat, or close the drawer; closing is remembered for that chat. */
export function togglePlan(chatId: string, turnId: string): void {
  if (viewOf(state, chatId).planTurnId === turnId) {
    closePlan(chatId)
    return
  }
  const { [chatId]: _reopened, ...planClosed } = readPrefs().planClosed ?? {}
  writePrefs({ planClosed })
  patchView(chatId, { planTurnId: turnId })
}

export function closePlan(chatId: string): void {
  writePrefs({ planClosed: { ...readPrefs().planClosed, [chatId]: true } })
  patchView(chatId, { planTurnId: null })
}

function setTabs(pane: number, tabs: string[]): void {
  patchPane(pane, { tabs })
  // A tab closed in the background lets its chat go.
  setState({ views: pruneViews(state.panes) })
  savePanes()
}

function fail(error: unknown): void {
  setState({ error: error instanceof Error ? error.message : String(error) })
}

export function dismissError(): void {
  setState({ error: null })
}

/** Show a chat (or the new-chat screen) in the orchestrator column, pane 0. */
export async function openChat(chatId: string | null, pane: number = 0, keepArtifact = false): Promise<void> {
  if (chatId === null) {
    showChat(pane, null, undefined, keepArtifact)
    return
  }
  // A chat open as a tab is kept current by live events, so it is shown as it stands.
  if (state.views[chatId]) {
    showChat(pane, chatId, undefined, keepArtifact)
    return
  }
  try {
    const snapshot = await call('chat.open', { chatId })
    showChat(pane, chatId, { turns: snapshot.turns, items: snapshot.items, queued: snapshot.queued ?? [], hasOlder: snapshot.hasOlder }, keepArtifact)
  } catch (error) {
    setTabs(pane, paneAt(state, pane).tabs.filter((id) => id !== chatId))
    showChat(pane, null, undefined, keepArtifact)
    fail(error)
  }
}

/**
 * Close a chat's tab in a pane. The chat stays in the history; closing the open one moves to its
 * neighbour. The last tab closing leaves the new-chat screen.
 */
export function closeTab(chatId: string, pane: number): void {
  const current = paneAt(state, pane)
  const index = current.tabs.indexOf(chatId)
  if (index === -1) return
  const tabs = current.tabs.filter((id) => id !== chatId)
  setTabs(pane, tabs)
  if (current.chatId === chatId) void openChat(tabs[index] ?? tabs[index - 1] ?? null, pane)
}

// ── Sending ───────────────────────────────────────────────────────────

/** Send in a pane's chat, creating one first when the composer is on the new-chat screen. */
export async function send(pane: number, text: string, attachments: Attachment[] = []): Promise<boolean> {
  try {
    const current = paneAt(state, pane)
    let chatId = current.chatId
    if (!chatId) {
      const chat = await call('chat.create', { cwd: state.defaultCwd })
      saveSelection(chat.id, { provider: current.provider, modelChoice: current.modelChoice })
      chatId = chat.id
    }
    await call('chat.send', { chatId, provider: current.provider, model: current.modelChoice[current.provider]?.id ?? null, text, attachmentIds: attachments.map(each => each.id) })
    updateDraft(current.chatId ?? `new:${current.key}`, { text: '', attachments: [], sending: false, error: null })
    const now = state.panes[pane]
    if (!current.chatId && now?.key === current.key && now.chatId === current.chatId) await openChat(chatId, pane)
    return true
  } catch (error) {
    fail(error)
    return false
  }
}

/**
 * Have the host warm up the chosen provider for a pane's chat (or for the next new one), so the
 * message being typed does not wait on a cold start. Costs nothing to repeat.
 */
export function prepare(pane: number): void {
  const { chatId, provider, modelChoice } = paneAt(state, pane)
  if (!state.ready || (chatId && state.running.has(chatId))) return
  void call('chat.prepare', { chatId, cwd: state.defaultCwd, provider, model: modelChoice[provider]?.id ?? null }).catch(() => {})
}

/** Stop a pane's turn. Messages that were waiting on it come back to the composer. */
export function stop(pane: number): void {
  const chatId = chatIdOf(state, pane)
  if (!chatId) return
  void call('chat.stop', { chatId })
    .then((withdrawn) => { if (withdrawn) restore(pane, withdrawn, chatId) })
    .catch(fail)
}

/** Stop a pane's turn and send what was waiting on it straight away. */
export function sendNow(pane: number): void {
  const chatId = chatIdOf(state, pane)
  if (chatId) void call('chat.stop', { chatId, sendQueued: true }).catch(fail)
}

/** Take a waiting message back into the composer. */
export function editQueued(pane: number, id: string): void {
  const chatId = chatIdOf(state, pane)
  if (!chatId) return
  void call('chat.unqueue', { chatId, id }).then((text) => restore(pane, text, chatId)).catch(fail)
}

function restore(pane: number, message: string | MessageDraft, chatId: string): void {
  restoreDraft(chatId, message)
  if (state.panes[pane]?.chatId === chatId) patchPane(pane, { restored: { text: '', at: Date.now() } })
}

/** Answer a question a model asked in a pane's chat; the provider picked in its composer takes the reply. */
export async function answerQuestion(pane: number, itemId: string, answer: string): Promise<void> {
  const { chatId, provider, modelChoice } = paneAt(state, pane)
  if (!chatId) return
  try {
    await call('question.answer', { chatId, itemId, answer, provider, model: modelChoice[provider]?.id ?? null })
  } catch (error) {
    fail(error)
  }
}

export function deleteChat(chatId: string): void {
  void call('chat.delete', { chatId }).catch(fail)
}

export function setProvider(pane: number, provider: ProviderId): void {
  const current = paneAt(state, pane)
  patchPane(pane, { provider })
  saveSelection(current.chatId, { provider, modelChoice: current.modelChoice })
}

/** Pick a provider's model, or null to go back to that provider's default. Also selects the provider. */
export function selectModel(pane: number, provider: ProviderId, model: ModelInfo | null): void {
  const current = paneAt(state, pane)
  const modelChoice = { ...current.modelChoice }
  if (model) modelChoice[provider] = { id: model.id, label: model.label }
  else delete modelChoice[provider]
  patchPane(pane, { provider, modelChoice })
  saveSelection(current.chatId, { provider, modelChoice })
}

const modelLoads = new Map<ProviderId, Promise<void>>()

/** Read a provider's models once per session; a failed read can be tried again. */
export function loadModels(provider: ProviderId): Promise<void> {
  let load = modelLoads.get(provider)
  if (!load) {
    load = call('models.list', { provider }).then((models) => {
      setState({ models: { ...state.models, [provider]: models } })
      // Drops a remembered model the provider no longer offers; other chats drop theirs when shown.
      setState({ panes: state.panes.map((pane) => ({ ...pane, modelChoice: selectionFor(pane.chatId).modelChoice })) })
    }).catch(() => {
      modelLoads.delete(provider)
      setState({ models: { ...state.models, [provider]: [] } })
    })
    modelLoads.set(provider, load)
  }
  return load
}

export function setSideWidth(sideWidth: number, save: boolean): void {
  setState({ sideWidth })
  if (save) writePrefs({ sideWidth })
}

/**
 * One reading speed everywhere. Main keeps the browser's (it scrolls web pages), so a change made
 * here is passed on to it, and one made there (Alt+↑/↓ in a page) comes back through `fromBrowser`.
 */
export function setReadingSpeed(speed: number, fromBrowser = false): void {
  const readingSpeed = clampSpeed(speed)
  if (readingSpeed === state.readingSpeed) return
  setState({ readingSpeed })
  writePrefs({ readingSpeed })
  if (!fromBrowser) window.rocket.browser.send({ type: 'readingSpeed', speed: readingSpeed })
}

/** The dock item shown as on: none while an artifact covers the right side. */
export function sideShown(current: AppState): Side | null {
  return current.artifact ? null : current.side
}

/** Show something on the right side; it closes an artifact over it. */
export function showSide(side: Side): void {
  linkRequest++
  const lastApp = side.kind === 'app' ? side.id : state.lastApp
  setState({ side, lastApp, artifact: null })
  writePrefs({ side, lastApp })
  if (side.kind === 'library' && !state.library.loaded) void loadLibrary()
}

/** Where the side goes when the browser or library is toggled off: the last app, else the shelf. */
function fallbackSide(): Side {
  const id = state.lastApp
  return id && isInstalled(state, id) ? { kind: 'app', id } : { kind: 'shelf' }
}

export function setBrowserOpen(open: boolean): void {
  if (open) showSide({ kind: 'browser' })
  else if (state.side.kind === 'browser') showSide(fallbackSide())
}

// ── Library ───────────────────────────────────────────────────────────

/** Show or hide the library on the right side; hiding it goes back to the last app or the shelf. */
export function setLibraryOpen(open: boolean): void {
  if (open) showSide({ kind: 'library' })
  else if (state.side.kind === 'library') showSide(fallbackSide())
}

export function patchLibrary(patch: Partial<LibraryState>): void {
  setState({ library: { ...state.library, ...patch } })
  if (patch.view) writePrefs({ libraryView: patch.view })
}

/** Read the shelf from the host. Card pictures of files that changed are asked for again. */
export async function loadLibrary(): Promise<void> {
  try {
    const entries = await call('library.list', {})
    const kept = new Set(entries.map((entry) => `${entry.id}:${entry.size}`))
    const previous = new Map(state.library.entries.map((entry) => [entry.id, `${entry.id}:${entry.size}`]))
    const previews = Object.fromEntries(Object.entries(state.library.previews).filter(([id]) => previous.has(id) && kept.has(previous.get(id)!)))
    patchLibrary({ entries, previews, loaded: true, error: null })
  } catch (error) {
    patchLibrary({ loaded: true, error: error instanceof Error ? error.message : 'The library could not be read. Close it and open it again.' })
  }
}

let libraryTimer: ReturnType<typeof setTimeout> | null = null
/** Several files often arrive together at a turn's end; the shelf is read once for them. */
function scheduleLibraryLoad(): void {
  if (libraryTimer) clearTimeout(libraryTimer)
  libraryTimer = setTimeout(() => { libraryTimer = null; void loadLibrary() }, 250)
}

/** Ask for a card's picture once; the grid calls this as a card scrolls into view. */
export async function loadLibraryPreview(id: string): Promise<void> {
  if (id in state.library.previews) return
  patchLibrary({ previews: { ...state.library.previews, [id]: null } })
  let preview: LibraryPreview
  try {
    preview = await call('library.preview', { id })
  } catch {
    preview = { type: 'none' }
  }
  patchLibrary({ previews: { ...state.library.previews, [id]: preview } })
}

/** Open a library file in the side panel, over the library; closing it brings the library back. */
export async function openLibraryEntry(id: string): Promise<void> {
  const entry = state.library.entries.find((each) => each.id === id)
  if (!entry) throw new Error(`There is no library file "${id}". Its id may have changed; list the library again.`)
  const request = ++linkRequest
  patchLibrary({ selected: id })
  setState({ artifact: { kind: 'library', entry, view: null, error: null } })
  try {
    const view = await call('library.view', { id })
    if (request === linkRequest) setState({ artifact: { kind: 'library', entry, view, error: null } })
  } catch (error) {
    if (request === linkRequest) setState({ artifact: { kind: 'library', entry, view: null, error: error instanceof Error ? error.message : 'This file could not be shown. Open the library again.' } })
  }
}

/**
 * Fetch the output a page left out of a finished tool call (`outputLength`), when its step is
 * opened. The row re-renders with it; a call that has since gone keeps showing none.
 */
export async function loadOutput(chatId: string, itemId: string): Promise<void> {
  const item = items.get(itemId)
  if (item?.type !== 'tool' || !item.outputLength || item.output) return
  try {
    const output = await call('item.output', { chatId, itemId })
    const current = items.get(itemId)
    if (current?.type !== 'tool') return
    const { outputLength: _left, ...rest } = current
    items.set(itemId, { ...rest, output })
    notifyItem(itemId)
  } catch (error) {
    fail(error)
  }
}

/** Chats whose earlier turns are on their way, so a scroll that fires twice asks once. */
const loadingOlder = new Set<string>()

/**
 * Bring in the turns before the first one a shown chat has loaded, as its reader scrolls up.
 * They go in front of what is there; a chat that was closed or reopened meanwhile keeps its own.
 */
export async function loadOlder(chatId: string): Promise<void> {
  const view = state.views[chatId]
  const first = view?.turns[0]
  if (!view?.hasOlder || !first || loadingOlder.has(chatId)) return
  loadingOlder.add(chatId)
  try {
    const page = await call('chat.older', { chatId, before: first.id })
    const current = state.views[chatId]
    if (current?.turns[0]?.id !== first.id) return
    const turnItems: Record<string, string[]> = {}
    for (const item of page.items) {
      items.set(item.id, item)
      ;(turnItems[item.turnId] ??= []).push(item.id)
    }
    // The page's lists are whole; anything held for those turns was only what live events brought.
    patchView(chatId, { turns: [...page.turns, ...current.turns], turnItems: { ...current.turnItems, ...turnItems }, hasOlder: page.hasOlder })
  } catch (error) {
    fail(error)
  } finally {
    loadingOlder.delete(chatId)
  }
}

/** Chats whose view is on its way, so many windows asking for one chat ask the host once. */
const loadingViews = new Map<string, Promise<void>>()

/** Load a worker's chat for its window on the board, outside every pane. Live events then keep it current. */
export function loadWorkerChat(chatId: string): Promise<void> {
  if (state.views[chatId]) return Promise.resolve()
  let load = loadingViews.get(chatId)
  if (!load) {
    load = loadView(chatId).finally(() => loadingViews.delete(chatId))
    loadingViews.set(chatId, load)
  }
  return load
}

async function loadView(chatId: string): Promise<void> {
  const snapshot = await call('chat.open', { chatId })
  if (state.views[chatId]) return
  const turnItems: Record<string, string[]> = {}
  for (const item of snapshot.items) {
    items.set(item.id, item)
    ;(turnItems[item.turnId] ??= []).push(item.id)
  }
  setState({ views: { ...state.views, [chatId]: { turns: snapshot.turns, turnItems, queued: snapshot.queued ?? [], planTurnId: null, hasOlder: snapshot.hasOlder } } })
  // A plan that arrived before the view did came in the snapshot, not as an event, so it opens
  // here, as it would have from the event (and as showChat does for the column's chat).
  const planning = snapshot.turns.findLast((turn) => turn.status === 'running' && items.has(planItemId(turn.id)))
  if (planning) openPlanIfNew(chatId, planning.id)
}

/** The current state without subscribing, for the dispatcher. */
export function peekState(): AppState {
  return state
}

/** Choose the folder a pane's chat works in, or the folder new chats start in. */
export async function chooseFolder(pane: number): Promise<void> {
  const chat = state.chats.find((entry) => entry.id === chatIdOf(state, pane))
  const picked = await window.rocket.pickFolder(chat?.cwd ?? state.defaultCwd)
  if (!picked) return
  writePrefs({ cwd: picked })
  setState({ defaultCwd: picked })
  if (chat) await call('chat.setCwd', { chatId: chat.id, cwd: picked }).catch(fail)
}

export function refreshUsage(provider: ProviderId, force = false): Promise<void> {
  return call('usage.read', { provider, force })
    .then((snapshot) => setState({ usage: { ...state.usage, [provider]: snapshot } }))
    .catch(() => {})
}

/** The column as it was last time, keeping only chats that still exist; older profiles saved several panes or one chat, and only the first is read. */
function savedPanes(saved: Prefs, chats: Chat[]): Pane[] {
  const exists = (id: string | null): id is string => id !== null && chats.some((chat) => chat.id === id)
  const entry = saved.panes?.[0] ?? { chatId: saved.activeChatId ?? null, tabs: saved.tabs ?? [] }
  const pane = newPane(exists(entry.chatId) ? entry.chatId : null, entry.tabs.filter(exists))
  if ('key' in entry && typeof entry.key === 'number') {
    pane.key = entry.key
    nextPaneKey = Math.max(nextPaneKey, entry.key + 1)
  }
  return [pane]
}

async function load(): Promise<void> {
  try {
    const [chats, orchestrations] = await Promise.all([call('chats.list', {}), call('orchestrator.list', {})])
    notificationObserver.seed(orchestrations)
    setState({ orchestrations: Object.fromEntries(orchestrations.map(run => [run.chatId, run])) })
    const saved = readPrefs()
    setState({ ready: true, chats: sortChats(chats) })
    const panes = savedPanes(saved, chats)
    items.clear()
    setState({ panes, views: {} })
    savePanes()
    collectAttachments()
    // The orchestrator column shows the chat that owns a run in progress when its own chat has none.
    const active = Object.values(state.orchestrations).filter((run) => run.status === 'running' || run.status === 'draining').sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const first = panes[0]!.chatId
    if (active && (!first || !state.orchestrations[first]) && chats.some((chat) => chat.id === active.chatId)) panes[0]!.chatId = active.chatId
    if (panes[0]!.chatId) await openChat(panes[0]!.chatId, 0)
  } catch (error) {
    setState({ ready: true })
    fail(error)
  }
  // The warm-up is asked for ahead of the usage readings, so a provider that can answer those
  // from the process being warmed does not start another for them.
  prepare(0)
  for (const provider of PROVIDERS) refreshUsage(provider.id)
}

export function start(): void {
  window.rocket.notifications.onActivate(target => { void activateRunNotification(target).catch(fail) })
  connectHost({
    events: applyEvents,
    // A restarted host has lost its live turns; read everything again from the store.
    reconnect: () => {
      notificationObserver.reset()
      modelLoads.clear()
      setState({ running: new Set(), models: {} })
      void load()
    }
  })
  void load()
  void loadCraft()
  // Some readings start a provider's CLI, so none are taken for a window nobody is looking at.
  const refreshAll = (): void => {
    if (!document.hidden) for (const provider of PROVIDERS) refreshUsage(provider.id)
  }
  setInterval(refreshAll, 5 * 60_000)
  document.addEventListener('visibilitychange', refreshAll)
  // Something handed to a running app from the command line opens as a chat link would.
  window.rocket.onOpen(({ href, cwd }) => void openChatLink(href, cwd))
}

// A later click or pane close wins over an earlier file read that is still in flight.
let linkRequest = 0

export function closeArtifact(): void {
  linkRequest++
  setState({ artifact: null })
}

/**
 * Show what a turn of a chat changed, beside the conversation. The chat is the one the transcript
 * draws, which on the board is a worker's and not the pane's.
 */
export async function openTurnChanges(chatId: string | null, turnId: string): Promise<void> {
  if (!chatId) return
  const request = ++linkRequest
  try {
    const patch = await call('turn.changes', { chatId, turnId })
    if (request !== linkRequest) return
    if (!patch) throw new Error('The changes of this turn are no longer available.')
    setState({ artifact: { kind: 'changes', chatId, turnId, patch } })
  } catch (error) {
    if (request === linkRequest) fail(error)
  }
}

/** Show an attached file beside the conversation, the way a link opens one. */
export async function openAttachment(attachment: FileAttachment): Promise<void> {
  const request = ++linkRequest
  setState({ artifact: { kind: 'attachment', attachment, preview: null, error: null } })
  try {
    const preview = await call('attachment.preview', { id: attachment.id })
    if (request === linkRequest) setState({ artifact: { kind: 'attachment', attachment, preview, error: null } })
  } catch (error) {
    if (request === linkRequest) setState({ artifact: { kind: 'attachment', attachment, preview: null, error: error instanceof Error ? error.message : 'This file could not be previewed. Attach it again.' } })
  }
}

/** Put a turn's files back as they were before it. The panel stays on the (now dimmed) diff. */
export async function undoTurn(chatId: string, turnId: string): Promise<void> {
  try {
    await call('turn.undo', { chatId, turnId })
    const view = state.artifact
    if (view?.kind === 'changes' && view.turnId === turnId) {
      setState({ artifact: { ...view, patch: { ...view.patch, undo: { offered: false, reason: 'Already undone.' } } } })
    }
  } catch (error) {
    fail(error)
  }
}

/** Open a link from a chat; without a folder of its own it resolves against the orchestrator chat's. */
export async function openChatLink(href: string, cwd?: string): Promise<void> {
  const request = ++linkRequest
  const folder = cwd ?? cwdOf(state, 0)
  try {
    const target = await window.rocket.openChatLink(href, folder)
    if (request !== linkRequest) return
    if (target.kind === 'browser') {
      showSide({ kind: 'browser' })
      window.rocket.browser.send({ type: 'newTab', url: target.url })
    } else {
      setState({ artifact: target })
      void call('library.add', { path: target.path, chatId: chatIdOf(state, 0) }).catch(() => {})
    }
  } catch (error) {
    if (request === linkRequest) fail(error)
  }
}

// ── Progress view ─────────────────────────────────────────────────────

/** The run whose progress.md the side panel shows, or null. Any way the file opens shows the view. */
export function progressRun(current: AppState): Orchestration | null {
  const view = current.artifact
  const path = view?.kind === 'artifact' ? view.path : view?.kind === 'library' ? view.entry.path : null
  if (!path) return null
  return Object.values(current.orchestrations).find((run) => run.progressFile === path) ?? null
}

/** Show a run's progress view in the side panel, at a section if one is given. */
export function openProgress(run: Orchestration, section?: ProgressSection): void {
  linkRequest++
  const shown = progressRun(state)?.id === run.id
  setState({
    artifact: shown ? state.artifact : { kind: 'artifact', path: run.progressFile, text: '', markdown: true, line: null },
    progress: section ? { section, jump: state.progress.jump + 1 } : shown ? state.progress : { section: 'now', jump: state.progress.jump + 1 }
  })
}

/** The section the user has scrolled to; it does not move the view. */
export function noteProgressSection(section: ProgressSection): void {
  if (state.progress.section !== section) setState({ progress: { ...state.progress, section } })
}

function updateRun(run: Orchestration): void {
  setState({ orchestrations: { ...state.orchestrations, [run.chatId]: run } })
}

/** One user change to the plan. Refused edits show as the app's error and return false. */
export async function editPlan(run: Orchestration, edit: PlanEdit): Promise<boolean> {
  try {
    updateRun(await call('orchestrator.planEdit', { runId: run.id, edit }))
    return true
  } catch (error) {
    fail(error)
    return false
  }
}

/** Answer one of the run's open questions. */
export async function answerNeed(run: Orchestration, need: string, answer: string): Promise<boolean> {
  try {
    updateRun(await call('orchestrator.answer', { runId: run.id, need, answer }))
    return true
  } catch (error) {
    fail(error)
    return false
  }
}

// ── Worker board ──────────────────────────────────────────────────────

/** The run the board shows: the one owned by the orchestrator column's chat (pane 0), if any. */
export function boardRun(current: AppState): Orchestration | null {
  const chatId = current.panes[0]?.chatId
  return (chatId && current.orchestrations[chatId]) || null
}

/** The worker chats on the board; their views are kept loaded while the board shows them. */
export function workerChatIds(current: AppState): string[] {
  return boardRun(current)?.tasks.map((task) => task.chatId) ?? []
}

export function workerStatus(current: AppState, run: Orchestration, task: OrchestratorTask): WorkerStatus {
  if (task.status === 'completed') return 'done'
  if (task.status !== 'interrupted') return task.status
  // A stop asked for from the board, or a run the user stopped, is a cancellation; a restart is not.
  const userStopped = current.board.stopped[task.chatId] || (run.status === 'stopped' && !/restart/i.test(task.result))
  return userStopped ? 'cancelled' : 'interrupted'
}

function patchBoard(patch: Partial<BoardState>): void {
  setState({ board: { ...state.board, ...patch } })
}

/** Show a worker large over the board, or null to put it back in its window. */
export function expandWorker(chatId: string | null): void {
  if (chatId) void loadWorkerChat(chatId).catch(fail)
  patchBoard({ expanded: chatId })
}

export function setWorkerFilter(filter: WorkerFilter): void {
  patchBoard({ filter })
}

/** Set the orchestrator column's width; saved once a drag ends. */
export function setOrchWidth(width: number | null, save: boolean): void {
  patchBoard({ width })
  if (save) writePrefs({ orchWidth: width })
}

/**
 * Stop one worker. A queued one leaves the queue through the run, which records it as cancelled and
 * never starts it. A running dispatch goes through the run too, so the task notes that the user
 * asked for it and a failed stop lands on the task; it stays running until the provider's turn
 * really ends. A finished worker can still be running a reply the user sent it, which is a turn of
 * its chat and not of the run, so that one is stopped as any chat's turn is.
 */
export function stopWorker(run: Orchestration, task: OrchestratorTask): void {
  if (task.status === 'queued' || task.status === 'running') {
    if (task.status === 'running') patchBoard({ stopped: { ...state.board.stopped, [task.chatId]: true } })
    void call('orchestrator.cancelTask', { runId: run.id, taskId: task.id })
      .then((updated) => setState({ orchestrations: { ...state.orchestrations, [updated.chatId]: updated } }))
      .catch(fail)
    return
  }
  patchBoard({ stopped: { ...state.board.stopped, [task.chatId]: true } })
  void call('chat.stop', { chatId: task.chatId }).catch(fail)
}

/** Running workers first, then queued ones, then the finished; newest first within each. */
const WORKER_RANK: Record<WorkerStatus, number> = { running: 0, queued: 1, done: 2, failed: 2, interrupted: 2, cancelled: 2 }

/** The board's workers in the order its windows show them, with the filter applied. */
export function boardWorkers(current: AppState, run: Orchestration | null = boardRun(current)): Array<{ task: OrchestratorTask; status: WorkerStatus }> {
  if (!run) return []
  const { filter } = current.board
  return run.tasks
    .map((task, index) => ({ task, status: workerStatus(current, run, task), index }))
    .sort((a, b) => WORKER_RANK[a.status] - WORKER_RANK[b.status] || b.index - a.index)
    .filter((worker) => filter === 'all' || (filter === 'running') === (WORKER_RANK[worker.status] < 2))
    .map(({ task, status }) => ({ task, status }))
}

/**
 * Expand the worker before or after the expanded one, in the board's order, wrapping round. With
 * none expanded, the first (or last) on the board. Returns the chat expanded, or null with no workers.
 */
export function stepWorker(step: 1 | -1): string | null {
  const workers = boardWorkers(state)
  if (workers.length === 0) return null
  const at = workers.findIndex((worker) => worker.task.chatId === state.board.expanded)
  const next = at === -1 ? (step === 1 ? 0 : workers.length - 1) : (at + step + workers.length) % workers.length
  const chatId = workers[next]!.task.chatId
  expandWorker(chatId)
  return chatId
}

/** Open or close the board over the shell while it is folded to a rail. */
export function setBoardRailOpen(open: boolean): void {
  if (state.board.railOpen !== open) patchBoard({ railOpen: open })
}

/** Where a queued worker stands: its place among the queued workers waiting for the same provider. */
export function queuePlace(run: Orchestration, task: OrchestratorTask): number {
  return run.tasks.filter((each) => each.status === 'queued' && each.provider === task.provider).findIndex((each) => each.id === task.id) + 1
}

/** Send a message to a worker chat from its expanded window, to the provider it was dispatched to. */
export async function replyToWorker(chatId: string, provider: ProviderId, text: string): Promise<boolean> {
  try {
    await call('chat.send', { chatId, provider, model: null, text, attachmentIds: [] })
    return true
  } catch (error) {
    fail(error)
    return false
  }
}

/** Open a worker's report in the artifact panel, resolved against its run's folder. */
export function openWorkerReport(run: Orchestration, task: OrchestratorTask): Promise<void> {
  return openChatLink(task.report, run.cwd)
}

/** Awaited controls preserve host refusals and update the captured owner, even after navigation. */
function runControl(runId: string, action: 'wrapUp' | 'resume'): Promise<void> {
  return executeRunControl({
    pending: () => state.board.runAction !== null,
    patch: patchBoard,
    request: (action, runId) => call(action === 'wrapUp' ? 'orchestrator.wrapUp' : 'orchestrator.resume', { runId }),
    update: updateRun
  }, runId, action)
}
export const wrapUpRun = (runId: string): Promise<void> => runControl(runId, 'wrapUp')
export const resumeRun = (runId: string): Promise<void> => runControl(runId, 'resume')
export function clearRunFocus(): void { patchBoard({ focusTarget: null }) }

export async function activateRunNotification(target: import('../../shared/types.ts').OrchestratorNotificationTarget): Promise<void> {
  const unavailable = "This notification's orchestration is no longer available."
  const workerUnavailable = "This notification's worker is no longer available."
  const resolve = (): Orchestration => {
    const run = state.orchestrations[target.chatId]
    if (!run || run.id !== target.runId || !state.chats.some(chat => chat.id === target.chatId)) throw new Error(unavailable)
    return run
  }
  resolve()
  await openChat(target.chatId, 0, true)
  const run = resolve()
  if (state.panes[0]?.chatId !== target.chatId) throw new Error(unavailable)
  if (target.kind === 'worker') {
    const task = run.tasks.find(task => task.id === target.taskId && task.chatId === target.workerChatId)
    if (!task || !state.chats.some(chat => chat.id === target.workerChatId)) throw new Error(workerUnavailable)
    await loadWorkerChat(target.workerChatId).catch(() => { throw new Error(workerUnavailable) })
    const current = resolve()
    if (!current.tasks.some(task => task.id === target.taskId && task.chatId === target.workerChatId) || !state.chats.some(chat => chat.id === target.workerChatId)) throw new Error(workerUnavailable)
    patchBoard({ filter: 'all', expanded: target.workerChatId, railOpen: true,
      focusTarget: { runId: run.id, kind: 'worker', chatId: target.workerChatId } })
  } else {
    patchBoard({ expanded: null, railOpen: false, focusTarget: { runId: run.id, kind: 'run', chatId: null } })
  }
}

// ── Craft apps ────────────────────────────────────────────────────────

/** A saved side as it can be trusted; a first run, with none saved, opens on the shelf. */
function savedSide(saved: unknown): Side {
  const record = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {}
  if (record.kind === 'app' && typeof record.id === 'string') return { kind: 'app', id: record.id }
  if (record.kind === 'browser' || record.kind === 'library') return { kind: record.kind }
  return { kind: 'shelf' }
}

type HasCraft = Pick<AppState, 'craft'>

/** The states of apps main has not reported on, kept so a component reading one gets the same object each time. */
const unreported = new Map<string, CraftState>()

/** An app's state as main last reported it, or as its catalog entry has it before any report. */
export function craftStateOf(current: HasCraft, id: string): CraftState {
  const reported = current.craft.states[id]
  if (reported) return reported
  const installed = current.craft.apps.find((entry) => entry.id === id)?.installed === true
  const key = `${id}:${installed}`
  let fallback = unreported.get(key)
  if (!fallback) unreported.set(key, fallback = { id, installState: installed ? 'installed' : 'none', run: 'stopped' })
  return fallback
}

export function isInstalled(current: HasCraft, id: string): boolean {
  return craftStateOf(current, id).installState === 'installed'
}

/**
 * The dock's apps: the installed ones and those installing, in the order they were installed, with
 * any the order does not know (installed before this profile) after them in the catalog's order.
 */
export function dockApps(current: HasCraft): CraftAppInfo[] {
  const { apps, order } = current.craft
  const docked = apps.filter((app) => {
    const { installState } = craftStateOf(current, app.id)
    return installState === 'installed' || installState === 'installing'
  })
  const rank = (id: string): number => {
    const at = order.indexOf(id)
    return at === -1 ? order.length + apps.findIndex((app) => app.id === id) : at
  }
  return docked.sort((a, b) => rank(a.id) - rank(b.id))
}

function patchCraft(patch: Partial<CraftStore>): void {
  setState({ craft: { ...state.craft, ...patch } })
  if (patch.order) writePrefs({ dockOrder: patch.order })
}

function putCraftState(next: CraftState): void {
  patchCraft({ states: { ...state.craft.states, [next.id]: next } })
}

/** The shown side must name an installed app; one that is gone puts the shelf there. */
function checkShownApp(): void {
  if (!state.craft.loaded) return
  if (state.side.kind === 'app' && !isInstalled(state, state.side.id)) showSide({ kind: 'shelf' })
  if (state.lastApp && !isInstalled(state, state.lastApp)) {
    setState({ lastApp: null })
    writePrefs({ lastApp: null })
  }
}

let craftSubscribed = false

/** Read the catalog and follow main's reports of installs and running apps. */
export async function loadCraft(): Promise<void> {
  if (!craftSubscribed) {
    craftSubscribed = true
    craft().onState((next) => {
      const before = craftStateOf(state, next.id).installState
      putCraftState(next)
      // A finished install or removal changes the catalog's version and size on disk.
      if (before !== next.installState && (next.installState === 'installed' || next.installState === 'none')) void loadCraft()
      if (next.installState === 'installed' && !state.craft.order.includes(next.id)) patchCraft({ order: [...state.craft.order, next.id] })
      if (next.installState === 'none') patchCraft({ order: state.craft.order.filter((id) => id !== next.id) })
      checkShownApp()
    })
  }
  try {
    const apps = await craft().catalog()
    // A report from main is newer than the catalog for anything but whether it is installed now.
    const states = Object.fromEntries(Object.entries(state.craft.states).filter(([id, entry]) => {
      const app = apps.find((each) => each.id === id)
      if (!app) return false
      if (entry.installState === 'none' || entry.installState === 'installing') return !app.installed
      return entry.installState !== 'installed' || app.installed
    }))
    patchCraft({ apps, states, loaded: true, error: null })
    checkShownApp()
  } catch (error) {
    patchCraft({ loaded: true, error: error instanceof Error ? error.message : 'The app catalog could not be read. Close the shelf and open it again.' })
  }
}

/** Show an installed app on the right side; main starts it on the first show. */
export function showApp(id: string): void {
  const app = state.craft.apps.find((entry) => entry.id === id)
  if (!app) throw new Error(`There is no app "${id}". The apps are ${state.craft.apps.map((entry) => entry.id).join(', ') || 'not loaded yet'}.`)
  if (!isInstalled(state, id)) throw new Error(`${app.name} is not installed. The user installs apps from the shelf; suggest it to them.`)
  showSide({ kind: 'app', id })
}

/** Install an app from the shelf. Only the user does this: the app map has no install action. */
export async function installApp(id: string): Promise<void> {
  const current = craftStateOf(state, id)
  if (current.installState === 'installing' || current.installState === 'installed') return
  putCraftState({ id, installState: 'installing', progress: 0, run: 'stopped' })
  patchCraft({ order: [...state.craft.order.filter((each) => each !== id), id] })
  try {
    await craft().install(id)
    void loadCraft()
  } catch (error) {
    const name = state.craft.apps.find((app) => app.id === id)?.name ?? 'The app'
    putCraftState({ id, installState: 'failed', run: 'stopped', error: error instanceof Error ? error.message : `${name} could not be installed. Check your connection and try again.` })
  }
}

/** Remove an installed app from the shelf; the side leaves it first if it is shown. */
export async function removeApp(id: string): Promise<void> {
  if (state.side.kind === 'app' && state.side.id === id) showSide({ kind: 'shelf' })
  try {
    await craft().remove(id)
    putCraftState({ id, installState: 'none', run: 'stopped' })
    patchCraft({ order: state.craft.order.filter((each) => each !== id) })
    checkShownApp()
    void loadCraft()
  } catch (error) {
    fail(error)
  }
}

/** A show that main refused before it could report a state, so the app's region can say why. */
export function noteCraftError(id: string, message: string): void {
  putCraftState({ ...craftStateOf(state, id), run: 'stopped', error: message })
}

export function clearCraftError(id: string): void {
  const { error: _cleared, ...rest } = craftStateOf(state, id)
  putCraftState(rest)
}

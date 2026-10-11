// The vocabulary every process shares: the app-owned transcript, the providers that can answer a
// turn, and the wire protocol between the renderer and the agent host.

import type { Orchestration, PlanEdit } from './orchestrator.ts'
import type { LibraryEntry, LibraryFilters, LibraryPreview, LibraryView } from './library.ts'

export type ProviderId = 'codex' | 'claude' | 'cursor' | 'antigravity'

/** Image bytes live in Craft Studio's data directory; messages carry stable references only. */
export type ImageAttachment = {
  /** Absent on images saved before documents could be attached. */
  kind?: 'image'
  id: string
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  size: number
  width: number
  height: number
}
/** A PDF or a text/code file, stored by the host like an image. `chars` counts the text a model can be given. */
export type FileAttachment = {
  kind: 'file'
  id: string
  name: string
  format: 'pdf' | 'text'
  mimeType: 'application/pdf' | 'text/plain'
  size: number
  chars: number
  lines?: number
  pages?: number
}
export type Attachment = ImageAttachment | FileAttachment
export const isFileAttachment = (attachment: Attachment): attachment is FileAttachment => attachment.kind === 'file'
/** What the side panel shows of a file: the start of its text, or PDF pages as images. */
export type AttachmentPreview =
  | { type: 'text'; text: string; truncated: boolean }
  | { type: 'pdf'; pages: string[]; truncated: boolean }
export type MessageDraft = { text: string; attachments?: Attachment[] }
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_MESSAGE_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_MESSAGE_FILE_BYTES = 50 * 1024 * 1024
/** Images and files together. */
export const MAX_MESSAGE_IMAGES = 10
export const MAX_MESSAGE_ATTACHMENTS = MAX_MESSAGE_IMAGES

/**
 * `steers`: a message sent while this provider is answering joins the turn in flight. For the
 * others it waits for the turn to end. The host decides; this only sets what the composer says.
 */
export const PROVIDERS: ReadonlyArray<{ id: ProviderId; label: string; steers: boolean }> = [
  { id: 'claude', label: 'Claude', steers: true },
  { id: 'codex', label: 'Codex', steers: true },
  { id: 'cursor', label: 'Cursor', steers: false },
  { id: 'antigravity', label: 'Antigravity', steers: false }
]

export function providerLabel(id: ProviderId): string {
  return PROVIDERS.find((provider) => provider.id === id)?.label ?? id
}

export type ToolKind = 'command' | 'edit' | 'read' | 'search' | 'web' | 'mcp' | 'other'
export type ToolStatus = 'running' | 'done' | 'failed'

/** One row of the transcript. Ids are unique within a chat and stable across updates. */
export type Item =
  /** `steer`: sent while the turn was running and taken into it, after the turn's first message. */
  | { type: 'user'; id: string; turnId: string; text: string; attachments?: Attachment[]; steer?: boolean }
  | { type: 'assistant'; id: string; turnId: string; text: string; streaming: boolean }
  | { type: 'reasoning'; id: string; turnId: string; text: string; streaming: boolean }
  | {
      type: 'tool'
      id: string
      turnId: string
      kind: ToolKind
      /** What the call is, in one line: the command, the file, the query. */
      label: string
      status: ToolStatus
      output: string
      /**
       * Set on a finished call in a page sent to the window: its output, this many characters,
       * was left out, since a step's output shows only when opened (`item.output` fetches it).
       */
      outputLength?: number
    }
  | { type: 'notice'; id: string; turnId: string; text: string; tone: 'info' | 'error' }
  /**
   * A question the model asked with `ask_user`. It never holds the turn up: the model carries on
   * and the answer, if one comes, is the chat's next message. `recommended` indexes the option
   * the model would take itself.
   */
  | {
      type: 'question'
      id: string
      turnId: string
      text: string
      options: QuestionOption[]
      recommended: number
      /** The option picked or the words typed; null while unanswered. */
      answer: string | null
    }
  /**
   * The plan a model keeps while it works (Claude Code's TodoWrite, Codex's plan, Cursor's
   * todos). One per turn, id `<turnId>:plan`, replaced whole each time the model updates it; it
   * is shown beside the chat, not in the transcript's flow.
   */
  | { type: 'plan'; id: string; turnId: string; steps: PlanStep[] }
  /**
   * A picture a model made (Codex's image generation), shown in the reply where it was made.
   * `image` is Craft Studio's own copy, stored like an attachment, so it outlives the provider's file.
   */
  | {
      type: 'image'
      id: string
      turnId: string
      status: 'generating' | 'done' | 'failed'
      /** What the picture was made from (the model's revised prompt), shown as its caption. */
      caption: string
      image?: ImageAttachment
      /** Why there is no picture, as a sentence for the user. */
      error?: string
      /** When the host first heard of it, for the elapsed time the placeholder shows. */
      startedAt?: number
      /**
       * From an adapter only: the provider's file and/or its base64 bytes. The hub stores a copy
       * and drops this before the item is saved or sent anywhere.
       */
      source?: GeneratedImageSource
    }

/** Where a provider put a picture it made; the hub reads the file first and the bytes if that fails. */
export type GeneratedImageSource = { path?: string; base64?: string }

/** One clickable answer: a short label and what picking it means. */
export type QuestionOption = { label: string; detail: string }

/** One line of a model's plan. `doing` is the step under way; a provider marks at most one, usually. */
export type PlanStep = { text: string; status: 'todo' | 'doing' | 'done' }

/** The id of a turn's plan item; the one place a turn and its plan are joined. */
export function planItemId(turnId: string): string {
  return `${turnId}:plan`
}

export type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted'

/** One user message and everything one provider did in answer to it. */
export type Turn = {
  id: string
  chatId: string
  provider: ProviderId
  /** The model the provider reported for this turn, when it reports one. */
  model: string | null
  status: TurnStatus
  error: string | null
  /** How many turns by other providers were handed to this provider along with the message. */
  handoffTurns: number
  /** What a running turn is doing, when it is something other than thinking: "Waiting for 2 background tasks". Not kept once the turn ends. */
  activity?: string | null
  /** What the turn changed in its folder, found by comparing its start and end; null until it has ended, or when nothing changed. */
  changes: TurnChanges | null
  /** What the turn cost in tokens, as its provider reported it; null when the provider reports nothing. */
  tokens: TurnTokens | null
  /** What the turn opened on the web and what its reply cited; null until it has ended, or when there was neither. */
  sources: TurnSources | null
  startedAt: number
  endedAt: number | null
}

/**
 * What a turn read on the web against what its reply cited. `opened` is every page the app saw
 * usable content returned for, in Craft Studio's shared reader/browser (`browser`) or through the provider's own fetch tool
 * (`provider`); a search is not a page. `cited` is every HTTP(S) link in the reply, with whether
 * the turn opened it. Worked out by `src/shared/sources.ts`, with no model judgment.
 */
export type TurnSources = {
  opened: Array<{ url: string; via: 'browser' | 'provider' }>
  cited: Array<{ url: string; opened: boolean }>
}

/**
 * A turn's tokens. `input` counts every input token its model calls read, cached ones included,
 * and `cached` how many of those came from the provider's prompt cache. `context` is the input of
 * the turn's last model call alone: how full the session was when the turn ended.
 */
export type TurnTokens = {
  input: number
  cached: number
  output: number
  context: number | null
  contextWindow: number | null
}

/** The totals a transcript line shows for a turn's changes, and whether the user has undone them. The full patch is read with `turn.changes`. */
export type TurnChanges = { files: number; added: number; removed: number; undone: boolean }

/**
 * A turn's changes in full: the unified patch as git wrote it, cut to a size limit when a turn
 * changed a great deal, and whether they can be undone right now (`reason` says why not).
 */
export type TurnPatch = { patch: string; truncated: boolean; undo: { offered: boolean; reason: string | null } }

export type Chat = {
  id: string
  title: string
  cwd: string
  lastProvider: ProviderId | null
  createdAt: number
  updatedAt: number
}

/** A message waiting for the chat's turn in flight to end, to be sent as the next one. Kept in memory only. */
/** `taking`: sent into the running turn, and its model has not read it yet. */
export type QueuedMessage = { id: string; provider: ProviderId; text: string; attachments?: Attachment[]; taking?: boolean }

/**
 * A chat as it opens: its newest turns and their items. A long chat's earlier turns are not
 * sent until the reader scrolls up to them (`chat.older`); `hasOlder` says there are some.
 */
export type ChatSnapshot = { chat: Chat; turns: Turn[]; items: Item[]; queued?: QueuedMessage[]; hasOlder: boolean }
/** The page of turns before one already shown, oldest first, with their items. */
export type OlderTurns = { turns: Turn[]; items: Item[]; hasOlder: boolean }
/** How many turns a chat opens with, and how many more each scroll to the top brings. */
export const TURN_PAGE = 20

export type UsageWindow = { label: string; percent: number; resetsAt: number | null }

/** A provider account's subscription usage, normalized to rolling windows. */
export type UsageSnapshot = {
  provider: ProviderId
  account: string | null
  plan: string | null
  windows: UsageWindow[]
  note: string | null
  /** Why there are no windows, when there are none. */
  unavailable: string | null
  updatedAt: number
}

/** One model a provider offers this account. `id` is whatever that provider takes back. */
export type ModelInfo = { id: string; label: string; description: string; isDefault: boolean }

export type HostEvent =
  | { type: 'orchestrator'; run: Orchestration }
  | { type: 'item'; chatId: string; item: Item }
  | { type: 'delta'; chatId: string; itemId: string; delta: string }
  | { type: 'turn'; turn: Turn }
  | { type: 'chat'; chat: Chat }
  | { type: 'chatDeleted'; chatId: string }
  | { type: 'usage'; snapshot: UsageSnapshot }
  /** The chat's waiting messages, all of them, each time they change. */
  | { type: 'queue'; chatId: string; queued: QueuedMessage[] }
  /** The library's shelf changed; a window showing it lists it again. */
  | { type: 'library' }

/** Request name → [params, result]. */
export type HostApi = {
  'attachment.import': [{ name: string; bytes: Uint8Array; thumbnail: Uint8Array }, ImageAttachment]
  /** A PDF or text file; the host decides which from the bytes and refuses anything else. */
  'attachment.importFile': [{ name: string; bytes: Uint8Array }, FileAttachment]
  'attachment.read': [{ id: string; thumbnail?: boolean }, string]
  'attachment.preview': [{ id: string }, AttachmentPreview]
  /** Copy an attachment's stored original to a path the user chose in the save dialog. */
  'attachment.export': [{ id: string; path: string }, null]
  /** Where the host keeps an attachment's original, for Reveal. */
  'attachment.locate': [{ id: string }, string]
  'attachment.collect': [{ keepIds: string[] }, null]
  'chats.list': [Record<string, never>, Chat[]]
  'chat.create': [{ cwd: string }, Chat]
  'chat.open': [{ chatId: string }, ChatSnapshot]
  /** The turns before `before`, a turn id the window already shows. */
  'chat.older': [{ chatId: string; before: string }, OlderTurns]
  /** A tool call's output, left out of the page that brought the call (`outputLength`). */
  'item.output': [{ chatId: string; itemId: string }, string]
  'chat.setCwd': [{ chatId: string; cwd: string }, Chat]
  'chat.delete': [{ chatId: string }, null]
  /** `model` is one of the provider's `models.list` ids, or null for the provider's default. */
  /**
   * Sent at once when the chat is idle. While a turn runs, it joins that turn when its provider
   * is the one answering and can take it, and otherwise waits for the turn to end.
   */
  'chat.send': [{ chatId: string; provider: ProviderId; model: string | null; text: string; attachmentIds?: string[] }, null]
  /**
   * Stop the turn in flight. Waiting messages are withdrawn with their images, for the
   * composer to take back; with `sendQueued` they stay and go out as soon as the turn has stopped.
   */
  'chat.stop': [{ chatId: string; sendQueued?: boolean }, string | MessageDraft | null]
  /** Take one waiting message back, including any images. Text-only callers retain string results. */
  'chat.unqueue': [{ chatId: string; id: string }, string | MessageDraft]
  /** A turn's changes as a unified patch; null when the turn changed nothing or its folder is not a repository. */
  'turn.changes': [{ chatId: string; turnId: string }, TurnPatch | null]
  /** Put the turn's files back as they were before it; the reversal is committed like a turn. Returns the turn as it now stands. */
  'turn.undo': [{ chatId: string; turnId: string }, Turn]
  /** Answer a question a model asked. The answer is sent as the chat's next message to `provider`. */
  'question.answer': [{ chatId: string; itemId: string; answer: string; provider: ProviderId; model: string | null }, null]
  /** Warm the provider up for the message being typed. A null `chatId` is the next new chat, in `cwd`. */
  'chat.prepare': [{ chatId: string | null; cwd: string; provider: ProviderId; model: string | null }, null]
  'usage.read': [{ provider: ProviderId; force?: boolean }, UsageSnapshot]
  'models.list': [{ provider: ProviderId }, ModelInfo[]]
  'orchestrator.cancelTask': [{ runId: string; taskId: string }, Orchestration]
  'orchestrator.wrapUp': [{ runId: string }, Orchestration]
  'orchestrator.resume': [{ runId: string }, Orchestration]
  'orchestrator.list': [Record<string, never>, Orchestration[]]
  /** A user change to a run's plan from the progress view; see `PlanEdit`. */
  'orchestrator.planEdit': [{ runId: string; edit: PlanEdit }, Orchestration]
  /** The user's answer to one of the run's open questions. */
  'orchestrator.answer': [{ runId: string; need: string; answer: string }, Orchestration]
  /** An error the page caught, for the host's journal. */
  'journal.report': [{ message: string; stack?: string }, null]
  /** MCP tool-call ledger for the Tools panel (read-only; not injected into agent prompts). */
  'toolLedger.loadPanel': [Record<string, never>, {
    available: boolean
    message?: string
    path?: string
    syncedAt?: string
    contextPolicy?: Record<string, unknown>
    scopes?: Array<{
      scope: string[]
      attempts: number
      successes: number
      failures: number
      descriptionBytes: number
      successRate: number | null
      failureRate: number | null
    }>
    groups?: Array<{
      tool: string
      operation: string
      code: string
      count: number
      failureRate: number
      examples: string[]
    }>
    queue?: Array<{
      callId: string
      tool: string
      code: string | null
      lifecycle: string
      at: number
    }>
    registeredTools?: Array<{ name: string; descriptionBytes: number; version: number }>
    retryCandidates?: Array<{ callId: string; tool: string; at: number }>
  }]
  'toolLedger.callDetail': [{ callId: string }, {
    path?: string
    calls?: Array<Record<string, unknown>>
    matching?: number
  }]
  /** Every file on the library's shelf, newest first (docs/library-plan.md). */
  'library.list': [Record<string, never>, LibraryEntry[]]
  /** A card's picture or opening text. */
  'library.preview': [{ id: string }, LibraryPreview]
  /** What the side panel shows of a file opened from the library. */
  'library.view': [{ id: string }, LibraryView]
  /** A file a chat opened (a link, `npm run open`) joins the shelf. */
  'library.add': [{ path: string; chatId: string | null }, LibraryEntry | null]
  'toolLedger.setReview': [{
    callId: string
    lifecycle?: 'diagnosed' | 'regression_added' | 'fixed' | 'verified'
    retryCallId?: string | null
    linkRetry?: boolean
    causeCode?: string | null
    causeNote?: string | null
    proposedFix?: string | null
  }, {
    path: string
    review: {
      callId: string
      lifecycle: string
      retryCallId: string | null
      causeCode: string | null
      proposedFix: string | null
    }
  }]
}

export type HostMethod = keyof HostApi

export type HostRequestMessage = { kind: 'request'; id: number; method: HostMethod; params: unknown }
export type HostResponseMessage =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
/** Events are batched per frame so a fast token stream costs one message, not hundreds. */
export type HostEventBatch = { kind: 'events'; events: HostEvent[] }
export type HostToRenderer = HostResponseMessage | HostEventBatch

/** One browser tab, as the tab strip and the address field need to see it. */
export type BrowserTab = {
  id: string
  /** Empty on the new tab page, as in Chromium. */
  url: string
  title: string
  /** A data: URL, or null when the page has no icon. */
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  pinned: boolean
  audible: boolean
  muted: boolean
  /** Opened by a model for its own work. */
  agent: boolean
  /** Hands-free reading in this tab, or null when it is not reading (src/main/reading-scroll.ts). */
  reading: BrowserReading | null
}

/** A tab's hands-free reading: how far down the page it is, and how long the rest takes at the current speed. */
export type BrowserReading = { state: 'running' | 'paused' | 'end'; progress: number; secondsLeft: number }

/** Tabs in strip order: pinned ones first. `readingSpeed` is the one speed every tab reads at. */
export type BrowserState = { tabs: BrowserTab[]; activeId: string | null; readingSpeed: number }

/** One browser tab, as a model is told about it. `id` is short (t3) and lasts until the app quits. */
/** A file a model's browsing saved, in main's record of it. */
export type BrowserDownload = {
  id: string
  chat: string
  url: string
  name: string
  path: string
  mime: string
  /** Bytes in all, 0 while unknown. */
  size: number
  received: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  startedAt: number
}

export type AgentTab = {
  id: string
  url: string
  title: string
  /** The tab the user is looking at. */
  active: boolean
  loading: boolean
  /** Opened by a model for its own work, not by the user. */
  agent: boolean
}

/**
 * Which tab an operation is for. With no `tab`, it is the tab the calling chat's model works in,
 * created the first time one is needed (the strip switches to it when opened); `chat` is null when the caller's chat
 * is unknown, and such callers share one.
 */
type OnTab = { chat: string | null; tab: string | null }
export type ReadFocus = 'all' | 'text' | 'elements' | 'network' | 'a11y'
/** After document-ready, optional bounded wait for SPAs (tab.goto second argument). */
export type GotoUntil = 'none' | 'title' | 'hash' | 'request'

/** What the agent host's tools can ask of the browser. Main does the work and answers once. */
export type BrowserAgentOp =
  | { op: 'tabs' }
  | { op: 'open'; chat: string | null; url: string | null }
  /** A request with the browser's cookies but no page: no CORS, no rendering. */
  | { op: 'fetch'; url: string; method: string | null; headers: Record<string, string> | null; body: string | null }
  | (OnTab & { op: 'info' })
  | (OnTab & { op: 'close' })
  | (OnTab & { op: 'goto'; url: string; until?: GotoUntil | null; untilValue?: string | null; settleTimeout?: number | null })
  /** The page as text a model can read. With a `url`, the tab goes there first. */
  | (OnTab & { op: 'read'; url: string | null; focus: ReadFocus; selector: string | null; max: number | null; query?: string | null; attachJson?: boolean | null })
  | (OnTab & { op: 'mark' })
  | (OnTab & { op: 'delta' })
  | (OnTab & { op: 'waitSpa'; timeout: number })
  | (OnTab & { op: 'follow'; href: string; until?: GotoUntil | null; untilValue?: string | null; settleTimeout?: number | null })
  /** JavaScript in the page's own world; the result must survive JSON. */
  | (OnTab & { op: 'eval'; expression: string })
  | (OnTab & { op: 'click'; target: string })
  | (OnTab & { op: 'fill'; target: string; value: string })
  | (OnTab & { op: 'press'; key: string })
  | (OnTab & { op: 'type'; text: string })
  /** Until `target` is visible or `expression` is truthy. */
  | (OnTab & { op: 'wait'; target: string | null; expression: string | null; timeout: number })
  | (OnTab & { op: 'requests'; match: string | null })
  | (OnTab & { op: 'body'; request: string })
  | (OnTab & { op: 'screenshot'; som?: boolean | null; somMax?: number | null })
  | (OnTab & { op: 'har'; sinceSeq: number | null; saveTo: string | null })
  /**
   * Save a file without a dialog: `url` (absolute, or relative to the tab's page) or what clicking
   * `target` downloads. `saveTo` is an absolute folder or file, or null for the downloads folder.
   * Waits up to `timeout` ms for the file to finish.
   */
  | (OnTab & { op: 'download'; url: string | null; target: string | null; saveTo: string | null; timeout: number })
  /** The chat's downloads that started at or after `since` (ms since the epoch). */
  | { op: 'downloads'; chat: string | null; since: number }
  /** The chat's turn is over: the tabs it worked in go back to being ordinary background tabs. */
  | { op: 'rest'; chat: string }
  /** The chat is gone: its own tab is closed. */
  | { op: 'forget'; chat: string }
/** The host-to-main channel also carries app UI captures, live automation connections and the app map. */
export type MainAgentOp = BrowserAgentOp | { op: 'uiSnapshot' } | { op: 'uiConnection' } | { op: 'uiResize'; width: number; height: number } | UiMapOp
/** Main runs these in the renderer's dispatcher (`window.rocketMap`); see `src/shared/app-map.ts`. */
export type UiMapOp =
  | { op: 'uiMap'; call: 'where' }
  | { op: 'uiMap'; call: 'go'; place: string; params: Record<string, unknown> }
  | { op: 'uiMap'; call: 'act'; action: string; params: Record<string, unknown> }
/** Where the shell is, in the app map's words. `place` is the most specific place on screen. */
export type UiWhere = {
  place: string
  panes: Array<{ index: number; chatId: string | null; title: string; provider: ProviderId; running: boolean; planOpen: boolean }>
  /** What the right side shows; an artifact (a file or the progress view) covers whatever is under it. */
  side: 'app' | 'shelf' | 'browser' | 'library' | 'artifact'
  artifact: { kind: string; path: string | null } | null
  /**
   * The Craft apps: the one shown on the right side (null when it shows something else) and every
   * app in the catalog with its install and run state. Models show installed apps; only the user installs.
   */
  craft?: {
    shown: string | null
    apps: Array<{ id: string; name: string; likeName: string; installState: 'none' | 'installing' | 'installed' | 'failed'; run: 'stopped' | 'starting' | 'shown' | 'working' | 'resting' }>
  }
  /** The progress view: its run, the section in view, the plan, and what is waiting; null while it is not shown. */
  progress?: {
    runId: string
    chatId: string
    section: string
    plan: Array<{ id: string; text: string; status: string; byUser: boolean }>
    pending: Array<{ id: string; text: string }>
    needs: Array<{ id: string; text: string; options: string[] }>
  } | null
  /** The library panel: its filters, view and how many files they show; null while it is closed. */
  library: { filters: LibraryFilters; view: 'grid' | 'list'; shown: number; total: number } | null
  /**
   * The worker board beside the orchestrator chat (pane 0): its run, each worker window by chat,
   * and the one expanded over the board. Absent or null when the column's chat owns no run.
   */
  board?: {
    /** `task` is the brief's first sentence; the whole brief is in the run's progress view. */
    run: { id: string; chatId: string; status: string; task: string; reason: string | null; canWrapUp: boolean; canResume: boolean; actionPending: boolean }
    filter: 'all' | 'running' | 'done'
    expanded: string | null
    workers: Array<{ chatId: string; taskId: string; provider: ProviderId; status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled'; title: string }>
  } | null
}
/** A dispatcher call's answer: what it returned, or why it failed, and where the shell ended up. */
export type UiMapResult = { ok: true; value: unknown; where: UiWhere } | { ok: false; error: string; where: UiWhere }
export type LiveUiConnection = { endpoint: string; pid: number; surfaces: Partial<Record<'shell' | 'browser' | 'suggestions', string>> }
export type UiSnapshot = {
  capturedAt: string
  instance: { pid: number; startedAt: string; version: string; mainBundleSha256: string; rendererUrl: string }
  window: { bounds: Bounds; contentBounds: Bounds; focused: boolean; minimized: boolean }
  shell: {
    panels: Array<{ name: string; bounds: Bounds }>
    /** `nav` is the app map's name for a control that opens a place; see `src/shared/app-map.ts`. */
    controls: Array<{ role: string; name: string; disabled: boolean; bounds: Bounds; nav?: string }>
    controlsTruncated: boolean
  }
  views: Array<{ url: string; bounds: Bounds; z: number }>
  capture: 'window' | 'surfaces'
  warnings: string[]
  directory: string
  images: Array<{ label: string; path: string; mimeType: string; base64: string }>
}
export type BrowserAgentRequest = { type: 'browser'; id: number; op: MainAgentOp }
export type BrowserAgentReply =
  | { type: 'browserReply'; id: number; ok: true; result: unknown }
  | { type: 'browserReply'; id: number; ok: false; error: string }

/** Host → isolated UI supervisor, over its private JSON-lines stdin. */
export type UiRunRequest = { id: number; code?: string; timeout?: number; capture?: boolean; close?: boolean }

export type Bounds = { x: number; y: number; width: number; height: number }

/** One row of the address field's dropdown. `value` is what choosing it navigates to. */
export type Suggestion = { kind: 'search' | 'url' | 'history'; value: string; title: string; detail: string }
export type SuggestionList = { items: Suggestion[]; selected: number }

/** The dropdown is a native view sized by main, so both sides share its row metrics. */
export const SUGGEST_ROW_HEIGHT = 32
export const SUGGEST_PADDING = 5

/** Everything the UI can ask of the browser. Commands without an id act on the active tab. */
export type BrowserCommand =
  /** Where the page goes, in window coordinates; null hides the browser. */
  | { type: 'setBounds'; bounds: Bounds | null }
  /** Ask for the current state, on mount. */
  | { type: 'sync' }
  /** Whether keyboard focus is in the browser's own toolbar, so tab shortcuts apply there too. */
  | { type: 'chromeFocus'; focused: boolean }
  | { type: 'newTab'; url?: string }
  | { type: 'closeTab'; id: string }
  | { type: 'activateTab'; id: string }
  /** `index` is the tab's new place in the strip. */
  | { type: 'moveTab'; id: string; index: number }
  | { type: 'muteTab'; id: string; muted: boolean }
  /** Show the tab's right-click menu at the pointer. */
  | { type: 'tabMenu'; id: string }
  | { type: 'navigate'; input: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'stop' }
  /** Show suggestions for what is typed, in a dropdown under `anchor` (the address field). */
  | { type: 'suggest'; text: string; anchor: Bounds }
  | { type: 'suggestSelect'; index: number }
  | { type: 'suggestHide' }
  /** Sent by the dropdown itself when a row is clicked. */
  | { type: 'suggestPick'; value: string }
  /** Hands-free reading in the active tab: start or stop it, or pause and carry on (`toggle`). */
  | { type: 'reading'; action: 'flip' | 'toggle' | 'stop' }
  | { type: 'readingSpeed'; speed: number }

export type ChatLinkTarget =
  | { kind: 'browser'; url: string }
  | { kind: 'artifact'; path: string; text: string; markdown: boolean; line: number | null }

/** A window or screen the capture picker offers, from Electron's desktopCapturer. Images are data URLs. */
export type CaptureSource = { id: string; kind: 'window' | 'screen'; name: string; thumbnail: string; icon: string | null; own: boolean }
/** What to capture: the browser's page, Craft Studio itself, a picked window or screen, the screen under the pointer, or a region of it. */
export type CaptureRequest = { kind: 'page' } | { kind: 'rocket' } | { kind: 'source'; id: string } | { kind: 'screen' } | { kind: 'region' }
/** A capture as PNG bytes at source resolution; `from` names where it came from for the review and the file name. */
export type CaptureResult = { png: Uint8Array; width: number; height: number; from: string; name: string }

export type OrchestratorNotificationTarget =
  | { kind: 'worker'; runId: string; chatId: string; workerChatId: string; taskId: string }
  | { kind: 'run'; runId: string; chatId: string }
export type OrchestratorNotification = {
  key: string
  title: string
  body: string
  target: OrchestratorNotificationTarget
}
export type NotificationOutcome = 'shown' | 'suppressed' | 'unsupported' | 'failed'

/** What the preload exposes on `window.rocket`. */
export type RocketBridge = {
  /** Ask main for a MessagePort to the agent host; it arrives as a window `message` event. */
  requestHostPort: () => void
  notifications: {
    show: (notice: OrchestratorNotification) => Promise<NotificationOutcome>
    onActivate: (listener: (target: OrchestratorNotificationTarget) => void) => () => void
  }
  window: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
  }
  pickFolder: (current: string | null) => Promise<string | null>
  capture: {
    sources: () => Promise<CaptureSource[]>
    /** Null when the user cancelled (a region dismissed with Escape). */
    take: (request: CaptureRequest) => Promise<CaptureResult | null>
  }
  /** The system save dialog for an attachment; the host then copies the stored original there. */
  saveAttachmentAs: (name: string) => Promise<string | null>
  /** Show a stored attachment in the file manager. Main refuses paths outside the attachments folder. */
  revealAttachment: (path: string) => Promise<void>
  openChatLink: (href: string, cwd: string) => Promise<ChatLinkTarget>
  /** Main hands over something to open as a chat link would: a second launch of the app with a path or URL. */
  onOpen: (listener: (target: { href: string; cwd: string }) => void) => () => void
  homeDir: string
  browser: {
    send: (command: BrowserCommand) => void
    onState: (listener: (state: BrowserState) => void) => () => void
    onSuggestions: (listener: (list: SuggestionList) => void) => () => void
    /** Main asks for the address field to take focus (Ctrl+L, a new tab). */
    onFocusAddress: (listener: () => void) => () => void
  }
}

export const HOST_PORT_MESSAGE = 'rocket:host-port'

// ---- Craft apps --------------------------------------------------------------------------------
// The open-source Craft apps hosted on the right side. Main installs them (`craft-install.ts`) and
// docks their native windows (`craft-dock.ts`); the preload exposes this contract on `window.craft`.
// The manifest itself is `craft-apps.ts`; these are only the shapes that cross into the renderer.

/** One app as the shelf and the dock show it: the manifest's identity plus what is installed. */
export type CraftAppInfo = {
  id: string
  name: string
  /** The well-known app it stands in for, for the shelf's "like Photoshop". */
  likeName: string
  /** The dock's label under the icon. */
  shortName: string
  /** Two letters for the icon until the release icons are used. */
  initials: string
  /** The icon's colour. */
  accent: string
  description: string
  /** `storytold/<app>` */
  repo: string
  /** The pinned version Craft Studio installs. */
  version: string
  extensions: string[]
  /** The pinned release download, in bytes. */
  downloadBytes: number
  /** The download size until installed, then the bytes the install takes on disk. */
  sizeBytes: number
  installed: boolean
  installedVersion: string | null
}

export type CraftInstallState = 'none' | 'installing' | 'installed' | 'failed'
/**
 * stopped: no process. starting: launched, its window not docked yet. shown: on screen, no limits.
 * working: hidden, recently used or called by a model, lower CPU share. resting: hidden and idle
 * for two minutes, memory squeezed and lowest CPU share. Every state but stopped has a process.
 */
export type CraftRunState = 'stopped' | 'starting' | 'shown' | 'working' | 'resting'

export type CraftState = {
  id: string
  installState: CraftInstallState
  /** 0 to 1 while installing. */
  progress?: number
  run: CraftRunState
  /** A full sentence, for a failed install or start. */
  error?: string
}

/** The right side's app region in CSS pixels, relative to the window's content. */
export type CraftBounds = Bounds

/** What the preload exposes on `window.craft`. */
export type CraftBridge = {
  catalog: () => Promise<CraftAppInfo[]>
  /** Only the UI may install or remove apps; model tools never can. */
  install: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /**
   * Shows the app in the region, starting it first if it is not running, and parks whichever app
   * was shown. `folder` is the chat's folder: an app started now may read and write only there.
   */
  show: (id: string, bounds: CraftBounds, folder?: string | null) => Promise<void>
  setBounds: (bounds: CraftBounds) => Promise<void>
  /** Parks the shown app, when the shelf, the browser or the library takes the region. */
  hide: () => Promise<void>
  onState: (listener: (state: CraftState) => void) => () => void
}

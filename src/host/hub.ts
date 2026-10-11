import { isSearchUrl, webReadProblem } from '../shared/web-evidence.ts'
import { randomUUID } from 'node:crypto'
import { validateAttachments, type ProviderAttachment } from './attachments.ts'
import type { Chat, ChatSnapshot, OlderTurns, HostEvent, Attachment, GeneratedImageSource, ImageAttachment, MessageDraft, Item, ModelInfo, ProviderId, QueuedMessage, Turn, TurnTokens, UsageSnapshot , TurnSources } from '../shared/types.ts'
import { isFileAttachment } from '../shared/types.ts'
import { buildHandoff, type Handoff, type MissedTurn } from './handoff.ts'
import { messageOf, oneLine } from './json.ts'
import { describeTokens } from './journal.ts'
import type { ProviderAdapter, RunResult, TurnSink, UnpromptedTurn } from './providers/provider.ts'
import { unavailableUsage } from './providers/provider.ts'
import { pageKey, sourcesNotice, turnSources } from '../shared/sources.ts'
import { publicTurn, type Store, type StoredTurn } from './store.ts'
import type { Working } from './teamwork.ts'

// The chat itself. The hub owns every conversation in the store and lends each turn to whichever
// provider the user picked for that message. A provider's session is resumed where it left off
// and handed only the turns it missed (handoff.ts); nothing here knows how any provider works.

const USAGE_REUSE_MS = 60_000
const MODELS_REUSE_MS = 10 * 60_000

/** How long a turn took to show something, measured from the moment the message was sent, and what it cost. */
export type TurnTiming = {
  chatId: string
  provider: ProviderId
  model: string | null
  status: Turn['status']
  /** Why a failed turn failed. */
  error: string | null
  /** To the provider's first sign of life: a session, a model, an item. */
  firstEventMs: number | null
  /** To the first reasoning or reply text the user could read. */
  firstTextMs: number | null
  totalMs: number
  tokens: TurnTokens | null
}

export function describeTiming(timing: TurnTiming): string {
  const ms = (value: number | null): string => (value === null ? 'none' : `${Math.round(value)}ms`)
  return `turn ${timing.provider}${timing.model ? ` (${timing.model})` : ''} ${timing.status}: `
    + `first event ${ms(timing.firstEventMs)}, first text ${ms(timing.firstTextMs)}, total ${(timing.totalMs / 1000).toFixed(1)}s`
    + (timing.tokens ? `; ${describeTokens(timing.tokens)}` : '')
}

type Question = Extract<Item, { type: 'question' }>
type Queued = QueuedMessage & { model: string | null }
/** Words sent into a running turn that its model has not read yet. */
type Taking = Queued & { turnId: string }

function takenItem(entry: Taking): Item {
  return { type: 'user', id: entry.id, turnId: entry.turnId, text: entry.text, steer: true }
}

/**
 * What a provider is told with words the user added mid-turn. Without the second sentence a
 * model stops to say "Got it", which the user does not want.
 */
export function steerText(text: string): string {
  return `[The user sent this while you were working. Take it into account from here on and carry on with the task; do not stop to acknowledge it.]\n\n${text}`
}

type LiveTurn = {
  turn: StoredTurn
  adapter: ProviderAdapter
  /** `performance.now()` at the send, and at the two marks `TurnTiming` reports. */
  clock: { sent: number; firstEvent: number | null; firstText: number | null }
  /** Items as they stand right now, deltas applied; the store gets them when they settle. */
  items: Map<string, Item>
  /** The pages the app saw the turn open, in order, for its sources record at the end. */
  opened: TurnSources['opened']
  stopRequested: boolean
  /** Pictures the turn made that are still being copied into Craft Studio's store; the turn ends after them. */
  saving: Array<Promise<void>>
}

type ImageItem = Extract<Item, { type: 'image' }>

export class Hub {
  private closing = false
  /** chatId → the turn in flight. One turn per chat at a time. */
  private readonly live = new Map<string, LiveTurn>()
  /** chatId → messages waiting for its turn in flight to end, oldest first. */
  private readonly queues = new Map<string, Queued[]>()
  private readonly taking = new Map<string, Taking[]>()
  private readonly usageCache = new Map<ProviderId, { at: number; snapshot: UsageSnapshot }>()
  private readonly usagePending = new Map<ProviderId, Promise<UsageSnapshot>>()
  private readonly modelCache = new Map<ProviderId, { at: number; models: Promise<ModelInfo[]> }>()
  private readonly turnWaiters = new Map<string, Array<{ turnId?: string; resolve: (turn: Turn) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>>()

  constructor(
    private readonly store: Store,
    private readonly adapters: Record<ProviderId, ProviderAdapter>,
    private readonly emit: (event: HostEvent) => void,
    private readonly onTiming: (timing: TurnTiming) => void = () => {},
    /**
     * A few lines about the app's state to put ahead of the user's message, or null for none.
     * `fresh` says the provider's session is new and has been told nothing yet.
     */
    private readonly context: ((chatId: string, provider: ProviderId, fresh: boolean) => Promise<string | null>) | null = null,
    private readonly resolveAttachments: (ids: string[]) => ProviderAttachment[] = () => [],
    /** Keep Craft Studio's own copy of a picture a provider made, stored like an attachment. */
    private readonly saveImage: (source: GeneratedImageSource, caption: string) => Promise<ImageAttachment> =
      () => Promise.reject(new Error('Craft Studio has nowhere to keep generated images in this run.'))
  ) {
    for (const entry of store.queues()) if (store.chat(entry.chatId)) this.queues.set(entry.chatId, entry.messages)
    for (const [provider, adapter] of Object.entries(adapters) as Array<[ProviderId, ProviderAdapter]>) {
      adapter.onUnprompted?.((chatId, reason) => this.openUnprompted(chatId, provider, reason))
    }
  }

  /** The chat a provider is answering right now, when it is answering exactly one. */
  runningChat(provider: ProviderId): string | null {
    const chats = [...this.live.values()].filter((live) => live.turn.provider === provider)
    return chats.length === 1 ? chats[0]!.turn.chatId : null
  }

  /** A chat's turn in flight, or null. The orchestrator reads its activity to find a worker held
   *  open only by background tasks after its report is written, and to steer rather than send. */
  liveTurn(chatId: string): Turn | null {
    return this.live.get(chatId)?.turn ?? null
  }

  /** Every turn in flight, with what it was asked and the files it has edited so far. */
  working(): Working[] {
    return [...this.live.values()].map(({ turn, items }) => {
      const user = items.get(`${turn.id}:user`)
      return {
        chatId: turn.chatId,
        provider: turn.provider,
        model: turn.model,
        request: user?.type === 'user' ? user.text : '',
        edited: [...items.values()].flatMap((item) => (item.type === 'tool' && item.kind === 'edit' && item.status !== 'failed' ? [item.label] : []))
      }
    })
  }

  listChats(): Chat[] {
    return this.store.listChats()
  }

  /** Resolve when a turn in this chat reaches a terminal status. */
  waitForTurn(chatId: string, options?: { turnId?: string; timeoutMs?: number }): Promise<Turn> {
    const timeoutMs = options?.timeoutMs ?? 600_000
    const wanted = options?.turnId
    const done = wanted
      ? this.store.turn(wanted)
      : this.store.lastSettledTurn(chatId)
    if (done && done.chatId === chatId && done.status !== 'running' && (!wanted || done.id === wanted)) {
      return Promise.resolve(publicTurn(done))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dropTurnWaiter(chatId, entry)
        reject(new Error(`Turn did not finish within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      const entry = {
        turnId: wanted,
        resolve: (turn: Turn) => { clearTimeout(timer); resolve(turn) },
        reject: (error: Error) => { clearTimeout(timer); reject(error) },
        timer
      }
      this.turnWaiters.set(chatId, [...this.turnWaiters.get(chatId) ?? [], entry])
    })
  }

  createChat(cwd: string, title = 'New chat'): Chat {
    const now = Date.now()
    const chat: Chat = { id: randomUUID(), title, cwd, lastProvider: null, createdAt: now, updatedAt: now }
    this.store.createChat(chat)
    this.emit({ type: 'chat', chat })
    return chat
  }

  /** The turns before `before`, for a reader scrolling up. A running turn is always the newest, so none of these is live. */
  olderTurns(chatId: string, before: string): OlderTurns {
    this.requireChat(chatId)
    const page = this.store.olderTurns(chatId, before)
    return { ...page, items: page.items.map(withoutOutput) }
  }

  /** The output `withoutOutput` left out of a page: from the turn in flight when it is the live one's. */
  itemOutput(chatId: string, itemId: string): string {
    const item = this.live.get(chatId)?.items.get(itemId) ?? this.store.item(chatId, itemId)
    if (item?.type !== 'tool') throw new Error('That step is no longer in this chat.')
    return item.output
  }

  openChat(chatId: string): ChatSnapshot {
    const stored = this.store.snapshot(chatId)
    if (!stored) throw new Error('That chat no longer exists')
    // The turn in flight keeps its output below, as it streams; every other call's waits to be opened.
    const snapshot = { ...stored, items: stored.items.map(withoutOutput), queued: this.queued(chatId) }
    const live = this.live.get(chatId)
    if (!live) return snapshot
    // A turn in flight holds newer text than the store does.
    const items = snapshot.items.map((item) => live.items.get(item.id) ?? item)
    const known = new Set(items.map((item) => item.id))
    for (const item of live.items.values()) if (!known.has(item.id)) items.push(item)
    return { ...snapshot, items }
  }

  setCwd(chatId: string, cwd: string): Chat {
    const chat = this.requireChat(chatId)
    if (this.live.has(chatId)) throw new Error('Wait for the current turn to finish before changing the folder')
    const next = { ...chat, cwd }
    // A provider's warm session is tied to the folder it was opened in; the next message reopens it in the new one.
    if (cwd !== chat.cwd) for (const adapter of Object.values(this.adapters)) adapter.forget(chatId)
    this.store.updateChat(next)
    this.emit({ type: 'chat', chat: next })
    return next
  }

  async deleteChat(chatId: string): Promise<void> {
    this.queues.delete(chatId)
    this.taking.delete(chatId)
    await this.stop(chatId)
    for (const adapter of Object.values(this.adapters)) adapter.forget(chatId)
    this.store.deleteChat(chatId)
    this.emit({ type: 'chatDeleted', chatId })
  }

  /** Start a turn and return its id; its progress and end arrive as events. */
  send(chatId: string, provider: ProviderId, model: string | null, text: string, attachments: Attachment[] = []): string {
    const message = text.trim()
    if (!message && !attachments.length) throw new Error('There is nothing to send')
    validateAttachments(attachments)
    if (attachments.some(each => !isFileAttachment(each)) && provider === 'antigravity') throw new Error('Antigravity cannot receive images yet. Choose Claude, Codex or Cursor.')
    if (this.live.has(chatId)) throw new Error('This chat is still answering the last message')
    const chat = this.requireChat(chatId)
    const adapter = this.adapters[provider]
    const session = this.store.session(chatId, provider)
    const handoff = this.handoffFor(chatId, session.seenTurnSeq)

    const turn = this.store.createTurn({
      id: randomUUID(),
      chatId,
      provider,
      model: null,
      status: 'running',
      error: null,
      handoffTurns: handoff?.turns ?? 0,
      changes: null,
      tokens: null,
      sources: null,
      startedAt: Date.now(),
      endedAt: null
    })
    const clock = { sent: performance.now(), firstEvent: null, firstText: null }
    const live: LiveTurn = { turn, adapter, clock, items: new Map(), opened: [], stopRequested: false, saving: [] }
    this.live.set(chatId, live)

    const named = chat.lastProvider === null
    const updated: Chat = {
      ...chat,
      title: named ? oneLine(message || attachments[0]?.name || 'Attachments', 60) : chat.title,
      lastProvider: provider,
      updatedAt: Date.now()
    }
    this.store.updateChat(updated)
    this.emit({ type: 'chat', chat: updated })
    this.emit({ type: 'turn', turn: publicTurn(turn) })
    this.putItem(live, { type: 'user', id: `${turn.id}:user`, turnId: turn.id, text: message, ...(attachments.length ? { attachments } : {}) })

    void this.runTurn(live, updated.cwd, message, model, session.sessionId, handoff, attachments)
    return turn.id
  }

  /**
   * A message the user sent. With the chat idle it starts a turn. While a turn runs, it joins
   * that turn when the provider answering is the one picked and can take it; otherwise, or when
   * messages are already waiting (they keep their order), it waits for the turn to end.
   */
  async post(chatId: string, provider: ProviderId, model: string | null, text: string, attachments: Attachment[] = []): Promise<void> {
    const message = text.trim()
    if (!message && !attachments.length) throw new Error('There is nothing to send')
    validateAttachments(attachments)
    if (attachments.some(each => !isFileAttachment(each)) && provider === 'antigravity') throw new Error('Antigravity cannot receive images yet. Choose Claude, Codex or Cursor.')
    const live = this.live.get(chatId)
    if (!live) {
      if (this.queues.get(chatId)?.length) {
        this.enqueue(chatId, provider, model, message, attachments)
        return
      }
      this.send(chatId, provider, model, message, attachments)
      return
    }
    const steerable = !attachments.length && live.turn.provider === provider && !live.stopRequested
      && !this.queues.get(chatId)?.length && live.adapter.steer
    if (!steerable) {
      this.enqueue(chatId, provider, model, message, attachments)
      return
    }
    // Shown as on its way until the provider says the model has read it; it enters the turn there.
    const entry: Taking = { id: `${live.turn.id}:steer-${randomUUID()}`, provider, model, text: message, turnId: live.turn.id }
    this.setTaking(chatId, [...this.taking.get(chatId) ?? [], entry])
    const steered = await live.adapter.steer!(chatId, steerText(message), () => this.taken(chatId, entry.id)).catch(() => false)
    if (steered || !this.dropTaking(chatId, entry.id)) return
    this.enqueue(chatId, provider, model, message, attachments)
  }

  /** The model has read words sent into its turn: they join the transcript at this point. */
  private taken(chatId: string, id: string): void {
    const entry = this.taking.get(chatId)?.find((each) => each.id === id)
    if (!entry || !this.dropTaking(chatId, id)) return
    const live = this.live.get(chatId)
    if (live?.turn.id === entry.turnId) this.putItem(live, takenItem(entry))
  }

  /** Forget words on their way into a turn; false when they were no longer on their way. */
  private dropTaking(chatId: string, id: string): boolean {
    const list = this.taking.get(chatId) ?? []
    if (!list.some((entry) => entry.id === id)) return false
    this.setTaking(chatId, list.filter((entry) => entry.id !== id))
    return true
  }

  private setTaking(chatId: string, list: Taking[]): void {
    if (list.length) this.taking.set(chatId, list)
    else this.taking.delete(chatId)
    this.emitQueue(chatId)
  }

  /** Hold a message until the chat's turn in flight has ended, then send it; sent at once when none is running. */
  enqueue(chatId: string, provider: ProviderId, model: string | null, text: string, attachments: Attachment[] = []): void {
    this.requireChat(chatId)
    const queue = this.queues.get(chatId) ?? []
    const combined = [...queue.flatMap(entry => entry.attachments ?? []), ...attachments]
    validateAttachments(combined)
    if (combined.some(each => !isFileAttachment(each)) && provider === 'antigravity') throw new Error('Images are waiting in this chat. Choose Claude, Codex or Cursor to send them.')
    queue.push({ id: randomUUID(), provider, model, text, ...(attachments.length ? { attachments } : {}) })
    this.setQueue(chatId, queue)
    if (!this.live.has(chatId)) this.drain(chatId)
  }

  /** Take one waiting message back; returns its text. */
  unqueue(chatId: string, id: string): string | MessageDraft {
    const queue = this.queues.get(chatId) ?? []
    const found = queue.find((entry) => entry.id === id)
    if (!found) throw new Error('That message has already been sent')
    this.setQueue(chatId, queue.filter((entry) => entry !== found))
    return found.attachments?.length ? { text: found.text, attachments: found.attachments } : found.text
  }

  /**
   * Take every waiting message back, as one text, with the words sent into the turn that its
   * model has not read yet (a stop cancels those); null when there were none.
   */
  withdraw(chatId: string): string | MessageDraft | null {
    const all = [...this.taking.get(chatId) ?? [], ...this.queues.get(chatId) ?? []]
    if (!all.length) return null
    this.taking.delete(chatId)
    this.setQueue(chatId, [])
    const text = all.map((entry) => entry.text).join('\n\n')
    const attachments = all.flatMap(entry => entry.attachments ?? [])
    return attachments.length ? { text, attachments } : text
  }

  /** Words on their way into the turn first, then the messages waiting for it to end. */
  queued(chatId: string): QueuedMessage[] {
    return [
      ...(this.taking.get(chatId) ?? []).map(({ id, provider, text }) => ({ id, provider, text, taking: true })),
      ...(this.queues.get(chatId) ?? []).map(({ id, provider, text, attachments }) => ({ id, provider, text, ...(attachments?.length ? { attachments } : {}) }))
    ]
  }

  /**
   * Send what was waiting, as one message to the provider and model of the latest: several
   * words sent while one turn ran belong to one next turn, as they would in a conversation.
   */
  private drain(chatId: string): void {
    if (this.closing) return
    const queue = this.queues.get(chatId)
    if (!queue?.length || this.live.has(chatId)) return
    this.setQueue(chatId, [])
    const last = queue.at(-1)!
    try {
      this.send(chatId, last.provider, last.model, queue.map((entry) => entry.text).join('\n\n'), queue.flatMap(entry => entry.attachments ?? []))
    } catch {
      // Left waiting where the user can see it, take it back, or have it go with the next turn's end.
      if (this.store.chat(chatId)) this.setQueue(chatId, queue)
    }
  }

  private setQueue(chatId: string, queue: Queued[]): void {
    this.store.saveQueue(chatId, queue)
    if (queue.length) this.queues.set(chatId, queue)
    else this.queues.delete(chatId)
    this.emitQueue(chatId)
  }

  private emitQueue(chatId: string): void {
    this.emit({ type: 'queue', chatId, queued: this.queued(chatId) })
  }

  /** Whether a chat has a turn in flight. */
  isRunning(chatId: string): boolean {
    return this.live.has(chatId)
  }

  /** A turn's items as they stand: live ones from the turn in flight, settled ones from the store. */
  turnItems(chatId: string, turnId: string): Item[] {
    const live = this.live.get(chatId)
    return live?.turn.id === turnId ? [...live.items.values()] : this.store.turnItems(chatId, turnId)
  }

  /**
   * Add an item of the app's own to the turn in flight, such as a question a tool posted on the
   * model's behalf. Returns the turn's id, or null when the chat has no turn running.
   */
  addItem(chatId: string, make: (turnId: string) => Item): string | null {
    const live = this.live.get(chatId)
    if (!live) return null
    this.putItem(live, make(live.turn.id))
    return live.turn.id
  }

  /** The question asked in the chat's turn in flight, if there is one. */
  liveQuestion(chatId: string): Question | undefined {
    const live = this.live.get(chatId)
    return live && [...live.items.values()].find((item): item is Question => item.type === 'question')
  }

  /** Record the user's answer on a question (null reopens it), whether its turn is still running or long over. */
  answerQuestion(chatId: string, itemId: string, answer: string | null): Question {
    const live = this.live.get(chatId)
    const item = live?.items.get(itemId) ?? this.store.item(chatId, itemId)
    if (item?.type !== 'question') throw new Error('That question is no longer in the chat')
    const answered: Question = { ...item, answer }
    if (live?.items.has(itemId)) live.items.set(itemId, answered)
    this.store.putItem(chatId, answered)
    this.emit({ type: 'item', chatId, item: answered })
    return answered
  }

  /**
   * Get a provider ready for the message being typed, so that message does not wait on a cold
   * start. A null `chatId` is the next new chat, which will start in `cwd`. Never fails: a
   * provider that cannot warm up reports its trouble when the message is sent.
   */
  async prepare(chatId: string | null, provider: ProviderId, model: string | null, cwd: string): Promise<void> {
    try {
      if (chatId === null) {
        await this.adapters[provider].prepare({ chatId: null, cwd, sessionId: null, model })
        return
      }
      const chat = this.store.chat(chatId)
      if (!chat || this.live.has(chatId)) return
      const { sessionId } = this.store.session(chatId, provider)
      await this.adapters[provider].prepare({ chatId, cwd: chat.cwd, sessionId, model })
    } catch {
      // Warming up is a courtesy.
    }
  }

  async stop(chatId: string): Promise<void> {
    const live = this.live.get(chatId)
    if (!live) { this.drain(chatId); return }
    live.stopRequested = true
    await live.adapter.stop(chatId).catch(() => {})
  }

  /** A provider's usage, shared across callers; a reading younger than a minute is reused. */
  usage(provider: ProviderId, force = false): Promise<UsageSnapshot> {
    const pending = this.usagePending.get(provider)
    if (pending) return pending
    const cached = this.usageCache.get(provider)
    if (!force && cached && Date.now() - cached.at < USAGE_REUSE_MS) return Promise.resolve(cached.snapshot)
    const read = this.adapters[provider].usage()
      .catch((error: unknown) => cached?.snapshot ?? unavailableUsage(provider, messageOf(error)))
      .then((snapshot) => {
        this.noteUsage(snapshot)
        return snapshot
      })
      .finally(() => this.usagePending.delete(provider))
    this.usagePending.set(provider, read)
    return read
  }

  /** A provider's model list. It changes rarely, so one reading serves ten minutes; a failure is not kept. */
  models(provider: ProviderId): Promise<ModelInfo[]> {
    const cached = this.modelCache.get(provider)
    if (cached && Date.now() - cached.at < MODELS_REUSE_MS) return cached.models
    const models = this.adapters[provider].models()
    this.modelCache.set(provider, { at: Date.now(), models })
    models.catch(() => {
      if (this.modelCache.get(provider)?.models === models) this.modelCache.delete(provider)
    })
    return models
  }

  /** A reading an adapter pushed on its own (a rate-limit event mid-turn). */
  noteUsage(snapshot: UsageSnapshot): void {
    this.usageCache.set(snapshot.provider, { at: Date.now(), snapshot })
    this.emit({ type: 'usage', snapshot })
  }

  async shutdown(): Promise<void> {
    this.closing = true
    await Promise.all([...this.live.keys()].map((chatId) => this.stop(chatId)))
    for (const adapter of Object.values(this.adapters)) adapter.shutdown()
  }

  private async runTurn(
    live: LiveTurn,
    cwd: string,
    text: string,
    model: string | null,
    sessionId: string | null,
    handoff: Handoff | null,
    attachments: Attachment[] = []
  ): Promise<void> {
    const { turn, adapter } = live
    const { chatId, provider } = turn
    const session = { id: sessionId }
    const sink = this.sinkFor(live, session)

    let result: RunResult
    try {
      // The provider is sent the message with the app's context ahead of it; the transcript keeps the message as typed.
      // With nothing to ask, the provider is started in the same tick as the send.
      // The last reply's unopened citations are named ahead of the message, whoever answers next.
      const notice = sourcesNotice(this.store.lastSettledTurn(chatId)?.sources ?? null)
      const { context } = this
      const assemble = (lines: string | null): string => {
        const head = [notice, lines].filter(Boolean).join('\n\n')
        return head ? `${head}\n\n${text}` : text
      }
      const told = async (fresh: boolean): Promise<string> => assemble(context ? await context(chatId, provider, fresh).catch(() => null) : null)
      const resolved = (history: Handoff | null): ProviderAttachment[] => this.resolveAttachments([...new Set([...attachments, ...(history?.attachments ?? []).toReversed()].map(image => image.id))])
      const first = context ? await told(session.id === null) : assemble(null)
      result = live.stopRequested ? { status: 'interrupted' }
        : await adapter.run({ chatId, turnId: turn.id, cwd, sessionId: session.id, model, text: first, handoff, attachments: resolved(handoff) }, sink)
      if (result.sessionLost && !live.stopRequested) {
        // The provider dropped its session: start a new one and hand over the whole chat.
        this.store.setSession(chatId, provider, { sessionId: null, seenTurnSeq: 0 })
        session.id = null
        const full = this.handoffFor(chatId, 0, turn.seq)
        turn.handoffTurns = full?.turns ?? 0
        const retry = await told(true)
        result = live.stopRequested ? { status: 'interrupted' }
          : await adapter.run({ chatId, turnId: turn.id, cwd, sessionId: null, model, text: retry, handoff: full, attachments: resolved(full) }, sink)
      }
    } catch (error) {
      result = { status: 'failed', error: messageOf(error) }
    }
    if (result.sessionLost) result = { status: 'failed', error: `${provider} could not start a session for this chat` }
    // Only a turn that made pictures waits; any other ends in the same tick as before.
    if (live.saving.length) await Promise.all(live.saving)
    this.endTurn(live, result, session.id)
  }

  /**
   * A turn the provider began by itself, such as Claude Code answering when a background task
   * it started has finished. Without this its reply had nowhere to go and was lost. The turn has
   * no message of the user's; a notice says what woke it.
   */
  private openUnprompted(chatId: string, provider: ProviderId, reason: string): UnpromptedTurn | null {
    const chat = this.store.chat(chatId)
    if (!chat || this.live.has(chatId)) return null
    const adapter = this.adapters[provider]
    const turn = this.store.createTurn({
      id: randomUUID(), chatId, provider, model: null, status: 'running', error: null,
      handoffTurns: 0, changes: null, tokens: null, sources: null, startedAt: Date.now(), endedAt: null
    })
    const live: LiveTurn = { turn, adapter, clock: { sent: performance.now(), firstEvent: null, firstText: null }, items: new Map(), opened: [], stopRequested: false, saving: [] }
    this.live.set(chatId, live)
    const updated: Chat = { ...chat, lastProvider: provider, updatedAt: Date.now() }
    this.store.updateChat(updated)
    this.emit({ type: 'chat', chat: updated })
    this.emit({ type: 'turn', turn: publicTurn(turn) })
    this.putItem(live, { type: 'notice', id: `${turn.id}:woke`, turnId: turn.id, text: reason, tone: 'info' })
    const session = { id: this.store.session(chatId, provider).sessionId }
    let ended = false
    return {
      turnId: turn.id,
      sink: this.sinkFor(live, session),
      finish: (result) => {
        if (ended) return
        ended = true
        const end = (): void => this.endTurn(live, result.sessionLost ? { status: 'failed', error: result.error ?? 'The session was lost' } : result, session.id)
        if (live.saving.length) void Promise.all(live.saving).then(end)
        else end()
      }
    }
  }

  /** Where an adapter sends a turn's stream. The session id it reports is saved at once, so a crash mid-turn can still resume. */
  private sinkFor(live: LiveTurn, session: { id: string | null }): TurnSink {
    const { turn, clock } = live
    const { chatId, provider } = turn
    const mark = (text: boolean): void => {
      clock.firstEvent ??= performance.now()
      if (text) clock.firstText ??= performance.now()
    }
    const readable = (item: Item | undefined): boolean => item?.type === 'assistant' || item?.type === 'reasoning'
    return {
      item: (item) => {
        mark(readable(item) && 'text' in item && item.text.length > 0)
        if (item.type === 'image' && item.source) this.keepImage(live, item)
        else this.putItem(live, item)
      },
      delta: (itemId, delta) => {
        mark(delta.length > 0 && readable(live.items.get(itemId)))
        this.applyDelta(live, itemId, delta)
      },
      session: (id) => {
        mark(false)
        // What the session has seen moves at the end.
        session.id = id
        this.store.setSession(chatId, provider, { sessionId: id, seenTurnSeq: this.store.session(chatId, provider).seenTurnSeq })
      },
      model: (model) => {
        mark(false)
        if (turn.model === model) return
        turn.model = model
        this.store.updateTurn(turn)
        this.emit({ type: 'turn', turn: publicTurn(turn) })
      },
      usage: (snapshot) => this.noteUsage(snapshot),
      // Kept on the turn and saved with its end.
      tokens: (tokens) => { turn.tokens = tokens },
      activity: (text) => {
        if ((turn.activity ?? null) === text) return
        turn.activity = text
        this.emit({ type: 'turn', turn: publicTurn(turn) })
      }
    }
  }

  /** Settle a turn: final items, status, what the provider's session now holds, and timing. */
  private endTurn(live: LiveTurn, result: RunResult, sessionId: string | null): void {
    const { turn, clock } = live
    const { chatId, provider } = turn
    // Whatever was still streaming is final now.
    for (const item of live.items.values()) {
      if ((item.type === 'assistant' || item.type === 'reasoning') && item.streaming) this.putItem(live, { ...item, streaming: false })
      else if (item.type === 'tool' && item.status === 'running') {
        this.putItem(live, { ...item, status: result.status === 'completed' ? 'done' : 'failed' })
      } else if (item.type === 'image' && item.status === 'generating') {
        this.putItem(live, { ...item, status: 'failed', error: 'The turn ended before the image was finished. Ask for it again.' })
      }
    }
    // Words the model never said it read: a stopped turn dropped them, so they go first in the
    // queue; any other end may have taken them unannounced, so they are recorded, not sent twice.
    const unread = (this.taking.get(chatId) ?? []).filter((entry) => entry.turnId === turn.id)
    if (unread.length) {
      this.setTaking(chatId, (this.taking.get(chatId) ?? []).filter((entry) => entry.turnId !== turn.id))
      if (live.stopRequested && result.status !== 'completed') {
        this.queues.set(chatId, [...unread.map(({ provider, model, text }) => ({ id: randomUUID(), provider, model, text })), ...this.queues.get(chatId) ?? []])
        this.emitQueue(chatId)
      } else for (const entry of unread) this.putItem(live, takenItem(entry))
    }
    // What the reply cited against what the turn opened; a stopped turn's reply still cited.
    turn.sources = turnSources(live.opened, [...live.items.values()].flatMap((item) => (item.type === 'assistant' ? [item.text] : [])))
    turn.status = live.stopRequested && result.status !== 'completed' ? 'interrupted' : result.status
    turn.error = turn.status === 'failed' ? result.error ?? 'The turn failed' : null
    turn.endedAt = Date.now()
    turn.activity = null
    this.store.updateTurn(turn)
    // The session now contains this turn, unless it failed before the provider took the message.
    // A failed turn that got as far as a reply or a tool call was taken: handing it over again
    // later would give the provider its own turn back as someone else's.
    const taken = turn.status !== 'failed'
      || [...live.items.values()].some((item) => item.type === 'assistant' || item.type === 'reasoning' || item.type === 'tool')
    if (taken) this.store.setSession(chatId, provider, { sessionId, seenTurnSeq: turn.seq })
    this.live.delete(chatId)
    const finished = publicTurn(turn)
    this.emit({ type: 'turn', turn: finished })
    this.releaseTurnWaiters(chatId, finished)
    // After those who hear of the end have heard it, as the next turn's start must come after.
    if (this.queues.get(chatId)?.length) queueMicrotask(() => this.drain(chatId))
    this.onTiming({
      chatId,
      provider,
      model: turn.model,
      status: turn.status,
      error: turn.error,
      firstEventMs: clock.firstEvent === null ? null : clock.firstEvent - clock.sent,
      firstTextMs: clock.firstText === null ? null : clock.firstText - clock.sent,
      totalMs: performance.now() - clock.sent,
      tokens: turn.tokens
    })
    void this.usage(provider, true)
  }

  /** The turns after `seenSeq` (and before `beforeSeq`), as a handoff for a provider that missed them. */
  private handoffFor(chatId: string, seenSeq: number, beforeSeq = Number.MAX_SAFE_INTEGER): Handoff | null {
    const missed: MissedTurn[] = this.store.turnsWithItems(chatId, seenSeq, beforeSeq)
      .map(({ turn, items }) => ({ provider: turn.provider, model: turn.model, status: turn.status, items }))
    const locate = (id: string): string | null => {
      try { return this.resolveAttachments([id])[0]?.path ?? null } catch { return null }
    }
    return buildHandoff(missed, undefined, this.store.chat(chatId)?.cwd ?? null, locate)
  }

  private releaseTurnWaiters(chatId: string, turn: Turn): void {
    if (turn.status === 'running') return
    const waiting = this.turnWaiters.get(chatId)
    if (!waiting?.length) return
    const keep: typeof waiting = []
    for (const entry of waiting) {
      if (entry.turnId && entry.turnId !== turn.id) { keep.push(entry); continue }
      entry.resolve(turn)
    }
    if (keep.length) this.turnWaiters.set(chatId, keep)
    else this.turnWaiters.delete(chatId)
  }

  private dropTurnWaiter(chatId: string, target: { timer: NodeJS.Timeout }): void {
    const waiting = this.turnWaiters.get(chatId)
    if (!waiting?.length) return
    const keep = waiting.filter((entry) => entry.timer !== target.timer)
    if (keep.length) this.turnWaiters.set(chatId, keep)
    else this.turnWaiters.delete(chatId)
  }

  /** The pages the chat's turn in flight has opened so far; none when it has no turn running. */
  opened(chatId: string): Array<{ url: string }> {
    return [...this.live.get(chatId)?.opened ?? []]
  }

  /** A page Craft Studio's browser opened for the chat's turn in flight. Nothing is recorded for a chat with no turn running. */
  noteOpened(chatId: string | null, url: string): void {
    const live = chatId ? this.live.get(chatId) : undefined
    live?.opened.push({ url, via: 'browser' })
  }

  /**
   * A finished picture: it keeps its place as "generating" while Craft Studio copies the file into its
   * own store, then shows from that copy. The provider's file and bytes go no further than here.
   */
  private keepImage(live: LiveTurn, { source, ...item }: ImageItem): void {
    this.putItem(live, { ...item, status: 'generating' })
    live.saving.push(this.saveImage(source ?? {}, item.caption).then(
      (image) => this.putItem(live, { ...item, status: 'done', image }),
      (error: unknown) => this.putItem(live, { ...item, status: 'failed', error: messageOf(error) })
    ))
  }

  private putItem(live: LiveTurn, item: Item): void {
    // A picture's start is kept from its first report, so its placeholder's clock survives a reload.
    if (item.type === 'image' && item.startedAt === undefined) {
      const before = live.items.get(item.id)
      item = { ...item, startedAt: before?.type === 'image' && before.startedAt !== undefined ? before.startedAt : Date.now() }
    }
    // Providers may return textual failures without an error flag. Apply the same evidence
    // check to every adapter; empty output, search pages and challenges prove no source read.
    if (item.type === 'tool' && item.kind === 'web' && item.status === 'done' && pageKey(item.label) && !isSearchUrl(item.label)) {
      const problem = webReadProblem(item.output)
      if (!problem) live.opened.push({ url: item.label, via: 'provider' })
      else item = { ...item, status: 'failed' }
    }
    live.items.set(item.id, item)
    this.store.putItem(live.turn.chatId, item)
    this.emit({ type: 'item', chatId: live.turn.chatId, item })
  }

  private applyDelta(live: LiveTurn, itemId: string, delta: string): void {
    const item = live.items.get(itemId)
    if (!item) return
    if (item.type === 'assistant' || item.type === 'reasoning') live.items.set(itemId, { ...item, text: item.text + delta })
    else if (item.type === 'tool') live.items.set(itemId, { ...item, output: item.output + delta })
    else return
    this.emit({ type: 'delta', chatId: live.turn.chatId, itemId, delta })
  }

  private requireChat(chatId: string): Chat {
    const chat = this.store.chat(chatId)
    if (!chat) throw new Error('That chat no longer exists')
    return chat
  }
}

/**
 * A finished tool call as a page for the window carries it: without its output, which is most of
 * a long chat's bytes and shows only when the step is opened. `outputLength` says there is some.
 */
export function withoutOutput(item: Item): Item {
  return item.type === 'tool' && item.status !== 'running' && item.output.length > 0
    ? { ...item, output: '', outputLength: item.output.length }
    : item
}

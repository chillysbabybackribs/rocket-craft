// Image input: SDKUserMessage content arrays with base64 image sources (SDK types inspected
// and official streaming-input docs read 2026-10-06; image turns not yet verified live).
import { claudeImageContent } from './images.ts'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Item, ModelInfo, ToolKind, TurnTokens, UsageSnapshot } from '../../shared/types.ts'
import { withHandoff } from '../handoff.ts'
import { clipOutput, jsonPreview, messageOf, oneLine, recordOf, stringOf } from '../json.ts'
import { claudeRateLimitWindow, claudeUsage, mergeWindow, planName } from '../usage-parsers.ts'
import { randomUUID } from 'node:crypto'
import {
  itemId, planItem, TOOL_SERVER, unavailableUsage,
  type OpenUnprompted, type PrepareRequest, type ProviderAdapter, type RunRequest, type RunResult, type ToolEndpoint, type TurnSink
} from './provider.ts'

// Claude through the Agent SDK, which runs the Claude Code binary as a child process. One
// `query()` over a streaming input stays alive per chat, so follow-up turns reuse the process
// and its prompt cache instead of paying a spawn per message; an idle one is retired. `prepare`
// starts that process while the message is still being typed, and keeps one spare for the next
// new chat, so the first message of a chat does not wait on the spawn either.
//
// Stream contract this relies on (SDK 0.3.285, includePartialMessages: true):
// - `system`/`init` carries the session id and resolved model; it repeats on resume.
// - text / thinking / tool_use blocks arrive as content_block_start → *_delta → *_stop inside
//   `stream_event`, then the whole `assistant` message restates them.
// - `user` messages carry tool_result blocks keyed by tool_use id.
// - `result` closes the turn.
// - (SDK 0.3.289, verified 2026-10-05) A background task (a backgrounded subagent or shell) ends
//   with `system`/`task_notification`, and Claude Code then starts a turn of its own: stream
//   events through to `result` with no user message. `system`/`background_tasks_changed` carries
//   the full set of live background tasks each time it changes; `ambient` ones are not activity.
//   A turn whose reply ends while such tasks run is held open and shown as waiting, so the
//   follow-up continues it; a follow-up with no turn open (after a restart, say) gets one of its own.
// - (SDK 0.3.289 types, read 2026-10-05; not yet seen live) A user message written while a turn
//   runs takes `priority` ('next': folded in between tool rounds) and a `uuid`. When the reply
//   ends before it was taken, the `result` has `queued_turn_count` > 0 and a turn answering it
//   follows. `interrupt()` resolves with `still_queued`: uuids that will run after the stop.
// - (SDK 0.3.289 / CLI 2.1.289, seen live 2026-10-05) A steered message waited 12s in the queue
//   while the model wrote a tool call. A plain interrupt then left it in `still_queued`, and
//   retiring the process for it killed a background subagent and shell. `interrupt({cancelQueued:
//   true})` (in the SDK runtime, not its types; capability `interrupt_cancel_queued_v1`; read, not
//   yet seen live) cancels it in place.
// - (CLI 2.1.289 binary, read 2026-10-05; not yet seen live) Assistant frames list consumed user
//   messages in `user_message_uuids`, but a typed prompt's turn is not stamped again after a fold,
//   so that cannot say when words sent mid-turn were read. With `--replay-user-messages` a queued
//   message is echoed (`isReplay`, its uuid) as it drains into a turn, and `command_lifecycle
//   {command_uuid, state}` goes queued → started → completed | cancelled. Either marks it read.
// - (CLI 2.1.289, seen live 2026-10-05) The model's plan is its `TodoWrite` tool_use: `input.todos`
//   is the whole list each time, `{content, status: 'pending'|'in_progress'|'completed',
//   activeForm}`. It becomes the turn's plan item, not a tool row; its tool_result is dropped.
// - (SDK 0.3.289 types, read 2026-10-05; not yet seen live) A turn's tokens: `result.usage` is the
//   main loop's for that turn alone (`input_tokens` uncached, plus `cache_read_input_tokens` and
//   `cache_creation_input_tokens`), subagents excluded; `result.modelUsage` is cumulative over the
//   process and only read for `contextWindow`. Each model call's `message_start` stream event
//   carries that call's usage, so the last one says how full the context is.
// The SDK has no supported way to import another model's turns into a session, so missed turns
// ride at the head of the user's message as a tagged block.
//
// Sessions run with permissions bypassed, like the other providers here: the app has no
// approval prompts yet.

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')

const IDLE_RETIRE_MS = 15 * 60_000
/** Processes kept waiting with no turn running; each one is a whole Claude Code in memory. */
const MAX_IDLE_RUNTIMES = 3
/** The key the spare runtime is held under until a new chat takes it. */
const SPARE = ''
/** How long the process that answers account questions is kept after its last one. */
const PROBE_LINGER_MS = 30_000
const ABORT_REASONS = new Set(['aborted_streaming', 'aborted_tools'])
/** How long a turn waits for Claude Code's follow-up once its background tasks have all ended. */
const FOLLOW_UP_WAIT_MS = 20_000

let sdkLoading: Promise<ClaudeSdk> | null = null

/**
 * Which `claude` binary Craft Studio drives. The Agent SDK defaults to its own bundled CLI, which
 * trails the install users update in a terminal (`claude update`, usually `~/.local/bin/claude`).
 * That mismatch is why `/model` in a terminal can list models the app never sees.
 */
export function claudeCodeExecutable(): string | undefined {
  const override = process.env.CLAUDE_CODE_EXECUTABLE?.trim()
  if (override && existsSync(override)) return override
  const installed = join(homedir(), '.local', 'bin', 'claude')
  if (existsSync(installed)) return installed
  return undefined
}

/** Loaded on first use: the SDK is a large module the app should not pay for at startup. */
function loadSdk(): Promise<ClaudeSdk> {
  sdkLoading ??= import('@anthropic-ai/claude-agent-sdk').catch((error: unknown) => {
    sdkLoading = null
    throw new Error(`Claude Agent SDK could not be loaded: ${messageOf(error)}`)
  })
  return sdkLoading
}

function queryOptions(
  cwd: string, resume: string | null, model: string | null, toolsUrl: string | null, stderr: (text: string) => void
): Options {
  const claudeExecutable = claudeCodeExecutable()
  return {
    cwd,
    ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
    ...(resume ? { resume } : {}),
    ...(model ? { model } : {}),
    thinking: { type: 'adaptive', display: 'summarized' },
    // Tool search off: the app's few tools are in the prompt from the start, not one lookup away.
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'craft-studio/0.1.0', ENABLE_TOOL_SEARCH: 'false' },
    includePartialMessages: true,
    // Echoes each user message as Claude Code takes it, which is when words sent mid-turn are read.
    extraArgs: { 'replay-user-messages': null },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // The workspace's CLAUDE.md and the user's skills apply; the user's own MCP connectors do not.
    // The app's tools are the one MCP server a session has.
    settingSources: ['project', 'user'],
    strictMcpConfig: true,
    mcpServers: toolsUrl ? { [TOOL_SERVER]: { type: 'http', url: toolsUrl } } : {},
    // There is no UI for a blocking question, so the model asks in its reply instead.
    disallowedTools: ['AskUserQuestion'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    stderr
  }
}

type RunningTurn = {
  request: RunRequest
  sink: TurnSink
  translator: TurnTranslator
  finish: (result: RunResult) => void
  /**
   * The model ended its reply while background tasks it started were still running. The turn
   * stays open, shown as waiting, and Claude Code's follow-up when they finish lands in it.
   */
  deferred?: RunResult | null
  /** Ends a deferred turn if no follow-up starts after the background has emptied. */
  settleTimer?: NodeJS.Timeout | null
  /** The user's words sent into this turn that Claude Code has not taken yet, by uuid. */
  steers?: Map<string, () => void>
}

/** One live Claude Code process for one chat. */
class Runtime {
  private readonly query: Query
  private readonly queue: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  private idleTimer: NodeJS.Timeout | null = null
  stderrTail = ''
  sessionId: string | null
  turn: RunningTurn | null = null
  /** Live background tasks (not ambient ones). While there are any, the process is not retired. */
  background = new Set<string>()
  /** What finished in the background since the last turn, to say why an unprompted turn began. */
  woke: string[] = []
  /** The key in this process's tools URL. A process can start before its chat exists, so the chat is tied to it later. */
  toolKey: string | null = null

  constructor(
    sdk: ClaudeSdk,
    readonly cwd: string,
    resume: string | null,
    /** The model this process is on; null is the CLI's own default. */
    public model: string | null,
    private readonly onMessage: (runtime: Runtime, message: SDKMessage) => void,
    private readonly onEnd: (runtime: Runtime, error: unknown) => void,
    /** Where this process finds the app's tools; null for one that only answers account questions. */
    toolsUrl: string | null = null
  ) {
    this.sessionId = resume
    this.query = sdk.query({
      prompt: this.input(),
      options: queryOptions(cwd, resume, model, toolsUrl, (text) => { this.stderrTail = (this.stderrTail + text).slice(-2_000) })
    })
    void this.consume()
  }

  get alive(): boolean {
    return !this.closed
  }

  /** A user message; one sent while a turn runs carries a `priority` and the uuid it is known by. */
  push(text: string | ReturnType<typeof claudeImageContent>, mid?: { uuid: string; priority: 'now' | 'next' | 'later' }): void {
    if (this.closed) throw new Error('Claude Code is not running')
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
      ...(mid ? { uuid: mid.uuid as `${string}-${string}-${string}-${string}-${string}`, priority: mid.priority } : {})
    })
    this.wake?.()
  }

  /** Switch the live session's model; null restores the CLI default. */
  async setModel(model: string | null): Promise<void> {
    if (model === this.model) return
    await this.query.setModel(model ?? undefined)
    this.model = model
  }

  /** Settles once the process has started and answered its handshake. */
  async ready(): Promise<void> {
    await this.query.initializationResult()
  }

  supportedModels(): ReturnType<Query['supportedModels']> {
    return this.query.supportedModels()
  }

  /**
   * Stops the turn and drops the user messages still queued behind it. Returns the uuids that
   * will run anyway: all of them on a CLI that cannot cancel, none on one that can.
   */
  async interrupt(): Promise<string[]> {
    // `cancelQueued` is in the SDK's runtime but not yet in its types.
    const interrupt = this.query.interrupt as (options?: { cancelQueued?: boolean }) => ReturnType<Query['interrupt']>
    const receipt = recordOf(await interrupt.call(this.query, { cancelQueued: true }))
    return Array.isArray(receipt.still_queued) ? receipt.still_queued.map(String) : []
  }

  /** The plan windows `/usage` shows. Experimental in the SDK, so its absence is not an error. */
  async planUsage(): Promise<unknown> {
    const read = this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    return typeof read === 'function' ? read.call(this.query) : null
  }

  accountInfo(): ReturnType<Query['accountInfo']> {
    return this.query.accountInfo()
  }

  /** Retire the process after a quiet spell; the session resumes from disk on the next message. */
  armIdle(retire: () => void): void {
    this.disarmIdle()
    this.idleTimer = setTimeout(retire, IDLE_RETIRE_MS)
    this.idleTimer.unref?.()
  }

  disarmIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  close(): void {
    this.disarmIdle()
    if (this.closed) return
    this.closed = true
    this.wake?.()
    try {
      this.query.close()
    } catch {
      // Already gone.
    }
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length) yield this.queue.shift()!
      if (this.closed) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = null
    }
  }

  private async consume(): Promise<void> {
    let failure: unknown = null
    try {
      for await (const message of this.query) this.onMessage(this, message)
    } catch (error) {
      failure = error
    } finally {
      this.closed = true
      this.onEnd(this, failure)
    }
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const
  private readonly runtimes = new Map<string, Runtime>()
  private lastUsage: UsageSnapshot | null = null
  private probe: Runtime | null = null
  private probeTimer: NodeJS.Timeout | null = null
  private openUnprompted: OpenUnprompted | null = null

  constructor(private readonly onUsage: (snapshot: UsageSnapshot) => void, private readonly tools: ToolEndpoint = null) {}

  async run(request: RunRequest, sink: TurnSink): Promise<RunResult> {
    let runtime: Runtime
    try {
      runtime = await this.runtimeFor(request.chatId, request)
      if (runtime.toolKey) this.tools?.bind(runtime.toolKey, request.chatId)
      await runtime.setModel(request.model)
    } catch (error) {
      return { status: 'failed', error: messageOf(error) }
    }
    runtime.disarmIdle()
    return new Promise<RunResult>((resolve) => {
      const turn: RunningTurn = {
        request,
        sink,
        translator: new TurnTranslator(request.turnId),
        finish: (result) => {
          if (runtime.turn !== turn) return
          runtime.turn = null
          this.rest(runtime)
          resolve(result)
        }
      }
      runtime.turn = turn
      try {
        runtime.push(request.attachments?.length ? claudeImageContent(withHandoff(request.handoff, request.text), request.attachments) : withHandoff(request.handoff, request.text))
      } catch (error) {
        turn.finish({ status: 'failed', error: messageOf(error) })
      }
    })
  }

  onUnprompted(open: OpenUnprompted): void {
    this.openUnprompted = open
  }

  async prepare(request: PrepareRequest): Promise<void> {
    const runtime = await this.runtimeFor(request.chatId ?? SPARE, request)
    if (!runtime.turn) this.rest(runtime)
    this.trimIdle(runtime)
    await runtime.ready()
  }

  async stop(chatId: string): Promise<void> {
    const runtime = this.runtimes.get(chatId)
    if (!runtime?.turn) return
    // A turn only waiting on background tasks has no model call to interrupt; it simply ends.
    // Whatever those tasks bring back later arrives as a turn of its own.
    const waiting = runtime.turn
    if (waiting.deferred) {
      clearTimeout(waiting.settleTimer ?? undefined)
      waiting.finish({ status: 'interrupted' })
      return
    }
    const survivors = await runtime.interrupt().catch(() => {
      // An interrupt the process cannot take is answered by closing it; the session resumes later.
      this.retire(runtime)
      return []
    })
    // Words the user sent into the turn and Claude Code has not taken yet would run after the
    // stop as a turn of their own. A CLI too old to cancel them loses its process instead, and
    // with it any background work.
    if (survivors.some((uuid) => waiting.steers?.has(uuid))) this.retire(runtime)
  }

  async steer(chatId: string, text: string, taken: () => void): Promise<boolean> {
    const runtime = this.runtimes.get(chatId)
    const turn = runtime?.turn
    if (!runtime?.alive || !turn) return false
    // 'next' folds the words in between tool rounds without cutting off the step under way. A
    // turn only waiting on background tasks is idle, so they start its follow-up at once.
    const uuid = randomUUID()
    ;(turn.steers ??= new Map()).set(uuid, taken)
    runtime.push(text, { uuid, priority: 'next' })
    return true
  }

  forget(chatId: string): void {
    const runtime = this.runtimes.get(chatId)
    if (runtime) this.retire(runtime)
  }

  async usage(): Promise<UsageSnapshot> {
    return this.readUsage(await this.accountRuntime())
  }

  /** The CLI's own catalog for the signed-in account. Aliases of one model collapse to one entry. */
  async models(): Promise<ModelInfo[]> {
    const infos = await (await this.accountRuntime()).supportedModels()
    const defaultTarget = infos.find((info) => info.value === 'default')?.resolvedModel ?? null
    const seen = new Set<string>()
    const models: ModelInfo[] = []
    for (const info of infos) {
      if (!info.value || info.value === 'default') continue
      const identity = info.resolvedModel ?? info.value
      if (seen.has(identity)) continue
      seen.add(identity)
      models.push({
        id: info.value,
        label: info.displayName || info.value,
        description: info.description ?? '',
        isDefault: defaultTarget !== null && identity === defaultTarget
      })
    }
    return models
  }

  shutdown(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probe?.close()
    this.probe = null
    for (const runtime of this.runtimes.values()) runtime.close()
    this.runtimes.clear()
  }

  /**
   * A process to ask about the account (usage, models): any chat's live one, or the spare. With
   * none running, a process of its own that never sends a model turn; it serves every such
   * question asked close together and exits a little after the last.
   */
  private async accountRuntime(): Promise<Runtime> {
    // Loaded before the lookup, so a warm-up asked for just ahead of this has its process by now.
    const sdk = await loadSdk()
    const live = [...this.runtimes.values()].find((runtime) => runtime.alive)
    if (live) return live
    if (!this.probe?.alive) this.probe = new Runtime(sdk, homedir(), null, null, () => {}, () => {})
    const probe = this.probe
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = setTimeout(() => {
      probe.close()
      if (this.probe === probe) this.probe = null
    }, PROBE_LINGER_MS)
    this.probeTimer.unref?.()
    return probe
  }

  /** The live process for a chat (or the spare, under `SPARE`), started if there is none. */
  private async runtimeFor(key: string, request: Pick<PrepareRequest, 'cwd' | 'sessionId' | 'model'>): Promise<Runtime> {
    // Loaded before the lookup, so two callers arriving together cannot both start a process.
    const sdk = await loadSdk()
    const existing = this.runtimes.get(key)
    // The spare belongs to no chat yet, so the folder it was started in has to match too.
    if (existing?.alive && existing.sessionId === request.sessionId && (key !== SPARE || existing.cwd === request.cwd)) {
      return this.hold(key, existing)
    }
    if (existing) this.retire(existing)
    const spare = this.runtimes.get(SPARE)
    if (key !== SPARE && request.sessionId === null && spare?.alive && !spare.turn && spare.cwd === request.cwd) {
      // A new chat takes the process that was warmed for it.
      this.runtimes.delete(SPARE)
      return this.hold(key, spare)
    }
    const toolKey = this.tools ? randomUUID() : null
    const runtime = new Runtime(
      sdk,
      request.cwd,
      request.sessionId,
      request.model,
      (source, message) => this.onMessage(source, message),
      (source, error) => this.onEnd(source, error),
      toolKey && this.tools ? this.tools.url('claude', toolKey) : null
    )
    runtime.toolKey = toolKey
    return this.hold(key, runtime)
  }

  /** File a runtime under its key as the most recently wanted one. */
  private hold(key: string, runtime: Runtime): Runtime {
    this.runtimes.delete(key)
    this.runtimes.set(key, runtime)
    return runtime
  }

  /** Close the longest-waiting idle processes beyond the few worth keeping warm. */
  private trimIdle(keep: Runtime): void {
    const idle = [...this.runtimes.values()].filter((runtime) => !runtime.turn && !runtime.background.size && runtime !== keep)
    for (const runtime of idle.slice(0, Math.max(0, idle.length + 1 - MAX_IDLE_RUNTIMES))) this.retire(runtime)
  }

  private release(runtime: Runtime): void {
    if (runtime.toolKey) this.tools?.unbind(runtime.toolKey)
    for (const [key, held] of this.runtimes) if (held === runtime) this.runtimes.delete(key)
  }

  private retire(runtime: Runtime): void {
    this.release(runtime)
    runtime.close()
  }

  private onMessage(runtime: Runtime, raw: SDKMessage): void {
    const message = recordOf(raw)
    if (message.type === 'rate_limit_event') this.noteRateLimit(recordOf(message.rate_limit_info))
    if (message.type === 'system') this.noteBackground(runtime, message)
    // Echoes and lifecycle of the user's own messages; one of steered words means the model has them.
    const echoed = message.type === 'user' && message.isReplay === true ? stringOf(message.uuid)
      : message.type === 'command_lifecycle' && message.state === 'started' ? stringOf(message.command_uuid) : null
    if (echoed !== null) {
      const taken = runtime.turn?.steers?.get(echoed)
      runtime.turn?.steers?.delete(echoed)
      taken?.()
      return
    }
    if (message.type === 'command_lifecycle') return
    const turn = runtime.turn ?? this.unprompted(runtime, message)
    if (!turn) return
    if (turn.deferred && (message.type === 'stream_event' || message.type === 'assistant')) {
      // The follow-up has begun; its own result ends the turn.
      clearTimeout(turn.settleTimer ?? undefined)
      turn.deferred = null
      turn.settleTimer = null
      this.showWaiting(runtime, turn, 'resumed')
    }
    const out = turn.translator.handle(message)
    if (out.sessionId) {
      runtime.sessionId = out.sessionId
      turn.sink.session(out.sessionId)
    }
    if (out.model) turn.sink.model(out.model)
    if (out.tokens) turn.sink.tokens(out.tokens)
    for (const op of out.ops) {
      if (op.type === 'item') turn.sink.item(op.item)
      else turn.sink.delta(op.itemId, op.delta)
    }
    // A reply that ended before Claude Code took the words sent into it is followed by another
    // turn answering them; that one belongs to this turn too, and its result ends it.
    if (out.end?.status === 'completed' && message.type === 'result' && Number(message.queued_turn_count) > 0 && turn.steers?.size) return
    if (out.end) this.ended(runtime, turn, out.end)
  }

  /** Idle with nothing running in the background: retire the process after a quiet spell. */
  private rest(runtime: Runtime): void {
    if (!runtime.alive || runtime.turn) return
    if (runtime.background.size) runtime.disarmIdle()
    else runtime.armIdle(() => this.retire(runtime))
  }

  /** A reply has ended. With background tasks still running, the turn waits for them instead of ending. */
  private ended(runtime: Runtime, turn: RunningTurn, result: RunResult): void {
    if (result.status !== 'completed' || !runtime.background.size) {
      turn.finish(result)
      return
    }
    turn.deferred = result
    this.showWaiting(runtime, turn, 'waiting')
  }

  /** What a waiting turn says it waits on, in its head; nothing is added to the reply. */
  private showWaiting(runtime: Runtime, turn: RunningTurn, state: 'waiting' | 'resumed'): void {
    const count = runtime.background.size
    turn.sink.activity(state === 'resumed'
      ? null
      : count ? `Waiting for ${count} background ${count === 1 ? 'task' : 'tasks'}` : 'Background work finished, following up')
  }

  private noteBackground(runtime: Runtime, message: Record<string, unknown>): void {
    if (message.subtype === 'background_tasks_changed') {
      const tasks = (Array.isArray(message.tasks) ? message.tasks : []).map(recordOf).filter((task) => task.ambient !== true)
      runtime.background = new Set(tasks.map((task) => stringOf(task.task_id)).filter(Boolean))
      const turn = runtime.turn
      if (turn?.deferred) {
        this.showWaiting(runtime, turn, 'waiting')
        clearTimeout(turn.settleTimer ?? undefined)
        // Claude Code follows up after its background work ends; if it does not, the turn ends as it was.
        if (!runtime.background.size) {
          turn.settleTimer = setTimeout(() => {
            if (runtime.turn === turn && turn.deferred) turn.finish(turn.deferred)
          }, FOLLOW_UP_WAIT_MS)
        }
      }
      this.rest(runtime)
    } else if (message.subtype === 'task_notification' && message.skip_transcript !== true && message.ambient !== true) {
      const summary = oneLine(stringOf(message.summary), 140)
      const status = stringOf(message.status)
      runtime.woke.push(`${status === 'completed' ? 'Finished' : status === 'failed' ? 'Failed' : 'Stopped'} in the background${summary ? `: ${summary}` : ''}`)
    }
  }

  /**
   * Claude Code has started a turn of its own, with none open: it does so when a background task
   * it launched finishes. Open one in the hub so the reply is kept, and route the stream to it.
   */
  private unprompted(runtime: Runtime, message: Record<string, unknown>): RunningTurn | null {
    if (message.type !== 'stream_event' && message.type !== 'assistant') return null
    if (typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id) return null
    const chatId = [...this.runtimes.entries()].find(([key, held]) => held === runtime && key !== SPARE)?.[0]
    if (!chatId || !this.openUnprompted) return null
    const reason = runtime.woke.length ? runtime.woke.join('\n') : 'Claude carried on by itself'
    const opened = this.openUnprompted(chatId, reason)
    if (!opened) return null
    runtime.woke = []
    runtime.disarmIdle()
    const turn: RunningTurn = {
      request: { chatId, turnId: opened.turnId, cwd: runtime.cwd, sessionId: runtime.sessionId, model: runtime.model, text: '', handoff: null },
      sink: opened.sink,
      translator: new TurnTranslator(opened.turnId),
      finish: (result) => {
        if (runtime.turn !== turn) return
        runtime.turn = null
        this.rest(runtime)
        opened.finish(result)
      }
    }
    runtime.turn = turn
    return turn
  }

  /** The process ended. With a turn open, that turn failed, or its session could not be resumed. */
  private onEnd(runtime: Runtime, error: unknown): void {
    this.release(runtime)
    const turn = runtime.turn
    if (!turn) return
    // A turn that was only waiting on background tasks had already replied in full.
    if (turn.deferred) {
      clearTimeout(turn.settleTimer ?? undefined)
      turn.finish(turn.deferred)
      return
    }
    const detail = `${error ? messageOf(error) : ''}\n${runtime.stderrTail}`
    if (turn.request.sessionId && /no conversation found|session.*not found|could not (find|resume)/i.test(detail)) {
      turn.finish({ status: 'failed', sessionLost: true })
      return
    }
    turn.finish({
      status: 'failed',
      error: error ? messageOf(error) : (oneLine(runtime.stderrTail, 300) || 'Claude Code exited before finishing the turn')
    })
  }

  private async readUsage(runtime: Runtime): Promise<UsageSnapshot> {
    let timer: NodeJS.Timeout | undefined
    try {
      const [account, usage] = await Promise.race([
        Promise.all([runtime.accountInfo(), runtime.planUsage()]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Claude usage read timed out')), 25_000) })
      ])
      const parsed = claudeUsage(usage)
      const snapshot: UsageSnapshot = {
        provider: 'claude',
        account: account.email ?? null,
        plan: parsed?.plan ?? planName(account.subscriptionType),
        windows: parsed?.windows ?? [],
        note: parsed?.note ?? null,
        unavailable: parsed
          ? parsed.unavailable ?? (parsed.windows.length ? null : 'Claude did not report any usage windows.')
          : 'This Claude Code version does not report subscription usage.',
        updatedAt: Date.now()
      }
      this.lastUsage = snapshot
      return snapshot
    } catch (error) {
      return this.lastUsage ?? unavailableUsage('claude', messageOf(error))
    } finally {
      clearTimeout(timer)
    }
  }

  /** A mid-turn event names the one window it moved; fold it into the last full reading. */
  private noteRateLimit(info: Record<string, unknown>): void {
    const window = claudeRateLimitWindow(info)
    if (!window) return
    const base = this.lastUsage ?? unavailableUsage('claude', '')
    this.lastUsage = { ...base, windows: mergeWindow(base.windows, window), unavailable: null, updatedAt: Date.now() }
    this.onUsage(this.lastUsage)
  }
}

type Op = { type: 'item'; item: Item } | { type: 'delta'; itemId: string; delta: string }
type Translation = { ops: Op[]; sessionId?: string; model?: string; end?: RunResult; tokens?: TurnTokens }
type Block = { id: string; kind: 'text' | 'thinking' | 'tool'; text: string; json: string; settled: boolean }
type ToolItem = Extract<Item, { type: 'tool' }>

/** Pure translation from one turn's SDK messages to transcript operations. */
export class TurnTranslator {
  private readonly blocks = new Map<number, Block>()
  private readonly tools = new Map<string, { item: ToolItem; name: string }>()
  /**
   * Streamed text that has closed and whose restatement in the `assistant` message is still to
   * come, counted per text: a turn can say the same thing twice, and each saying is its own row.
   */
  private readonly awaited = new Map<string, number>()
  /** TodoWrite calls, which become the turn's plan rather than tool rows. */
  private readonly planCalls = new Set<string>()
  private lastPlan = ''
  private messageCount = 0
  private pendingError: string | null = null
  private model: string | null = null
  /** Summed over the turn's results: a turn that follows up after background work has several. */
  private spent = { input: 0, cached: 0, output: 0 }
  /** Input of the latest model call. */
  private context: number | null = null

  constructor(private readonly turnId: string) {}

  handle(message: Record<string, unknown>): Translation {
    // A subagent's inner stream belongs to its Task tool call, not to the transcript.
    if (typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id) return { ops: [] }
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          if (typeof message.model === 'string') this.model = message.model
          return {
            ops: [],
            ...(typeof message.session_id === 'string' ? { sessionId: message.session_id } : {}),
            ...(typeof message.model === 'string' ? { model: message.model } : {})
          }
        }
        if (message.subtype === 'compact_boundary') return { ops: [this.notice('Conversation context compacted', 'info')] }
        return { ops: [] }
      case 'stream_event':
        return { ops: this.streamEvent(recordOf(message.event)) }
      case 'assistant':
        return { ops: this.assistant(message) }
      case 'user':
        return { ops: this.toolResults(message) }
      case 'rate_limit_event': {
        const info = recordOf(message.rate_limit_info)
        if (info.status === 'rejected') this.pendingError = 'Claude usage limit reached.'
        return { ops: [] }
      }
      case 'result':
        return this.result(message)
      default:
        return { ops: [] }
    }
  }

  private streamEvent(event: Record<string, unknown>): Op[] {
    const index = Number(event.index ?? 0)
    switch (event.type) {
      case 'message_start': {
        this.messageCount += 1
        this.blocks.clear()
        const usage = recordOf(recordOf(event.message).usage)
        if (Object.keys(usage).length) this.context = inputOf(usage)
        return []
      }
      case 'content_block_start': {
        const block = recordOf(event.content_block)
        if (block.type === 'text' || block.type === 'thinking') {
          const id = itemId(this.turnId, `m${this.messageCount}b${index}`)
          this.blocks.set(index, { id, kind: block.type, text: '', json: '', settled: false })
          return [{ type: 'item', item: this.textItem(block.type, id, '', true) }]
        }
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          this.blocks.set(index, { id: block.id, kind: 'tool', text: '', json: '', settled: false })
          return this.startTool(block.id, stringOf(block.name) || 'tool', recordOf(block.input))
        }
        return []
      }
      case 'content_block_delta': {
        const block = this.blocks.get(index)
        const delta = recordOf(event.delta)
        if (!block) return []
        const text = block.kind === 'text' ? delta.text : block.kind === 'thinking' ? delta.thinking : null
        if (typeof text === 'string' && text) {
          block.text += text
          return [{ type: 'delta', itemId: block.id, delta: text }]
        }
        if (block.kind === 'tool' && typeof delta.partial_json === 'string') block.json += delta.partial_json
        return []
      }
      case 'content_block_stop': {
        const block = this.blocks.get(index)
        if (!block) return []
        if (block.kind === 'tool') return this.relabelTool(block.id, parseJson(block.json))
        // The restatement got here first and closed the row already.
        if (block.settled) return []
        const key = `${block.kind} ${block.text}`
        this.awaited.set(key, (this.awaited.get(key) ?? 0) + 1)
        return [{ type: 'item', item: this.textItem(block.kind, block.id, block.text, false) }]
      }
      default:
        return []
    }
  }

  /** The restated message: complete tool inputs, and any text that did not arrive as a stream. */
  private assistant(message: Record<string, unknown>): Op[] {
    if (typeof message.error === 'string' && message.error) {
      this.pendingError = `Claude request failed: ${message.error.replaceAll('_', ' ')}`
    }
    const body = recordOf(message.message)
    const content = Array.isArray(body.content) ? body.content.map(recordOf) : []
    const ops: Op[] = []
    content.forEach((block, index) => {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        ops.push(...this.startTool(block.id, stringOf(block.name) || 'tool', recordOf(block.input)))
        ops.push(...this.relabelTool(block.id, recordOf(block.input)))
        return
      }
      const kind = block.type === 'text' ? 'text' : block.type === 'thinking' ? 'thinking' : null
      const text = kind === 'text' ? stringOf(block.text) : stringOf(block.thinking)
      if (!kind || !text) return
      const key = `${kind} ${text}`
      const shown = this.awaited.get(key) ?? 0
      if (shown > 0) {
        if (shown === 1) this.awaited.delete(key)
        else this.awaited.set(key, shown - 1)
        return
      }
      // The restatement can arrive before the block's own stop event; it must land on the
      // streamed item, not beside it.
      const streaming = [...this.blocks.values()].find((open) =>
        open.kind === kind && !open.settled && open.text.length > 0 && (text.startsWith(open.text) || open.text.startsWith(text)))
      if (streaming) {
        streaming.text = text
        streaming.settled = true
      }
      const id = streaming?.id ?? itemId(this.turnId, `${stringOf(message.uuid) || `a${this.messageCount}`}-${index}`)
      ops.push({ type: 'item', item: this.textItem(kind, id, text, false) })
    })
    return ops
  }

  private toolResults(message: Record<string, unknown>): Op[] {
    const content = recordOf(message.message).content
    const ops: Op[] = []
    for (const block of Array.isArray(content) ? content.map(recordOf) : []) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const tool = this.tools.get(block.tool_use_id)
      if (!tool) continue
      tool.item = {
        ...tool.item,
        status: block.is_error === true ? 'failed' : 'done',
        output: clipOutput(resultText(block.content))
      }
      ops.push({ type: 'item', item: tool.item })
    }
    return ops
  }

  private result(message: Record<string, unknown>): Translation {
    const tokens = this.tokens(message)
    const close = (end: RunResult): Translation => ({ ops: [], end, ...(tokens ? { tokens } : {}) })
    if (ABORT_REASONS.has(stringOf(message.terminal_reason))) return close({ status: 'interrupted' })
    if (message.subtype === 'success' && message.is_error !== true) return close({ status: 'completed' })
    const errors = Array.isArray(message.errors) ? message.errors.filter((e): e is string => typeof e === 'string' && !!e.trim()) : []
    const error = this.pendingError
      ?? (errors.length ? errors.join('\n') : null)
      ?? (stringOf(message.result).trim() || `Claude turn ended: ${stringOf(message.subtype) || 'error'}`)
    if (/no conversation found/i.test(error)) return close({ status: 'failed', sessionLost: true })
    return close({ status: 'failed', error })
  }

  /** The turn's tokens with this result's added in; undefined when the result carries none. */
  private tokens(message: Record<string, unknown>): TurnTokens | undefined {
    const usage = recordOf(message.usage)
    if (!Object.keys(usage).length) return undefined
    this.spent = {
      input: this.spent.input + inputOf(usage),
      cached: this.spent.cached + count(usage.cache_read_input_tokens),
      output: this.spent.output + count(usage.output_tokens)
    }
    const models = recordOf(message.modelUsage)
    const windows = Object.values(models).map((entry) => count(recordOf(entry).contextWindow)).filter(Boolean)
    const own = this.model ? count(recordOf(models[this.model]).contextWindow) : 0
    return { ...this.spent, context: this.context, contextWindow: own || (windows.length ? Math.max(...windows) : null) }
  }

  private startTool(id: string, name: string, input: Record<string, unknown>): Op[] {
    if (name === 'TodoWrite') {
      this.planCalls.add(id)
      return this.plan(input)
    }
    if (this.tools.has(id)) return []
    const item: ToolItem = { type: 'tool', id: itemId(this.turnId, id), turnId: this.turnId, status: 'running', output: '', ...describeTool(name, input) }
    this.tools.set(id, { item, name })
    return [{ type: 'item', item }]
  }

  /** The whole list arrives with each TodoWrite; the plan item is replaced when it has changed. */
  private plan(input: Record<string, unknown>): Op[] {
    const item = planItem(this.turnId, input.todos, (todo) => stringOf(todo.content))
    if (!item) return []
    const key = JSON.stringify(item)
    if (key === this.lastPlan) return []
    this.lastPlan = key
    return [{ type: 'item', item }]
  }

  /** Arguments stream after the call is announced; re-describe it once they are known. */
  private relabelTool(id: string, input: Record<string, unknown>): Op[] {
    if (this.planCalls.has(id)) return this.plan(input)
    const tool = this.tools.get(id)
    if (!tool || tool.item.status !== 'running' || Object.keys(input).length === 0) return []
    const described = describeTool(tool.name, input)
    if (described.label === tool.item.label) return []
    tool.item = { ...tool.item, ...described }
    return [{ type: 'item', item: tool.item }]
  }

  private textItem(kind: 'text' | 'thinking', id: string, text: string, streaming: boolean): Item {
    return kind === 'text'
      ? { type: 'assistant', id, turnId: this.turnId, text, streaming }
      : { type: 'reasoning', id, turnId: this.turnId, text, streaming }
  }

  private notice(text: string, tone: 'info' | 'error'): Op {
    return { type: 'item', item: { type: 'notice', id: itemId(this.turnId, `n${Date.now()}`), turnId: this.turnId, text, tone } }
  }
}

/** A Claude Code tool call as a kind and a one-line label. */
export function describeTool(name: string, input: Record<string, unknown>): { kind: ToolKind; label: string } {
  const text = (key: string): string => stringOf(input[key])
  switch (name) {
    case 'Bash':
      return { kind: 'command', label: text('command') || 'shell command' }
    case 'Read':
      return { kind: 'read', label: text('file_path') || 'file' }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return { kind: 'edit', label: text('file_path') || text('notebook_path') || 'file' }
    case 'Grep':
    case 'Glob':
      return { kind: 'search', label: [text('pattern'), text('path')].filter(Boolean).join(' in ') || name }
    case 'WebSearch':
      return { kind: 'web', label: text('query') || 'web search' }
    case 'WebFetch':
      return { kind: 'web', label: text('url') || 'web page' }
    case 'Task':
    case 'Agent':
      return { kind: 'other', label: `Agent: ${text('description') || 'subtask'}` }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      const args = jsonPreview(input, 120)
      const title = mcp ? `${mcp[1]} · ${mcp[2]}` : name
      return { kind: mcp ? 'mcp' : 'other', label: args && args !== '{}' ? `${title} ${args}` : title }
    }
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Every input token of an Anthropic usage block: the uncached ones and both kinds of cached. */
function inputOf(usage: Record<string, unknown>): number {
  return count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens)
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(recordOf).map((block) => (block.type === 'text' ? stringOf(block.text) : block.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
}

function parseJson(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  try {
    return recordOf(JSON.parse(text))
  } catch {
    return {}
  }
}

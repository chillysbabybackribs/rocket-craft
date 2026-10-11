// Image input: turn/start accepts localImage paths (official app-server docs read
// 2026-10-06; image turns not yet verified live against the installed CLI).
import { codexImageContent } from './images.ts'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { Item, ModelInfo, ToolStatus, TurnTokens, UsageSnapshot } from '../../shared/types.ts'
import { clipOutput, jsonPreview, messageOf, recordOf, stringOf } from '../json.ts'
import { StdioJsonRpcClient, type JsonRpcNotification, type JsonRpcRequest } from '../stdio-json-rpc.ts'
import { codexUsage } from '../usage-parsers.ts'
import {
  itemId, planItem, TOOL_SERVER, unavailableUsage,
  type PrepareRequest, type ProviderAdapter, type RunRequest, type RunResult, type ToolEndpoint, type TurnSink
} from './provider.ts'

// Codex through `codex app-server`: one long-lived process speaking newline-delimited JSON-RPC,
// shared by every chat (a thread carries its own cwd). Verified live against codex-cli 0.160.0
// on 2026-10-05:
// - `thread/start` / `thread/resume` return `{thread: {id, model}}`; `turn/start` takes
//   `{threadId, input: [{type: 'text', text}]}` and the turn's life arrives as notifications
//   (`item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`).
// - `thread/inject_items` appends Responses-API message items to the thread's history without
//   starting a turn, and the model treats them as real earlier turns. That is how the turns
//   other providers answered are handed over: as history with roles, not as pasted text.
// - (app-server docs, read 2026-10-05; not yet seen live) `turn/steer {threadId, expectedTurnId,
//   input}` appends the user's words to the turn in flight without a new `turn/started`, and
//   fails when that turn is no longer the active one. (Seen live 2026-10-05) Codex takes them at
//   its next tool boundary, seconds later, and then reports a `userMessage` item holding them.
// - (codex-cli 0.160.0 `app-server generate-json-schema`, read 2026-10-05; not yet seen live) The
//   model's plan is the `turn/plan/updated` notification: `{threadId, turnId, explanation, plan:
//   [{step, status: 'pending'|'inProgress'|'completed'}]}`, the whole list each time. It becomes
//   the turn's plan item. The `plan` thread item is something else: a proposed plan as text.
// - (codex-cli 0.160.0 `app-server generate-json-schema`, read 2026-10-05; not yet seen live) A
//   turn's tokens: `thread/tokenUsage/updated {threadId, turnId, tokenUsage: {total, last,
//   modelContextWindow}}`, where `total` is the thread's running count and `last` the latest model
//   call's, each `{inputTokens, cachedInputTokens, outputTokens, …}`. As in the Responses API,
//   `inputTokens` includes the cached ones. The turn's own share is `total` less what it stood at
//   before the turn's first call.
// - `model/list` pages through the account's models; `turn/start` takes a `model` for that turn.
// - `account/rateLimits/read` and the `account/rateLimits/updated` notification carry the
//   subscription windows.
// - (codex-cli 0.160.0, config/read verified 2026-10-05) Process-local `-c
//   plugins.<name>@openai-bundled.enabled=false` overrides inherited plugin settings.
//   Do not quote the key inside the argument: the CLI treats those quotes as part of its name.
// - Generated images, codex-cli 0.161.0, 2026-10-10. `codex features list` shows `image_generation`
//   stable and on. (Schema only, `app-server generate-ts`) The thread item is `{type:
//   'imageGeneration', id, status, revisedPrompt, result, transparentBackground?, failure:
//   {type: 'usageLimitExceeded', limitId, resetsAt} | null, savedPath?}`, and `{type: 'imageView',
//   id, path}` is Codex looking at a picture on disk. (Seen in Codex's own rollout files under
//   ~/.codex/sessions, 113 generations from 2026-09-02 to 2026-10-10, stored there as `{type:
//   'Extension', kind: 'image_gen.generation'}` with the same fields) `result` is the picture as
//   base64 PNG, about 2 MB of text, and `savedPath` is the file Codex already wrote,
//   ~/.codex/generated_images/<threadId>/<itemId>.png. Statuses seen there: 'completed', and once
//   'failed' with `failure: null` and an empty `result`. (Seen live over app-server in rocketv1,
//   2026-10-11, one turn, traced with its ROCKET_CODEX_TRACE, now CRAFT_CODEX_TRACE) Codex first reads its bundled imagegen
//   skill with a command, then `item/started` brings `{status: 'in_progress', revisedPrompt: null,
//   result: '', transparentBackground: null, failure: null}` with no `savedPath`; about 18 s later
//   `item/completed` brings `status: 'completed'`, the revised prompt, `result` (3.4 M characters
//   of base64) and `savedPath`. A `usageLimitExceeded` failure has not been seen; `resetsAt` is
//   read as epoch seconds, like the rate-limit windows. A rollout's imageView path was a file://
//   URL; no imageView has been seen over app-server yet.
//
// `CRAFT_CODEX_TRACE=<file>` appends every app-server notification to that file, long strings
// cut, for re-verifying the behaviour above against a new CLI without guessing.
//
// Threads run with approvalPolicy 'never' and full access, like the Codex CLI in its
// unattended mode: the app has no approval prompts yet.

const TOOL_TIMEOUT_SEC = 150
const TRACE = process.env.CRAFT_CODEX_TRACE || null

/** A payload for the trace: strings over 300 characters (a picture's base64) kept to their head and length. */
function traced(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 80)}…<${value.length} chars>` : value
  if (Array.isArray(value)) return value.map(traced)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, traced(entry)]))
  return value
}

type ActiveTurn = {
  request: RunRequest
  sink: TurnSink
  codexTurnId: string | null
  stopRequested: boolean
  interrupt: Promise<void> | null
  finish: (result: RunResult) => void
  /** The user's words sent into this turn that Codex has not taken yet. */
  steers?: Array<{ text: string; taken: () => void }>
  /** The thread's token count before this turn, known from its first reading. */
  tokenBase?: Spent
}

type Spent = Pick<TurnTokens, 'input' | 'cached' | 'output'>

class AppServerClient extends StdioJsonRpcClient {
  constructor() {
    // Craft Studio owns the browser. Exclude ChatGPT's competing browser tools, skills and hooks
    // from this process, including resumed threads, without editing the user's Codex config.
    super({
      peer: 'Codex', executable: 'codex', cwd: homedir(),
      args: [
        'app-server', '--listen', 'stdio://',
        '-c', 'plugins.unified-computer-use@openai-bundled.enabled=false',
        '-c', 'plugins.browser@openai-bundled.enabled=false',
        '-c', 'plugins.chrome@openai-bundled.enabled=false'
      ]
    })
  }

  override async start(): Promise<void> {
    if (this.connected) return
    await super.start()
    try {
      await this.request('initialize', {
        clientInfo: { name: 'craft-studio', title: 'Craft Studio', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      })
      this.notify('initialized', {})
    } catch (error) {
      this.stop()
      throw error
    }
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const
  private client: AppServerClient | null = null
  private starting: Promise<AppServerClient> | null = null
  /** chatId → the thread this process has loaded for it, and the model it runs. */
  private readonly loaded = new Map<string, { threadId: string; model: string }>()
  /** threadId → the turn running on it. */
  private readonly active = new Map<string, ActiveTurn>()
  /** chatId → a `prepare` still resuming that chat's thread; `run` waits for it instead of resuming twice. */
  private readonly preparing = new Map<string, Promise<void>>()
  private account: { email: string | null; plan: string | null } = { email: null, plan: null }

  constructor(private readonly onUsage: (snapshot: UsageSnapshot) => void, private readonly tools: ToolEndpoint = null) {}

  async run(request: RunRequest, sink: TurnSink): Promise<RunResult> {
    let client: AppServerClient
    let threadId: string
    try {
      await this.preparing.get(request.chatId)
      client = await this.connect()
      const opened = await this.openThread(client, request)
      if (opened === null) return { status: 'failed', sessionLost: true }
      threadId = opened.threadId
      sink.session(threadId)
      if (request.model || opened.model) sink.model(request.model ?? opened.model)
      if (request.handoff) {
        await client.request('thread/inject_items', {
          threadId,
          items: request.handoff.messages.map((message) => ({
            type: 'message',
            role: message.role,
            content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text }]
          }))
        })
      }
    } catch (error) {
      return { status: 'failed', error: messageOf(error) }
    }

    return new Promise<RunResult>((resolve) => {
      const turn: ActiveTurn = {
        request,
        sink,
        codexTurnId: null,
        stopRequested: false,
        interrupt: null,
        finish: (result) => {
          if (this.active.get(threadId) !== turn) return
          this.active.delete(threadId)
          resolve(result)
        }
      }
      this.active.set(threadId, turn)
      client.request<{ turn?: { id?: unknown } }>('turn/start', {
        threadId,
        ...(request.model ? { model: request.model } : {}),
        input: codexImageContent(request.text, request.attachments)
      }).then((response) => {
        if (typeof response.turn?.id === 'string') turn.codexTurnId ??= response.turn.id
        if (turn.stopRequested) void this.interruptTurn(threadId, turn)
      }, (error: unknown) => turn.finish({ status: 'failed', error: messageOf(error) }))
    })
  }

  /**
   * Start the app-server and, for a chat that already has a thread, resume it. A thread is not
   * started ahead of a first message: that costs little, and one never used would be left behind.
   */
  prepare(request: PrepareRequest): Promise<void> {
    const { chatId } = request
    if (chatId === null || request.sessionId === null) return this.connect().then(() => {})
    let pending = this.preparing.get(chatId)
    if (!pending) {
      pending = this.connect()
        .then((client) => this.openThread(client, { ...request, chatId }))
        .then(() => {}, () => {})
        .finally(() => this.preparing.delete(chatId))
      this.preparing.set(chatId, pending)
    }
    return pending
  }

  async stop(chatId: string): Promise<void> {
    const threadId = this.loaded.get(chatId)?.threadId
    const turn = threadId ? this.active.get(threadId) : undefined
    if (!threadId || !turn || !this.client?.connected) return
    turn.stopRequested = true
    await this.interruptTurn(threadId, turn)
  }

  private async interruptTurn(threadId: string, turn: ActiveTurn): Promise<void> {
    // Keep tracking a pending start until its ID arrives, by reply or notification.
    if (!turn.codexTurnId || this.active.get(threadId) !== turn || !this.client?.connected) return
    turn.interrupt ??= this.client.request('turn/interrupt', { threadId, turnId: turn.codexTurnId }).then(() => {}, () => {
      turn.finish({ status: 'interrupted' })
    })
    await turn.interrupt
  }

  async steer(chatId: string, text: string, taken: () => void): Promise<boolean> {
    const threadId = this.loaded.get(chatId)?.threadId
    const turn = threadId ? this.active.get(threadId) : undefined
    // Until Codex has named its turn there is nothing to steer; the words wait for the turn's end instead.
    if (!threadId || !turn?.codexTurnId || !this.client?.connected) return false
    // Registered first: the item saying Codex took them may come before the reply to the request.
    const steer = { text, taken }
    ;(turn.steers ??= []).push(steer)
    try {
      await this.client.request('turn/steer', { threadId, expectedTurnId: turn.codexTurnId, input: [{ type: 'text', text }] })
      return true
    } catch {
      turn.steers = turn.steers.filter((each) => each !== steer)
      return false
    }
  }

  forget(chatId: string): void {
    this.loaded.delete(chatId)
  }

  async usage(): Promise<UsageSnapshot> {
    const client = await this.connect()
    const [account, limits] = await Promise.all([
      client.request<{ account?: unknown }>('account/read', {}),
      client.request<{ rateLimits?: unknown }>('account/rateLimits/read', {})
    ])
    const info = recordOf(account.account)
    if (Object.keys(info).length === 0) return unavailableUsage('codex', 'Not signed in. Run `codex login` in a terminal.')
    this.account = { email: stringOf(info.email) || null, plan: stringOf(info.planType) || null }
    return this.snapshot(limits.rateLimits)
      ?? unavailableUsage('codex', 'Codex did not report subscription usage for this account.')
  }

  async models(): Promise<ModelInfo[]> {
    const client = await this.connect()
    const models: ModelInfo[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const response: { data?: unknown; nextCursor?: unknown } = await client.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {})
      })
      for (const entry of Array.isArray(response.data) ? response.data.map(recordOf) : []) {
        const id = stringOf(entry.id)
        if (!id || models.some((model) => model.id === id)) continue
        models.push({
          id,
          label: stringOf(entry.displayName) || id,
          description: stringOf(entry.description),
          isDefault: entry.isDefault === true
        })
      }
      cursor = stringOf(response.nextCursor) || null
      if (!cursor) break
    }
    return models
  }

  shutdown(): void {
    this.client?.stop()
    this.client = null
  }

  private connect(): Promise<AppServerClient> {
    if (this.client?.connected) return Promise.resolve(this.client)
    this.starting ??= (async () => {
      const client = new AppServerClient()
      client.on('notification', (notification: JsonRpcNotification) => this.onNotification(notification))
      client.on('request', (request: JsonRpcRequest) => this.onRequest(client, request))
      client.on('exit', (error: Error) => this.onExit(client, error))
      await client.start()
      this.client = client
      return client
    })().finally(() => { this.starting = null })
    return this.starting
  }

  /** The thread to run on and its own model, or null when the stored thread can no longer be resumed. */
  private async openThread(
    client: AppServerClient,
    request: Pick<RunRequest, 'chatId' | 'cwd' | 'sessionId'>
  ): Promise<{ threadId: string; model: string } | null> {
    const loaded = this.loaded.get(request.chatId)
    if (loaded && loaded.threadId === request.sessionId) return loaded
    const params = {
      cwd: request.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      // The app's tools, at a URL that names this chat. A browser script may run for two minutes,
      // so a call is given longer than that before Codex gives up on it.
      ...(this.tools
        ? { config: { mcp_servers: { [TOOL_SERVER]: { url: this.tools.url('codex', request.chatId), tool_timeout_sec: TOOL_TIMEOUT_SEC } } } }
        : {})
    }
    let response: { thread?: { id?: unknown }; model?: unknown }
    if (request.sessionId) {
      try {
        response = await client.request('thread/resume', { threadId: request.sessionId, ...params }, 60_000)
      } catch (error) {
        if (!client.connected) throw error
        return null
      }
    } else {
      response = await client.request('thread/start', { ...params, serviceName: 'craft-studio' }, 60_000)
    }
    const threadId = stringOf(response.thread?.id)
    if (!threadId) throw new Error('Codex did not return a thread')
    const model = stringOf(response.model) || stringOf(recordOf(response.thread).model)
    const opened = { threadId, model }
    this.loaded.set(request.chatId, opened)
    return opened
  }

  private onNotification(notification: JsonRpcNotification): void {
    const params = recordOf(notification.params)
    if (TRACE) {
      try { appendFileSync(TRACE, `${JSON.stringify({ at: Date.now(), method: notification.method, params: traced(params) })}\n`) } catch {}
    }
    if (notification.method === 'account/rateLimits/updated') {
      const snapshot = this.snapshot(params.rateLimits)
      if (snapshot) this.onUsage(snapshot)
      return
    }
    const turn = this.active.get(stringOf(params.threadId))
    if (!turn) return
    const { sink, request } = turn
    switch (notification.method) {
      case 'turn/started':
        turn.codexTurnId = stringOf(recordOf(params.turn).id) || turn.codexTurnId
        if (turn.stopRequested) void this.interruptTurn(stringOf(params.threadId), turn)
        break
      case 'item/started':
      case 'item/completed': {
        const steered = steeredText(params.item)
        const steer = steered === null ? undefined : turn.steers?.find((each) => each.text === steered)
        if (steer) {
          turn.steers = turn.steers!.filter((each) => each !== steer)
          steer.taken()
        }
        const item = codexItem(params.item, request.turnId, notification.method === 'item/completed')
        if (item) sink.item(item)
        break
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/commandExecution/outputDelta': {
        const delta = stringOf(params.delta)
        if (delta) sink.delta(itemId(request.turnId, stringOf(params.itemId)), delta)
        break
      }
      case 'thread/tokenUsage/updated': {
        // A late reading of the turn before this one is not this turn's.
        const about = stringOf(params.turnId)
        if (about && turn.codexTurnId && about !== turn.codexTurnId) break
        const read = codexTokens(params.tokenUsage, turn.tokenBase ?? null)
        if (!read) break
        turn.tokenBase = read.base
        sink.tokens(read.tokens)
        break
      }
      case 'turn/plan/updated': {
        const plan = planItem(request.turnId, params.plan, (step) => stringOf(step.step))
        if (plan) sink.item(plan)
        break
      }
      case 'error': {
        // `willRetry` errors are the app-server reconnecting on its own; only the last one matters.
        if (params.willRetry === true) break
        const message = stringOf(recordOf(params.error).message)
        if (message) sink.item(notice(request.turnId, `error-${Date.now()}`, message))
        break
      }
      case 'turn/completed': {
        const done = recordOf(params.turn)
        const status = stringOf(done.status)
        if (status === 'interrupted') turn.finish({ status: 'interrupted' })
        else if (status === 'failed') {
          turn.finish({ status: 'failed', error: stringOf(recordOf(done.error).message) || 'The Codex turn failed' })
        } else turn.finish({ status: 'completed' })
        break
      }
    }
  }

  /** Approvals should not arrive under approvalPolicy 'never'; one that does is accepted. */
  private onRequest(client: AppServerClient, request: JsonRpcRequest): void {
    try {
      if (/requestApproval$/.test(request.method)) client.respond(request.id, { decision: 'accept' })
      else client.respondWithError(request.id, -32601, `Craft Studio does not implement ${request.method}`)
    } catch {
      // The process went away between the request and the answer.
    }
  }

  private onExit(client: AppServerClient, error: Error): void {
    if (this.client === client) this.client = null
    this.loaded.clear()
    for (const turn of [...this.active.values()]) turn.finish({ status: 'failed', error: error.message })
  }

  private snapshot(rateLimits: unknown): UsageSnapshot | null {
    const parsed = codexUsage(rateLimits)
    if (!parsed) return null
    return {
      provider: 'codex',
      account: this.account.email,
      plan: parsed.plan ?? this.account.plan,
      windows: parsed.windows,
      note: parsed.note,
      unavailable: parsed.windows.length ? null : 'Codex did not report any rate-limit windows for this account.',
      updatedAt: Date.now()
    }
  }
}

/**
 * A turn's tokens from a thread's token reading. `base` is the thread's count before the turn;
 * on the turn's first reading it is unknown and worked out as the total less that latest call.
 */
export function codexTokens(value: unknown, base: Spent | null): { tokens: TurnTokens; base: Spent } | null {
  const usage = recordOf(value)
  const spent = (entry: unknown): Spent | null => {
    const raw = recordOf(entry)
    if (typeof raw.inputTokens !== 'number') return null
    const count = (key: string): number => (typeof raw[key] === 'number' ? raw[key] as number : 0)
    return { input: count('inputTokens'), cached: count('cachedInputTokens'), output: count('outputTokens') }
  }
  const total = spent(usage.total)
  const last = spent(usage.last)
  if (!total) return null
  const before = base ?? (last
    ? { input: total.input - last.input, cached: total.cached - last.cached, output: total.output - last.output }
    : total)
  const window = usage.modelContextWindow
  return {
    base: before,
    tokens: {
      input: Math.max(0, total.input - before.input),
      cached: Math.max(0, total.cached - before.cached),
      output: Math.max(0, total.output - before.output),
      context: last?.input ?? null,
      contextWindow: typeof window === 'number' && window > 0 ? window : null
    }
  }
}

function notice(turnId: string, key: string, text: string): Item {
  return { type: 'notice', id: itemId(turnId, key), turnId, text, tone: 'error' }
}

/** The text of a user message item, which is how Codex shows it has taken words sent mid-turn. */
export function steeredText(value: unknown): string | null {
  const item = recordOf(value)
  if (item.type !== 'userMessage' || !Array.isArray(item.content)) return null
  return item.content.map((part) => stringOf(recordOf(part).text)).join('')
}

/** One app-server thread item in transcript form; null for kinds the transcript does not show. */
export function codexItem(value: unknown, turnId: string, completed: boolean): Item | null {
  const item = recordOf(value)
  const rawId = stringOf(item.id)
  if (!rawId) return null
  const id = itemId(turnId, rawId)
  const status = toolStatus(item.status, completed)
  switch (item.type) {
    case 'agentMessage':
      return { type: 'assistant', id, turnId, text: stringOf(item.text), streaming: !completed }
    case 'reasoning': {
      const text = [...textList(item.summary), ...textList(item.content)].join('\n\n')
      // An empty reasoning item is the model thinking with summaries off; nothing to show.
      return text || !completed ? { type: 'reasoning', id, turnId, text, streaming: !completed } : null
    }
    case 'commandExecution': {
      const action = Array.isArray(item.commandActions) ? stringOf(recordOf(item.commandActions[0]).command) : ''
      return {
        type: 'tool', id, turnId, kind: 'command', status,
        label: action || stringOf(item.command),
        output: clipOutput(stringOf(item.aggregatedOutput))
      }
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes.map(recordOf) : []
      return {
        type: 'tool', id, turnId, kind: 'edit', status,
        label: changes.map((change) => stringOf(change.path)).filter(Boolean).join(', ') || 'file changes',
        output: clipOutput(changes.map((change) => stringOf(change.diff)).filter(Boolean).join('\n'))
      }
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const name = [stringOf(item.server), stringOf(item.tool)].filter(Boolean).join(' · ') || 'tool'
      const args = jsonPreview(item.arguments, 120)
      return {
        type: 'tool', id, turnId, kind: 'mcp', status,
        label: args && args !== '{}' ? `${name} ${args}` : name,
        output: completed ? clipOutput(jsonPreview(item.result ?? item.error ?? '', 4_000)) : ''
      }
    }
    case 'webSearch':
      return { type: 'tool', id, turnId, kind: 'web', status, label: stringOf(item.query) || 'web search', output: '' }
    case 'imageGeneration':
      return codexImage(item, id, turnId, completed)
    case 'imageView': {
      // Codex looking at a picture on disk. The path is the step's output, for opening it.
      const path = stringOf(item.path).replace(/^file:\/\//, '')
      return { type: 'tool', id, turnId, kind: 'other', status: 'done', label: `Viewed ${basename(path) || 'an image'}`, output: path }
    }
    default:
      return null
  }
}

/**
 * A picture Codex is making or has made. A finished one carries what the hub needs to keep its
 * own copy: the file Codex saved and the base64 bytes it also sends, either of which will do.
 */
function codexImage(item: Record<string, unknown>, id: string, turnId: string, completed: boolean): Item {
  const caption = stringOf(item.revisedPrompt).trim()
  const status = stringOf(item.status)
  const failure = recordOf(item.failure)
  const failed = (error: string): Item => ({ type: 'image', id, turnId, status: 'failed', caption, error })
  if (failure.type === 'usageLimitExceeded') return failed(imageLimitText(failure.resetsAt))
  if (status === 'failed' || status === 'declined') {
    return failed('Codex could not make this image. Ask again, or reword the request if it may have been refused.')
  }
  if (!completed && status !== 'completed') return { type: 'image', id, turnId, status: 'generating', caption }
  const path = stringOf(item.savedPath)
  const base64 = stringOf(item.result)
  if (!path && !base64) return failed('Codex finished the image but did not send it. Ask for it again.')
  return { type: 'image', id, turnId, status: 'done', caption, source: { ...(path ? { path } : {}), ...(base64 ? { base64 } : {}) } }
}

/** The usage-limit failure as a sentence. `resetsAt` is epoch seconds, as in Codex's rate limits. */
export function imageLimitText(resetsAt: unknown, now = Date.now()): string {
  const head = 'Codex has used up its image generation limit for now.'
  if (typeof resetsAt !== 'number' || resetsAt <= 0) return `${head} Codex did not say when it resets; try again later.`
  const at = new Date(resetsAt > 1e12 ? resetsAt : resetsAt * 1_000)
  const sameDay = at.toDateString() === new Date(now).toDateString()
  const when = at.toLocaleString(undefined, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `${head} Try again after ${when}.`
}

function toolStatus(value: unknown, completed: boolean): ToolStatus {
  if (value === 'failed' || value === 'declined') return 'failed'
  if (value === 'completed' || completed) return 'done'
  return 'running'
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry : stringOf(recordOf(entry).text))).filter(Boolean)
}

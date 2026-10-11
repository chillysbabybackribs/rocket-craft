// Image input: ACP v1 base64 image blocks, gated on initialize promptCapabilities.image
// (official ACP docs read 2026-10-06; image turns not yet verified live).
import { cursorImageContent } from './images.ts'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Item, ModelInfo, ToolKind, UsageSnapshot } from '../../shared/types.ts'
import { withHandoff } from '../handoff.ts'
import { clipOutput, jsonPreview, messageOf, recordOf, stringOf } from '../json.ts'
import { JsonRpcPeerError, StdioJsonRpcClient, type JsonRpcNotification, type JsonRpcRequest } from '../stdio-json-rpc.ts'
import { cursorUsage } from '../usage-parsers.ts'
import {
  itemId, planItem, TOOL_SERVER, unavailableUsage,
  type PrepareRequest, type ProviderAdapter, type RunRequest, type RunResult, type ToolEndpoint, type TurnSink
} from './provider.ts'

// Cursor through `cursor-agent acp`: the Agent Client Protocol, JSON-RPC 2.0 over stdio. One
// process serves every chat; each chat is an ACP session.
//
// We drive: initialize, session/new, session/load, session/prompt, session/cancel. The agent
// drives back: session/update (the whole transcript stream), session/request_permission,
// fs/read_text_file + fs/write_text_file, and Cursor's `cursor/*` extensions (per Cursor's ACP
// docs, read 2026-10-05; see CURSOR_EXTENSIONS). Facts the code depends on, verified live by the
// reference build against cursor-agent in September 2026:
// - `terminal` is not advertised, so the agent runs commands itself and reports them as
//   `tool_call` updates.
// - `session/cancel` must be a notification; sent as a request it is ignored.
// - `session/load` replays the stored history as `session/update` notifications before it
//   answers, so updates are dropped while a load is in flight.
// - `session/new` only reserves an id: a session that never took a prompt cannot be loaded later.
// - (cursor-agent 2026.10.01, verified 2026-10-05) `initialize` advertises `loadSession`,
//   `sessionCapabilities.list` and image prompts; not `session/resume` or `session/fork`.
// - Permission requests are answered with the broadest allow offered: the app has no approval
//   prompts yet.
// - (ACP spec, read 2026-10-05; not yet seen live from cursor-agent) The agent's plan is the
//   `plan` session update, `entries: [{content, priority, status: 'pending'|'in_progress'|
//   'completed'}]`, the whole list each time; it becomes the turn's plan item. Cursor's own
//   `cursor/update_todos` request carries no session id, so with several chats on one process it
//   cannot be placed; it is accepted and its list dropped.
// - The model list is whatever a session's setup reports in `models.availableModels`; an id is
//   `<base>[<key>=<value>,…]` and only an id listed there verbatim can be selected.
// - (cursor-agent 2026.10.01 bundle, read 2026-10-05) The ACP schema it ships allows `usage` on
//   the `session/prompt` answer and a `usage_update` session update, but the agent answers with
//   `stopReason` alone and sends no usage, so Cursor turns carry no token reading.
// ACP gives the agent ownership of history, so missed turns ride at the head of the prompt.

const execFileAsync = promisify(execFile)
const PROMPT_TIMEOUT_MS = 60 * 60_000

function cursorBinary(): string {
  // The installer puts a wrapper in ~/.local/bin, which a desktop-launched app often lacks on PATH.
  const installed = join(homedir(), '.local', 'bin', 'cursor-agent')
  return existsSync(installed) ? installed : 'cursor-agent'
}

class AcpClient extends StdioJsonRpcClient {
  supportsImages = false
  constructor() {
    super({ peer: 'Cursor', executable: cursorBinary(), cwd: homedir(), args: ['acp'], version: '2.0' })
    this.on('request', (request: JsonRpcRequest) => { void this.serve(request) })
  }

  override async start(): Promise<void> {
    if (this.connected) return
    await super.start()
    try {
      const initialized = recordOf(await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }
      }))
      this.supportsImages = recordOf(recordOf(initialized.agentCapabilities).promptCapabilities).image === true
    } catch (error) {
      this.stop()
      throw error
    }
  }

  /** cursor-agent puts the reason in `data.message` and only a generic label in `message`. */
  protected override rpcError(message: string, code: number | null, data: unknown): Error {
    const detail = stringOf(recordOf(data).message)
    return new JsonRpcPeerError(detail && detail !== message ? `${message}: ${detail}` : message, code, data)
  }

  private async serve(request: JsonRpcRequest): Promise<void> {
    const params = recordOf(request.params)
    try {
      if (request.method === 'session/request_permission') {
        this.respond(request.id, { outcome: { outcome: 'selected', optionId: allowOption(params) } })
      } else if (request.method === 'fs/read_text_file') {
        const content = await readFile(String(params.path), 'utf8')
        this.respond(request.id, { content: clipLines(content, params) })
      } else if (request.method === 'fs/write_text_file') {
        await writeFile(String(params.path), String(params.content ?? ''), 'utf8')
        this.respond(request.id, {})
      } else if (Object.hasOwn(CURSOR_EXTENSIONS, request.method)) {
        this.respond(request.id, cursorExtensionReply(request.method, params))
      } else {
        this.respondWithError(request.id, -32601, `Craft Studio does not implement ${request.method}`)
      }
    } catch (error) {
      try { this.respondWithError(request.id, -32000, messageOf(error)) } catch { /* the process is gone */ }
    }
  }
}

type ActiveTurn = { sink: TurnSink; translator: UpdateTranslator }

/** What a session's setup said about models. */
type SessionModels = {
  models: ModelInfo[]
  currentId: string
  /** The config option that selects the model, when the agent exposes one. */
  configId: string | null
}
type LoadedSession = {
  sessionId: string
  /** Whether the hub has been told this id. A session opened by `prepare` is not yet the chat's. */
  announced: boolean
} & SessionModels
type OpenRequest = Pick<RunRequest, 'chatId' | 'cwd' | 'sessionId' | 'model'>

function readSetup(setup: Record<string, unknown>): SessionModels {
  const info = recordOf(setup.models)
  const currentId = stringOf(info.currentModelId)
  const models = (Array.isArray(info.availableModels) ? info.availableModels.map(recordOf) : []).flatMap((model): ModelInfo[] => {
    const id = stringOf(model.modelId)
    if (!id) return []
    return [{ id, label: stringOf(model.name) || id, description: describeModelId(id), isDefault: id === currentId }]
  })
  const options = Array.isArray(setup.configOptions) ? setup.configOptions.map(recordOf) : []
  const option = options.find((entry) => entry.category === 'model')
  return { models, currentId, configId: stringOf(option?.id) || stringOf(option?.configId) || null }
}

/** What the bracket of `base[thinking=true,context=300k,effort=high]` says, in plain words. */
function describeModelId(id: string): string {
  const match = /\[([^\]]*)\]$/.exec(id)
  if (!match) return ''
  const params = Object.fromEntries(match[1]!.split(',').map((pair) => pair.split('=').map((part) => part.trim())).filter((pair) => pair[0]))
  const parts: string[] = []
  if (params.thinking === 'true') parts.push('Thinking')
  const effort = params.effort ?? params.reasoning ?? params.reasoning_effort
  if (effort) parts.push(`${effort} effort`)
  if (params.context) parts.push(`${params.context} context`)
  if (params.fast === 'true') parts.push('Fast')
  return parts.join(' · ')
}

export class CursorAdapter implements ProviderAdapter {
  readonly id = 'cursor' as const
  private client: AcpClient | null = null
  private starting: Promise<AcpClient> | null = null
  /** chatId → the ACP session this process holds for it, and what it said about models. */
  private readonly loaded = new Map<string, LoadedSession>()
  /** The most recent model list any session reported, so the picker rarely needs its own. */
  private catalog: ModelInfo[] | null = null
  /** sessionId → the turn running on it. Sessions being loaded are absent, which drops their replay. */
  private readonly active = new Map<string, ActiveTurn>()
  /** chatId → a `prepare` still opening that chat's session; `run` waits for it instead of opening twice. */
  private readonly preparing = new Map<string, Promise<void>>()

  constructor(private readonly tools: ToolEndpoint = null) {}

  async run(request: RunRequest, sink: TurnSink): Promise<RunResult> {
    let client: AcpClient
    let sessionId: string
    try {
      await this.preparing.get(request.chatId)
      client = await this.connect()
      const session = await this.openSession(client, request)
      if (session === null) return { status: 'failed', sessionLost: true }
      sessionId = session.sessionId
      if (!session.announced) {
        session.announced = true
        sink.session(sessionId)
      }
      const name = session.models.find((model) => model.id === session.currentId)?.label || session.currentId
      if (name) sink.model(name)
    } catch (error) {
      return { status: 'failed', error: messageOf(error) }
    }
    const translator = new UpdateTranslator(request.turnId)
    this.active.set(sessionId, { sink, translator })
    try {
      if (request.attachments?.length && !client.supportsImages) throw new Error('This Cursor version does not accept images. Update Cursor or choose Claude or Codex.')
      const result = await client.request<{ stopReason?: unknown }>(
        'session/prompt',
        { sessionId, prompt: cursorImageContent(withHandoff(request.handoff, request.text), request.attachments) },
        PROMPT_TIMEOUT_MS
      )
      for (const item of translator.finish()) sink.item(item)
      if (result?.stopReason === 'cancelled') return { status: 'interrupted' }
      if (result?.stopReason === 'refusal') return { status: 'failed', error: 'Cursor declined this request.' }
      return { status: 'completed' }
    } catch (error) {
      for (const item of translator.finish()) sink.item(item)
      return { status: 'failed', error: messageOf(error) }
    } finally {
      this.active.delete(sessionId)
    }
  }

  /**
   * Start the agent and open the chat's session with its model selected. With no chat yet, the
   * model read stands in: it starts the agent and takes the slow first session setup off the
   * first message.
   */
  prepare(request: PrepareRequest): Promise<void> {
    const { chatId } = request
    if (chatId === null) return this.models().then(() => {})
    let pending = this.preparing.get(chatId)
    if (!pending) {
      pending = this.connect()
        .then((client) => this.openSession(client, { ...request, chatId }))
        .then(() => {}, () => {})
        .finally(() => this.preparing.delete(chatId))
      this.preparing.set(chatId, pending)
    }
    return pending
  }

  async stop(chatId: string): Promise<void> {
    const sessionId = this.loaded.get(chatId)?.sessionId
    if (sessionId && this.active.has(sessionId)) this.client?.notify('session/cancel', { sessionId })
  }

  forget(chatId: string): void {
    this.loaded.delete(chatId)
  }

  async usage(): Promise<UsageSnapshot> {
    try {
      // The stored token is tried as it is; only one the service turns away costs a run of the CLI to renew it.
      let token = await accessToken()
      const current = await dashboard(token, 'GetCurrentPeriodUsage').catch(async (error: unknown) => {
        if (!(error instanceof DashboardError) || (error.status !== 401 && error.status !== 403)) throw error
        token = await accessToken(true)
        return dashboard(token, 'GetCurrentPeriodUsage')
      })
      const [plan, me] = await Promise.all([
        dashboard(token, 'GetPlanInfo').catch(() => null),
        dashboard(token, 'GetMe').catch(() => null)
      ])
      const parsed = cursorUsage(current, plan)
      return {
        provider: 'cursor',
        account: stringOf(recordOf(me).email) || null,
        plan: parsed.plan,
        windows: parsed.windows,
        note: parsed.note,
        unavailable: parsed.windows.length ? null : 'Cursor did not report percentage usage for this plan.',
        updatedAt: Date.now()
      }
    } catch (error) {
      return unavailableUsage('cursor', messageOf(error))
    }
  }

  async models(): Promise<ModelInfo[]> {
    if (this.catalog) return this.catalog
    // No chat has opened a session yet. `session/new` only reserves an id and reports the
    // account's models; this one never takes a prompt.
    const client = await this.connect()
    const setup = readSetup(recordOf(await client.request('session/new', { cwd: homedir(), mcpServers: [] }, 60_000)))
    this.catalog = setup.models
    return setup.models
  }

  shutdown(): void {
    this.client?.stop()
    this.client = null
  }

  private connect(): Promise<AcpClient> {
    if (this.client?.connected) return Promise.resolve(this.client)
    this.starting ??= (async () => {
      const client = new AcpClient()
      client.on('notification', (notification: JsonRpcNotification) => this.onNotification(notification))
      client.on('exit', () => {
        if (this.client === client) this.client = null
        this.loaded.clear()
      })
      await client.start()
      this.client = client
      return client
    })().finally(() => { this.starting = null })
    return this.starting
  }

  /** The session to prompt, on the requested model, or null when the stored one can no longer be loaded. */
  private async openSession(client: AcpClient, request: OpenRequest): Promise<LoadedSession | null> {
    let session = this.loaded.get(request.chatId)
    // A session `prepare` made for a chat that had none is the one its first message uses.
    const held = session && (session.sessionId === request.sessionId || (request.sessionId === null && !session.announced))
    if (!session || !held) {
      const opened = await this.loadOrCreate(client, request)
      if (!opened) return null
      session = opened
      this.loaded.set(request.chatId, session)
      if (session.models.length) this.catalog = session.models
    }
    if (request.model && request.model !== session.currentId && session.models.some((model) => model.id === request.model)) {
      if (session.configId) {
        await client.request('session/set_config_option', { sessionId: session.sessionId, configId: session.configId, value: request.model })
      } else {
        await client.request('session/set_model', { sessionId: session.sessionId, modelId: request.model })
      }
      session.currentId = request.model
    }
    return session
  }

  private async loadOrCreate(client: AcpClient, request: OpenRequest): Promise<LoadedSession | null> {
    let setup: Record<string, unknown>
    let sessionId: string
    // The app's tools, at a URL that names this chat.
    const mcpServers = this.tools
      ? [{ type: 'http', name: TOOL_SERVER, url: this.tools.url('cursor', request.chatId), headers: [] }]
      : []
    if (request.sessionId) {
      try {
        setup = recordOf(await client.request('session/load', { sessionId: request.sessionId, cwd: request.cwd, mcpServers }, 60_000))
      } catch (error) {
        if (!client.connected) throw error
        return null
      }
      sessionId = request.sessionId
    } else {
      setup = recordOf(await client.request('session/new', { cwd: request.cwd, mcpServers }, 60_000))
      sessionId = stringOf(setup.sessionId)
      if (!sessionId) throw new Error('Cursor did not return a session')
    }
    return { sessionId, announced: request.sessionId !== null, ...readSetup(setup) }
  }

  private onNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'session/update') return
    const params = recordOf(notification.params)
    const turn = this.active.get(stringOf(params.sessionId))
    if (!turn) return
    for (const op of turn.translator.handle(recordOf(params.update))) {
      if (op.type === 'item') turn.sink.item(op.item)
      else turn.sink.delta(op.itemId, op.delta)
    }
  }
}

type Op = { type: 'item'; item: Item } | { type: 'delta'; itemId: string; delta: string }
type ToolItem = Extract<Item, { type: 'tool' }>
type OpenText = { id: string; kind: 'assistant' | 'reasoning'; text: string }

/**
 * Pure translation from one turn's ACP updates to transcript operations. Chunks are true deltas
 * (no full-text restatement follows), and text and tools interleave, so a tool call closes the
 * open text item and the next chunk starts a new one.
 */
export class UpdateTranslator {
  private readonly tools = new Map<string, ToolItem>()
  private open: OpenText | null = null
  private seq = 0

  constructor(private readonly turnId: string) {}

  handle(update: Record<string, unknown>): Op[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.text('assistant', chunkText(update))
      case 'agent_thought_chunk':
        return this.text('reasoning', chunkText(update))
      case 'tool_call':
      case 'tool_call_update':
        return this.tool(update)
      case 'plan': {
        const item = planItem(this.turnId, update.entries, (entry) => stringOf(entry.content))
        return item ? [{ type: 'item', item }] : []
      }
      default:
        return []
    }
  }

  /** Close whatever the turn left open when it ends. */
  finish(): Item[] {
    const items = this.closeText().map((op) => (op as Extract<Op, { type: 'item' }>).item)
    for (const [id, tool] of this.tools) {
      if (tool.status !== 'running') continue
      const closed: ToolItem = { ...tool, status: 'failed', output: tool.output || 'The turn ended before this call reported a result.' }
      this.tools.set(id, closed)
      items.push(closed)
    }
    return items
  }

  private text(kind: OpenText['kind'], delta: string): Op[] {
    if (!delta) return []
    if (this.open && this.open.kind !== kind) return [...this.closeText(), ...this.text(kind, delta)]
    if (!this.open) {
      this.seq += 1
      this.open = { id: itemId(this.turnId, `t${this.seq}`), kind, text: delta }
      return [{ type: 'item', item: this.textItem(this.open, true) }]
    }
    this.open.text += delta
    return [{ type: 'delta', itemId: this.open.id, delta }]
  }

  private closeText(): Op[] {
    const open = this.open
    if (!open) return []
    this.open = null
    return [{ type: 'item', item: this.textItem(open, false) }]
  }

  private textItem(open: OpenText, streaming: boolean): Item {
    return { type: open.kind, id: open.id, turnId: this.turnId, text: open.text, streaming }
  }

  private tool(update: Record<string, unknown>): Op[] {
    const callId = stringOf(update.toolCallId)
    if (!callId) return []
    const ops: Op[] = []
    let item = this.tools.get(callId)
    const rawInput = recordOf(update.rawInput)
    if (!item) {
      ops.push(...this.closeText())
      item = { type: 'tool', id: itemId(this.turnId, callId), turnId: this.turnId, status: 'running', output: '', ...describeCall(update, rawInput) }
    } else if (item.status === 'running' && (Object.keys(rawInput).length || stringOf(update.title))) {
      // The announcement often carries an empty input; the first update fills it in.
      const described = describeCall({ kind: update.kind ?? acpKind(item.kind), title: update.title }, rawInput)
      item = { ...item, label: described.label || item.label, kind: update.kind ? described.kind : item.kind }
    }
    if (item.status === 'running' && (update.status === 'completed' || update.status === 'failed')) {
      item = { ...item, status: update.status === 'failed' ? 'failed' : 'done', output: clipOutput(callOutput(update)) }
    }
    if (item !== this.tools.get(callId)) {
      this.tools.set(callId, item)
      ops.push({ type: 'item', item })
    }
    return ops
  }
}

const ACP_KINDS: Record<string, ToolKind> = {
  execute: 'command', edit: 'edit', delete: 'edit', move: 'edit', read: 'read', search: 'search', fetch: 'web'
}

function acpKind(kind: ToolKind): string {
  return Object.entries(ACP_KINDS).find(([, value]) => value === kind)?.[0] ?? 'other'
}

function describeCall(update: Record<string, unknown>, rawInput: Record<string, unknown>): { kind: ToolKind; label: string } {
  const title = stringOf(update.title).replace(/^`(.*)`$/s, '$1')
  // One of an MCP server's tools arrives as kind "other" and is only named in the input.
  const server = stringOf(rawInput.providerIdentifier)
  const tool = stringOf(rawInput.toolName)
  if (server && tool) {
    const args = jsonPreview(rawInput.args, 120)
    return { kind: 'mcp', label: args && args !== '{}' ? `${server} · ${tool} ${args}` : `${server} · ${tool}` }
  }
  const kind = ACP_KINDS[stringOf(update.kind)] ?? 'other'
  const label = kind === 'command'
    ? stringOf(rawInput.command) || title
    : stringOf(rawInput.path) || stringOf(rawInput.query) || stringOf(rawInput.url) || title
  return { kind, label: label || stringOf(update.kind) || 'tool' }
}

function callOutput(update: Record<string, unknown>): string {
  const parts: string[] = []
  for (const block of Array.isArray(update.content) ? update.content.map(recordOf) : []) {
    if (block.type === 'content') parts.push(stringOf(recordOf(block.content).text))
    else if (block.type === 'diff') parts.push(`${stringOf(block.path)}\n${stringOf(block.newText)}`)
  }
  const text = parts.filter(Boolean).join('\n')
  if (text) return text
  const raw = recordOf(update.rawOutput)
  return stringOf(raw.content) || stringOf(raw.stdout) || stringOf(raw.output) || stringOf(raw.error)
}

function chunkText(update: Record<string, unknown>): string {
  return stringOf(recordOf(update.content).text)
}

/** The broadest allow the request offers, so a turn never stalls on a prompt nobody will see. */
function allowOption(params: Record<string, unknown>): string {
  const options = Array.isArray(params.options) ? params.options.map(recordOf) : []
  const always = options.find((option) => /^allow[_-]always$/.test(String(option.kind ?? option.optionId)))
  const allow = options.find((option) => /allow/i.test(String(option.kind ?? '')) || /allow/i.test(String(option.optionId ?? '')))
  return stringOf((always ?? allow ?? options[0])?.optionId) || 'allow'
}

// Cursor's own ACP extensions. A question or plan approval would hold the turn for a human, and
// Craft Studio routes questions by role without blocking, so a question is skipped with report,
// checkpoint needs or ordinary ask_user guidance. A plan is accepted unattended. The docs call todos and task
// completions notifications but give them responses too; answered as requests, they are accepted.
const CURSOR_EXTENSIONS: Record<string, (params: Record<string, unknown>) => unknown> = {
  'cursor/ask_question': () => ({
    outcome: {
      outcome: 'skipped',
      reason: 'Nobody is waiting on this session. Orchestration workers put questions or blockers in their report and end their turn. Leaders use orchestrator checkpoint needs. Ordinary chats can use ask_user, which returns immediately. Carry on with work that does not depend on the answer.'
    }
  }),
  'cursor/create_plan': () => ({ outcome: { outcome: 'accepted' } }),
  'cursor/update_todos': (params) => ({ outcome: { outcome: 'accepted', todos: Array.isArray(params.todos) ? params.todos : [] } }),
  'cursor/task': (params) => ({
    outcome: { outcome: 'completed', ...(stringOf(params.agentId) ? { agentId: stringOf(params.agentId) } : {}) }
  })
}

/** What the app answers one of Cursor's extension requests with. */
export function cursorExtensionReply(method: string, params: Record<string, unknown>): unknown {
  const reply = Object.hasOwn(CURSOR_EXTENSIONS, method) ? CURSOR_EXTENSIONS[method] : undefined
  if (!reply) throw new Error(`Craft Studio does not implement ${method}`)
  return reply(params)
}

/** ACP lets a read name a window; honouring it keeps large files out of the agent's context. */
function clipLines(content: string, params: Record<string, unknown>): string {
  const line = typeof params.line === 'number' ? Math.max(1, Math.trunc(params.line)) : 1
  const limit = typeof params.limit === 'number' ? Math.max(0, Math.trunc(params.limit)) : null
  if (line === 1 && limit === null) return content
  return content.split('\n').slice(line - 1, limit === null ? undefined : line - 1 + limit).join('\n')
}

// Subscription usage. Cursor documents no quota endpoint; this reads the same internal dashboard
// service the CLI's own /usage command calls, signed in as the CLI. It can change without notice,
// and when it does the ring reports "unavailable" instead of a number.

const DASHBOARD = 'https://api2.cursor.sh/aiserver.v1.DashboardService/'

/**
 * The CLI's own stored token. It stays in this process: never logged, never sent to the renderer.
 * With `refresh`, the CLI is first given the chance to renew it; `about` starts no chat.
 */
async function accessToken(refresh = false): Promise<string> {
  if (refresh) await execFileAsync(cursorBinary(), ['about'], { timeout: 30_000 }).catch(() => null)
  const directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cursor')
  try {
    const auth = recordOf(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')))
    const token = stringOf(auth.accessToken).trim()
    if (token) return token
  } catch {
    // Missing or unreadable credentials read the same as not signed in.
  }
  throw new Error('Sign in with `cursor-agent login` to read Cursor usage.')
}

class DashboardError extends Error {
  constructor(readonly status: number) {
    super(`Cursor usage request failed (${status}).`)
  }
}

async function dashboard(token: string, method: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(DASHBOARD + method, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-cursor-client-type': 'cli'
      },
      body: '{}',
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    throw new Error('Could not reach Cursor to read usage.')
  }
  if (!response.ok) throw new DashboardError(response.status)
  return response.json()
}

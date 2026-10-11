import { attachmentInput } from './images.ts'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Item, ModelInfo, ToolKind, UsageSnapshot } from '../../shared/types.ts'
import { withHandoff } from '../handoff.ts'
import { clipOutput, jsonPreview, messageOf, oneLine, recordOf, stringOf } from '../json.ts'
import { ownProcessGroup, stopProcessGroup, trackProcessGroup } from '../process-tree.ts'
import { antigravityUsage } from '../usage-parsers.ts'
import { SHARED } from '../tools/channel.ts'
import {
  itemId, TOOL_SERVER, unavailableUsage,
  type PrepareRequest, type ProviderAdapter, type RunRequest, type RunResult, type ToolBrief, type ToolEndpoint, type TurnSink
} from './provider.ts'

// Antigravity through Google's `agy` CLI in headless stream-json mode: one process per chat,
// one JSON turn per stdin line, NDJSON events on stdout. Facts the code depends on, verified
// live by the reference build against agy in September 2026:
// - `--print=` (an EMPTY value) with `--input-format stream-json` keeps the process alive across
//   turns. A bare `--print` swallows the next flag as its prompt.
// - `--dangerously-skip-permissions` is required: without it a headless turn stalls on a prompt
//   that has no channel to be answered on.
// - `--add-dir <workspace>` must come first; the spawn cwd alone does not reach the model's shell.
// - Every line is `{"event": <kind>, <kind>: {...}}`. `step_update` carries text deltas and tool
//   steps; `result` closes the turn and its `response` is the authoritative final text, because
//   the delta stream sometimes comes up short.
// - There is no interrupt in the protocol: a stop kills the process and the conversation resumes
//   in a fresh one with `--conversation <id>`.
// - `agy models` prints one `<id>\t<display name>` line per model after a banner; the reasoning
//   effort is part of the id. The model is fixed per process (`--model`), so changing it means a
//   fresh process on the same conversation.
// - MCP servers come only from the CLI's own global config (`agy mcp add`); a process cannot be
//   given one of its own. So the app's tools are registered there once, at a URL every chat
//   shares, and the app works out which chat is calling from the turn that is running.
// Verified live against agy 1.2.17 on 2026-10-05:
// - MCP tools are not in the model's prompt. `init.tools` lists only the CLI's own tools; the
//   model reaches an MCP tool through `call_mcp_tool {ServerName, ToolName, Arguments}` and, told
//   nothing, first spends several steps reading the schema files the CLI keeps under
//   ~/.gemini/antigravity-cli/mcp/<server>/. So a new conversation's first message opens with
//   the app's tools and how to call them (`toolBrief`).
// - Thinking is never in the stream. A step that was only thinking arrives as one `agent_response`
//   with state DONE, no `text_delta`, and a `usage.thinking_tokens` count; there is no text to show.
// - Step types seen: `user_input`, `agent_response`, `tool`.
// - A step's `usage` has been seen carrying only `thinking_tokens`; with no input or context count
//   on record, Antigravity turns carry no token reading yet.
// The CLI owns its conversation store, so missed turns ride at the head of the message.
// `prepare` starts the process while the message is still being typed, and keeps one spare for
// the next new chat, so a first message (or the one after a stop) does not wait on the spawn.

const execFileAsync = promisify(execFile)
const IDLE_RETIRE_MS = 15 * 60_000
/** Processes kept waiting with no turn running. */
const MAX_IDLE_PROCESSES = 3
/** The key the spare process is held under until a new chat takes it. */
const SPARE = ''

function agyBinary(): string {
  const installed = join(homedir(), '.local', 'bin', 'agy')
  return existsSync(installed) ? installed : 'agy'
}

type RunningTurn = {
  request: RunRequest
  sink: TurnSink
  translator: StepTranslator
  sawEvent: boolean
  stopped: boolean
  finish: (result: RunResult) => void
}

class AgyProcess {
  private readonly child: ChildProcess
  private buffer = ''
  private stderrTail = ''
  private idleTimer: NodeJS.Timeout | null = null
  exited = false
  /** The CLI itself could not be started, which says nothing about its conversations. */
  spawnFailed = false
  turn: RunningTurn | null = null

  constructor(
    readonly cwd: string,
    public conversationId: string | null,
    readonly model: string | null,
    private readonly onEvent: (event: Record<string, unknown>) => void,
    private readonly onExit: (detail: string) => void
  ) {
    const args = [
      '--print=',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--print-timeout', '60m',
      ...(model ? ['--model', model] : []),
      ...(conversationId ? ['--conversation', conversationId] : []),
      '--add-dir', cwd
    ]
    this.child = spawn(agyBinary(), args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], ...ownProcessGroup() })
    trackProcessGroup(this.child)
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.read(chunk))
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2_000) })
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      this.spawnFailed = true
      this.end(error.code === 'ENOENT' ? 'The Antigravity CLI (agy) was not found. Install it and sign in, then try again.' : error.message)
    })
    this.child.on('close', (code, signal) => {
      this.read('\n')
      const tail = oneLine(this.stderrTail, 300)
      this.end(tail || `Antigravity exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`)
    })
  }

  write(content: string): void {
    const stdin = this.child.stdin
    if (this.exited || !stdin || stdin.destroyed || !stdin.writable) throw new Error('Antigravity is not running')
    stdin.write(`${JSON.stringify({ event: 'user', message: { role: 'user', content } })}\n`)
  }

  armIdle(retire: () => void): void {
    this.disarmIdle()
    this.idleTimer = setTimeout(retire, IDLE_RETIRE_MS)
    this.idleTimer.unref?.()
  }

  disarmIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  kill(): void {
    this.disarmIdle()
    stopProcessGroup(this.child)
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) {
        try {
          this.onEvent(recordOf(JSON.parse(line)))
        } catch {
          // A non-JSON line is diagnostic noise, not a turn failure.
        }
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  private end(detail: string): void {
    if (this.exited) return
    this.exited = true
    this.disarmIdle()
    this.onExit(detail)
  }
}

export class AntigravityAdapter implements ProviderAdapter {
  readonly id = 'antigravity' as const
  private readonly processes = new Map<string, AgyProcess>()
  private registering: Promise<void> | null = null

  /** `serverName` is the entry in agy's MCP config; a second instance of the host needs its own. */
  constructor(private readonly tools: ToolEndpoint = null, private readonly serverName = TOOL_SERVER) {}

  async run(request: RunRequest, sink: TurnSink): Promise<RunResult> {
    await this.registerTools()
    return new Promise<RunResult>((resolve) => {
      let agy: AgyProcess
      try {
        agy = this.processFor(request.chatId, request)
      } catch (error) {
        resolve({ status: 'failed', error: messageOf(error) })
        return
      }
      agy.disarmIdle()
      const turn: RunningTurn = {
        request,
        sink,
        translator: new StepTranslator(request.turnId),
        sawEvent: false,
        stopped: false,
        finish: (result) => {
          if (agy.turn !== turn) return
          agy.turn = null
          if (!agy.exited) agy.armIdle(() => this.retire(agy))
          resolve(result)
        }
      }
      agy.turn = turn
      try {
        // A conversation that has not started has not been told about the app's tools.
        const brief = agy.conversationId === null && this.tools ? toolBrief(this.serverName, this.tools.list(request.chatId)) : ''
        const message = attachmentInput(withHandoff(request.handoff, request.text), request.attachments, false).text
        agy.write(brief ? `${brief}\n\n${message}` : message)
      } catch (error) {
        turn.finish({ status: 'failed', error: messageOf(error) })
      }
    })
  }

  async prepare(request: PrepareRequest): Promise<void> {
    await this.registerTools()
    const agy = this.processFor(request.chatId ?? SPARE, request)
    if (!agy.turn) agy.armIdle(() => this.retire(agy))
    const idle = [...this.processes.values()].filter((other) => !other.turn && other !== agy)
    for (const other of idle.slice(0, Math.max(0, idle.length + 1 - MAX_IDLE_PROCESSES))) this.retire(other)
  }

  async stop(chatId: string): Promise<void> {
    const agy = this.processes.get(chatId)
    if (!agy?.turn) return
    agy.turn.stopped = true
    this.retire(agy)
  }

  forget(chatId: string): void {
    const agy = this.processes.get(chatId)
    if (agy) this.retire(agy)
  }

  async usage(): Promise<UsageSnapshot> {
    try {
      const { stdout } = await execFileAsync(agyBinary(), ['-p', '/quota', '--output-format', 'json'], {
        cwd: homedir(), timeout: 30_000, maxBuffer: 1_000_000
      })
      const parsed = antigravityUsage(JSON.parse(stdout))
      if (!parsed) return unavailableUsage('antigravity', 'The agy CLI did not report subscription usage.')
      return { provider: 'antigravity', account: null, plan: parsed.plan, windows: parsed.windows, note: parsed.note, unavailable: null, updatedAt: Date.now() }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return unavailableUsage('antigravity', code === 'ENOENT' ? 'The Antigravity CLI (agy) is not installed.' : 'Could not read usage from the agy CLI.')
    }
  }

  async models(): Promise<ModelInfo[]> {
    const { stdout } = await execFileAsync(agyBinary(), ['models'], { cwd: homedir(), timeout: 30_000, maxBuffer: 1_000_000 })
    const models: ModelInfo[] = []
    for (const line of stdout.split('\n')) {
      const match = /^([a-z0-9][a-z0-9.-]*)\t(.+)$/i.exec(line.trim())
      if (match) models.push({ id: match[1]!, label: match[2]!.trim(), description: '', isDefault: false })
    }
    return models
  }

  shutdown(): void {
    for (const agy of this.processes.values()) agy.kill()
    this.processes.clear()
  }

  /**
   * Point agy's MCP config at the app's tools, before the first process starts. Done once per
   * run, and only written when the URL there is not already this one. A failure leaves agy
   * without the app's tools and is not an error for the turn.
   */
  private registerTools(): Promise<void> {
    if (!this.tools) return Promise.resolve()
    const url = this.tools.url('antigravity', SHARED)
    this.registering ??= (async () => {
      const options = { cwd: homedir(), timeout: 30_000, maxBuffer: 1_000_000 }
      const { stdout } = await execFileAsync(agyBinary(), ['mcp', 'list'], options)
      const listed = stdout.split('\n').some((line) => {
        const columns = line.trim().split(/\s+/)
        return columns[0] === this.serverName && columns.includes(url)
      })
      if (!listed) await execFileAsync(agyBinary(), ['mcp', 'add', this.serverName, url], options)
    })().catch(() => {})
    return this.registering
  }

  /** Take the app's tools back out of agy's config. */
  async unregisterTools(): Promise<void> {
    await execFileAsync(agyBinary(), ['mcp', 'remove', this.serverName], { cwd: homedir(), timeout: 30_000 }).catch(() => {})
  }

  /** The live process for a chat (or the spare, under `SPARE`), started if there is none. */
  private processFor(key: string, request: Pick<PrepareRequest, 'cwd' | 'sessionId' | 'model'>): AgyProcess {
    const existing = this.processes.get(key)
    // The spare belongs to no chat yet, so the folder it was started in has to match too.
    if (existing && !existing.exited && existing.model === request.model && (key !== SPARE || existing.cwd === request.cwd)) {
      return this.hold(key, existing)
    }
    // A different model needs a new process; it picks the conversation up where the old one left it.
    if (existing) this.retire(existing)
    const conversationId = (key === SPARE ? null : existing?.conversationId) ?? request.sessionId
    const spare = this.processes.get(SPARE)
    if (key !== SPARE && conversationId === null && spare && !spare.exited && !spare.turn
      && spare.model === request.model && spare.cwd === request.cwd) {
      // A new chat takes the process that was warmed for it.
      this.processes.delete(SPARE)
      return this.hold(key, spare)
    }
    const agy: AgyProcess = new AgyProcess(
      request.cwd,
      conversationId,
      request.model,
      (event) => this.onEvent(agy, event),
      (detail) => this.onExit(agy, detail)
    )
    return this.hold(key, agy)
  }

  /** File a process under its key as the most recently wanted one. */
  private hold(key: string, agy: AgyProcess): AgyProcess {
    this.processes.delete(key)
    this.processes.set(key, agy)
    return agy
  }

  private release(agy: AgyProcess): void {
    for (const [key, held] of this.processes) if (held === agy) this.processes.delete(key)
  }

  private retire(agy: AgyProcess): void {
    this.release(agy)
    agy.kill()
  }

  private onEvent(agy: AgyProcess, event: Record<string, unknown>): void {
    const turn = agy.turn
    if (!turn) return
    turn.sawEvent = true
    const out = turn.translator.handle(event)
    if (out.conversationId) {
      agy.conversationId = out.conversationId
      turn.sink.session(out.conversationId)
    }
    if (out.model ?? agy.model) turn.sink.model(out.model ?? agy.model!)
    for (const op of out.ops) {
      if (op.type === 'item') turn.sink.item(op.item)
      else turn.sink.delta(op.itemId, op.delta)
    }
    if (out.end) turn.finish(out.end)
  }

  private onExit(agy: AgyProcess, detail: string): void {
    this.release(agy)
    const turn = agy.turn
    if (!turn) return
    for (const item of turn.translator.finish()) turn.sink.item(item)
    if (turn.stopped) turn.finish({ status: 'interrupted' })
    // Exiting before a single event, when asked to continue a conversation, means the CLI no
    // longer has that conversation.
    else if (!turn.sawEvent && agy.conversationId && !agy.spawnFailed) turn.finish({ status: 'failed', sessionLost: true })
    else turn.finish({ status: 'failed', error: detail })
  }
}

/**
 * What a new conversation is told about the app's tools, since agy leaves MCP tools out of the
 * prompt: each tool's description and arguments, and the one call that reaches them.
 */
export function toolBrief(serverName: string, tools: ToolBrief[]): string {
  if (tools.length === 0) return ''
  const blocks = tools.map((tool) => {
    const schema = recordOf(tool.inputSchema)
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const args = Object.entries(recordOf(schema.properties)).map(([name, value]) => {
      const property = recordOf(value)
      const choices = Array.isArray(property.enum) ? property.enum.map((choice) => JSON.stringify(choice)).join(' | ') : ''
      const type = choices || stringOf(property.type) || 'any'
      const description = stringOf(property.description)
      return `  - ${name} (${type}${required.has(name) ? ', required' : ''})${description ? `: ${description}` : ''}`
    })
    return [`## ${tool.name}`, tool.description.trim(), args.length ? `Arguments:\n${args.join('\n')}` : 'No arguments.'].join('\n')
  })
  return [
    '<app-tools>',
    `This app serves the tools below on the MCP server "${serverName}". Call one with call_mcp_tool, giving ServerName "${serverName}", ToolName as named here and Arguments as described. This is the whole list with every argument, so do not look the tools or their schema files up first.`,
    '',
    blocks.join('\n\n'),
    '</app-tools>'
  ].join('\n')
}

type Op = { type: 'item'; item: Item } | { type: 'delta'; itemId: string; delta: string }
type ToolItem = Extract<Item, { type: 'tool' }>
type Translation = { ops: Op[]; conversationId?: string; model?: string; end?: RunResult }

const INTERRUPTED = new Set(['CANCELED', 'CANCELLED', 'INTERRUPTED'])

/** Pure translation from one turn's `agy` stream-json events to transcript operations. */
export class StepTranslator {
  private readonly tools = new Map<number, ToolItem>()
  private readonly texts = new Map<number, string>()
  private lastText: { id: string; text: string } | null = null
  private settled = false

  constructor(private readonly turnId: string) {}

  handle(event: Record<string, unknown>): Translation {
    const conversation = typeof event.conversation_id === 'string' ? { conversationId: event.conversation_id } : {}
    switch (event.event) {
      case 'init': {
        const model = stringOf(recordOf(event.init).model)
        return { ops: [], ...conversation, ...(model ? { model } : {}) }
      }
      case 'step_update': {
        const step = recordOf(event.step_update)
        const id = typeof step.conversation_id === 'string' ? { conversationId: step.conversation_id } : conversation
        return { ops: this.step(step), ...id }
      }
      case 'result':
        return { ...this.result(recordOf(event.result)), ...conversation }
      default:
        return { ops: [] }
    }
  }

  /** Close every tool still running and settle the last text when the turn ends. */
  finish(): Item[] {
    if (this.settled) return []
    this.settled = true
    const items: Item[] = []
    for (const [index, tool] of this.tools) {
      if (tool.status !== 'running') continue
      const closed: ToolItem = { ...tool, status: 'failed', output: 'The turn ended before this call reported a result.' }
      this.tools.set(index, closed)
      items.push(closed)
    }
    if (this.lastText) items.push(this.assistant(this.lastText.id, this.lastText.text, false))
    return items
  }

  private step(step: Record<string, unknown>): Op[] {
    const index = typeof step.step_index === 'number' ? step.step_index : -1
    if (index < 0) return []
    if (step.step_type === 'agent_response') return this.text(index, step)
    if (step.step_type === 'tool') return this.tool(index, step)
    return []
  }

  private text(index: number, step: Record<string, unknown>): Op[] {
    const delta = stringOf(step.text_delta)
    const done = step.state === 'DONE'
    const known = this.texts.has(index)
    if (!delta && !known) return []
    const id = itemId(this.turnId, `s${index}`)
    const text = (this.texts.get(index) ?? '') + delta
    this.texts.set(index, text)
    this.lastText = { id, text }
    if (!known) return [{ type: 'item', item: this.assistant(id, text, !done) }]
    const ops: Op[] = delta ? [{ type: 'delta', itemId: id, delta }] : []
    if (done) ops.push({ type: 'item', item: this.assistant(id, text, false) })
    return ops
  }

  private tool(index: number, step: Record<string, unknown>): Op[] {
    const info = recordOf(step.tool_info)
    const name = stringOf(step.tool_name) || stringOf(info.name) || 'tool'
    const parameters = recordOf(info.parameters)
    const ops: Op[] = []
    let item = this.tools.get(index)
    if (!item) {
      item = { type: 'tool', id: itemId(this.turnId, `s${index}`), turnId: this.turnId, status: 'running', output: '', ...describeStep(name, parameters) }
      this.tools.set(index, item)
      ops.push({ type: 'item', item })
    }
    if (item.status !== 'running' || (step.state !== 'DONE' && step.state !== 'ERROR')) return ops
    const failed = step.state === 'ERROR'
    const error = typeof info.error === 'string' ? info.error : stringOf(recordOf(info.error).message)
    item = { ...item, status: failed ? 'failed' : 'done', output: clipOutput(stringOf(info.output) || (failed ? error || 'The tool call failed' : '')) }
    this.tools.set(index, item)
    ops.push({ type: 'item', item })
    return ops
  }

  private result(result: Record<string, unknown>): Translation {
    const status = stringOf(result.status) || 'SUCCESS'
    const response = stringOf(result.response)
    const ops: Op[] = this.finish().map((item) => ({ type: 'item', item }))
    if (INTERRUPTED.has(status)) return { ops, end: { status: 'interrupted' } }
    if (status !== 'SUCCESS') {
      return { ops, end: { status: 'failed', error: stringOf(result.error) || `Antigravity turn ended: ${status.toLowerCase()}` } }
    }
    // Trust `response` over a delta stream that came up short.
    if (response.trim()) {
      if (!this.lastText) ops.push({ type: 'item', item: this.assistant(itemId(this.turnId, 'final'), response, false) })
      else if (this.lastText.text.trim() !== response.trim() && this.lastText.text.length < response.length) {
        ops.push({ type: 'item', item: this.assistant(this.lastText.id, response, false) })
      }
    }
    return { ops, end: { status: 'completed' } }
  }

  private assistant(id: string, text: string, streaming: boolean): Item {
    return { type: 'assistant', id, turnId: this.turnId, text, streaming }
  }
}

function describeStep(name: string, parameters: Record<string, unknown>): { kind: ToolKind; label: string } {
  const text = (...keys: string[]): string => keys.map((key) => stringOf(parameters[key])).find(Boolean) ?? ''
  if (/command|shell|terminal|bash/i.test(name)) return { kind: 'command', label: text('CommandLine', 'command', 'cmd') || name }
  if (/write|edit|replace|create|patch/i.test(name)) return { kind: 'edit', label: text('TargetFile', 'AbsolutePath', 'path', 'file_path') || name }
  if (/view|read|list_dir|outline/i.test(name)) return { kind: 'read', label: text('AbsolutePath', 'DirectoryPath', 'path', 'file_path') || name }
  if (/grep|find|search_dir|codebase/i.test(name)) return { kind: 'search', label: text('Query', 'Pattern', 'query', 'pattern') || name }
  if (/web|url|browser/i.test(name)) return { kind: 'web', label: text('Url', 'url', 'query', 'Query') || name }
  const args = jsonPreview(parameters, 120)
  return { kind: /^mcp_/.test(name) ? 'mcp' : 'other', label: args && args !== '{}' ? `${name} ${args}` : name }
}

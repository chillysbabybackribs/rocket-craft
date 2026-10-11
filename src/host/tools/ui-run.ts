import { existsSync, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import type { UiRunRequest } from '../../shared/types.ts'
import { repoRoot } from '../git.ts'
import { recordOf, stringOf } from '../json.ts'
import { SHELL_UI_TOOL_NOTE } from '../agent-situation.ts'
import { failureResult, textResult, type Tool, type ToolContent, type ToolResult, type ToolFailure } from './registry.ts'

// The supervisor is plain Node on a private display. Keep it outside Electron's bundle so
// Playwright and script workers use their own process, while the host owns their entire tree.
type RunCommand = (command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onOutput: (data: Buffer) => void; onStart: (child: ChildProcess) => void; cleanupOnExit: boolean
}) => Promise<number>
type Session = {
  directory: string
  controller: AbortController
  child?: ChildProcess
  ready: Promise<void>
  completion: Promise<void>
  pending: Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>
  idle?: NodeJS.Timeout
  busy: boolean
  seq: number
  releaseUiSlot?: () => Promise<void>
}

const DESCRIPTION = `${SHELL_UI_TOOL_NOTE}

Interact with the LIVE Craft Studio window the user is using. target defaults to "live": clicks, drafts, new chats and browser interactions affect the current app. Await every action. Live calls attach to the existing window, never build or launch another app. Only one live script runs at a time across chats. Timeout stops the script and disconnects the automation client; completed actions remain and Craft Studio stays open.
Use target="isolated" explicitly for regression testing: its first call builds current source into a private app folder, with a fresh profile, scratch workspace, controlled providers, local browser fixture and private display. Later isolated calls reuse this chat's session. Only isolated calls accept reset=true, build=false or close=true and support ui.request(), ui.release(), ui.restart().
code is the body of an async function. Await every action. page is the app shell:
For example, to read the orchestrator composer: return await ui.pane(0).getByRole('textbox', {name:'Message'}).inputValue().
The orchestrator column is pane 0, and an expanded worker has its own textbox on the board (getByTestId('worker-expanded')), so scope the column's actions with ui.pane(0) instead of matching conversation text or unscoped Message textboxes.
Locators support getByRole, getByText, getByLabel, getByPlaceholder, getByTestId, locator, filter({hasText}), nth, first, last; actions click, dblclick, fill, press, pressSequentially, hover, check, uncheck, selectOption, scrollIntoViewIfNeeded, waitFor({state:'visible'|'hidden'}); reads count, isVisible, isEnabled, textContent, innerText, inputValue, getAttribute, boundingBox. Use string names/text (not RegExp) in locator options.
page.evaluate(fn,arg) and page.waitForFunction(fn,arg,options) inspect DOM; do not mutate app state to manufacture a passing UI. page.keyboard.press/type, page.title(), page.url() are available.
ui.surface('browser'|'suggestions') returns the same page API for visible native views; ui.resize(width,height); ui.read() returns visible shell controls and panels; ui.snapshot() returns capture metadata and includes the images in the tool result. In isolated mode only: ui.request() reads the latest controlled turn; ui.release() completes a held stream or plan; ui.restart() restarts the same profile and build. sleep(ms) and console.log exist.
For target="isolated", choose the scratch working folder using the normal folder button before sending UI check: stream, stop, recover, fail, ask, plan, edit or work. Stream/plan wait for ui.release(); ordinary prompts fail because providers are controlled.
Results include images by default, saved paths, logs and instance identity. capture=false skips the automatic final image; failures still capture. Isolated sessions close on timeout and expire after ten idle minutes. Live scripts use the running app's current build; source edits require restarting Craft Studio.`

/** Keep tool metadata valid JSON even when several verbose snapshots exceed the text budget. */
export function uiRunResult(response: Record<string, unknown>, directory: string): ToolResult {
  const captures = Array.isArray(response.captures) ? response.captures : []
  const images: ToolContent[] = captures.flatMap(raw => {
    const content = recordOf(raw).content
    return Array.isArray(content) ? content as ToolContent[] : []
  })
  const metadata = { ...response, captures: captures.map(capture => recordOf(recordOf(capture).metadata)) }
  const fullResult = join(directory, `run-${response.id}.json`)
  if (JSON.stringify(metadata).length > 12_000) {
    metadata.captures = metadata.captures.map(capture => ({
      ...capture,
      shell: { ...recordOf(capture.shell), controls: [], controlsTruncated: true, controlsSavedIn: join(stringOf(capture.directory), 'snapshot.json') }
    }))
    Object.assign(metadata, { fullResult })
  }
  if (JSON.stringify(metadata).length > 16_000) {
    Object.assign(metadata, {
      value: { truncated: true, preview: JSON.stringify(response.value ?? null).slice(0, 4000), fullResult },
      logs: [JSON.stringify(response.logs ?? []).slice(0, 2000)],
      errors: [JSON.stringify(response.errors ?? []).slice(0, 2000)],
      fullResult
    })
  }
  const code = stringOf(response.errorCode) || (response.timedOut ? 'SCRIPT_TIMEOUT' : 'UI_RUN_FAILED')
  const origin = (stringOf(response.errorOrigin) || 'runner') as ToolFailure['origin']
  return { content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }, ...images], ...(response.ok ? {} : { isError: true, structuredContent: { error: { code, origin, message: stringOf(response.error) || 'UI inspection failed.' } } }) }
}

export function rocketSourceRoot(): string {
  const candidates = [process.env.CRAFT_UI_SOURCE_ROOT, resolve(import.meta.dirname, '../..'), resolve(import.meta.dirname, '../../..')]
  const root = candidates.find(candidate => candidate && existsSync(join(candidate, 'scripts/ui-runner.mjs')))
  return root ?? resolve(import.meta.dirname, '../..')
}

/**
 * Where an isolated session builds from: the calling chat's repository root, so a worker in a
 * worktree tests its own code, or the host's source root when that folder has no UI runner.
 */
export async function buildRoot(cwd: string | null, fallback: string): Promise<string> {
  const top = cwd ? await repoRoot(cwd).catch(() => null) : null
  return top && existsSync(join(top, 'scripts/ui-runner.mjs')) ? top : fallback
}

export class UiRunManager {
  private readonly sessions = new Map<string, Session>()
  private readonly active = new Set<string>()
  private readonly cancelledStarts = new Set<string>()
  private stopping = false

  constructor(private readonly root: string, private readonly output = join(root, '.artifacts/ui-run'), private readonly live?: (args: Record<string, unknown>, chatId: string | null) => Promise<ToolResult>, private readonly cwdOf?: (chatId: string) => string | null) {}

  tools(): Tool[] {
    return [{
      name: 'studio_ui_run', description: DESCRIPTION,
      inputSchema: {
        type: 'object', properties: {
          target: { type: 'string', enum: ['live', 'isolated'], description: 'Default live: operate on the user’s current Craft Studio window. Use isolated explicitly for testing.' },
          code: { type: 'string', description: 'Body of an async function using page, ui, sleep and console.' },
          reset: { type: 'boolean', description: 'Isolated only: discard the session and start fresh, rebuilding by default.' },
          build: { type: 'boolean', description: 'Isolated only: build current source for a new session. Default true; false uses existing out/.' },
          close: { type: 'boolean', description: 'Isolated only: close this chat’s inspection session.' },
          capture: { type: 'boolean', description: 'Include a final snapshot. Default true; failures always capture.' },
          timeout: { type: 'number', minimum: 1, maximum: 120, description: 'Script timeout in seconds, default 30. Initial build/startup has its own deadline.' }
        }, additionalProperties: false
      },
      run: (args, context) => {
        if (args.target === 'isolated') return this.run(args, context.chatId)
        if (args.target !== undefined && args.target !== 'live') return Promise.resolve(failureResult('INVALID_ARGUMENT', 'Choose target="live" or target="isolated".'))
        if (!this.live) return Promise.resolve({ ...textResult('Live UI control is unavailable. Restart Craft Studio to load the live runner.'), isError: true })
        return this.live(args, context.chatId)
      }
    }]
  }

  async run(args: Record<string, unknown>, chatId: string | null): Promise<ToolResult> {
    if (chatId && this.active.has(chatId) && !args.close) return { ...textResult('This chat already has a UI script running. Wait for it to finish before making another call.'), isError: true }
    if (!args.close && chatId) this.active.add(chatId)
    try { return await this.execute(args, chatId) }
    catch (error) {
      if (chatId) await this.close(chatId)
      return { ...textResult(error instanceof Error ? error.message : String(error)), isError: true }
    } finally { if (!args.close && chatId) this.active.delete(chatId) }
  }

  private async execute(args: Record<string, unknown>, chatId: string | null): Promise<ToolResult> {
    if (!chatId) return { ...textResult('This call has no chat identity. Run studio_ui_run from a Craft Studio chat.'), isError: true }
    if (this.stopping) return { ...textResult('Craft Studio is closing. Restart the app before inspecting its UI.'), isError: true }
    if (args.close && (args.reset || stringOf(args.code).trim())) return { ...textResult('Use close by itself, or run a script without close.'), isError: true }
    if (!args.close && !stringOf(args.code).trim()) return { ...textResult('Provide code to run in the isolated app, or close=true to end the session.'), isError: true }
    if (args.timeout !== undefined && (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout) || args.timeout < 1 || args.timeout > 120)) return { ...textResult('Use a script timeout between 1 and 120 seconds.'), isError: true }
    if (this.sessions.get(chatId)?.busy && !args.close) return { ...textResult('This chat already has a UI script running. Wait for it to finish before making another call.'), isError: true }
    if (args.close) {
      if (this.active.has(chatId) && !this.sessions.has(chatId)) this.cancelledStarts.add(chatId)
      await this.close(chatId)
      return textResult('The isolated UI session is closed. Captures and traces remain in .artifacts/ui-run/.')
    }
    if (args.reset) await this.close(chatId)
    if (!this.sessions.has(chatId)) {
      const reserved = new Set([...this.sessions.keys(), ...this.active])
      if (reserved.size > 4) return { ...textResult('Four isolated UI sessions are open. Close an unused session before starting another.'), isError: true }
      await this.start(chatId, args.build !== false, await buildRoot(this.cwdOf?.(chatId) ?? null, this.root))
    }
    const session = this.sessions.get(chatId)!
    session.busy = true
    clearTimeout(session.idle)
    try {
      await session.ready
      const response = await this.request(session, { code: stringOf(args.code), timeout: typeof args.timeout === 'number' ? args.timeout : 30, capture: args.capture !== false }, (Number(args.timeout) || 30) * 1000 + 20_000)
      if (recordOf(response.session).open === false) await this.close(chatId)
      return uiRunResult(response, session.directory)
    } catch (error) {
      await this.close(chatId)
      return { ...textResult(`${error instanceof Error ? error.message : String(error)}\nRunner log: ${join(session.directory, 'runner.log')}`), isError: true }
    } finally {
      session.busy = false
      if (this.sessions.get(chatId) === session) {
        session.idle = setTimeout(() => { void this.close(chatId) }, 10 * 60_000)
        session.idle.unref()
      }
    }
  }

  private async start(chatId: string, build: boolean, root: string): Promise<void> {
    if (!existsSync(join(root, 'scripts/ui-runner.mjs'))) throw new Error('Craft Studio’s UI runner source is missing. Run this tool from a development installation of Craft Studio.')
    const slots = await import(pathToFileURL(join(this.root, 'scripts/ui-slots.mjs')).href) as {
      acquireUiSlots: (options?: { exclusive?: boolean }) => Promise<{ release: () => Promise<void> }>
    }
    // An app under a UI check already runs inside that check's slots, often all of them, so
    // waiting for another would never end.
    const slotLock = process.env.CRAFT_UI_TEST === '1' ? { release: async () => {} } : await slots.acquireUiSlots({ exclusive: false })
    let slotReleased = false
    const releaseSlot = async (): Promise<void> => {
      if (slotReleased) return
      slotReleased = true
      await slotLock.release()
    }
    const module = await import(pathToFileURL(join(this.root, 'scripts/ui-process.mjs')).href) as { runCommand: RunCommand }
    await mkdir(this.output, { recursive: true })
    const directory = await mkdtemp(join(this.output, `${new Date().toISOString().replace(/[:.]/g, '-')}-`))
    if (this.stopping || this.cancelledStarts.delete(chatId)) {
      await releaseSlot()
      throw new Error('The isolated UI session was closed before startup.')
    }
    let readyResolve!: () => void, readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    // Startup errors may arrive before run() starts awaiting this promise.
    void ready.catch(() => {})
    const session: Session = { directory, controller: new AbortController(), ready, completion: Promise.resolve(), pending: new Map(), busy: true, seq: 0, releaseUiSlot: releaseSlot }
    this.sessions.set(chatId, session)
    const log = createWriteStream(join(directory, 'runner.log'))
    const timer = setTimeout(() => { readyReject(new Error('The isolated UI build or startup timed out.')); session.controller.abort() }, 180_000)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      readyReject(error)
      for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
      session.pending.clear()
    }
    let buffer = ''
    session.completion = module.runCommand('xvfb-run', ['-a', '--server-args=-screen 0 2560x1600x24', process.execPath, join(root, 'scripts/ui-runner.mjs'), root, directory, build ? 'build' : 'existing'], {
      cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal: session.controller.signal, onOutput: () => {}, cleanupOnExit: true,
      onStart: child => {
        session.child = child
        child.stdin?.on('error', error => fail(error))
        child.stderr?.on('data', data => log.write(data))
        child.stdout?.on('data', data => {
          buffer += String(data)
          let end: number
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
            try {
              const message = recordOf(JSON.parse(line))
              if (message.type === 'ready') { clearTimeout(timer); readyResolve() }
              else if (message.type === 'startupError') fail(new Error(stringOf(message.error)))
              else {
                const id = Number(message.id), pending = session.pending.get(id)
                if (pending) { session.pending.delete(id); clearTimeout(pending.timer); pending.resolve(message) }
              }
            } catch { log.write(`${line}\n`) }
          }
        })
      }
    }).then(status => { fail(new Error(`The isolated UI runner exited (${status}).`)) }, error => { fail(error) }).finally(() => log.end())
  }

  private request(session: Session, params: Omit<UiRunRequest, 'id'>, timeout: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++session.seq
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error('The isolated UI runner did not answer in time.')) }, timeout)
      session.pending.set(id, { resolve, reject, timer })
      session.child?.stdin?.write(`${JSON.stringify({ id, ...params })}\n`)
    })
  }

  async close(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId)
    if (!session) return
    this.sessions.delete(chatId)
    clearTimeout(session.idle)
    await session.releaseUiSlot?.()
    if (session.child?.stdin?.writable && !session.busy) {
      await this.request(session, { close: true }, 10_000).catch(() => {})
    }
    session.controller.abort()
    await session.completion
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    await Promise.all([...this.sessions.keys()].map(chatId => this.close(chatId)))
  }
}

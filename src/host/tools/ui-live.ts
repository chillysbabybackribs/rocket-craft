import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Browser, Page } from 'playwright'
import type { LiveUiConnection, MainAgentOp, UiSnapshot } from '../../shared/types.ts'
import { recordOf, stringOf } from '../json.ts'
import { failureResult, type ToolResult } from './registry.ts'
import { uiRunResult } from './ui-run.ts'

const LOCATORS = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'locator', 'filter', 'nth', 'first', 'last'])
const ACTIONS = new Set(['click', 'dblclick', 'fill', 'press', 'pressSequentially', 'hover', 'check', 'uncheck', 'selectOption', 'scrollIntoViewIfNeeded', 'waitFor', 'count', 'isVisible', 'isEnabled', 'textContent', 'innerText', 'inputValue', 'getAttribute', 'boundingBox'])
type Capture = { metadata: Record<string, unknown>; content: ToolResult['content'] }

// This client connects to the running Electron app, never launches a replacement. Only one
// live script runs at a time across all chats; worker termination cannot close the live window.
export class LiveUiRunner {
  private busy = false
  private stopping = false
  private worker: Worker | null = null
  private browser: Browser | null = null

  constructor(private readonly root: string, private readonly output: string, private readonly main: (op: MainAgentOp) => Promise<unknown>) {}

  async run(args: Record<string, unknown>, _chatId: string | null): Promise<ToolResult> {
    if (this.stopping) return failureResult('TARGET_UNAVAILABLE', 'Craft Studio is closing. Restart it before running UI actions.', 'runner')
    if (this.busy) return failureResult('UI_BUSY', 'Another live UI script is running. Wait for it to finish before interacting with the shared window.', 'runner')
    if (['build', 'reset', 'close'].some(key => args[key] !== undefined)) return failureResult('INVALID_ARGUMENT', 'build, reset and close belong to target="isolated". Live UI actions use the app you already have open.')
    const code = stringOf(args.code)
    if (!code.trim()) return failureResult('INVALID_ARGUMENT', 'Provide code to run against the live Craft Studio window.')
    const timeout = args.timeout ?? 30
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1 || timeout > 120) return failureResult('INVALID_ARGUMENT', 'Use a script timeout between 1 and 120 seconds.')
    this.busy = true
    let cancelled = false
    let directory = this.output
    const captures: Capture[] = [], logs: string[] = []
    let connection: LiveUiConnection | undefined
    try {
      await mkdir(this.output, { recursive: true })
      directory = await mkdtemp(join(this.output, `${new Date().toISOString().replace(/[:.]/g, '-')}-`))
      connection = await this.main({ op: 'uiConnection' }) as LiveUiConnection
      const { chromium } = createRequire(join(this.root, 'package.json'))('playwright') as typeof import('playwright')
      const browser = this.browser = await chromium.connectOverCDP(connection.endpoint, { timeout: 10_000, noDefaults: true })
      const ids = new WeakMap<Page, string>()
      const surface = async (kind: string): Promise<Page> => {
        if (!['shell', 'browser', 'suggestions'].includes(kind)) throw new Error('Choose shell, browser or suggestions.')
        const info = await this.main({ op: 'uiConnection' }) as LiveUiConnection
        const id = info.surfaces[kind as keyof LiveUiConnection['surfaces']]
        if (!id) throw new Error(`The live ${kind} surface is not visible. Open it through the app UI first.`)
        // Showing a native view creates its Chromium target asynchronously. Wait for the
        // connected client to observe it, just as locator actions wait for new controls.
        const deadline = Date.now() + 10_000
        while (!cancelled && Date.now() < deadline) {
          for (const context of browser.contexts()) for (const page of context.pages()) {
            if (page.isClosed()) continue
            if (!ids.has(page)) {
              const cdp = await context.newCDPSession(page)
              try { ids.set(page, (await cdp.send('Target.getTargetInfo')).targetInfo.targetId) }
              finally { await cdp.detach() }
            }
            if (ids.get(page) === id) return page
          }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error(`The live ${kind} page is not ready. Try again after it loads.`)
      }
      const capture = async (): Promise<Record<string, unknown>> => {
        const { images, ...details } = await this.main({ op: 'uiSnapshot' }) as UiSnapshot
        const metadata = { ...details, images: images.map(({ base64: _base64, ...image }) => image) }
        captures.push({ metadata, content: images.flatMap(image => [
          { type: 'text' as const, text: image.label },
          { type: 'image' as const, data: image.base64, mimeType: image.mimeType }
        ]) })
        return metadata
      }
      const operate = async (op: Record<string, unknown>): Promise<unknown> => {
        if (cancelled) throw new Error('The live UI script was stopped.')
        if (op.type === 'snapshot') {
          if (captures.length >= 5) throw new Error('Use at most five explicit snapshots per script.')
          return capture()
        }
        if (op.type === 'read') return (await this.main({ op: 'uiSnapshot' }) as UiSnapshot).shell
        if (op.type === 'resize') return this.main({ op: 'uiResize', width: Number(op.width), height: Number(op.height) })
        if (['request', 'release', 'restart'].includes(stringOf(op.type))) throw new Error(`ui.${op.type}() is available only with target="isolated".`)
        const page = await surface(stringOf(op.surface) || 'shell')
        if (cancelled) throw new Error('The live UI script was stopped.')
        page.setDefaultTimeout(10_000)
        if (op.type === 'surface') return null
        if (op.type === 'page') {
          if (op.method === 'title') return page.title()
          if (op.method === 'url') return page.url()
          throw new Error('Unsupported page operation.')
        }
        if (op.type === 'keyboard') {
          if (op.method === 'press') return page.keyboard.press(stringOf(op.value))
          if (op.method === 'type') return page.keyboard.type(stringOf(op.value))
          throw new Error('Unsupported keyboard operation.')
        }
        if (op.type === 'waitForFunction') {
          const predicate = new Function(`return (${stringOf(op.expression)})`) as () => boolean
          const handle = await page.waitForFunction(predicate, undefined, recordOf(op.options))
          await handle.dispose()
          return null
        }
        let target: unknown = page
        const chain = Array.isArray(op.chain) ? op.chain : []
        for (const raw of chain) {
          const step = recordOf(raw), method = stringOf(step.method)
          if (!LOCATORS.has(method)) throw new Error('Unsupported locator operation.')
          target = (target as Record<string, (...args: unknown[]) => unknown>)[method](...(Array.isArray(step.args) ? step.args : []))
        }
        if (cancelled) throw new Error('The live UI script was stopped.')
        if (op.type === 'evaluate') {
          const fn = chain.length ? new Function(`return (${stringOf(op.expression)})`)() : new Function(`return (${stringOf(op.expression)})`)
          return (target as Page).evaluate(fn)
        }
        const method = stringOf(op.method)
        if (op.type !== 'locator' || !ACTIONS.has(method)) throw new Error('Unsupported live UI operation.')
        return (target as Record<string, (...args: unknown[]) => unknown>)[method](...(Array.isArray(op.args) ? op.args : []))
      }
      const worker = this.worker = new Worker(join(this.root, 'scripts/ui-run-worker.mjs'), { workerData: { code } })
      let operations = Promise.resolve()
      const outcome = await new Promise<Record<string, unknown>>(resolve => {
        let finished = false
        const finish = (value: Record<string, unknown>): void => { if (!finished) { finished = true; clearTimeout(timer); resolve(value) } }
        const timer = setTimeout(() => { cancelled = true; finish({ ok: false, timedOut: true, errorCode: 'SCRIPT_TIMEOUT', errorOrigin: 'runner', error: `The live UI script was stopped after ${timeout}s. Completed actions remain in the live app.` }) }, timeout * 1000)
        worker.on('message', raw => {
          const message = recordOf(raw)
          if (message.type === 'log') { if (logs.join('\n').length < 12_000) logs.push(stringOf(message.text).slice(0, 2000)) }
          else if (message.type === 'done') void operations.then(() => finish(message))
          else if (message.type === 'call') operations = operations.then(async () => {
            try { worker.postMessage({ id: message.id, ok: true, value: await operate(recordOf(message.op)) ?? null }) }
            catch (error) {
              const messageText = error instanceof Error ? error.message : String(error)
              const errorCode = error instanceof Error && error.name === 'TimeoutError' ? 'OPERATION_TIMEOUT' : messageText.includes('strict mode violation:') ? 'AMBIGUOUS_TARGET' : 'UI_OPERATION_FAILED'
              worker.postMessage({ id: message.id, ok: false, error: messageText, errorCode })
            }
          }).catch(() => {})
        })
        worker.on('error', error => finish({ ok: false, error: error.message }))
        worker.on('exit', code => finish({ ok: false, error: `The live UI script worker exited (${code}).` }))
      })
      cancelled = true
      await worker.terminate()
      this.worker = null
      // For a CDP-connected browser close() disconnects this client; it does not close Electron.
      await browser.close()
      this.browser = null
      if (args.capture !== false || !outcome.ok) {
        try { await capture() } catch (error) { logs.push(`Capture failed: ${error instanceof Error ? error.message : String(error)}`); if (outcome.ok) Object.assign(outcome, { ok: false, errorCode: 'CAPTURE_FAILED', errorOrigin: 'runner', error: error instanceof Error ? error.message : String(error) }) }
      }
      const response = { ...outcome, type: undefined, id: 1, target: 'live', session: { pid: connection.pid, open: true, directory }, logs, captures }
      await writeFile(join(directory, 'run-1.json'), JSON.stringify({ ...response, captures: captures.map(c => c.metadata) }, null, 2))
      return uiRunResult(response, directory)
    } catch (error) {
      return failureResult('UI_CONNECTION_FAILED', `Live UI interaction failed: ${error instanceof Error ? error.message : String(error)}`, 'runner')
    } finally {
      cancelled = true
      await this.worker?.terminate()
      this.worker = null
      await this.browser?.close().catch(() => {})
      this.browser = null
      this.busy = false
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    await this.worker?.terminate()
    await this.browser?.close().catch(() => {})
  }
}

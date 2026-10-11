import { test as base, expect } from '@playwright/test'
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const SPA_HTML = readFileSync(resolve('tests/fixtures/browser/spa.html'), 'utf8')
const SPA_RECORDS: Record<string, { name: string; note: string }> = {
  alpha: { name: 'Alpha Corp', note: 'ALPHA-42' },
  beta: { name: 'Beta LLC', note: 'BETA-99' }
}
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

type Request = { turnId: string; provider: string; model: string | null; sessionId: string | null; cwd: string; handoffTurns: number }
type Studio = {
  app: ElectronApplication
  page: Page
  profile: string
  workspace: string
  origin: string
  surface: (kind: 'browser' | 'suggestions') => Promise<Page>
  request: () => Promise<Request>
  release: () => Promise<void>
  capture: (name: string) => Promise<void>
  restart: () => Promise<void>
  allowConsoleError: (pattern: RegExp) => void
}

export const test = base.extend<{ rocket: Studio; rocketEnv: Record<string, string> }>({
  // Settings a spec turns on with test.use({ rocketEnv }), applied over the isolated defaults.
  rocketEnv: [{}, { option: true }],
  rocket: async ({ rocketEnv }, use, info) => {
    const allowedConsoleErrors: RegExp[] = []
    const profile = info.outputPath('profile')
    const workspace = info.outputPath('workspace')
    await mkdir(profile, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(profile, 'ui-test-profile'), 'craft-ui-check-v1')
    const server = createServer((request, response) => {
      const path = request.url ? new URL(request.url, 'http://127.0.0.1').pathname : ''
      if (request.url === '/favicon.ico') { response.writeHead(204).end(); return }
      // Files served as attachments, and a page that links to one, for the download checks.
      if (request.url?.startsWith('/files/')) {
        const name = request.url.slice('/files/'.length).split('?')[0]!
        response.setHeader('Content-Type', name.endsWith('.pdf') ? 'application/pdf' : 'text/plain')
        response.setHeader('Content-Disposition', `attachment; filename="${name}"`)
        response.end(name.endsWith('.pdf') ? '%PDF-1.4 Craft Studio download check' : 'Craft Studio download check\n')
        return
      }
      if (request.url === '/downloads') {
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><title>Downloads</title><h1>Downloads</h1><a id="get" href="/files/notes.txt">Download notes</a>')
        return
      }
      if (path === '/spa' || path === '/spa/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(SPA_HTML)
        return
      }
      if (path.startsWith('/spa/api/records/')) {
        const id = path.slice('/spa/api/records/'.length).split('/')[0]!
        const row = SPA_RECORDS[id]
        response.setHeader('Content-Type', 'application/json')
        if (!row) {
          response.writeHead(404)
          response.end(JSON.stringify({ error: 'not found' }))
          return
        }
        response.end(JSON.stringify(row))
        return
      }
      // A long read, for hands-free reading.
      if (path === '/long') {
        const paragraph = '<p>The night train leaves at half past nine. The cabins are small, the sheets are real, and the blind has a gap at the bottom through which the fields go grey and then gold before breakfast.</p>'
        response.setHeader('Content-Type', 'text/html')
        response.end(`<!doctype html><title>A long read</title>
          <style>body{font:19px/1.7 Georgia,serif;max-width:640px;margin:40px auto;padding:0 24px;background:#fbfaf7;color:#26272b}</style>
          <h1>The slow return of the night train</h1>${paragraph.repeat(60)}<a href="/one">Next page</a>`)
        return
      }
      if (path !== '/one' && path !== '/two') {
        response.writeHead(404).end('Not found')
        return
      }
      const second = path === '/two'
      response.setHeader('Content-Type', 'text/html')
      response.end(`<!doctype html><title>UI page ${second ? 'two' : 'one'}</title>
        <style>body{font:20px system-ui;padding:24px;background:#eef3ff;color:#17264a}input,button{font:inherit;padding:8px}a{display:block;margin:24px 0}</style>
        <h1>Craft Studio browser check</h1><p>Local test page ${second ? 'two' : 'one'}</p>
        <a href="${second ? '/one' : '/two'}">Next page</a>
        <label>Test input <input aria-label="Test input"></label>
        <button onclick="document.getElementById('result').textContent='Clicked successfully'">Test button</button><p id="result">Ready</p>`)
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The local fixture server did not start.')
    const origin = `http://127.0.0.1:${address.port}`
    await writeFile(join(profile, 'browser-tabs.json'), JSON.stringify({ active: 0, tabs: [{ url: `${origin}/one`, title: 'UI page one', favicon: null, pinned: false }] }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    const noSandbox = env.CRAFT_NO_SANDBOX === '1'
    // Never inherit the parent app's profile, capture script, provider mode or Electron binary.
    for (const name of Object.keys(env)) {
      if (/^(CRAFT_|ROCKET_|ELECTRON_|__NV_PRIME_RENDER_OFFLOAD$|__GLX_VENDOR_LIBRARY_NAME$|__VK_LAYER_NV_optimus$)/.test(name)) delete env[name]
    }
    Object.assign(env, { NODE_ENV: 'test', CRAFT_UI_TEST: '1', CRAFT_USER_DATA: profile, CRAFT_AUTO_COMMIT: '0', CRAFT_SELF_CHECK: '1', CRAFT_UI_TEST_ORIGIN: origin }, rocketEnv)
    const errors: string[] = []
    const logs: string[] = []
    let app: ElectronApplication | undefined
    let tracing = false
    let generation = 0
    let page!: Page
    const launch = async (): Promise<void> => {
      app = await _electron.launch({
        executablePath: createRequire(import.meta.url)('electron') as string,
        args: [resolve('.'), ...(noSandbox ? ['--no-sandbox'] : [])],
        cwd: resolve('.'), env, timeout: 30_000
      })
      const application = app
      application.process().stdout?.on('data', data => logs.push(String(data)))
      application.process().stderr?.on('data', data => logs.push(String(data)))
      application.context().setDefaultTimeout(10_000)
      const watch = (page: Page): void => {
        page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`))
        page.on('crash', () => errors.push(`Renderer crashed: ${page.url()}`))
        page.on('console', message => {
          logs.push(`[${message.type()}] ${page.url()}: ${message.text()}\n`)
          if (message.type() === 'error') {
            const detail = `${page.url()}: ${message.text()}`
            if (!allowedConsoleErrors.some(pattern => pattern.test(detail))) errors.push(detail)
          }
        })
      }
      for (const page of application.context().pages()) watch(page)
      application.context().on('page', watch)
      await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
      tracing = true
      page = await application.firstWindow()
      await expect(page.getByRole('textbox', { name: 'Message', exact: true }).first()).toBeVisible()
      await application.evaluate(({ BrowserWindow, dialog }, workspace) => {
        BrowserWindow.getAllWindows()[0].setTitle('Craft Studio — UI check')
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] })
      }, workspace)
    }
    const close = async (): Promise<void> => {
      if (!app) return
      const closing = app
      try {
        if (tracing) {
          const path = info.outputPath(`trace-${generation++}.zip`)
          await closing.context().tracing.stop({ path }).then(() => info.attach('Trace', { path, contentType: 'application/zip' })).catch(error => logs.push(String(error)))
          tracing = false
        }
        await closing.close().catch(error => { errors.push(`Closing test app: ${String(error)}`); closing.process().kill('SIGKILL') })
      } finally { app = undefined }
    }
    try {
      await launch()
      const surface = async (kind: 'browser' | 'suggestions'): Promise<Page> => {
        const matches = (candidate: Page): boolean => kind === 'browser'
          ? candidate.url().startsWith(origin)
          : candidate.url().endsWith('/suggest.html')
        await expect.poll(() => app!.context().pages().some(matches)).toBe(true)
        return app!.context().pages().find(matches)!
      }
      const request = async (): Promise<Request> => JSON.parse(await readFile(join(profile, 'ui-request.json'), 'utf8')) as Request
      const capture = async (name: string): Promise<void> => {
        const shell = info.outputPath(`${name}-shell.png`)
        await page.screenshot({ path: shell })
        await info.attach(`${name}: app shell`, { path: shell, contentType: 'image/png' })
        const views = await app!.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0].contentView.children
          .filter(view => view instanceof WebContentsView && view.getVisible())
          .map(view => ({ url: (view as InstanceType<typeof WebContentsView>).webContents.getURL(), bounds: view.getBounds() })))
        await info.attach(`${name}: native view layout`, { body: JSON.stringify(views, null, 2), contentType: 'application/json' })
        for (const [index, view] of views.entries()) {
          const target = app!.context().pages().find(candidate => candidate.url() === view.url)
          if (!target || target === page) continue
          const path = info.outputPath(`${name}-view-${index}.png`)
          await target.screenshot({ path })
          await info.attach(`${name}: ${view.url}`, { path, contentType: 'image/png' })
        }
        // CDP screenshots omit sibling native views. On this Linux app, X11 can capture the
        // actual composed window; other environments still retain each surface and its bounds.
        try {
          if (!process.env.DISPLAY) throw new Error('No X11 display is available.')
          const id = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0))
          const path = info.outputPath(`${name}-window.png`)
          await promisify(execFile)('import', ['-window', String(id), path], { timeout: 5_000 })
          await info.attach(`${name}: full window`, { path, contentType: 'image/png' })
        } catch (error) {
          await info.attach(`${name}: full-window capture unavailable`, { body: String(error), contentType: 'text/plain' })
        }
      }
      try {
        await use({ get app() { return app! }, get page() { return page }, profile, workspace, origin, surface, request,
          allowConsoleError: pattern => { allowedConsoleErrors.push(pattern) },
          restart: async () => { await close(); await launch() },
          release: async () => { await writeFile(join(profile, `ui-release-${(await request()).turnId}`), '') }, capture })
      } finally {
        if (info.status !== info.expectedStatus && !page.isClosed()) {
          await capture('failure').catch(error => logs.push(`Failure capture: ${String(error)}\n`))
        }
      }
    } finally {
      await close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await info.attach('App log', { body: logs.join(''), contentType: 'text/plain' })
      const journal = await readFile(join(profile, 'journal.jsonl'), 'utf8').catch(() => '')
      await info.attach('Journal', { body: journal || '(empty)', contentType: 'text/plain' })
      expect(errors, 'No renderer errors, crashes, or shutdown failures').toEqual([])
    }
  }
})

export { expect }

export type SectionName = 'Chats' | 'Library' | 'Tools' | 'Browser'

/**
 * A toolbar section's button: the only way to Chats, Library, Tools and Browser. A section
 * in the closed Sections drawer is reached by opening the drawer first.
 */
export async function section(page: Page, name: SectionName): Promise<Locator> {
  const id = name.toLowerCase()
  const toggle = page.getByRole('button', { name: 'Sections', exact: true })
  if (await toggle.getAttribute('aria-expanded') !== 'true' && await page.locator(`.tb-drawer [data-section="${id}"]`).count()) await toggle.click()
  return page.locator(`.toolbar [data-section="${id}"]`)
}

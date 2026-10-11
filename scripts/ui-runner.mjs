import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Worker } from 'node:worker_threads'
import { runCommand } from './ui-process.mjs'

// One private display and Electron profile per inspection session. The supervisor owns all
// Playwright objects; scripts get a worker-thread facade and cannot stall cleanup or timeouts.
const [root, directory, buildMode] = process.argv.slice(2)
const profile = join(directory, 'profile')
const workspace = join(directory, 'workspace')
const appRoot = buildMode === 'build' ? join(directory, 'app') : root
const controller = new AbortController()
let application, shell, server, origin, closing
let generation = 0
const errors = []
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const log = value => process.stderr.write(String(value))
const session = { id: directory.split('/').at(-1), directory, profile, workspace, build: buildMode === 'build' ? 'session build of current source' : 'existing out/ build' }

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CRAFT_|ROCKET_|ELECTRON_|__NV_PRIME_RENDER_OFFLOAD$|__GLX_VENDOR_LIBRARY_NAME$|__VK_LAYER_NV_optimus$)/.test(name)))
const noSandbox = process.env.CRAFT_NO_SANDBOX === '1'
Object.assign(env, { NODE_ENV: 'test', CRAFT_UI_TEST: '1', CRAFT_USER_DATA: profile, CRAFT_AUTO_COMMIT: '0', CRAFT_SELF_CHECK: '1', CRAFT_UI_SOURCE_ROOT: root })

async function build() {
  await mkdir(appRoot, { recursive: true })
  await symlink(join(root, 'node_modules'), join(appRoot, 'node_modules'), 'dir')
  const buildEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
  delete buildEnv.CRAFT_UI_TEST
  for (const args of [
    [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'],
    [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build', '--outDir', join(appRoot, 'out')]
  ]) {
    const status = await runCommand(process.execPath, args, { cwd: root, env: buildEnv, signal: controller.signal, onOutput: log })
    if (status) throw new Error('The isolated UI build failed. Read runner.log, fix the build, then retry.')
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: manifest.name, productName: manifest.productName, version: manifest.version, type: 'module', main: 'out/main/index.js' }))
}

async function launch() {
  application = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [appRoot, ...(noSandbox ? ['--no-sandbox'] : [])], cwd: root, env, timeout: 30_000 })
  application.process().stdout?.on('data', log)
  application.process().stderr?.on('data', log)
  application.context().setDefaultTimeout(10_000)
  const watch = page => {
    page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`))
    page.on('crash', () => errors.push(`Renderer crashed: ${page.url()}`))
    page.on('console', message => { if (message.type() === 'error') errors.push(`${page.url()}: ${message.text()}`) })
  }
  for (const page of application.context().pages()) watch(page)
  application.context().on('page', watch)
  await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  shell = await application.firstWindow()
  await shell.getByRole('textbox', { name: 'Message', exact: true }).first().waitFor({ state: 'visible' })
  await application.evaluate(({ BrowserWindow, dialog }, folder) => {
    BrowserWindow.getAllWindows()[0].setTitle('Craft Studio — isolated UI inspection')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, workspace)
}

async function closeApp() {
  if (!application) return
  const app = application
  application = undefined
  await app.context().tracing.stop({ path: join(directory, `trace-${generation++}.zip`) }).catch(error => log(error.message))
  await app.close().catch(error => { log(error.message); app.process().kill('SIGKILL') })
}

async function close() {
  closing ??= (async () => {
    controller.abort()
    await closeApp()
    server?.closeAllConnections()
    if (server?.listening) await new Promise(resolve => server.close(resolve))
  })()
  return closing
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close().finally(() => process.exit(0)) })

async function surface(kind) {
  if (kind === 'shell') return shell
  if (!['browser', 'suggestions'].includes(kind)) throw new Error('Choose shell, browser or suggestions as the UI surface.')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    // Resolve the visible native view each time, including after navigation or switching
    // between tabs with identical URLs. The local fixture need not remain the active page.
    const selected = await application.evaluate(({ BrowserWindow, WebContentsView }, kind) => {
      const views = BrowserWindow.getAllWindows()[0].contentView.children
      const current = views.find(view => view instanceof WebContentsView && view.getVisible()
        && (kind === 'suggestions' ? view.webContents.getURL().endsWith('/suggest.html') : !view.webContents.getURL().endsWith('/suggest.html')))
      return current ? { url: current.webContents.getURL(), id: current.webContents.id } : null
    }, kind)
    const candidates = application.context().pages().filter(page => page.url() === selected?.url)
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) {
      // Electron may report visible documents for concealed sibling views. Match Chromium
      // target ids instead of trusting document.visibilityState or choosing the first URL.
      const targetId = await application.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id)
        const attached = contents.debugger.isAttached()
        if (!attached) contents.debugger.attach('1.3')
        try { return (await contents.debugger.sendCommand('Target.getTargetInfo')).targetInfo.targetId }
        finally { if (!attached) contents.debugger.detach() }
      }, selected.id)
      for (const candidate of candidates) {
        const cdp = await application.context().newCDPSession(candidate)
        try {
          if ((await cdp.send('Target.getTargetInfo')).targetInfo.targetId === targetId) return candidate
        } finally { await cdp.detach() }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`The ${kind} surface is not open. Open it through the app UI first.`)
}

// This harness owns an isolated host; its capture route must not depend on an active provider turn.
async function snapshot() {
  const { port, secret } = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8'))
  const response = await fetch(`http://127.0.0.1:${port}/mcp/${secret}/codex/isolated-ui-harness`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_ui_snapshot', arguments: {} } })
  })
  const { result, error } = await response.json()
  if (error || result?.isError) throw new Error(error?.message ?? result?.content?.[0]?.text ?? 'The isolated UI capture failed.')
  return { metadata: JSON.parse(result.content[0].text), content: result.content.slice(1) }
}

const LOCATORS = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'locator', 'filter', 'nth', 'first', 'last'])
const ACTIONS = new Set(['click', 'dblclick', 'fill', 'press', 'pressSequentially', 'hover', 'check', 'uncheck', 'selectOption', 'scrollIntoViewIfNeeded', 'waitFor', 'count', 'isVisible', 'isEnabled', 'textContent', 'innerText', 'inputValue', 'getAttribute', 'boundingBox'])
async function operate(op, captures) {
  switch (op.type) {
    case 'surface': await surface(op.surface); return null
    case 'snapshot': {
      if (captures.length >= 5) throw new Error('Use at most five explicit snapshots per UI script; continue inspecting in another call.')
      const capture = await snapshot(); captures.push(capture); return capture.metadata
    }
    case 'read': return (await snapshot()).metadata.shell
    case 'request': return JSON.parse(await readFile(join(profile, 'ui-request.json'), 'utf8'))
    case 'release': {
      const request = JSON.parse(await readFile(join(profile, 'ui-request.json'), 'utf8'))
      await writeFile(join(profile, `ui-release-${request.turnId}`), '')
      return request
    }
    case 'resize': {
      if (!Number.isInteger(op.width) || !Number.isInteger(op.height) || op.width < 880 || op.width > 2400 || op.height < 560 || op.height > 1400) throw new Error('Use a window size between 880×560 and 2400×1400.')
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), op)
      await shell.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, op)
      return { width: op.width, height: op.height }
    }
    case 'restart': await closeApp(); await launch(); return null
    case 'page': {
      if (!['title', 'url'].includes(op.method)) throw new Error('Unsupported page operation.')
      return (await surface(op.surface))[op.method]()
    }
    case 'keyboard': {
      if (!['press', 'type'].includes(op.method)) throw new Error('Unsupported keyboard operation.')
      return (await surface(op.surface)).keyboard[op.method](op.value)
    }
    case 'waitForFunction': {
      // Recreate a function in Node before handing it to Playwright. Its string-predicate
      // path uses eval inside the renderer, which Craft Studio's content security policy rejects.
      const predicate = new Function(`return (${op.expression})`)
      const handle = await (await surface(op.surface)).waitForFunction(predicate, undefined, op.options)
      await handle.dispose()
      return null
    }
    case 'evaluate':
    case 'locator': {
      let target = await surface(op.surface)
      for (const step of op.chain ?? []) {
        if (!LOCATORS.has(step.method)) throw new Error('Unsupported locator operation.')
        target = target[step.method](...step.args)
      }
      if (op.type === 'evaluate') {
        const fn = op.chain?.length ? new Function(`return (${op.expression})`)() : new Function(`return (${op.expression})`)
        return target.evaluate(fn)
      }
      if (!ACTIONS.has(op.method)) throw new Error('Unsupported UI operation.')
      return await target[op.method](...op.args) ?? null
    }
    default: throw new Error('Unsupported UI operation.')
  }
}

async function run(request) {
  const captures = [], logs = []
  const worker = new Worker(new URL('./ui-run-worker.mjs', import.meta.url), { workerData: { code: request.code } })
  let operations = Promise.resolve()
  const outcome = await new Promise(resolve => {
    let finished = false
    const finish = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => finish({ ok: false, timedOut: true, error: `The UI script was stopped after ${request.timeout}s. The session was closed; retry with a shorter flow.` }), request.timeout * 1000)
    worker.on('message', message => {
      if (message.type === 'log') { if (logs.join('\n').length < 12_000) logs.push(message.text.slice(0, 2000)) }
      else if (message.type === 'done') void operations.then(() => finish(message))
      else if (message.type === 'call') operations = operations.then(async () => {
        try { worker.postMessage({ id: message.id, ok: true, value: await operate(message.op, captures) }) }
        catch (error) { worker.postMessage({ id: message.id, ok: false, error: error.message, errorCode: error.name === 'TimeoutError' ? 'OPERATION_TIMEOUT' : error.message.includes('strict mode violation:') ? 'AMBIGUOUS_TARGET' : 'UI_OPERATION_FAILED' }) }
      })
    })
    worker.on('error', error => finish({ ok: false, error: error.message }))
    worker.on('exit', code => { if (!finished) finish({ ok: false, error: `The UI script worker exited (${code}).` }) })
  })
  await worker.terminate()
  // Capture failure states as evidence too. A timed-out operation may still be in flight, so
  // discard that session instead of letting it change the UI underneath a later script.
  if (request.capture !== false || !outcome.ok) {
    try { captures.push(await snapshot()) } catch (error) { logs.push(`Capture failed: ${error.message}`); outcome.ok = false; outcome.error ??= error.message }
  }
  if (outcome.timedOut) await closeApp()
  const result = { ...outcome, type: undefined, session: { ...session, origin, open: !!application }, logs, errors: [...errors], captures }
  if (errors.length) { result.ok = false; result.error ??= 'The inspected app reported renderer errors. Read errors and runner.log.' }
  await writeFile(join(directory, `run-${request.id}.json`), JSON.stringify({ ...result, captures: captures.map(capture => capture.metadata) }, null, 2))
  return result
}

try {
  await mkdir(profile, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(profile, 'ui-test-profile'), 'craft-ui-check-v1')
  server = createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return }
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><title>UI page ${request.url === '/two' ? 'two' : 'one'}</title><style>body{font:20px system-ui;padding:24px;background:#eef3ff;color:#17264a}input,button{font:inherit;padding:8px}</style><h1>Craft Studio browser check</h1><p>Local test page ${request.url === '/two' ? 'two' : 'one'}</p><a href="${request.url === '/two' ? '/one' : '/two'}">Next page</a><p><label>Test input <input aria-label="Test input"></label><button onclick="document.getElementById('result').textContent='Clicked successfully'">Test button</button></p><p id="result">Ready</p>`)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  env.CRAFT_UI_TEST_ORIGIN = origin
  await writeFile(join(profile, 'browser-tabs.json'), JSON.stringify({ active: 0, tabs: [{ url: `${origin}/one`, title: 'UI page one', favicon: null, pinned: false }] }))
  if (buildMode === 'build') await build()
  await launch()
  output({ type: 'ready', session: { ...session, origin } })
  let queue = Promise.resolve()
  const input = createInterface({ input: process.stdin })
  input.on('line', line => {
    queue = queue.then(async () => {
      const request = JSON.parse(line)
      if (request.close) { await close(); output({ id: request.id, ok: true, session: { ...session, open: false }, captures: [] }); process.exit(0) }
      const result = await run(request)
      output({ id: request.id, ...result })
    }).catch(error => { output({ ok: false, error: error.message }); void close().finally(() => process.exit(1)) })
  })
  input.on('close', () => { void close().finally(() => process.exit(0)) })
} catch (error) {
  output({ type: 'startupError', error: error.message })
  await close()
  process.exitCode = 1
}

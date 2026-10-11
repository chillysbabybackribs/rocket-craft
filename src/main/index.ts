import {
  app, BrowserWindow, Notification, dialog, ipcMain, MessageChannelMain, session, shell, utilityProcess, type UtilityProcess
} from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserAgentReply, BrowserAgentRequest, BrowserCommand, CaptureRequest } from '../shared/types.ts'
import { HOST_PORT_MESSAGE } from '../shared/types.ts'
import { readChatLink } from './chat-links.ts'
import { ScreenCapture } from './capture.ts'
import { BrowserAgent } from './browser-agent.ts'
import { BrowserPane } from './browser-pane.ts'
import { BROWSER_PARTITION } from './browser-url.ts'
import { defaultCookieSource, detectCookieSources, importCookies } from './cookie-import.ts'
import { appendJournal } from '../host/journal.ts'
import { uiTestProfile } from '../host/ui-test.ts'
import { isolateUiTestNetwork } from './ui-test-network.ts'
import { captureUiSnapshot } from './ui-snapshot.ts'
import { liveUiConnection } from './ui-connection.ts'
import { OrchestratorNotifications } from './orchestrator-notifications.ts'
import { notificationTestTransport } from './orchestrator-notifications-test.ts'
import { publishLivePort } from './live-port.ts'
import { CraftStudio } from './craft-studio.ts'

// Electron's main process does three things and nothing else: it owns the window, it owns the
// embedded browser view, and it forks the agent host and introduces it to the renderer over a
// MessageChannel. Chat traffic never passes through here.

// CRAFT_USER_DATA points the app at another profile folder, so a test run never touches real chats.
const testProfile = uiTestProfile()
if (process.env.CRAFT_USER_DATA) app.setPath('userData', process.env.CRAFT_USER_DATA)
// Acquire the lock before configuring Chromium: an opener only hands off its argument.
const ownsInstance = app.requestSingleInstanceLock()
let livePort = 0
if (ownsInstance) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  // A port of 0 sets navigator.webdriver. Choose a numbered port ourselves and publish
  // it independently of Chromium's DevToolsActivePort, which other launches can overwrite.
  livePort = await freeLoopbackPort()
  app.commandLine.appendSwitch('remote-debugging-port', String(livePort))
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => done(port))
    })
  })
}

let window: BrowserWindow | null = null
let host: UtilityProcess | null = null
let browser: BrowserPane | null = null
let browserAgent: BrowserAgent | null = null
let screenCapture: ScreenCapture | null = null
let quitting = false
// The Craft apps: installs, the docked windows and their processes (craft-studio.ts).
let craft: CraftStudio | null = null
let craftQuit: Promise<void> | null = null
let craftDone = false
const notificationTest = testProfile ? notificationTestTransport(testProfile) : null
if (notificationTest) Object.assign(globalThis, { rocketNotificationTest: notificationTest.seam })
const notifications = new OrchestratorNotifications({
  window: () => window,
  supported: () => notificationTest ? true : Notification.isSupported(),
  create: notice => notificationTest ? notificationTest.create(notice) : new Notification({ title: notice.title, body: notice.body }),
  diagnostic: message => appendJournal(join(app.getPath('userData'), 'journal.jsonl'), {
    at: Date.now(), source: 'main', severity: 'warn', kind: 'observation', message
  })
})
ipcMain.handle('rocket:orchestrator-notification', (event, payload: unknown) => notifications.show(event.sender, payload))

// Rocket's ROCKET_* variables (its profile path among them) arrive when Craft Studio is started
// from a Rocket chat's shell. The host and every provider shell it starts must not see them.
function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ROCKET_')))
}

function startHost(): UtilityProcess {
  const child = utilityProcess.fork(join(import.meta.dirname, 'host.js'), [], {
    serviceName: 'Craft Studio Agent Host',
    env: { ...hostEnv(), CRAFT_DATA_DIR: app.getPath('userData') },
    stdio: 'inherit'
  })
  // The host's browser tools: one request in, one answer out, the work done here beside the pages.
  child.on('message', (message: BrowserAgentRequest) => {
    if (message?.type !== 'browser') return
    const reply = (answer: { ok: true; result: unknown } | { ok: false; error: string }): void => {
      if (host === child) child.postMessage({ type: 'browserReply', id: message.id, ...answer } satisfies BrowserAgentReply)
    }
    Promise.resolve()
      .then(() => {
        if (message.op.op === 'uiConnection') {
          if (!window) throw new Error('Craft Studio’s window is closed.')
          return liveUiConnection(window)
        }
        if (message.op.op === 'uiResize') {
          if (!window) throw new Error('Craft Studio’s window is closed.')
          const { width, height } = message.op
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 880 || height < 560 || width > 4000 || height > 2400) throw new Error('Use a window size between 880×560 and 4000×2400.')
          window.setSize(width, height)
          return { width, height }
        }
        if (message.op.op === 'uiSnapshot') {
          if (!window) throw new Error('Craft Studio’s window is closed. Open the app and try again.')
          return captureUiSnapshot(window)
        }
        if (message.op.op === 'uiMap') {
          // The renderer's dispatcher answers with a result object, never a thrown error, so a
          // refusal keeps its wording instead of Electron's "script failed to execute".
          if (!window) throw new Error('Craft Studio’s window is closed. Open the app and try again.')
          const { call } = message.op
          const expression = call === 'where' ? 'window.rocketMap.where()'
            : call === 'go' ? `window.rocketMap.go(${JSON.stringify(message.op.place)}, ${JSON.stringify(message.op.params)})`
              : `window.rocketMap.act(${JSON.stringify(message.op.action)}, ${JSON.stringify(message.op.params)})`
          return window.webContents.executeJavaScript(`(async () => { try { return await ${expression} } catch (error) { return { ok: false, error: String(error && error.message || error), where: window.rocketMap.where() } } })()`)
        }
        if (message.op.op === 'craft') {
          if (!craft) throw new Error('The Craft apps are not available in this session. Restart Craft Studio.')
          return craft.agentOp(message.op)
        }
        if (!browserAgent) throw new Error('The browser is not open')
        return browserAgent.handle(message.op)
      })
      .then((result) => reply({ ok: true, result }), (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  })
  child.on('exit', (code) => {
    if (host !== child) return
    host = null
    if (quitting) return
    console.error(`[main] agent host exited with code ${code}; restarting`)
    appendJournal(join(app.getPath('userData'), 'journal.jsonl'), {
      at: Date.now(), source: 'main', severity: 'error', kind: 'restart', message: `The agent host exited with code ${code} and was restarted`
    })
    host = startHost()
    connectRenderer()
  })
  return child
}

/** Give the renderer a fresh port to the host. Called when the page asks, and after a host restart. */
function connectRenderer(): void {
  if (!window || window.isDestroyed() || !host) return
  const { port1, port2 } = new MessageChannelMain()
  host.postMessage({ type: 'connect' }, [port1])
  window.webContents.postMessage(HOST_PORT_MESSAGE, null, [port2])
}

// On the very first launch, seed the embedded browser with the user's logged-in sessions from
// their default OS browser, so a site signed in out there is signed in here. The `persist:browser`
// session keeps the cookies on disk, so this runs once; a marker records that it has. Re-importing
// later, or picking a different browser, is the right-click menu's job (`browser-pane.ts`).
async function firstRunCookieImport(): Promise<void> {
  const marker = join(app.getPath('userData'), 'cookies-imported')
  if (existsSync(marker)) return
  try {
    const source = defaultCookieSource(detectCookieSources())
    if (source) await importCookies(session.fromPartition(BROWSER_PARTITION), source)
    // Write the marker even when nothing was found, so we try exactly once; the menu covers the rest.
    await writeFile(marker, new Date().toISOString())
  } catch (error) {
    appendJournal(join(app.getPath('userData'), 'journal.jsonl'), {
      at: Date.now(), source: 'main', severity: 'warn', kind: 'observation',
      message: `First-run cookie import failed: ${error instanceof Error ? error.message : String(error)}`
    })
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: '#08090a',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // The renderer observes worker events and submits notices even while the shell is hidden.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      // An ESM preload cannot run in a sandboxed renderer; the page loads only this app's own UI.
      sandbox: false
    }
  })
  browser = new BrowserPane(window)
  browserAgent = new BrowserAgent(browser)
  craft?.attach(window)
  screenCapture = new ScreenCapture(window, () => browser)
  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => {
    window = null
    browser = null
    browserAgent?.dispose()
    browserAgent = null
    screenCapture = null
  })
  // The UI never navigates or opens windows. A link that tries opens inside the app, in a
  // browser tab, the way a chat link does; nothing is handed to a system app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|file):/i.test(url)) openInWindow({ href: url, cwd: homedir() })
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  // Development hooks for checking the interface from a script. CRAFT_CAPTURE=<file.png> saves
  // a picture of the UI a few seconds after load, CRAFT_CAPTURE_SCRIPT=<file.js> first runs that
  // script in the page (to click through a flow), and CRAFT_CAPTURE_EXIT=1 quits afterwards.
  const capture = process.env.CRAFT_CAPTURE
  if (capture) {
    window.webContents.once('did-finish-load', () => {
      const script = process.env.CRAFT_CAPTURE_SCRIPT
      if (script) {
        setTimeout(() => {
          void readFile(script, 'utf8')
            .then((source) => window?.webContents.executeJavaScript(source, true))
            .catch((error: unknown) => console.error('[main] capture script failed:', error))
        }, 2_000)
      }
      setTimeout(async () => {
        const image = await window?.webContents.capturePage()
        if (image) await writeFile(capture, image.toPNG())
        if (process.env.CRAFT_CAPTURE_EXIT === '1') app.quit()
      }, Number(process.env.CRAFT_CAPTURE_DELAY_MS ?? 4_000))
    })
  }
}

ipcMain.on('rocket:request-host-port', (event) => {
  if (event.sender === window?.webContents) connectRenderer()
})
ipcMain.on('rocket:window', (event, action: string) => {
  if (event.sender !== window?.webContents || !window) return
  if (action === 'minimize') window.minimize()
  else if (action === 'toggleMaximize') window.isMaximized() ? window.unmaximize() : window.maximize()
  else if (action === 'close') window.close()
})
ipcMain.handle('rocket:pick-folder', async (event, current: string | null) => {
  if (event.sender !== window?.webContents || !window) return null
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose the folder this chat works in',
    defaultPath: current || homedir(),
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled ? null : result.filePaths[0] ?? null
})
ipcMain.handle('rocket:save-attachment-as', async (event, name: string) => {
  if (event.sender !== window?.webContents || !window) return null
  const result = await dialog.showSaveDialog(window, {
    title: 'Save attachment',
    defaultPath: join(app.getPath('downloads'), basename(String(name)) || 'attachment')
  })
  return result.canceled ? null : result.filePath ?? null
})
// Only the host's attachments folder is revealed, so a page cannot use this to open other places.
ipcMain.handle('rocket:reveal-attachment', (event, path: string) => {
  const folder = join(app.getPath('userData'), 'attachments')
  const target = resolve(String(path))
  if (event.sender !== window?.webContents || dirname(target) !== folder) throw new Error('Craft Studio can only reveal its own stored attachments.')
  shell.showItemInFolder(target)
})
ipcMain.handle('rocket:capture-sources', (event) => {
  if (event.sender !== window?.webContents || !screenCapture) throw new Error('Capture is only available from Craft Studio\'s window.')
  return screenCapture.sources()
})
ipcMain.handle('rocket:capture', (event, request: CaptureRequest) => {
  if (event.sender !== window?.webContents || !screenCapture) throw new Error('Capture is only available from Craft Studio\'s window.')
  return screenCapture.take(request)
})
ipcMain.handle('rocket:chat-link', (event, href: string, cwd: string) => {
  if (event.sender !== window?.webContents) throw new Error('This link cannot be opened from this window.')
  return readChatLink(href, cwd)
})
ipcMain.on('rocket:browser', (event, command: BrowserCommand) => {
  browser?.handle(event.sender, command)
})

// `rocket <path or URL>` opens it inside the app, as a link in the chat would: a page in a
// browser tab, a text file in the artifact panel. A second launch hands its arguments to the
// instance already running and exits; the first launch opens its argument once the page is up.
// The lock is per profile folder, so a test profile never reaches the real window.
function openTargetOf(argv: string[], cwd: string): { href: string; cwd: string } | null {
  const own = new Set(['.', app.getAppPath()])
  const arg = argv.slice(1).findLast((value) => value && !value.startsWith('-') && !own.has(value))
  if (!arg) return null
  return { href: /^(https?|file):/i.test(arg) ? arg : resolve(cwd, arg), cwd }
}

function openInWindow(target: { href: string; cwd: string } | null): void {
  if (!target || !window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.focus()
  window.webContents.send('rocket:open', target)
}

// A launch that loses the lock quits here and must start nothing: `ready` still fires on the
// way out, and a second host in the same profile would fight the first over its files.
if (!ownsInstance) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, cwd) => openInWindow(openTargetOf(argv, cwd)))
  app.whenReady().then(async () => {
    await publishLivePort(app.getPath('userData'), process.pid, livePort)
    if (testProfile) isolateUiTestNetwork(process.env.CRAFT_UI_TEST_ORIGIN)
    host = startHost()
    craft = new CraftStudio((message) => appendJournal(join(app.getPath('userData'), 'journal.jsonl'), {
      at: Date.now(), source: 'craft', severity: 'info', kind: 'observation', message
    }))
    craft.registerIpc()
    createWindow()
    if (!testProfile) void firstRunCookieImport()
    const first = openTargetOf(process.argv, process.cwd())
    if (first) window?.webContents.once('did-finish-load', () => openInWindow(first))
  })
}

app.on('window-all-closed', () => app.quit())

app.on('before-quit', (event) => {
  notifications.dispose()
  // Every Craft app this run started stops first (each gets SIGTERM, then SIGKILL after 3 s).
  if (craft && !craftDone) {
    event.preventDefault()
    craftQuit ??= craft.quit().finally(() => {
      craftDone = true
      app.quit()
    })
    return
  }
  if (quitting || !host) return
  // Let the host stop its provider processes before it goes; it exits on its own when done.
  quitting = true
  event.preventDefault()
  const child = host
  const done = (): void => app.quit()
  child.once('exit', done)
  child.postMessage({ type: 'shutdown' })
  setTimeout(() => {
    child.kill()
    done()
  }, 3_000).unref()
})

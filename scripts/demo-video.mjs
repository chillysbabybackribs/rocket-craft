#!/usr/bin/env node
// Records a demo of Craft Studio: sending messages, switching providers, and the browser tools
// filling a form in one batched script. It runs an isolated app on a private display, as
// npm run check:ui does: a fresh marked profile, scripted provider turns (src/host/ui-demo.ts)
// whose browser tool calls are real, and a local "Acme Support" site, so no model is called
// and nothing outside loopback is reached.
//
// ffmpeg records the display; this script logs where and when each thing happens
// (events.json), and scripts/demo-edit.py turns both into the finished video with camera
// zooms, a pointer and captions. Run it with: npm run demo:video
import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = process.argv[2] && resolve(process.argv[2])
if (!directory || !process.env.DISPLAY) throw new Error('Run this through npm run demo:video, which gives it a folder and a private display.')
const SCALE = 2
const WIDTH = 1600
const HEIGHT = 900
const appRoot = join(root, '.artifacts/demo/app')
const profile = join(directory, 'profile')
const workspace = join(directory, 'workspace')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The local site the agent works on. A GET form keeps it to plain HTML: submitting lands on
// the ticket page, which the next turn reads, and its comment form posts back to itself.
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
  *{box-sizing:border-box}body{margin:0;font:15px/1.5 Inter,system-ui,sans-serif;background:#f4f6fb;color:#1b2333}
  header{background:#1d3fd8;color:#fff;padding:14px 28px;display:flex;gap:28px;align-items:center}
  header b{font-size:17px;letter-spacing:.2px}header a{color:#dfe6ff;text-decoration:none;font-size:14px}
  main{max-width:720px;margin:28px auto;padding:0 24px}h1{font-size:24px;margin:0 0 6px}p.lead{color:#5b6478;margin:0 0 22px}
  .card{background:#fff;border:1px solid #e1e6f0;border-radius:12px;padding:22px 24px;box-shadow:0 1px 2px #0000000d}
  label{display:block;font-weight:600;font-size:13px;margin:0 0 6px;color:#38415a}.field{margin:0 0 16px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  input,select,textarea{width:100%;font:inherit;padding:9px 11px;border:1px solid #cfd6e4;border-radius:8px;background:#fff;color:#1b2333}
  textarea{min-height:96px;resize:vertical}button{font:inherit;font-weight:600;background:#1d3fd8;color:#fff;border:0;border-radius:8px;padding:10px 18px}
  .ok{background:#e8f7ee;border:1px solid #b8e5c8;color:#13623a;border-radius:10px;padding:12px 16px;margin:0 0 18px;font-weight:600}
  dl{display:grid;grid-template-columns:140px 1fr;gap:8px 12px;margin:0}dt{color:#5b6478}dd{margin:0;font-weight:600}
  .pill{display:inline-block;padding:2px 10px;border-radius:99px;background:#e6edff;color:#1d3fd8;font-size:13px}
  .note{margin-top:16px;padding:12px 14px;background:#f7f8fc;border-radius:8px;color:#38415a}
  #comments .c{border-top:1px solid #edf0f6;padding:10px 0}#comments .c b{display:block;font-size:13px}
</style></head><body><header><b>Acme Support</b><a href="/">Home</a><a href="/tickets/new">New ticket</a><a href="/tickets/4821">My tickets</a></header><main>${body}</main></body></html>`

const comments = []
function site(request, response) {
  const url = new URL(request.url, 'http://local')
  if (url.pathname === '/favicon.ico') return void response.writeHead(204).end()
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (url.pathname === '/tickets/new') return void response.end(page('New ticket · Acme Support', `
    <h1>New support ticket</h1><p class="lead">Tell us what went wrong and we will get back to you within a day.</p>
    <form class="card" action="/tickets/created" method="get">
      <div class="row"><div class="field"><label for="name">Your name</label><input id="name" name="name"></div>
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email"></div></div>
      <div class="row"><div class="field"><label for="product">Product</label><select id="product" name="product"><option>Choose…</option><option>Acme Cloud</option><option>Acme Identity</option><option>Acme Billing</option></select></div>
      <div class="field"><label for="subject">Subject</label><input id="subject" name="subject"></div></div>
      <div class="field"><label for="details">What happened?</label><textarea id="details" name="details"></textarea></div>
      <button type="submit">Submit ticket</button></form>`))
  if (url.pathname === '/tickets/created') return void response.end(page('Ticket #4821 · Acme Support', `
    <div class="ok">Ticket created. We have emailed ${url.searchParams.get('email') || 'you'} a copy.</div>
    <h1>#4821 · ${url.searchParams.get('subject') || ''}</h1><p class="lead">${url.searchParams.get('product') || ''}</p>
    <div class="card"><dl><dt>Status</dt><dd><span class="pill">New</span></dd><dt>From</dt><dd>${url.searchParams.get('name') || ''}</dd><dt>Details</dt><dd style="font-weight:400">${url.searchParams.get('details') || ''}</dd></dl></div>`))
  if (url.pathname === '/tickets/4821') {
    const comment = url.searchParams.get('comment')
    if (comment) comments.push(comment)
    return void response.end(page('Ticket #4821 · Acme Support', `
    ${comment ? '<div class="ok">Comment posted.</div>' : ''}
    <h1>#4821 · SSO login fails after the 4.2 update</h1><p class="lead">Acme Identity</p>
    <div class="card"><dl><dt>Status</dt><dd><span class="pill">Open</span></dd><dt>Priority</dt><dd>High</dd><dt>Assigned to</dt><dd>Priya Shah · Identity team</dd><dt>Updated</dt><dd>12 minutes ago</dd></dl>
    <div class="note"><b>Priya:</b> Reproduced. A fix is being tested for 4.2.1.</div></div>
    <form class="card" style="margin-top:16px" action="/tickets/4821" method="get"><div id="comments">${comments.map(text => `<div class="c"><b>Dana Parker</b>${text}</div>`).join('')}</div>
    <div class="field" style="margin-top:8px"><label for="comment">Add a comment</label><textarea id="comment" name="comment" style="min-height:70px"></textarea></div><button type="submit">Post comment</button></form>`))
  }
  response.end(page('Acme Support', `<h1>How can we help?</h1><p class="lead">Search the help centre or open a ticket with our team.</p>
    <div class="card"><p style="margin:0 0 12px">Most issues are answered within a day.</p><a href="/tickets/new"><button>Open a new ticket</button></a></div>`))
}

// What happened when, in screen pixels of the recording, for demo-edit.py.
const events = []
let t0 = 0
const note = (kind, fields = {}) => events.push({ t: (Date.now() - t0) / 1000, kind, ...fields })
const scaled = box => box && { x: box.x * SCALE, y: box.y * SCALE, w: box.width * SCALE, h: box.height * SCALE }

let application, shell, server, recorder
async function main() {
  await rm(directory, { recursive: true, force: true })
  await mkdir(profile, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(profile, 'ui-test-profile'), 'craft-ui-check-v1')
  if (!existsSync(join(appRoot, 'node_modules'))) await symlink(join(root, 'node_modules'), join(appRoot, 'node_modules'), 'dir')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: manifest.name, productName: manifest.productName, version: manifest.version, type: 'module', main: 'out/main/index.js' }))

  server = createServer(site)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(profile, 'browser-tabs.json'), JSON.stringify({ active: 0, tabs: [{ url: `${origin}/`, title: 'Acme Support', favicon: null, pinned: false }] }))

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CRAFT_|ROCKET_|ELECTRON_|__NV_PRIME_RENDER_OFFLOAD$|__GLX_VENDOR_LIBRARY_NAME$|__VK_LAYER_NV_optimus$)/.test(name)))
  Object.assign(env, { NODE_ENV: 'test', CRAFT_UI_TEST: '1', CRAFT_USER_DATA: profile, CRAFT_AUTO_COMMIT: '0', CRAFT_UI_TEST_ORIGIN: origin })
  application = await _electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [appRoot, `--force-device-scale-factor=${SCALE}`, ...(process.env.CRAFT_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    cwd: root, env, timeout: 30_000
  })
  // Both pipes must be drained, or the app stalls once one fills.
  const log = data => { if (!String(data).includes('gpu_persistent_cache')) process.stderr.write(data) }
  application.process().stdout?.on('data', log)
  application.process().stderr?.on('data', log)
  shell = await application.firstWindow()
  const message = shell.getByRole('textbox', { name: 'Message', exact: true })
  await message.waitFor({ state: 'visible' })
  await application.evaluate(({ BrowserWindow, dialog, session }, { folder, width, height }) => {
    // Squiggles under names in the composer only distract in a video.
    session.defaultSession.setSpellCheckerEnabled(false)
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ x: 0, y: 0, width, height })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, { folder: workspace, width: WIDTH, height: HEIGHT })
  await shell.waitForFunction(size => innerWidth === size.w && innerHeight === size.h, { w: WIDTH, h: HEIGHT })

  // Set the stage before recording: a folder, Claude, and the browser on the portal's home page.
  await shell.locator('.composer-folder').click()
  await chooseProvider('Claude', false)
  await shell.getByRole('button', { name: 'Sections', exact: true }).click()
  await shell.getByRole('button', { name: 'Browser', exact: true }).click()
  await browserPage(origin, '/')
  await sleep(1500)

  recorder = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '30', '-video_size', `${WIDTH * SCALE}x${HEIGHT * SCALE}`,
    '-i', `${process.env.DISPLAY}+0,0`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', join(directory, 'raw.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] })
  await sleep(1500)
  // A magenta flash marks the moment events are timed from; demo-edit.py finds it in the frames.
  await shell.evaluate(() => new Promise(resolve => {
    const flash = Object.assign(document.createElement('div'), { id: 'demo-sync' })
    flash.style.cssText = 'position:fixed;inset:0;background:#ff00ff;z-index:2147483647'
    document.body.append(flash)
    setTimeout(() => { flash.remove(); requestAnimationFrame(() => requestAnimationFrame(resolve)) }, 400)
  }))
  t0 = Date.now()

  note('camera', { box: null })
  note('caption', { text: 'Craft Studio: one chat, any provider, with a browser it can use', dur: 3.2 })
  await sleep(3400)

  // 1. Claude files a ticket.
  await send('File a ticket on the Acme support portal: SSO login fails after the 4.2 update.', 'Send a message. Claude answers first.')
  await waitForBrowser(origin, '/tickets/new')
  note('camera', { box: await viewBox(), pad: 1.06 })
  note('caption', { text: 'browser_read opens the agent\'s own tab and reads the form', dur: 3.2 })
  const form = await browserPage(origin, '/tickets/new')
  await sleep(1300)
  await batchFill(form, ['#name', '#email', '#product', '#subject', '#details'], '#name', 'browser_run fills all five fields in one script. No clicks, no typing.')
  await waitForBrowser(origin, '/tickets/created')
  note('caption', { text: 'Submitted in the same way, with requestSubmit()', dur: 2.6 })
  await sleep(1200)
  await settle()
  note('camera', { box: await transcriptBox() })
  await sleep(3200)

  // 2. Codex carries on from the same transcript.
  note('camera', { box: null })
  await sleep(900)
  await chooseProvider('Codex', true, 'Switch to Codex mid-chat. It is told what Claude did.')
  await send('Check that ticket\'s status page. Who is it assigned to?')
  await waitForBrowser(origin, '/tickets/4821')
  note('camera', { box: await viewBox(), pad: 1.06 })
  note('caption', { text: 'Codex reads the ticket page in the same browser', dur: 2.8 })
  await settle()
  note('camera', { box: await transcriptBox() })
  await sleep(3200)

  // 3. Cursor posts a comment.
  note('camera', { box: null })
  await sleep(900)
  await chooseProvider('Cursor', true, 'And to Cursor')
  await send('Add a comment asking Priya for an ETA on 4.2.1.')
  const ticket = await browserPage(origin, '/tickets/4821')
  await batchFill(ticket, ['#comment'], '#comment', 'One browser_run call writes the comment and posts it')
  await settle()
  note('camera', { box: null })
  note('caption', { text: 'Three providers, one transcript, one browser', dur: 3.4 })
  await sleep(4200)
  note('end')

  recorder.stdin.write('q')
  await new Promise(resolve => recorder.on('exit', resolve))
  await writeFile(join(directory, 'events.json'), JSON.stringify({ scale: SCALE, width: WIDTH * SCALE, height: HEIGHT * SCALE, events }, null, 2))
  console.log(`Recorded ${join(directory, 'raw.mp4')}`)
}

/** Move the pointer to something, then click it, so the edit can show the move and the click. */
async function point(locator, { click = true, lead = 750 } = {}) {
  const box = scaled(await locator.boundingBox())
  note('point', { x: box.x + box.w / 2, y: box.y + box.h / 2 })
  await sleep(lead)
  if (click) {
    note('click', { x: box.x + box.w / 2, y: box.y + box.h / 2 })
    await locator.click()
  }
}

async function chooseProvider(name, filmed, caption) {
  const trigger = shell.locator('.picker-trigger').first()
  if (filmed) {
    note('camera', { box: await composerBox() })
    if (caption) note('caption', { text: caption, dur: 3 })
    await point(trigger)
  } else await trigger.click()
  const item = shell.getByRole('menu', { name: 'Providers', exact: true }).getByRole('menuitemradio').filter({ hasText: name })
  await item.waitFor({ state: 'visible' })
  if (filmed) {
    await sleep(350)
    await point(item, { lead: 700 })
    await sleep(700)
  } else await item.click()
}

async function send(text, caption) {
  const message = shell.getByRole('textbox', { name: 'Message', exact: true })
  note('camera', { box: await composerBox() })
  if (caption) note('caption', { text: caption, dur: 3 })
  await point(message)
  await message.pressSequentially(text, { delay: 28 })
  await sleep(300)
  await point(shell.getByRole('button', { name: 'Send', exact: true }), { lead: 600 })
  note('hide-pointer')
  await sleep(500)
  note('camera', { box: null })
}

/** The turn is over when the Stop button goes. */
async function settle() {
  await shell.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 90_000 })
  await sleep(400)
}

/** Frame the empty fields, then mark the moment the agent's one script fills them all. */
async function batchFill(page, selectors, first, caption) {
  const view = await viewBounds()
  const boxes = []
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox()
    boxes.push(scaled({ x: box.x + view.x, y: box.y + view.y, width: box.width, height: box.height }))
  }
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y))
  const union = { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y }
  note('camera', { box: union, pad: 1.35 })
  await page.waitForFunction(selector => document.querySelector(selector)?.value !== '', first, { timeout: 60_000, polling: 30 })
  note('fill', { boxes })
  note('caption', { text: caption, dur: 3.6 })
  await sleep(2800)
}

async function viewBounds() {
  return application.evaluate(({ BrowserWindow, WebContentsView }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children
      .find(child => child instanceof WebContentsView && child.getVisible() && /^http/.test(child.webContents.getURL()))
    return view.getBounds()
  })
}
/** The top of the browser view, with its tabs and address: where a page's news shows first. */
async function viewBox() {
  const bounds = await viewBounds()
  return scaled({ x: bounds.x, y: bounds.y - 70, width: bounds.width, height: bounds.width * 0.5 })
}
async function composerBox() {
  return scaled(await shell.locator('.composer').first().boundingBox())
}
async function transcriptBox() {
  // The user's message down to the end of the reply.
  const turn = shell.locator('.turn').last()
  const top = scaled(await turn.locator('.user-bubble').first().boundingBox())
  const reply = scaled(await turn.locator('.prose').last().boundingBox())
  const left = Math.min(top.x, reply.x)
  return { x: left, y: top.y, w: Math.max(top.x + top.w, reply.x + reply.w) - left, h: reply.y + reply.h - top.y }
}

async function waitForBrowser(origin, path) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const url = await application.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0].contentView.children
      .filter(child => child instanceof WebContentsView && child.getVisible()).map(child => child.webContents.getURL()))
    if (url.some(entry => entry.startsWith(origin + path))) return
    await sleep(50)
  }
  throw new Error(`The browser never showed ${path}.`)
}

async function browserPage(origin, path) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const found = application.context().pages().filter(candidate => candidate.url().startsWith(origin + path)).at(-1)
    if (found) return found
    await sleep(50)
  }
  throw new Error(`No browser page at ${path}.`)
}

try {
  await main()
} catch (error) {
  console.error(error)
  if (shell) await shell.screenshot({ path: join(directory, 'failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  if (recorder && recorder.exitCode === null) { recorder.stdin.write('q'); await new Promise(resolve => recorder.on('exit', resolve)) }
  await application?.close().catch(() => application.process().kill('SIGKILL'))
  server?.closeAllConnections()
  server?.close()
}

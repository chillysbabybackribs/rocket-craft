import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CRAFT_APPS } from '../../shared/craft-apps.ts'
import type { CraftAgentApp, CraftAgentControl, MainAgentOp } from '../../shared/types.ts'
import { decodePng, encodePng, scalePng, shrinkPng } from '../png.ts'
import { CRAFT_ADAPTERS, adapterProblems, documentFileOf, documentOf, fileCall, routeCommand, wireCall, writerFor, type CraftAdapter } from './craft-adapters.ts'
import { CraftConnection, CraftConnections, CraftQueue, replyOf } from './craft-client.ts'
import { CraftAgent, checkArgs, craftSituation, craftTools, findCommands, inlinePng } from './craft.ts'
import { toolAllowed, type Tool, type ToolResult } from './registry.ts'

// The craft_* tools against fake apps: real loopback sockets speaking each app's framing, and a
// fake main that answers `apps`, `touch` and `control` the way craft-studio.ts does.

type Handler = (message: Record<string, unknown>, socket: Socket, state: { authed: boolean; lines: number }) => unknown | Promise<unknown>

type FakeApp = { port: number; server: Server; seen: Array<{ at: number; message: Record<string, unknown> }>; connections: number; close: () => Promise<void> }

async function fakeApp(handler: Handler): Promise<FakeApp> {
  const seen: FakeApp['seen'] = []
  const sockets = new Set<Socket>()
  const app = { seen, connections: 0 } as FakeApp
  const server = createServer((socket) => {
    app.connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const state = { authed: false, lines: 0 }
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', async (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        const message = JSON.parse(line) as Record<string, unknown>
        state.lines++
        seen.push({ at: Date.now(), message })
        const reply = await handler(message, socket, state)
        if (reply !== undefined && !socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`)
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  app.server = server
  app.port = (server.address() as AddressInfo).port
  app.close = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((done) => server.close(() => done()))
  }
  return app
}

const ok = (message: Record<string, unknown>, result: unknown): unknown => ({ id: message.id, ok: true, result })

function control(app: string, port: number | null, extra: Partial<CraftAgentControl> = {}): CraftAgentControl {
  return { app, launch: 1, port, tokenFile: null, controlFile: null, configHome: '/nonexistent', folder: null, run: 'working', ...extra }
}

type FakeMain = { main: (op: MainAgentOp) => Promise<unknown>; ops: MainAgentOp[] }

function fakeMain(installed: Record<string, CraftAgentControl>, states: Partial<Record<string, Partial<CraftAgentApp>>> = {}): FakeMain {
  const ops: MainAgentOp[] = []
  const main = async (op: MainAgentOp): Promise<unknown> => {
    ops.push(op)
    if (op.op === 'uiMap') return { ok: true, value: null, where: {} }
    if (op.op !== 'craft') throw new Error(`unexpected ${op.op}`)
    if (op.call === 'apps') {
      return CRAFT_APPS.map((app) => ({
        id: app.id, name: app.name, likeName: app.likeName,
        installState: installed[app.id] ? 'installed' : 'none', run: installed[app.id] ? 'working' : 'stopped', shown: false,
        ...states[app.id]
      }))
    }
    const found = installed[op.app]
    if (op.call === 'control') return found ?? null
    if (!found) throw new Error(`${CRAFT_APPS.find((app) => app.id === op.app)?.name} is not installed. Ask the user to install it from the app shelf (+ Add in the dock); models cannot install apps.`)
    return found
  }
  return { main, ops }
}

function toolsFor(main: FakeMain['main'], options: ConstructorParameters<typeof CraftAgent>[2] = {}, cwd: string | null = null): { agent: CraftAgent; tool: (name: string) => Tool } {
  const agent = new CraftAgent(main, () => cwd, options)
  const tools = craftTools(agent)
  return { agent, tool: (name) => tools.find((entry) => entry.name === name)! }
}

const call = (tool: Tool, args: Record<string, unknown>): Promise<ToolResult> => Promise.resolve(tool.run(args, { provider: 'claude', chatId: 'chat-1' }))
const text = (result: ToolResult): string => result.content.map((part) => part.type === 'text' ? part.text : '[image]').join('\n')

// ---- The adapter table --------------------------------------------------------------------------

test('every manifest app has exactly one adapter, and every adapter can run, list, inspect and screenshot', () => {
  assert.deepEqual(adapterProblems(), [])
  assert.equal(Object.keys(CRAFT_ADAPTERS).length, 12)
  for (const adapter of Object.values(CRAFT_ADAPTERS)) {
    assert.ok(adapter.execute.method && adapter.commands.method && adapter.inspect.method && adapter.ui.method && adapter.brief.method, adapter.id)
    assert.match(adapter.screenshot.method, /screenshot/, adapter.id)
    for (const name of ['app.quit', 'ui.resize', 'ui.focus', 'app.open', 'app.save']) assert.ok(adapter.refused[name], `${adapter.id} refuses ${name}`)
    for (const method of adapter.methods) assert.ok(!adapter.refused[method], `${adapter.id} both allows and refuses ${method}`)
  }
})

test('the per-app quirks are in the table, not the schemas', () => {
  const photo = CRAFT_ADAPTERS.photocraft!
  assert.deepEqual(photo.auth, { kind: 'token', method: 'auth', field: 'token' })
  assert.equal(photo.idleCloseMs, 30_000)
  assert.equal(photo.paths, 'roots')
  assert.deepEqual(photo.screenshot.params, { focus: false })
  // PhotoCraft's document.inspect is an engine command, not a control method.
  assert.deepEqual(wireCall(photo, photo.inspect), { method: 'engine.execute', params: { command: 'document.inspect', params: {} } })
  assert.equal(CRAFT_ADAPTERS.pdfcraft!.framing, 'jsonrpc')
  assert.equal(CRAFT_ADAPTERS.pdfcraft!.auth.kind, 'controlFile')
  assert.equal(CRAFT_ADAPTERS.wordcraft!.auth.kind, 'key')
  assert.equal(CRAFT_ADAPTERS.gridcraft!.commands.search, 'search')
  assert.deepEqual(wireCall(CRAFT_ADAPTERS.soundcraft!, CRAFT_ADAPTERS.soundcraft!.inspect), { method: 'session.inspect', params: { detail: 'summary' } })
})

test('craft_run sends a listed control method as itself and anything else as an engine command; quitting and window control are refused', () => {
  const grid = CRAFT_ADAPTERS.gridcraft!
  assert.deepEqual(routeCommand(grid, 'sheet.read', { range: 'A1:B2' }), { call: { method: 'sheet.read', params: { range: 'A1:B2' } } })
  assert.deepEqual(routeCommand(grid, 'insert.chart', { type: 'line' }), { call: { method: 'engine.execute', params: { command: 'insert.chart', params: { type: 'line' } } } })
  assert.match((routeCommand(grid, 'app.quit', {}) as { refused: string }).refused, /only the user closes apps/)
  assert.match((routeCommand(grid, 'ui.resize', {}) as { refused: string }).refused, /break the dock/)
  assert.match((routeCommand(CRAFT_ADAPTERS.photocraft!, 'file.saveAs', {}) as { refused: string }).refused, /craft_save/)
  assert.deepEqual(routeCommand(CRAFT_ADAPTERS.cadcraft!, 'cmdline.input', { text: 'circle 0,0 5' }), { call: { method: 'cmdline.input', params: { text: 'circle 0,0 5' } } })
})

test('the open document comes from the table\'s fields', () => {
  assert.equal(documentOf(CRAFT_ADAPTERS.gridcraft!, { title: 'Book1', path: null }), 'Book1')
  assert.equal(documentOf(CRAFT_ADAPTERS.gridcraft!, { title: 'book.xlsx', path: '/tmp/book.xlsx' }), '/tmp/book.xlsx')
  assert.equal(documentOf(CRAFT_ADAPTERS.photocraft!, { name: 'Untitled', layers: [] }), 'Untitled')
  assert.equal(documentOf(CRAFT_ADAPTERS.vectorcraft!, { title: 'logo', path: null }), 'logo')
  assert.equal(documentOf(CRAFT_ADAPTERS.designcraft!, [{ title: 'a', active: false }, { title: 'b', active: true }]), 'b')
  const pdf = { documents: [{ name: 'a.pdf', path: '/x/a.pdf', active: false }, { name: 'b.pdf', path: null, active: true }] }
  assert.equal(documentOf(CRAFT_ADAPTERS.pdfcraft!, pdf), 'b.pdf')
  assert.equal(documentFileOf(CRAFT_ADAPTERS.pdfcraft!, pdf), null)
  assert.equal(documentFileOf(CRAFT_ADAPTERS.wordcraft!, { title: 'Document1' }), null)
  assert.equal(documentOf(CRAFT_ADAPTERS.gridcraft!, null), null)
})

test('commands that would open a native file dialog are refused unless they name a file', () => {
  const film = CRAFT_ADAPTERS.filmcraft!
  assert.match((routeCommand(film, 'file.import', {}) as { refused: string }).refused, /native file or print dialog/)
  assert.deepEqual(routeCommand(film, 'file.import', { paths: ['/m/a.mp4'] }), { call: { method: 'engine.execute', params: { command: 'file.import', params: { paths: ['/m/a.mp4'] } } } })
  assert.match((routeCommand(film, 'file.exportMedia', { preset: 'h264' }) as { refused: string }).refused, /dialog/)
  assert.match((routeCommand(CRAFT_ADAPTERS.wordcraft!, 'file.print', {}) as { refused: string }).refused, /print dialog/)
  assert.ok('call' in routeCommand(CRAFT_ADAPTERS.photocraft!, 'file.new', { width: 10, height: 10 }))
  assert.match((routeCommand(CRAFT_ADAPTERS.soundcraft!, 'ui.menu.invoke', { path: 'Track > New...' }) as { refused: string }).refused, /native file dialogs/)
})

test('PdfCraft runs commands as ui.command {id} with no params', () => {
  const pdf = CRAFT_ADAPTERS.pdfcraft!
  assert.deepEqual(routeCommand(pdf, 'view.zoomIn', {}), { call: { method: 'ui.command', params: { id: 'view.zoomIn' } } })
  assert.match((routeCommand(pdf, 'view.zoom', { level: 2 }) as { refused: string }).refused, /take no params/)
  assert.deepEqual(wireCall(pdf, pdf.save.own!), { method: 'ui.command', params: { id: 'file.save' } })
  assert.equal(pdf.save.to, null)
})

test('a save goes to the app\'s own Save As for its formats and to an export for the others', () => {
  const vector = CRAFT_ADAPTERS.vectorcraft!
  assert.deepEqual(writerFor(vector, 'svg'), { call: vector.save.to, export: false })
  assert.equal(writerFor(vector, 'png')?.export, true)
  assert.equal(writerFor(vector, 'mp3'), null)
  assert.equal(writerFor(CRAFT_ADAPTERS.gridcraft!, 'csv')?.export, false)
  assert.equal(writerFor(CRAFT_ADAPTERS.wordcraft!, 'pdf')?.call.method, 'file.exportPdf')
  assert.equal(writerFor(CRAFT_ADAPTERS.lightcraft!, 'lrcat'), null)
  // LightCraft opens by importing into its library, as a list.
  assert.deepEqual(fileCall(CRAFT_ADAPTERS.lightcraft!, CRAFT_ADAPTERS.lightcraft!.open!, '/p/a.jpg'),
    { method: 'engine.execute', params: { command: 'library.import', params: { mode: 'add', paths: ['/p/a.jpg'] } } })
})

test('both reply shapes read the same', () => {
  assert.deepEqual(replyOf({ id: 1, ok: true, result: { a: 1 } }), { ok: true, result: { a: 1 } })
  assert.deepEqual(replyOf({ id: 1, ok: false, error: 'nope' }), { ok: false, error: 'nope' })
  assert.deepEqual(replyOf({ jsonrpc: '2.0', id: 1, result: 5 }), { ok: true, result: 5 })
  assert.deepEqual(replyOf({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } }), { ok: false, error: 'no such method' })
})

// ---- Arguments ----------------------------------------------------------------------------------

test('arguments are checked before anything reaches main or an app', async () => {
  assert.equal(checkArgs({ app: 'gridcraft' }, { app: { type: 'string', required: true } }), null)
  assert.equal(checkArgs({}, { app: { type: 'string', required: true } }), 'app is required.')
  assert.equal(checkArgs({ app: 'gridcraft', params: [] }, { app: { type: 'string' }, params: { type: 'object' } }), 'params must be an object.')
  assert.match(checkArgs({ app: 'gridcraft', wait: true }, { app: { type: 'string' } })!, /wait is not an argument/)
  const fake = fakeMain({})
  const { tool } = toolsFor(fake.main)
  const results = await Promise.all([
    call(tool('craft_run'), { app: 'gridcraft' }),
    call(tool('craft_run'), { app: 'gridcraft', command: 'x', params: 'A1' }),
    call(tool('craft_run'), { app: 'excel', command: 'x' }),
    call(tool('craft_batch'), { app: 'gridcraft', steps: [] }),
    call(tool('craft_screenshot'), { app: 'gridcraft', maxWidth: '800' }),
    call(tool('craft_inspect'), { app: 'gridcraft', what: 'layers' })
  ])
  assert.ok(results.every((result) => result.isError))
  assert.match(text(results[0]!), /command is required/)
  assert.match(text(results[1]!), /params must be an object/)
  assert.match(text(results[2]!), /There is no Craft app "excel"\. app is one of photocraft, vectorcraft/)
  assert.match(text(results[3]!), /at least one step/)
  assert.match(text(results[4]!), /maxWidth must be a number/)
  assert.match(text(results[5]!), /what must be one of document, ui/)
  assert.deepEqual(fake.ops, [])
})

test('every tool names the app in its schema, from the twelve ids', () => {
  const { tool } = toolsFor(fakeMain({}).main)
  for (const name of ['craft_show', 'craft_commands', 'craft_run', 'craft_batch', 'craft_inspect', 'craft_open', 'craft_save', 'craft_screenshot']) {
    const schema = tool(name).inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] }
    assert.deepEqual(schema.properties.app?.enum, CRAFT_APPS.map((app) => app.id), name)
    assert.ok(schema.required.includes('app'), name)
  }
})

// ---- Not installed ------------------------------------------------------------------------------

test('an app that is not installed is refused with a sentence telling the model to ask the user, and nothing is started', async () => {
  const fake = fakeMain({})
  const { tool } = toolsFor(fake.main)
  const shown = await call(tool('craft_show'), { app: 'vectorcraft' })
  assert.ok(shown.isError)
  assert.match(text(shown), /VectorCraft is not installed\. Ask the user to install it from the app shelf.*models cannot install apps/)
  assert.ok(!fake.ops.some((op) => op.op === 'uiMap'))
  const run = await call(tool('craft_run'), { app: 'vectorcraft', command: 'document.new' })
  assert.ok(run.isError)
  assert.match(text(run), /VectorCraft is not installed\. Ask the user to install it/)
  const listed = JSON.parse(text(await call(tool('craft_apps'), {})).split('\n')[0]!) as Array<Record<string, unknown>>
  assert.equal(listed.length, 12)
  assert.ok(listed.every((row) => row.installed === false))
  assert.match(text(await call(tool('craft_apps'), {})), /Suggest one to the user; they install it from the app shelf/)
})

test('workers, leaders and ordinary chats all get the craft tools', () => {
  for (const role of ['worker', 'leader', 'ordinary'] as const) assert.ok(toolAllowed(role, 'craft_run'), role)
})

// ---- Calls, queueing, reconnects ----------------------------------------------------------------

test('craft_run reaches the app, touched first with the chat\'s folder, and answers its result', async () => {
  const app = await fakeApp((message) => ok(message, { echoed: message.method, params: message.params }))
  try {
    const fake = fakeMain({ gridcraft: control('gridcraft', app.port) })
    const { tool, agent } = toolsFor(fake.main, {}, '/work/chat')
    const result = await call(tool('craft_run'), { app: 'gridcraft', command: 'insert.chart', params: { type: 'line' } })
    assert.ok(!result.isError, text(result))
    assert.deepEqual(JSON.parse(text(result)), { echoed: 'engine.execute', params: { command: 'insert.chart', params: { type: 'line' } } })
    assert.deepEqual(fake.ops[0], { op: 'craft', call: 'touch', app: 'gridcraft', folder: '/work/chat' })
    const failed = await call(tool('craft_run'), { app: 'gridcraft', command: 'app.quit' })
    assert.match(text(failed), /app\.quit is not available to models/)
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('calls to one app run one at a time in order; calls to another app do not wait', async () => {
  const gate: Array<() => void> = []
  const slow = await fakeApp((message) => new Promise((done) => gate.push(() => done(ok(message, { n: (message.params as Record<string, unknown>).params })))))
  const quick = await fakeApp((message) => ok(message, 'quick'))
  try {
    const fake = fakeMain({ gridcraft: control('gridcraft', slow.port), soundcraft: control('soundcraft', quick.port) })
    const { tool, agent } = toolsFor(fake.main)
    const first = call(tool('craft_run'), { app: 'gridcraft', command: 'a', params: { n: 1 } })
    const second = call(tool('craft_run'), { app: 'gridcraft', command: 'b', params: { n: 2 } })
    const other = await call(tool('craft_run'), { app: 'soundcraft', command: 'transport.play' })
    assert.equal(text(other), '"quick"')
    for (let i = 0; i < 50 && slow.seen.length < 1; i++) await new Promise((done) => setTimeout(done, 10))
    await new Promise((done) => setTimeout(done, 50))
    // The second request has not been sent while the first waits for its reply.
    assert.equal(slow.seen.length, 1)
    assert.equal(agent.queue.isBusy('gridcraft'), true)
    gate.shift()!()
    assert.deepEqual(JSON.parse(text(await first)), { n: { n: 1 } })
    for (let i = 0; i < 50 && gate.length < 1; i++) await new Promise((done) => setTimeout(done, 10))
    assert.equal(slow.seen.length, 2)
    gate.shift()!()
    assert.deepEqual(JSON.parse(text(await second)), { n: { n: 2 } })
    assert.deepEqual(slow.seen.map((entry) => (entry.message.params as Record<string, unknown>).command), ['a', 'b'])
    assert.equal(agent.queue.isBusy('gridcraft'), false)
    agent.connections.closeAll()
  } finally {
    await slow.close()
    await quick.close()
  }
})

test('a batch runs as one turn of the queue and stops at the first failure', async () => {
  const app = await fakeApp((message) => {
    const command = (message.params as Record<string, unknown>).command
    return command === 'bad' ? { id: message.id, ok: false, error: 'unknown command `bad`' } : ok(message, command)
  })
  try {
    const { tool, agent } = toolsFor(fakeMain({ gridcraft: control('gridcraft', app.port) }).main)
    const result = await call(tool('craft_batch'), { app: 'gridcraft', steps: [{ command: 'one' }, { command: 'bad' }, { command: 'three' }] })
    assert.ok(result.isError)
    assert.match(text(result), /stopped at step 2/)
    assert.deepEqual(app.seen.map((entry) => (entry.message.params as Record<string, unknown>).command), ['one', 'bad'])
    const refused = await call(tool('craft_batch'), { app: 'gridcraft', steps: [{ command: 'one' }, { command: 'app.quit' }] })
    assert.match(text(refused), /Step 2 was refused, so nothing ran/)
    assert.equal(app.seen.length, 2)
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('PhotoCraft-style apps sign in first on every connection, with the token from the launch\'s file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'craft-token-'))
  const tokenFile = join(dir, 'token')
  await writeFile(tokenFile, 'a'.repeat(64) + '\n')
  const app = await fakeApp((message, socket, state) => {
    if (!state.authed) {
      if (message.method === 'auth' && (message.params as Record<string, unknown>).token === 'a'.repeat(64)) {
        state.authed = true
        return ok(message, { authenticated: true })
      }
      socket.end(`${JSON.stringify({ id: message.id, ok: false, error: 'unauthorized' })}\n`)
      return undefined
    }
    return ok(message, { name: 'Untitled' })
  })
  try {
    const { tool, agent } = toolsFor(fakeMain({ photocraft: control('photocraft', app.port, { tokenFile }) }).main)
    const result = await call(tool('craft_inspect'), { app: 'photocraft' })
    assert.ok(!result.isError, text(result))
    assert.deepEqual(app.seen.map((entry) => entry.message.method), ['auth', 'engine.execute'])
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('WordCraft\'s key goes at the top level of its auth line, read from the key file under its config folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'craft-key-'))
  const app = await fakeApp((message, _socket, state) => {
    if (!state.authed) {
      state.authed = message.method === 'auth' && message.key === 'k'.repeat(64)
      return state.authed ? ok(message, {}) : { id: message.id, ok: false, error: 'unauthorized' }
    }
    return ok(message, 'in')
  })
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'wordcraft'))
    await writeFile(join(dir, 'wordcraft', `control-key.local-${app.port}`), 'k'.repeat(64))
    const { tool, agent } = toolsFor(fakeMain({ wordcraft: control('wordcraft', app.port, { configHome: dir }) }).main)
    const result = await call(tool('craft_run'), { app: 'wordcraft', command: 'format.bold' })
    assert.equal(text(result), '"in"')
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('PdfCraft-style apps: JSON-RPC 2.0, port and token from the control file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'craft-pdf-'))
  const app = await fakeApp((message, _socket, state) => {
    assert.equal(message.jsonrpc, '2.0')
    if (!state.authed) {
      state.authed = message.method === 'auth' && (message.params as Record<string, unknown>).token === 'tok'
      return state.authed ? { jsonrpc: '2.0', id: message.id, result: {} } : { jsonrpc: '2.0', id: message.id, error: { code: 1, message: 'unauthorized' } }
    }
    return { jsonrpc: '2.0', id: message.id, result: { pages: 3 } }
  })
  try {
    const controlFile = join(dir, 'pdf.control.json')
    await writeFile(controlFile, JSON.stringify({ port: app.port, token: 'tok', pid: 1 }))
    const { tool, agent } = toolsFor(fakeMain({ pdfcraft: control('pdfcraft', null, { controlFile }) }).main)
    assert.equal(text(await call(tool('craft_inspect'), { app: 'pdfcraft' })), '{"pages":3}')
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('an idle connection is replaced before the app would drop it, and a request lost to a close is sent once more', async () => {
  let dropNext = false
  const app = await fakeApp((message, socket) => {
    if (dropNext) {
      dropNext = false
      socket.destroy()
      return undefined
    }
    return ok(message, message.method)
  })
  try {
    let now = 1_000_000
    const adapter: CraftAdapter = { ...CRAFT_ADAPTERS.gridcraft!, idleCloseMs: 30_000 }
    const connection = new CraftConnection(adapter, control('gridcraft', app.port), 'GridCraft', undefined, () => now)
    assert.deepEqual(await connection.request('one', {}, 2_000), { ok: true, result: 'one' })
    assert.equal(app.connections, 1)
    now += 26_000
    assert.deepEqual(await connection.request('two', {}, 2_000), { ok: true, result: 'two' })
    assert.equal(app.connections, 2, 'a connection idle 26 s is replaced before a PhotoCraft-style app drops it at 30 s')
    dropNext = true
    assert.deepEqual(await connection.request('three', {}, 2_000), { ok: true, result: 'three' })
    assert.equal(connection.reconnects, 1)
    assert.equal(app.connections, 3)
    assert.deepEqual(app.seen.map((entry) => entry.message.method), ['one', 'two', 'three', 'three'])
    connection.close()
  } finally {
    await app.close()
  }
})

test('an app that does not answer in time gets a full-sentence error, and the next call still works', async () => {
  let answer = false
  const app = await fakeApp((message) => (answer ? ok(message, 'late but fine') : undefined))
  try {
    const { tool, agent } = toolsFor(fakeMain({ gridcraft: control('gridcraft', app.port) }).main, { timeouts: { run: 200 } })
    const result = await call(tool('craft_run'), { app: 'gridcraft', command: 'calc.now' })
    assert.ok(result.isError)
    assert.match(text(result), /^GridCraft did not answer within 0 seconds\. It may still be working: call craft_inspect/)
    answer = true
    assert.equal(text(await call(tool('craft_run'), { app: 'gridcraft', command: 'calc.now' })), '"late but fine"')
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('an app that is still starting is tried again until it listens; one that never does gets a sentence, not a stack', async () => {
  const probe = await fakeApp(() => undefined)
  const port = probe.port
  await probe.close()
  // The app's window is docked before it listens: the first attempts are refused.
  setTimeout(() => {
    const late = createServer((socket) => {
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        const message = JSON.parse(chunk.trim()) as Record<string, unknown>
        socket.write(`${JSON.stringify(ok(message, 'listening now'))}\n`)
      })
    })
    late.listen(port, '127.0.0.1')
    setTimeout(() => late.close(), 2_000).unref()
  }, 600)
  const started = Date.now()
  const { tool, agent } = toolsFor(fakeMain({ gridcraft: control('gridcraft', port) }).main)
  const result = await call(tool('craft_run'), { app: 'gridcraft', command: 'x' })
  assert.equal(text(result), '"listening now"')
  assert.ok(Date.now() - started >= 500)
  agent.connections.closeAll()

  const gone = await fakeApp(() => undefined)
  const closed = gone.port
  await gone.close()
  const connection = new CraftConnection(CRAFT_ADAPTERS.gridcraft!, control('gridcraft', closed), 'GridCraft')
  await assert.rejects(connection.request('x', {}, 1_000), /GridCraft refused the connection .*It may have quit/)
})

test('a new launch of an app gets a new connection', () => {
  const made: number[] = []
  const connections = new CraftConnections((adapter, control, name) => {
    made.push(control.launch)
    return new CraftConnection(adapter, control, name)
  })
  const adapter = CRAFT_ADAPTERS.gridcraft!
  const first = connections.get(adapter, control('gridcraft', 1), 'GridCraft')
  assert.equal(connections.get(adapter, control('gridcraft', 1), 'GridCraft'), first)
  connections.get(adapter, control('gridcraft', 1, { launch: 2 }), 'GridCraft')
  assert.deepEqual(made, [1, 2])
  connections.closeAll()
})

test('queue: a failed call does not block the next', async () => {
  const queue = new CraftQueue()
  const order: string[] = []
  const failing = queue.run('a', async () => { order.push('1'); throw new Error('boom') })
  const next = queue.run('a', async () => { order.push('2'); return 'ok' })
  await assert.rejects(failing, /boom/)
  assert.equal(await next, 'ok')
  assert.deepEqual(order, ['1', '2'])
})

// ---- Commands, inspect, files, screenshots ------------------------------------------------------

test('craft_commands filters by every word, pages, and clips long params', async () => {
  const list = [
    { id: 'insert.chart', label: 'Insert Chart', params: '{type?}', enabled: true },
    { id: 'chart.set', label: 'Chart Properties', params: 'x'.repeat(2000), enabled: true },
    { id: 'cell.set', label: 'Set Cell', params: '{cell, input}', enabled: false }
  ]
  assert.deepEqual(findCommands(list, 'insert chart').shown.map((entry) => (entry as { id: string }).id), ['insert.chart'])
  assert.equal(findCommands(list, 'input').by, 'text')
  assert.ok(((findCommands(list, 'chart').shown[1] as { params: string }).params).length < 500)
  assert.equal((findCommands(list, 'cell').shown[0] as { enabled?: boolean }).enabled, false)
  const app = await fakeApp((message) => ok(message, list))
  try {
    const { tool, agent } = toolsFor(fakeMain({ gridcraft: control('gridcraft', app.port) }).main)
    const result = text(await call(tool('craft_commands'), { app: 'gridcraft', search: 'chart' }))
    assert.match(result, /^GridCraft: 2 commands match "chart"; 1–2 below\./)
    // One word goes to GridCraft's own search as well.
    assert.deepEqual(app.seen[0]!.message.params, { search: 'chart' })
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

function testPng(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) pixels.writeUInt32BE((((i % width) * 255 / width) << 24 | 0x40ff) >>> 0, i * 4)
  return encodePng({ width, height, channels: 4, pixels })
}

test('PNG: decode, scale and encode round-trip; unreadable data passes through', () => {
  const png = testPng(400, 200)
  const decoded = decodePng(png)!
  assert.equal(decoded.width, 400)
  const small = scalePng(decoded, 100)
  assert.deepEqual([small.width, small.height], [100, 50])
  assert.deepEqual(decodePng(encodePng(small))!.pixels, small.pixels)
  const shrunk = shrinkPng(png, 100)
  assert.deepEqual([shrunk.width, shrunk.height, shrunk.scaled], [100, 50, true])
  assert.equal(shrinkPng(png, 1000).scaled, false)
  const junk = Buffer.from('not a png')
  assert.equal(shrinkPng(junk, 10).data, junk)
})

test('craft_screenshot finds the PNG in the reply, downscales it by default and keeps full size on request', async () => {
  const png = testPng(1600, 1000)
  assert.deepEqual(inlinePng({ png_base64: png.toString('base64') }), png)
  assert.deepEqual(inlinePng({ result: { image: `data:image/png;base64,${png.toString('base64')}` } }), png)
  assert.equal(inlinePng({ path: '/tmp/x.png' }), null)
  const app = await fakeApp((message) => ok(message, { base64: png.toString('base64'), width: 1600 }))
  try {
    const { tool, agent } = toolsFor(fakeMain({ gridcraft: control('gridcraft', app.port) }).main)
    const small = await call(tool('craft_screenshot'), { app: 'gridcraft' })
    assert.equal(small.content[0]!.type === 'text' && small.content[0].text, 'GridCraft window, 1600×1000, scaled to 1024×640.')
    const image = small.content[1]!
    assert.ok(image.type === 'image')
    assert.equal(decodePng(Buffer.from(image.data, 'base64'))!.width, 1024)
    const full = await call(tool('craft_screenshot'), { app: 'gridcraft', maxWidth: 0 })
    assert.equal(full.content[0]!.type === 'text' && full.content[0].text, 'GridCraft window, 1600×1000.')
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('apps that write their screenshot to a file get a private path, read back and removed', async () => {
  const png = testPng(300, 200)
  const app = await fakeApp(async (message) => {
    const path = (message.params as Record<string, unknown>).path as string
    await writeFile(path, png)
    return ok(message, { path, width: 300, height: 200 })
  })
  try {
    const shotDir = await mkdtemp(join(tmpdir(), 'craft-shots-'))
    const { tool, agent } = toolsFor(fakeMain({ effectcraft: control('effectcraft', app.port) }).main, { shotDir })
    const result = await call(tool('craft_screenshot'), { app: 'effectcraft' })
    assert.ok(!result.isError, text(result))
    const path = (app.seen[0]!.message.params as Record<string, unknown>).path as string
    assert.ok(path.startsWith(shotDir))
    await assert.rejects(readFile(path))
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('craft_open and craft_save take paths from the chat\'s folder, and a root-confined app refuses paths outside its folder before it sees them', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'craft-chat-'))
  await writeFile(join(folder, 'in.png'), testPng(4, 4))
  const tokenFile = join(folder, '.token')
  await writeFile(tokenFile, 't')
  const app = await fakeApp(async (message) => {
    const params = message.params as Record<string, unknown>
    if (message.method === 'auth') return ok(message, { authenticated: true })
    if (message.method === 'app.save') await writeFile(params.path as string, 'x')
    return ok(message, { path: params.path, warnings: [] })
  })
  try {
    const fake = fakeMain({ photocraft: control('photocraft', app.port, { folder, tokenFile }), gridcraft: control('gridcraft', app.port) })
    const { tool, agent } = toolsFor(fake.main, {}, folder)
    const opened = await call(tool('craft_open'), { app: 'photocraft', path: 'in.png' })
    assert.ok(!opened.isError, text(opened))
    assert.deepEqual(app.seen.at(-1)!.message, { id: app.seen.at(-1)!.message.id, method: 'app.open', params: { path: join(folder, 'in.png') } })
    const saved = JSON.parse(text(await call(tool('craft_save'), { app: 'photocraft', path: 'out/result', format: 'png' })))
    assert.equal(saved.file, join(folder, 'out', 'result.png'))
    assert.equal(saved.bytes, 1)
    const outside = await call(tool('craft_save'), { app: 'photocraft', path: '/tmp/elsewhere.png' })
    assert.match(text(outside), /PhotoCraft may only read and write inside .*the folder it was started with/)
    const missing = await call(tool('craft_open'), { app: 'gridcraft', path: 'nope.xlsx' })
    assert.match(text(missing), /There is no file at .*nope\.xlsx/)
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('craft_save exports formats the app\'s Save does not write', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'craft-export-'))
  let ownFile: string | null = null
  const app = await fakeApp((message) => message.method === 'document.inspect'
    ? ok(message, { title: 'logo', path: ownFile })
    : ok(message, { path: (message.params as Record<string, unknown>).path }))
  try {
    const { tool, agent } = toolsFor(fakeMain({ vectorcraft: control('vectorcraft', app.port, { folder }) }).main, {}, folder)
    await call(tool('craft_save'), { app: 'vectorcraft', path: 'logo.png' })
    assert.deepEqual(app.seen.at(-1)!.message.params, { path: join(folder, 'logo.png'), format: 'png' })
    assert.equal(app.seen.at(-1)!.message.method, 'app.export')
    await call(tool('craft_save'), { app: 'vectorcraft', path: 'logo.svg' })
    assert.deepEqual(app.seen.at(-1)!.message, { id: app.seen.at(-1)!.message.id, method: 'app.save', params: { path: join(folder, 'logo.svg'), format: 'svg', svg: {} } })
    const wrong = await call(tool('craft_save'), { app: 'vectorcraft', path: 'logo.mp3' })
    assert.match(text(wrong), /VectorCraft cannot write \.mp3 .*it writes vectorcraft, template, pdf, svg, svgz, png/)
    // Never saved: Save would open a dialog, so it is refused and nothing is sent.
    const before = app.seen.length
    const refused = await call(tool('craft_save'), { app: 'vectorcraft' })
    assert.match(text(refused), /no file of its own yet.*Give a path/)
    assert.deepEqual(app.seen.slice(before).map((entry) => entry.message.method), ['document.inspect'])
    ownFile = join(folder, 'logo.vectorcraft')
    await call(tool('craft_save'), { app: 'vectorcraft' })
    assert.equal(app.seen.at(-1)!.message.method, 'app.save')
    assert.deepEqual(app.seen.at(-1)!.message.params, {})
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

// ---- Situation and listing ----------------------------------------------------------------------

test('the situation line names installed, shown and running apps and the shown app\'s document, without touching anything', async () => {
  const app = await fakeApp((message) => ok(message, { title: 'Book1', path: null }))
  try {
    const fake = fakeMain(
      { gridcraft: control('gridcraft', app.port), photocraft: control('photocraft', 1) },
      { gridcraft: { shown: true, run: 'shown' }, photocraft: { run: 'resting' } }
    )
    const agent = new CraftAgent(fake.main, () => null)
    const line = (await craftSituation(agent))!
    assert.equal(line, '<craft-apps>Installed: PhotoCraft (photocraft: running, resting); GridCraft (gridcraft: shown, Book1). Drive them with the craft_* tools, naming the app; 10 more can be suggested for the user to install.</craft-apps>')
    assert.ok(!fake.ops.some((op) => op.op === 'craft' && op.call === 'touch'))
    assert.match((await craftSituation(new CraftAgent(fakeMain({}).main, () => null)))!, /No Craft apps are installed/)
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

test('the situation line gives up on a slow document rather than hold the message', async () => {
  const app = await fakeApp(() => undefined)
  try {
    const fake = fakeMain({ gridcraft: control('gridcraft', app.port) }, { gridcraft: { shown: true, run: 'shown' } })
    const agent = new CraftAgent(fake.main, () => null, { timeouts: { brief: 100 } })
    const started = Date.now()
    assert.match((await craftSituation(agent))!, /GridCraft \(gridcraft: shown\)/)
    assert.ok(Date.now() - started < 1_500)
    agent.connections.closeAll()
  } finally {
    await app.close()
  }
})

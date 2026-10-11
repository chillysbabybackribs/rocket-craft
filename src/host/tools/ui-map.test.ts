import assert from 'node:assert/strict'
import test from 'node:test'
import type { MainAgentOp, UiMapResult, UiSnapshot, UiWhere } from '../../shared/types.ts'
import { describeWhere, uiMapTools, whereForChat } from './ui-map.ts'

const where = (patch: Partial<UiWhere> = {}): UiWhere => ({
  place: 'shelf',
  panes: [{ index: 0, chatId: 'a', title: 'first chat', provider: 'claude', running: true, planOpen: false }],
  side: 'shelf', artifact: null, library: null, ...patch
})

const snapshot: UiSnapshot = {
  capturedAt: 'now', instance: { pid: 1, startedAt: 'then', version: '0', mainBundleSha256: 'x', rendererUrl: 'app://' },
  window: { bounds: { x: 0, y: 0, width: 10, height: 10 }, contentBounds: { x: 0, y: 0, width: 10, height: 10 }, focused: true, minimized: false },
  shell: { panels: [], controls: [], controlsTruncated: false }, views: [], capture: 'window', warnings: [], directory: '/tmp/x',
  images: [{ label: 'window', path: '/tmp/x/window.png', mimeType: 'image/jpeg', base64: 'AAAA' }]
}

test('the where line names whether the asking chat is the column, and the side panel', () => {
  const own = whereForChat(where(), 'a')
  assert.equal(own.yourPane, 0)
  const line = describeWhere(own)
  assert.ok(line.includes('one chat pane'))
  assert.ok(line.includes('this chat is pane 0 (ui.pane(0))'))
  assert.ok(line.includes('the app shelf is shown on the right side'))
  assert.equal(whereForChat(where(), 'zzz').yourPane, null)
  assert.ok(describeWhere(whereForChat(where(), 'zzz')).includes('pane 0: first chat, running'))
  assert.ok(describeWhere(whereForChat(where(), null)).includes('this chat is not on screen'))
  const craft: UiWhere['craft'] = { shown: 'photocraft', apps: [
    { id: 'photocraft', name: 'PhotoCraft', likeName: 'Photoshop', installState: 'installed', run: 'shown' },
    { id: 'gridcraft', name: 'GridCraft', likeName: 'Excel', installState: 'none', run: 'stopped' }
  ] }
  const app = describeWhere(whereForChat(where({ place: 'app', side: 'app', craft }), 'a'))
  assert.ok(app.includes('PhotoCraft is shown on the right side (shown); installed apps: PhotoCraft'))
  const library = describeWhere(whereForChat(where({ place: 'library', side: 'library', library: { filters: { kind: 'pdf' }, view: 'grid', shown: 3, total: 22 } }), 'a'))
  assert.ok(library.includes('the library is shown on the right side (grid, 3 of 22 files, filtered by kind pdf)'))
})

test('go and act pass through the dispatcher, add the pane and the image, and refuse unknown names', async () => {
  const calls: MainAgentOp[] = []
  const main = async (op: MainAgentOp): Promise<unknown> => {
    calls.push(op)
    if (op.op === 'uiSnapshot') return snapshot
    if (op.op === 'uiMap' && op.call === 'where') return where()
    if (op.op === 'uiMap' && op.call === 'go') return { ok: true, value: null, where: where({ place: op.place, side: 'library' }) } satisfies UiMapResult
    if (op.op === 'uiMap' && op.call === 'act') return { ok: false, error: 'The board has no workers to move between.', where: where() } satisfies UiMapResult
    throw new Error('unexpected op')
  }
  const tools = Object.fromEntries(uiMapTools(main).map((tool) => [tool.name, tool]))
  const context = { provider: 'codex' as const, chatId: 'b' }

  const seen = await tools.studio_ui_where!.run({}, context)
  const seenText = JSON.parse((seen.content[0] as { text: string }).text)
  assert.equal(seenText.where.yourPane, null)
  assert.ok(seenText.summary.startsWith('Where you are:'))
  assert.equal(seen.content.length, 1)

  const went = await tools.studio_ui_go!.run({ place: 'library', params: {} }, context)
  assert.ok(!went.isError)
  const wentText = JSON.parse((went.content[0] as { text: string }).text)
  assert.equal(wentText.where.place, 'library')
  assert.equal(wentText.capture.directory, '/tmp/x')
  assert.deepEqual(went.content[2], { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' })
  assert.deepEqual(calls.at(-2), { op: 'uiMap', call: 'go', place: 'library', params: {} })

  const refused = await tools.studio_ui_act!.run({ action: 'worker.next', capture: false }, context)
  assert.ok(refused.isError)
  assert.equal(refused.structuredContent?.error?.code, 'UI_MAP_REFUSED')
  assert.equal(refused.structuredContent?.error?.message, 'The board has no workers to move between.')
  assert.equal(refused.content.length, 1)

  const unknown = await tools.studio_ui_go!.run({ place: 'evals.scenario' }, context)
  assert.equal(unknown.structuredContent?.error?.code, 'INVALID_ARGUMENT')
  assert.ok(!calls.some((op) => op.op === 'uiMap' && op.call === 'go' && op.place === 'evals.scenario'))

  const closed = await uiMapTools(async () => { throw new Error('Craft Studio’s window is closed.') })[0]!.run({}, context)
  assert.equal(closed.structuredContent?.error?.code, 'UI_UNAVAILABLE')
  assert.ok((closed.content[0] as { text: string }).text.includes('Open the app and try again.'))
})

test('the schemas enumerate the map, so a model cannot invent a place or action', () => {
  const [, go, act] = uiMapTools(async () => null)
  const places = (go!.inputSchema.properties as { place: { enum: string[] } }).place.enum
  const actions = (act!.inputSchema.properties as { action: { enum: string[] } }).action.enum
  assert.ok(places.includes('app') && places.includes('shelf') && !places.includes('app.show'))
  assert.ok(actions.includes('app.show') && actions.includes('shelf.open') && !actions.includes('app'))
  // Installing and removing are the user's alone, and the tool ledger's panel is gone.
  assert.ok(![...places, ...actions].some((name) => /install|remove|tools/.test(name)))
  assert.ok(!places.some((name) => name.startsWith('evals')) && !actions.some((name) => name.startsWith('evals')))
  assert.ok(!actions.some((name) => name.startsWith('pane.')))
  assert.ok(go!.description.includes('- library {source'))
  assert.ok(go!.description.includes('- app {id'))
  assert.ok(act!.description.includes('- library.open {id'))
})

test('where summary includes the pause reason and pending control', () => {
  const summary = describeWhere(whereForChat(where({ board: {
    run: { id: 'r', chatId: 'a', status: 'paused', task: 'Work.', reason: 'Review ended without a checkpoint.', canWrapUp: true, canResume: true, actionPending: true },
    workers: [], filter: 'all', expanded: null
  } }), 'a'))
  assert.match(summary, /Review ended without a checkpoint/)
  assert.match(summary, /run action pending/)
})

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { GeneratedImageSource, HostEvent, ImageAttachment, ModelInfo } from '../shared/types.ts'
import { Hub } from './hub.ts'
import { ImageRunner, imagePrompt } from './image.ts'
import { unavailableUsage, type ProviderAdapter, type RunRequest, type RunResult, type TurnSink } from './providers/provider.ts'
import { Store } from './store.ts'
import { imageTools } from './tools/image.ts'
import { toolAllowed } from './tools/registry.ts'

// A 1×1 PNG: the smallest picture Codex could send back.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** A Codex whose turn does what the test says; the script may wait, so two turns can overlap. */
class ScriptedCodex implements ProviderAdapter {
  readonly id = 'codex' as const
  ran: RunRequest[] = []
  constructor(private readonly script: (request: RunRequest, sink: TurnSink) => Promise<RunResult> | RunResult) {}
  async run(request: RunRequest, sink: TurnSink): Promise<RunResult> {
    this.ran.push(request)
    sink.session('s1')
    return this.script(request, sink)
  }
  async prepare(): Promise<void> {}
  async stop(): Promise<void> {}
  forget(): void {}
  async usage() { return unavailableUsage('codex', 'test') }
  async models(): Promise<ModelInfo[]> { return [] }
  shutdown(): void {}
}

function setup(script: ConstructorParameters<typeof ScriptedCodex>[0]) {
  const base = mkdtempSync(join(tmpdir(), 'craft-image-'))
  const store = new Store(':memory:')
  const adapter = new ScriptedCodex(script)
  const shown: HostEvent[] = []
  const stored = new Map<string, string>()
  let images: ImageRunner
  const hub = new Hub(
    store, { claude: adapter, codex: adapter, cursor: adapter, antigravity: adapter },
    (event) => { if (!images.observe(event)) shown.push(event) },
    undefined, null, () => [],
    async (source: GeneratedImageSource, caption: string): Promise<ImageAttachment> => {
      const id = `img-${stored.size + 1}`
      const path = join(base, `${id}.png`)
      writeFileSync(path, source.base64 ? Buffer.from(source.base64, 'base64') : PNG)
      stored.set(id, path)
      return { kind: 'image', id, name: `${caption.replace(/\W+/g, '-') || 'picture'}.png`, mimeType: 'image/png', size: PNG.length, width: 1, height: 1 }
    }
  )
  images = new ImageRunner(
    store, hub, join(base, 'chats'), join(base, 'kept'), (id) => stored.get(id)!,
  )
  return { base, store, adapter, shown, images, hub }
}

const picture = (request: RunRequest, sink: TurnSink, caption = 'a red kite over a hill'): RunResult => {
  sink.item({ type: 'image', id: 'i1', turnId: request.turnId, status: 'done', caption, source: { base64: PNG.toString('base64') } })
  return { status: 'completed' }
}

test('a picture is made in a chat the window never sees, kept, and nothing is left behind', async () => {
  const { base, store, adapter, shown, images } = setup((request, sink) => picture(request, sink))
  const made = await images.generate({ prompt: 'A red kite over a hill', aspect: 'landscape', references: ['/tmp/ref.png'] }, 'caller-chat')

  assert.match(adapter.ran[0]!.text, /Picture: A red kite over a hill/)
  assert.match(adapter.ran[0]!.text, /landscape, wider than it is tall/)
  assert.match(adapter.ran[0]!.text, /- \/tmp\/ref\.png/)
  assert.equal(adapter.ran[0]!.cwd.startsWith(images.root + '/'), true)
  assert.equal(made.caption, 'a red kite over a hill')
  assert.equal(made.path.startsWith(join(base, 'kept') + '/'), true)
  assert.deepEqual(readFileSync(made.path), PNG, 'the file is the picture Codex made')
  assert.deepEqual(shown.filter((event) => event.type !== 'usage'), [], 'nothing of the run reaches the window, though a usage reading does')
  assert.deepEqual(store.listChats(), [], 'the picture\'s chat is deleted')
  assert.deepEqual(readdirSync(images.root), [], 'and so is its folder')
  store.close()
})

test('a picture Codex could not make says why, and still leaves nothing behind', async () => {
  const { store, images } = setup((request, sink) => {
    sink.item({ type: 'image', id: 'i1', turnId: request.turnId, status: 'failed', caption: '', error: 'Codex has used up its image generation limit for now. Try again after 3:00 PM.' })
    return { status: 'completed' }
  })
  await assert.rejects(images.generate({ prompt: 'a kite' }, null), /used up its image generation limit.*3:00 PM/)
  assert.deepEqual(store.listChats(), [])
  assert.deepEqual(readdirSync(images.root), [])
  store.close()
})

test('a Codex turn that fails, or that makes no picture, ends in a sentence saying what to do', async () => {
  const failing = setup(() => ({ status: 'failed', error: 'Not signed in' }))
  await assert.rejects(failing.images.generate({ prompt: 'a kite' }, null), /Codex could not make the picture: Not signed in\. Check that Codex is signed in/)
  const silent = setup(() => ({ status: 'completed' }))
  await assert.rejects(silent.images.generate({ prompt: 'a kite' }, null), /finished without making a picture\. Reword the request/)
  await assert.rejects(silent.images.generate({ prompt: '  ' }, null), /Say what the picture should show/)
  failing.store.close()
  silent.store.close()
})

test('at most two pictures are made at once, and a slot frees when one ends', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { store, images } = setup(async (request, sink) => { await gate; return picture(request, sink) })
  const first = images.generate({ prompt: 'one' }, null)
  const second = images.generate({ prompt: 'two' }, null)
  await assert.rejects(images.generate({ prompt: 'three' }, null), /already making two pictures/)
  release()
  await Promise.all([first, second])
  await images.generate({ prompt: 'four' }, null)
  store.close()
})

test('imagePrompt asks for one picture and nothing else', () => {
  const prompt = imagePrompt({ prompt: '  a lighthouse ' })
  assert.match(prompt, /Make one picture .* then stop/)
  assert.match(prompt, /^Picture: a lighthouse$/m)
  assert.doesNotMatch(prompt, /Shape:|Look at these/)
})

test('generate_image checks its arguments before Codex is asked, and answers with the file\'s path', async () => {
  const calls: unknown[] = []
  const runner = { generate: async (brief: unknown, forChat: unknown) => { calls.push([brief, forChat]); return { path: '/kept/kite.png', name: 'kite.png', width: 1024, height: 768, caption: 'a kite' } } }
  const [tool] = imageTools(() => runner as unknown as ImageRunner)
  const context = { provider: 'claude' as const, chatId: 'c1' }

  for (const [args, code] of [
    [{}, 'IMAGE_PROMPT'],
    [{ prompt: 'x', aspect: 'wide' }, 'IMAGE_ASPECT'],
    [{ prompt: 'x', reference_images: ['relative.png'] }, 'IMAGE_REFERENCES'],
    [{ prompt: 'x', reference_images: ['/a', '/b', '/c', '/d', '/e'] }, 'IMAGE_REFERENCES']
  ] as const) {
    const result = await tool!.run(args, context)
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent?.error?.code, code)
  }
  assert.deepEqual(calls, [], 'a bad call never reaches Codex')

  const ok = await tool!.run({ prompt: 'a kite', aspect: 'square', reference_images: ['/ref/a.png'] }, context)
  assert.equal(ok.isError, undefined)
  assert.match(ok.content[0]!.type === 'text' ? ok.content[0]!.text : '', /1024×768 picture, saved at \/kept\/kite\.png/)
  assert.deepEqual(calls, [[{ prompt: 'a kite', aspect: 'square', references: ['/ref/a.png'] }, 'c1']])
})

test('a failed run reaches the caller as an error it can read', async () => {
  const runner = { generate: async () => { throw new Error('Codex did not finish the picture in 5 minutes. Try again.') } }
  const [tool] = imageTools(() => runner as unknown as ImageRunner)
  const result = await tool!.run({ prompt: 'a kite' }, { provider: 'claude', chatId: null })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent?.error?.code, 'IMAGE_GENERATION')
  assert.match(result.structuredContent?.error?.message ?? '', /did not finish the picture/)
  assert.equal(existsSync('/kept/kite.png'), false)
})

test('the asking chat shows the picture as it is made: dots first, then the picture, or the reason there is none', async () => {
  let images: ImageRunner | undefined
  let outcome: 'done' | 'failed' = 'done'
  const seen: Array<{ status: string }> = []
  let open: () => void = () => {}
  let gate: Promise<void> = Promise.resolve()
  const ctx = setup(async (request, sink) => {
    if (request.cwd.startsWith(images!.root + '/')) await gate
    if (request.cwd.startsWith(images!.root + '/')) return outcome === 'done' ? picture(request, sink) : { status: 'failed', error: 'Not signed in' }
    // The asking provider's turn: it calls the tool and watches its own chat while it waits.
    gate = new Promise<void>((resolve) => { open = resolve })
    const call = images!.generate({ prompt: 'a red kite' }, request.chatId).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    seen.push(...ctx.hub.turnItems(request.chatId, request.turnId).flatMap((item) => (item.type === 'image' ? [{ status: item.status }] : [])))
    open()
    await call
    return { status: 'completed' }
  })
  images = ctx.images
  for (const wanted of ['done', 'failed'] as const) {
    outcome = wanted
    seen.length = 0
    const chat = ctx.hub.createChat('/home/me/code')
    const turnId = ctx.hub.send(chat.id, 'claude', null, 'make a kite')
    await ctx.hub.waitForTurn(chat.id, { turnId })
    const item = ctx.hub.turnItems(chat.id, turnId).find((entry) => entry.type === 'image')
    assert.equal(item?.type === 'image' && item.status, wanted)
    assert.equal(item?.type === 'image' && item.caption.length > 0, true)
    if (wanted === 'done') assert.equal(item?.type === 'image' && item.image?.width, 1)
    else assert.match(item?.type === 'image' ? item.error ?? '' : '', /Not signed in/)
    assert.equal(seen.length, 1, 'one picture item, shown while the tool still waits')
    assert.equal(seen[0]!.status, 'generating', 'and it was the placeholder then')
  }
  ctx.store.close()
})

test('every role may make a picture, workers included, and its description points at craft_open', () => {
  for (const role of ['ordinary', 'leader', 'worker'] as const) assert.equal(toolAllowed(role, 'generate_image'), true, role)
  const [tool] = imageTools(() => { throw new Error('not called') })
  assert.match(tool!.description, /craft_open/)
  assert.doesNotMatch(tool!.description, /photocraft|PhotoCraft|Rocket/)
})

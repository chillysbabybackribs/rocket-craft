import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HostEvent } from '../shared/types.ts'
import { Hub, type TurnTiming } from './hub.ts'
import { unavailableUsage, type OpenUnprompted, type PrepareRequest, type ProviderAdapter, type RunRequest, type RunResult, type TurnSink } from './providers/provider.ts'
import { Store } from './store.ts'
import type { FileAttachment, ImageAttachment } from '../shared/types.ts'
import { AttachmentStore } from './attachments.ts'
import { jpegBase64 } from '../../tests/fixtures/image.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('image-only messages, queues, restart restoration and provider handoffs retain image references', async () => {
  const store = new Store(':memory:')
  const first = new FakeAdapter()
  const second = new FakeAdapter()
  const adapters = { claude: first, codex: second, cursor: second, antigravity: second }
  const image: ImageAttachment = { id: 'image-1', name: 'screen.png', mimeType: 'image/png', size: 100, width: 10, height: 10 }
  const hub = new Hub(store, adapters, () => {}, undefined, null, ids => ids.map(id => ({ ...image, id, path: `/images/${id}.png` })))
  const chat = hub.createChat('/work')
  await hub.post(chat.id, 'claude', null, '', [image])
  const initial = hub.openChat(chat.id).items.find(item => item.type === 'user')
  assert.equal(initial?.type === 'user' && initial.attachments?.[0].id, image.id)
  assert.equal(first.ran[0].attachments?.[0].path, '/images/image-1.png')
  await hub.post(chat.id, 'claude', null, 'Another view', [image])
  assert.equal(hub.queued(chat.id)[0].taking, undefined, 'images never steer a live turn')
  const restored = new Hub(store, adapters, () => {})
  assert.deepEqual(restored.queued(chat.id)[0].attachments, [image])
  assert.deepEqual(hub.unqueue(chat.id, hub.queued(chat.id)[0].id), { text: 'Another view', attachments: [image] })
  await hub.post(chat.id, 'claude', null, '', [image])
  assert.deepEqual(hub.withdraw(chat.id), { text: '', attachments: [image] })
  first.complete()
  await hub.waitForTurn(chat.id)
  await hub.post(chat.id, 'codex', null, 'Compare with the earlier screen')
  assert.deepEqual(second.ran[0].handoff?.attachments, [image])
  assert.equal(second.ran[0].attachments?.[0].id, image.id)
  second.lose()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.ran[1].sessionId, null)
  assert.equal(second.ran[1].attachments?.[0].id, image.id)
  second.complete()
  await hub.waitForTurn(chat.id)
  await assert.rejects(hub.post(chat.id, 'antigravity', null, '', [image]), /cannot receive images/)
  // Files travel as text, so a text-only provider takes them.
  const file: FileAttachment = { kind: 'file', id: 'file-1', name: 'brief.pdf', format: 'pdf', mimeType: 'application/pdf', size: 100, chars: 20, pages: 1 }
  await hub.post(chat.id, 'antigravity', null, 'Read this', [file])
  assert.equal(second.ran.at(-1)?.attachments?.[0].id, file.id)
  second.complete()
  await hub.waitForTurn(chat.id)
  store.close()
})

/** An adapter that records what it was asked and answers a turn when the test says so. */
class FakeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const
  prepared: PrepareRequest[] = []
  ran: RunRequest[] = []
  forgotten: string[] = []
  answer: ((sink: TurnSink) => void) | null = null
  private finish: ((result: RunResult) => void) | null = null

  run(request: RunRequest, sink: TurnSink): Promise<RunResult> {
    this.ran.push(request)
    sink.session('session-1')
    this.answer?.(sink)
    return new Promise((resolve) => { this.finish = resolve })
  }
  complete(): void { this.finish?.({ status: 'completed' }) }
  protected finishWith(result: RunResult): void { this.finish?.(result) }
  fail(): void { this.finish?.({ status: 'failed', error: 'boom' }) }
  lose(): void { this.finish?.({ status: 'failed', sessionLost: true }) }
  async prepare(request: PrepareRequest): Promise<void> { this.prepared.push(request) }
  async stop(): Promise<void> {}
  forget(chatId: string): void { this.forgotten.push(chatId) }
  async usage() { return unavailableUsage('claude', 'test') }
  async models() { return [] }
  shutdown(): void {}
}

function setup() {
  const adapter = new FakeAdapter()
  const events: HostEvent[] = []
  const timings: TurnTiming[] = []
  const adapters = { claude: adapter, codex: adapter, cursor: adapter, antigravity: adapter }
  const hub = new Hub(new Store(':memory:'), adapters, (event) => events.push(event), (timing) => timings.push(timing))
  const ended = (): Promise<void> => new Promise((resolve) => {
    const poll = (): void => (timings.length ? resolve() : void setImmediate(poll))
    poll()
  })
  return { adapter, hub, timings, ended }
}

test('waitForTurn resolves when the turn ends', async () => {
  const { adapter, hub } = setup()
  const chat = hub.createChat('/work')
  const turnId = hub.send(chat.id, 'claude', null, 'hello')
  const pending = hub.waitForTurn(chat.id, { turnId, timeoutMs: 5_000 })
  adapter.complete()
  const turn = await pending
  assert.equal(turn.id, turnId)
  assert.equal(turn.status, 'completed')
})

test('prepare hands the provider the chat folder and the session it would resume', async () => {
  const { adapter, hub, ended } = setup()
  const chat = hub.createChat('/work')
  await hub.prepare(chat.id, 'claude', 'm1', '/elsewhere')
  assert.deepEqual(adapter.prepared, [{ chatId: chat.id, cwd: '/work', sessionId: null, model: 'm1' }])

  hub.send(chat.id, 'claude', null, 'hello')
  await hub.prepare(chat.id, 'claude', null, '/work')
  assert.equal(adapter.prepared.length, 1, 'a chat that is answering is left alone')
  adapter.complete()
  await ended()

  await hub.prepare(chat.id, 'claude', null, '/work')
  assert.equal(adapter.prepared[1]!.sessionId, 'session-1')
})

test('prepare for the next new chat passes the folder it will start in, and never throws', async () => {
  const { adapter, hub } = setup()
  await hub.prepare(null, 'claude', null, '/next')
  assert.deepEqual(adapter.prepared, [{ chatId: null, cwd: '/next', sessionId: null, model: null }])
  adapter.prepare = async () => { throw new Error('not installed') }
  await hub.prepare(null, 'claude', null, '/next')
  await hub.prepare('no-such-chat', 'claude', null, '/next')
})

test('a turn reports when it first showed anything and when it first showed text', async () => {
  const { adapter, hub, timings, ended } = setup()
  const chat = hub.createChat('/work')
  adapter.answer = (sink) => {
    sink.item({ type: 'tool', id: 'tool', turnId: 't', kind: 'read', label: 'file', status: 'running', output: '' })
    sink.item({ type: 'assistant', id: 'a', turnId: 't', text: '', streaming: true })
  }
  hub.send(chat.id, 'claude', null, 'hello')
  assert.equal(timings.length, 0)
  adapter.complete()
  await ended()
  assert.equal(timings[0]!.status, 'completed')
  assert.equal(typeof timings[0]!.firstEventMs, 'number')
  assert.equal(timings[0]!.firstTextMs, null, 'an empty reply row and a tool call are not text')

  timings.length = 0
  adapter.answer = (sink) => {
    sink.item({ type: 'assistant', id: 'b', turnId: 't', text: '', streaming: true })
    sink.delta('b', 'Hi')
  }
  hub.send(chat.id, 'claude', null, 'again')
  adapter.complete()
  await ended()
  assert.ok(timings[0]!.firstTextMs !== null && timings[0]!.firstTextMs >= timings[0]!.firstEventMs!)
})

test('changing the folder drops every provider\'s warm session for the chat', () => {
  const { adapter, hub } = setup()
  const chat = hub.createChat('/work')
  hub.setCwd(chat.id, '/work')
  assert.equal(adapter.forgotten.length, 0, 'the same folder changes nothing')
  hub.setCwd(chat.id, '/other')
  assert.deepEqual(adapter.forgotten, [chat.id, chat.id, chat.id, chat.id])
})

test('a failed turn the provider had started answering is not handed back to it', async () => {
  const { adapter, hub, timings, ended } = setup()
  const chat = hub.createChat('/work')
  adapter.answer = (sink) => sink.item({ type: 'assistant', id: 'a', turnId: 't', text: 'half an answer', streaming: true })
  hub.send(chat.id, 'claude', null, 'first')
  adapter.fail()
  await ended()

  timings.length = 0
  adapter.answer = null
  hub.send(chat.id, 'claude', null, 'second')
  assert.equal(adapter.ran[1]!.handoff, null)
  adapter.fail()
  await ended()

  // That one failed before the provider did anything, so its message is still owed.
  timings.length = 0
  hub.send(chat.id, 'claude', null, 'third')
  assert.equal(adapter.ran[2]!.handoff?.turns, 1)
  assert.match(adapter.ran[2]!.handoff!.text, /second/)
  adapter.complete()
  await ended()
})

test('a session that was lost is told the app\'s context again', async () => {
  const adapter = new FakeAdapter()
  const timings: TurnTiming[] = []
  const asked: boolean[] = []
  const adapters = { claude: adapter, codex: adapter, cursor: adapter, antigravity: adapter }
  const hub = new Hub(new Store(':memory:'), adapters, () => {}, (timing) => timings.push(timing), async (_chat, _provider, fresh) => {
    asked.push(fresh)
    return fresh ? '<tabs>' : null
  })
  const ended = async (): Promise<void> => { while (!timings.length) await new Promise((resolve) => setImmediate(resolve)) }
  const chat = hub.createChat('/work')
  hub.send(chat.id, 'claude', null, 'one')
  await new Promise((resolve) => setImmediate(resolve))
  adapter.complete()
  await ended()

  timings.length = 0
  hub.send(chat.id, 'claude', null, 'two')
  await new Promise((resolve) => setImmediate(resolve))
  adapter.lose()
  await new Promise((resolve) => setImmediate(resolve))
  adapter.complete()
  await ended()
  assert.deepEqual(asked, [true, false, true])
  assert.deepEqual(adapter.ran.map((request) => request.text), ['<tabs>\n\none', 'two', '<tabs>\n\ntwo'])
})

test('a turn the provider starts by itself is recorded, replied in, and settled', async () => {
  const adapter = new FakeAdapter()
  const claude = new FakeAdapter()
  const opener: { open: OpenUnprompted | null } = { open: null }
  ;(claude as ProviderAdapter).onUnprompted = (open) => { opener.open = open }
  const events: HostEvent[] = []
  const adapters = { claude, codex: adapter, cursor: adapter, antigravity: adapter }
  const store = new Store(':memory:')
  const hub = new Hub(store, adapters, (event) => events.push(event))
  const open = opener.open
  assert.ok(open, 'the hub registers with adapters that can start turns')
  const chat = hub.createChat('/work')

  const opened = open!(chat.id, 'Finished in the background: research')!
  assert.equal(hub.isRunning(chat.id), true)
  assert.equal(open!(chat.id, 'again'), null, 'a busy chat takes no second turn')
  opened.sink.session('session-9')
  opened.sink.item({ type: 'assistant', id: `${opened.turnId}:a`, turnId: opened.turnId, text: 'Here is the synthesis.', streaming: false })
  opened.finish({ status: 'completed' })

  const snapshot = hub.openChat(chat.id)
  assert.equal(snapshot.turns[0]!.status, 'completed')
  assert.deepEqual(snapshot.items.map((item) => item.type), ['notice', 'assistant'])
  assert.equal(hub.isRunning(chat.id), false)
  assert.equal(store.session(chat.id, 'claude').sessionId, 'session-9')
  assert.equal(store.session(chat.id, 'claude').seenTurnSeq, store.turns(chat.id)[0]!.seq, 'the session holds its own turn')
  assert.equal(open!('no-such-chat', 'x'), null)
})

/** A fake whose turns take the user's words while they run, until told not to. */
class SteeringAdapter extends FakeAdapter {
  steered: Array<{ chatId: string; text: string; taken: () => void }> = []
  takes = true
  async steer(chatId: string, text: string, taken: () => void): Promise<boolean> {
    if (!this.takes) return false
    this.steered.push({ chatId, text, taken })
    return true
  }
  interrupted(): void { this.finishWith({ status: 'interrupted' }) }
}

function steerSetup() {
  const claude = new SteeringAdapter()
  const cursor = new FakeAdapter()
  const events: HostEvent[] = []
  const timings: TurnTiming[] = []
  const hub = new Hub(new Store(':memory:'), { claude, codex: cursor, cursor, antigravity: cursor }, (event) => events.push(event), (timing) => timings.push(timing))
  const ended = (count: number): Promise<void> => new Promise((resolve) => {
    const poll = (): void => (timings.length >= count ? resolve() : void setImmediate(poll))
    poll()
  })
  const queueOf = (chatId: string): string[] => {
    const last = events.findLast((event) => event.type === 'queue' && event.chatId === chatId)
    return last?.type === 'queue' ? last.queued.map((entry) => entry.text) : []
  }
  return { claude, cursor, hub, ended, queueOf }
}

test('words sent to the provider answering join its turn, told not to acknowledge them', async () => {
  const { claude, hub, ended } = steerSetup()
  const chat = hub.createChat('/work')
  const turnId = hub.send(chat.id, 'claude', null, 'Restyle settings')
  await hub.post(chat.id, 'claude', null, '  Leave the account section  ')

  assert.equal(claude.ran.length, 1, 'no second turn')
  assert.match(claude.steered[0]!.text, /do not stop to acknowledge/)
  assert.match(claude.steered[0]!.text, /Leave the account section$/)
  const users = (): Array<[string, string, boolean]> => hub.openChat(chat.id).items
    .flatMap((item) => (item.type === 'user' ? [[item.turnId, item.text, item.steer === true] as [string, string, boolean]] : []))
  assert.deepEqual(users(), [[turnId, 'Restyle settings', false]], 'not in the turn until the model reads it')
  assert.deepEqual(hub.queued(chat.id).map((entry) => [entry.text, entry.taking]), [['Leave the account section', true]])

  claude.steered[0]!.taken()
  assert.deepEqual(users(), [[turnId, 'Restyle settings', false], [turnId, 'Leave the account section', true]])
  assert.deepEqual(hub.queued(chat.id), [])
  claude.complete()
  await ended(1)
})

test('words a turn never said it read are kept when it completes, and sent next when it is stopped', async () => {
  const { claude, hub, ended } = steerSetup()
  const chat = hub.createChat('/work')
  const first = hub.send(chat.id, 'claude', null, 'One')
  await hub.post(chat.id, 'claude', null, 'unannounced')
  claude.complete()
  await ended(1)
  assert.deepEqual(hub.openChat(chat.id).items.filter((item) => item.type === 'user').map((item) => [item.turnId, item.text]), [
    [first, 'One'], [first, 'unannounced']
  ], 'recorded, not sent twice')

  hub.send(chat.id, 'claude', null, 'Two')
  await hub.post(chat.id, 'claude', null, 'cut off')
  await hub.stop(chat.id)
  claude.interrupted()
  await ended(2)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(claude.ran.length, 3, 'the stop dropped them, so they are the next message')
  assert.match(claude.ran[2]!.text, /cut off$/)
  claude.complete()
  await ended(3)
})

test('Stop gives back words on their way into the turn with those waiting for it', async () => {
  const { claude, hub, ended } = steerSetup()
  const chat = hub.createChat('/work')
  hub.send(chat.id, 'claude', null, 'Start')
  await hub.post(chat.id, 'claude', null, 'on its way')
  await hub.post(chat.id, 'cursor', null, 'waiting')
  assert.equal(hub.withdraw(chat.id), 'on its way\n\nwaiting')
  await hub.stop(chat.id)
  claude.interrupted()
  await ended(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(claude.ran.length, 1, 'nothing is sent after the stop')
  assert.deepEqual(hub.openChat(chat.id).items.filter((item) => item.type === 'user').length, 1)
})

test('words for a provider that cannot take them wait, and go out together when the turn ends', async () => {
  const { claude, cursor, hub, ended, queueOf } = steerSetup()
  const chat = hub.createChat('/work')
  hub.send(chat.id, 'cursor', null, 'Find the blank tab bug')
  await hub.post(chat.id, 'cursor', null, 'Only with more than five tabs')
  await hub.post(chat.id, 'claude', 'opus', 'And check the restore order')

  assert.equal(cursor.ran.length, 1)
  assert.deepEqual(queueOf(chat.id), ['Only with more than five tabs', 'And check the restore order'])
  assert.deepEqual(hub.openChat(chat.id).queued!.map((entry) => entry.provider), ['cursor', 'claude'])
  cursor.complete()
  await ended(1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(claude.ran.length, 1, 'the latest waiting message picks the provider')
  assert.equal(claude.ran[0]!.model, 'opus')
  assert.match(claude.ran[0]!.text, /Only with more than five tabs\n\nAnd check the restore order$/)
  assert.deepEqual(queueOf(chat.id), [])
  claude.complete()
  await ended(2)
})

test('a turn that cannot take words leaves them waiting, and later words keep their place behind them', async () => {
  const { claude, hub, ended, queueOf } = steerSetup()
  const chat = hub.createChat('/work')
  hub.send(chat.id, 'claude', null, 'Start')
  claude.takes = false
  await hub.post(chat.id, 'claude', null, 'first')
  claude.takes = true
  await hub.post(chat.id, 'claude', null, 'second')
  assert.equal(claude.steered.length, 0, 'not steered past a waiting message')
  assert.deepEqual(queueOf(chat.id), ['first', 'second'])

  const [first] = hub.queued(chat.id)
  assert.equal(hub.unqueue(chat.id, first!.id), 'first')
  assert.equal(hub.withdraw(chat.id), 'second')
  assert.equal(hub.withdraw(chat.id), null)
  claude.complete()
  await ended(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(claude.ran.length, 1, 'nothing was left to send')
})

for (const retry of [false, true]) {
  test(`Stop during ${retry ? 'lost-session retry' : 'initial'} context prevents provider startup`, async () => {
    const store = new Store(':memory:')
    const adapter = new FakeAdapter()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    let contexts = 0
    const hub = new Hub(store, { claude: adapter, codex: adapter, cursor: adapter, antigravity: adapter }, () => {}, () => {}, async () => {
      if (++contexts === (retry ? 2 : 1)) await waiting
      return null
    })
    const chat = hub.createChat('/work')
    hub.send(chat.id, 'claude', null, 'hello')
    if (retry) {
      await new Promise((resolve) => setImmediate(resolve))
      adapter.lose()
      await new Promise((resolve) => setImmediate(resolve))
    }
    await hub.stop(chat.id)
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(adapter.ran.length, retry ? 1 : 0)
    assert.equal(hub.isRunning(chat.id), false)
    assert.equal(store.turns(chat.id)[0]!.status, 'interrupted')
    store.close()
  })
}

test("a turn's tokens are kept on it and reported with its timing; the latest reading wins", async () => {
  const { adapter, hub, timings, ended } = setup()
  const chat = hub.createChat('/work')
  adapter.answer = (sink) => {
    sink.tokens({ input: 10, cached: 0, output: 1, context: 10, contextWindow: null })
    sink.tokens({ input: 900, cached: 800, output: 40, context: 500, contextWindow: 200_000 })
  }
  hub.send(chat.id, 'claude', null, 'hello')
  adapter.complete()
  await ended()
  const tokens = { input: 900, cached: 800, output: 40, context: 500, contextWindow: 200_000 }
  assert.deepEqual(timings[0]!.tokens, tokens)
  assert.deepEqual(hub.openChat(chat.id).turns[0]!.tokens, tokens)
})

test('a page leaves finished tool output out and serves it on request; the turn in flight keeps its own', async () => {
  const { adapter, hub, ended } = setup()
  const chat = hub.createChat('/work')
  const turnId = (): string => adapter.ran.at(-1)!.turnId
  adapter.answer = (sink) => sink.item({ type: 'tool', id: 'done-call', turnId: turnId(), kind: 'command', label: 'ls', status: 'done', output: 'a.txt\nb.txt' })
  hub.send(chat.id, 'claude', null, 'list')
  adapter.complete()
  await ended()
  const finished = hub.openChat(chat.id).items.find((item) => item.id === 'done-call')
  assert.deepEqual(finished?.type === 'tool' && [finished.output, finished.outputLength], ['', 11])
  assert.equal(hub.itemOutput(chat.id, 'done-call'), 'a.txt\nb.txt')
  assert.throws(() => hub.itemOutput(chat.id, 'no-such-step'), /no longer in this chat/)

  adapter.answer = (sink) => sink.item({ type: 'tool', id: 'live-call', turnId: turnId(), kind: 'command', label: 'cat', status: 'done', output: 'streamed so far' })
  hub.send(chat.id, 'claude', null, 'again')
  const live = hub.openChat(chat.id).items.find((item) => item.id === 'live-call')
  assert.deepEqual(live?.type === 'tool' && [live.output, live.outputLength], ['streamed so far', undefined])
  adapter.complete()
})

test('a turn records the pages it opened against the pages its reply cites, and the next message is told of the unopened ones', async () => {
  const { adapter, hub, ended } = setup()
  const chat = hub.createChat('/work')
  adapter.answer = (sink) => {
    sink.item({ type: 'tool', id: 'w1', turnId: 't', kind: 'web', label: 'linux desktop app', status: 'done', output: '' })
    sink.item({ type: 'tool', id: 'w2', turnId: 't', kind: 'web', label: 'https://developers.example.com/docs/', status: 'done', output: 'The official release documentation.' })
    hub.noteOpened(chat.id, 'https://help.example.com/article#top')
    hub.noteOpened('no-such-chat', 'https://nowhere.example.com/')
    sink.item({ type: 'assistant', id: 'a1', turnId: 't', text: 'Per [the docs](https://developers.example.com/docs) and https://help.example.com/article, yes. News: https://news.example.org/story.', streaming: false })
  }
  hub.send(chat.id, 'claude', null, 'Is it out?')
  adapter.complete()
  await ended()
  const turn = hub.openChat(chat.id).turns.at(-1)!
  assert.deepEqual(turn.sources, {
    opened: [{ url: 'https://developers.example.com/docs/', via: 'provider' }, { url: 'https://help.example.com/article#top', via: 'browser' }],
    cited: [
      { url: 'https://developers.example.com/docs', opened: true },
      { url: 'https://help.example.com/article', opened: true },
      { url: 'https://news.example.org/story', opened: false }
    ]
  })
  adapter.answer = null
  hub.send(chat.id, 'codex', null, 'And the price?')
  assert.match(adapter.ran[1]!.text, /^<sources>\nThe last reply in this chat cited a page its turn never opened: https:\/\/news\.example\.org\/story\./)
  assert.ok(adapter.ran[1]!.text.endsWith('\n\nAnd the price?'))
  adapter.complete()
  await hub.waitForTurn(chat.id)
  assert.equal(hub.openChat(chat.id).turns.at(-1)!.sources, null, 'a reply that cites nothing has no record')
  hub.send(chat.id, 'claude', null, 'Thanks')
  assert.equal(adapter.ran[2]!.text, 'Thanks', 'the notice is for the message right after the reply')
  adapter.complete()
})

test('all providers reject textual fetch failures and search URLs as citation evidence', async () => {
  const { adapter, hub, ended } = setup()
  const chat = hub.createChat('/work')
  adapter.answer = sink => {
    for (const [id, label, output] of [
      ['blocked', 'https://example.org/blocked', 'The server returned HTTP 403 Forbidden.'],
      ['pdf', 'https://example.org/paper.pdf', 'The content is a raw PDF file dump: compressed binary streams.'],
      ['empty', 'https://example.org/empty', ''],
      ['search', 'https://www.google.com/search?q=research', 'Search leads and snippets']
    ]) sink.item({ type: 'tool', id: id!, turnId: adapter.ran.at(-1)!.turnId, kind: 'web', label: label!, status: 'done', output: output! })
    sink.item({ type: 'assistant', id: 'a', turnId: adapter.ran.at(-1)!.turnId, streaming: false, text: 'https://example.org/blocked https://example.org/paper.pdf https://example.org/empty' })
  }
  hub.send(chat.id, 'claude', null, 'Research')
  adapter.complete()
  await ended()
  const result = hub.openChat(chat.id)
  assert.deepEqual(result.turns.at(-1)!.sources!.opened, [])
  assert.ok(result.turns.at(-1)!.sources!.cited.every(c => !c.opened))
  const blocked = result.items.find(i => i.type === 'tool' && i.label === 'https://example.org/blocked')
  assert.equal(blocked?.type === 'tool' && blocked.status, 'failed')
})

test('a picture a provider made is shown from Craft Studio\'s own copy, ends its turn saved, and is named in the next handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-hub-images-'))
  const store = new Store(':memory:')
  try {
    const attachments = new AttachmentStore(store, join(root, 'attachments'))
    const adapter = new FakeAdapter()
    const events: HostEvent[] = []
    const hub = new Hub(store, { claude: adapter, codex: adapter, cursor: adapter, antigravity: adapter }, (event) => events.push(event),
      () => {}, null, (ids) => attachments.resolve(ids), (source, caption) => attachments.keepGenerated(source, caption))
    const made = join(root, 'made.jpg')
    await writeFile(made, Buffer.from(jpegBase64, 'base64'))
    adapter.answer = (sink) => {
      const turnId = adapter.ran.at(-1)!.turnId
      sink.item({ type: 'image', id: `${turnId}:g1`, turnId, status: 'generating', caption: 'A neon horizon' })
      sink.item({ type: 'image', id: `${turnId}:g1`, turnId, status: 'done', caption: 'A neon horizon', source: { path: made, base64: jpegBase64 } })
      sink.item({ type: 'image', id: `${turnId}:g2`, turnId, status: 'generating', caption: 'A second one' })
      sink.item({ type: 'assistant', id: `${turnId}:a`, turnId, text: 'Here it is.', streaming: false })
    }
    const chat = hub.createChat(root)
    const turnId = hub.send(chat.id, 'codex', null, 'make a neon horizon')
    const ended = hub.waitForTurn(chat.id, { turnId, timeoutMs: 5_000 })
    adapter.complete()
    await ended

    const items = hub.openChat(chat.id).items
    const [kept, unfinished] = items.filter((item) => item.type === 'image')
    assert.equal(kept?.type === 'image' && kept.status, 'done')
    assert.equal(typeof (kept?.type === 'image' && kept.startedAt), 'number', 'stamped when first reported, for the placeholder\'s clock')
    const image = kept?.type === 'image' ? kept.image : undefined
    assert.ok(image, 'the item shows Craft Studio\'s copy')
    assert.equal(unfinished?.type === 'image' && unfinished.error, 'The turn ended before the image was finished. Ask for it again.')
    assert.deepEqual(items.map((item) => item.type), ['user', 'image', 'image', 'assistant'], 'the picture keeps its place in the reply')
    assert.ok(!JSON.stringify(events).includes(jpegBase64.slice(0, 40)), 'the provider\'s bytes never leave the hub')
    assert.ok(!JSON.stringify(store.turnItems(chat.id, turnId)).includes('"source"'))

    adapter.answer = null
    const next = hub.send(chat.id, 'claude', null, 'now describe it')
    const nextEnded = hub.waitForTurn(chat.id, { turnId: next, timeoutMs: 5_000 })
    await new Promise((resolve) => setImmediate(resolve))
    const handoff = adapter.ran.at(-1)!.handoff
    assert.ok(handoff?.text.includes(`made an image from the prompt "A neon horizon": ${attachments.resolve([image!.id])[0]!.path} (2×2;`), handoff?.text)
    adapter.complete()
    await nextEnded
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

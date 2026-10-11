import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HostEvent } from '../../shared/types.ts'
import { Hub } from '../hub.ts'
import { unavailableUsage, type ProviderAdapter, type RunResult, type TurnSink } from '../providers/provider.ts'
import { Store } from '../store.ts'
import { answerMessage, askTools, parseQuestion } from './ask.ts'

const options = [
  { label: 'Postgres', detail: 'What the other services use; one more database to run locally.' },
  { label: 'SQLite', detail: 'Nothing to install; harder to share between machines.' }
]

test('a question needs real options, their consequences and the model\'s own pick', () => {
  assert.match(parseQuestion({}) as string, /Give the question/)
  assert.match(parseQuestion({ question: 'Which database?', options: [options[0]], recommended: 0 }) as string, /2 to 4 options/)
  assert.match(parseQuestion({ question: 'Which database?', options: [...options, ...options, options[0]], recommended: 0 }) as string, /at most 4/)
  assert.match(parseQuestion({ question: 'Which database?', options: [options[0], { label: 'SQLite' }], recommended: 0 }) as string, /needs a `detail`/)
  assert.match(parseQuestion({ question: 'Which database?', options: [options[0], { ...options[0] }], recommended: 0 }) as string, /same label/)
  assert.match(parseQuestion({ question: 'Which database?', options }) as string, /`recommended`/)
  assert.match(parseQuestion({ question: 'Which database?', options, recommended: 2 }) as string, /`recommended`/)
  assert.deepEqual(parseQuestion({ question: ' Which database? ', options, recommended: 1 }), { text: 'Which database?', options, recommended: 1 })
})

test('the answer goes to the model with the question quoted above it', () => {
  const question = { type: 'question' as const, id: 'q', turnId: 't', text: 'Which database?', options, recommended: 0, answer: null }
  assert.equal(answerMessage(question, 'SQLite'), '> Which database?\n\nSQLite')
})

/** An adapter whose turn stays open until the test ends it, so a tool can be called mid-turn. */
class OpenAdapter implements ProviderAdapter {
  readonly id = 'claude' as const
  private finish: ((result: RunResult) => void) | null = null
  run(_request: unknown, sink: TurnSink): Promise<RunResult> {
    sink.session('s')
    return new Promise((resolve) => { this.finish = resolve })
  }
  complete(): void { this.finish?.({ status: 'completed' }) }
  async prepare(): Promise<void> {}
  async stop(): Promise<void> {}
  forget(): void {}
  async usage() { return unavailableUsage('claude', 'test') }
  async models() { return [] }
  shutdown(): void {}
}

function setup() {
  const adapter = new OpenAdapter()
  const events: HostEvent[] = []
  let ended = 0
  const adapters = { claude: adapter, codex: adapter, cursor: adapter, antigravity: adapter }
  const hub = new Hub(new Store(':memory:'), adapters, (event) => events.push(event), () => { ended++ })
  const [tool] = askTools(() => hub)
  const whenEnded = (): Promise<void> => new Promise((resolve) => {
    const poll = (): void => (ended ? resolve() : void setImmediate(poll))
    poll()
  })
  return { adapter, hub, events, tool: tool!, whenEnded }
}

test('ask_user posts one question into the running turn and refuses a second', async () => {
  const { adapter, hub, events, tool, whenEnded } = setup()
  const chat = hub.createChat('/work')
  const context = { provider: 'claude' as const, chatId: chat.id }

  const outside = await tool.run({ question: 'Which database?', options, recommended: 0 }, context)
  assert.equal(outside.isError, true, 'with no turn running there is nowhere to post')

  const turnId = hub.send(chat.id, 'claude', null, 'build the service')
  const first = await tool.run({ question: 'Which database?', options, recommended: 0 }, context)
  assert.equal(first.isError, undefined)
  assert.match(first.content[0]!.type === 'text' ? first.content[0].text : '', /Postgres.*as your pick/)
  const posted = events.find((event) => event.type === 'item' && event.item.type === 'question')
  assert.ok(posted && posted.type === 'item' && posted.item.type === 'question')
  assert.equal(posted.item.turnId, turnId)
  assert.equal(posted.item.answer, null)

  const second = await tool.run({ question: 'Which colour?', options, recommended: 0 }, context)
  assert.equal(second.isError, true)
  assert.match(second.content[0]!.type === 'text' ? second.content[0].text : '', /already asked/)

  adapter.complete()
  await whenEnded()
  // The question is part of the turn's record, and the answer can land after the turn is over.
  const items = hub.turnItems(chat.id, turnId)
  assert.equal(items.filter((item) => item.type === 'question').length, 1)
  const answered = hub.answerQuestion(chat.id, `${turnId}:question`, 'SQLite')
  assert.equal(answered.answer, 'SQLite')
  assert.equal(hub.turnItems(chat.id, turnId).find((item) => item.type === 'question')?.answer, 'SQLite')
  assert.equal(hub.liveQuestion(chat.id), undefined)
})

// Live check of the host core under plain Node: real providers, an in-memory store.
//   node --experimental-transform-types src/host/live-check.ts claude codex cursor antigravity codex
// The first provider is told a codeword; each later one is asked for it, which only works if the
// turns it missed were handed over. Uses a little of each subscription. PREPARE=1 warms each
// provider up before its message, as the app does while one is being typed; compare the
// "first text" times with and without it. ASK=<message> sends that instead of the codeword
// exchange; FULL=1 prints replies whole; ANSWER=1 clicks the suggested option of a question the
// model asked and sends it as the next turn.
import { tmpdir } from 'node:os'
import type { HostEvent, Item, ProviderId, UsageSnapshot } from '../shared/types.ts'
import { describeTiming, Hub } from './hub.ts'
import { stopAllProcessGroups } from './process-tree.ts'
import { AntigravityAdapter } from './providers/antigravity.ts'
import { ClaudeAdapter } from './providers/claude.ts'
import { CodexAdapter } from './providers/codex.ts'
import { CursorAdapter } from './providers/cursor.ts'
import { Store } from './store.ts'
import { answerMessage, askTools } from './tools/ask.ts'
import { browserTools } from './tools/browser.ts'
import { ToolChannel } from './tools/channel.ts'
import { ToolRegistry } from './tools/registry.ts'

const order = process.argv.slice(2) as ProviderId[]
const store = new Store(':memory:')
const waiters = new Map<string, () => void>()
let deltas = 0
/** The last question a model asked, for ANSWER=1 to click its suggested option. */
let asked: Extract<Item, { type: 'question' }> | null = null
const takeQuestion = (): Extract<Item, { type: 'question' }> | null => {
  const question = asked
  asked = null
  return question
}
const emit = (event: HostEvent): void => {
  if (event.type === 'delta') { deltas += 1; return }
  if (event.type === 'item') {
    const item = event.item
    if (item.type === 'assistant' && !item.streaming) console.log(`   assistant: ${process.env.FULL === '1' ? item.text : item.text.replace(/\s+/g, ' ').slice(0, 200)}`)
    if (item.type === 'tool' && item.status !== 'running') console.log(`   tool[${item.kind}/${item.status}]: ${item.label.slice(0, 80)} → ${item.output.replace(/\s+/g, ' ').slice(0, 60)}`)
    if (item.type === 'notice') console.log(`   notice: ${item.text}`)
    if (item.type === 'question' && item.answer === null) {
      asked = item
      console.log(`   question: ${item.text}`)
      for (const [index, option] of item.options.entries()) console.log(`     ${index === item.recommended ? '*' : ' '} ${option.label} — ${option.detail}`)
    }
  }
  if (event.type === 'turn' && event.turn.status !== 'running') {
    const turn = event.turn
    console.log(`   = ${turn.provider} ${turn.status} model=${turn.model} handoff=${turn.handoffTurns} ${((turn.endedAt! - turn.startedAt) / 1000).toFixed(1)}s deltas=${deltas}${turn.error ? ` error=${turn.error}` : ''}`)
    deltas = 0
    waiters.get(turn.chatId)?.()
  }
}
// The app's tools are served for real, but the browser is the app's, so a call to one answers
// that it is unavailable: ASK='Call browser_read on https://example.com ...' checks that a
// provider can reach the tools. Antigravity is registered under a name of its own, so a check
// never moves the running app's entry in agy's config. ask_user is served for real; ANSWER=1
// clicks the suggested option after the turn, as the user would.
const tools = new ToolChannel(
  new ToolRegistry().add(...browserTools({
    request: async () => { throw new Error('PELICAN-42: the browser is only available inside the app') }
  }, tmpdir())).add(...askTools(() => hub)),
  null,
  (provider) => hub.runningChat(provider)
)
await tools.start()
const antigravity = new AntigravityAdapter(tools, 'studio_check')
const onUsage = (snapshot: UsageSnapshot): void => hub.noteUsage(snapshot)
const hub: Hub = new Hub(store, {
  codex: new CodexAdapter(onUsage, tools), claude: new ClaudeAdapter(onUsage, tools), cursor: new CursorAdapter(tools), antigravity
}, emit, (timing) => console.log(`   ⏱ ${describeTiming(timing)}`))

if (process.env.USAGE === '1') {
  for (const provider of new Set(order)) {
    const usage = await hub.usage(provider)
    console.log(`usage ${provider}: plan=${usage.plan} ${usage.windows.map((w) => `${w.label} ${w.percent}%`).join(', ') || usage.unavailable}`)
  }
}
// MODEL_<PROVIDER>=a,b picks the model for that provider's first turn, second turn, and so on.
const models: Partial<Record<ProviderId, string[]>> = {}
for (const provider of new Set(order)) {
  const list = process.env[`MODEL_${provider.toUpperCase()}`]
  if (list) models[provider] = list.split(';')
}
const chat = hub.createChat(process.cwd())
const send = async (provider: ProviderId, text: string): Promise<void> => {
  const model = models[provider]?.shift() ?? null
  if (process.env.PREPARE === '1') {
    const began = performance.now()
    await hub.prepare(chat.id, provider, model, chat.cwd)
    console.log(`\n   prepared ${provider} in ${Math.round(performance.now() - began)}ms`)
  }
  console.log(`\n> [${provider}] ${text}`)
  await new Promise<void>((resolve) => {
    waiters.set(chat.id, resolve)
    hub.send(chat.id, provider, model, text)
  })
}
if (process.env.TURNS !== '0') {
  for (const [index, provider] of order.entries()) {
    if (index === 0 && !process.env.ASK) await send(provider, 'Remember this codeword for later: MANGO-77. Reply with just "ok".')
    else if (process.env.ASK) {
      await send(provider, process.env.ASK)
      const question = takeQuestion()
      if (process.env.ANSWER === '1' && question) {
        const pick = question.options[question.recommended]!.label
        hub.answerQuestion(chat.id, question.id, pick)
        await send(provider, answerMessage(question, pick))
      }
    }
    else await send(provider, `What is the codeword? Also remember the number ${index * 11}. Reply in one short sentence listing the codeword and every number you were asked to remember so far.`)
  }
}
await hub.shutdown()
if (order.includes('antigravity')) await antigravity.unregisterTools()
tools.stop()
stopAllProcessGroups()
process.exit(0)

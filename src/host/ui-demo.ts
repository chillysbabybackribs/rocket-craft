import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ProviderId } from '../shared/types.ts'
import type { RunRequest, RunResult, TurnSink } from './providers/provider.ts'

// Scripted turns for recording a demo video (scripts/demo-video.mjs). The words are fixed, but
// the browser work is real: each tool call goes through the app's own MCP channel, as a
// provider CLI's would, so the browser panel shows what the tools actually do. Only reachable
// from UiTestAdapter, so only in a marked, isolated profile.

type Step = (turn: DemoTurn) => Promise<void>

/** The user's message, as the recording script types it, and what the "model" does with it. */
export const DEMO_TURNS: Record<string, Step> = {
  'File a ticket on the Acme support portal: SSO login fails after the 4.2 update.': async (turn) => {
    await turn.think('The user wants a ticket filed. I will open the portal\'s new-ticket form, read its fields, then fill them all in one script.')
    await turn.say('Opening the support portal\'s new-ticket form.')
    await turn.tool('browser_read', { url: `${turn.origin}/tickets/new` })
    await turn.say('Five fields. Filling them all in one script, without clicking into each one.')
    await turn.tool('browser_run', {
      code: [
        "await tab.fill('#name', 'Dana Parker')",
        "await tab.fill('#email', 'dana@acme.dev')",
        "await tab.fill('#product', 'Acme Identity')",
        "await tab.fill('#subject', 'SSO login fails after the 4.2 update')",
        "await tab.fill('#details', 'Since upgrading to 4.2, signing in with SSO returns to the login page with no error. Password login still works. Seen on Chrome and Firefox.')",
        "return tab.eval(() => Object.fromEntries(new FormData(document.forms[0])))"
      ].join('\n')
    }, 2_200)
    await turn.say('Every field holds the right value. Submitting the form.')
    await turn.tool('browser_run', {
      code: [
        "await tab.eval(() => document.forms[0].requestSubmit())",
        "await tab.waitFor('text=Ticket created')",
        "return tab.read({ focus: 'text', max: 400 })"
      ].join('\n')
    })
    await turn.say('**Filed ticket #4821**, "SSO login fails after the 4.2 update", under Acme Identity. The portal will email dana@acme.dev with updates.')
  },
  'Check that ticket\'s status page. Who is it assigned to?': async (turn) => {
    await turn.say('Reading the ticket\'s status page.')
    await turn.tool('browser_read', { url: `${turn.origin}/tickets/4821` })
    await turn.say('Ticket **#4821** is **Open**, priority **High**, assigned to **Priya Shah** on the Identity team. Her note says a fix is being tested for 4.2.1.')
  },
  'Add a comment asking Priya for an ETA on 4.2.1.': async (turn) => {
    await turn.say('Writing the comment and posting it in one script.')
    await turn.tool('browser_run', {
      code: [
        "await tab.fill('#comment', 'Hi Priya, thanks for picking this up. Do you have an ETA for 4.2.1? Our team is on password login until then.')",
        "await sleep(1500)",
        "await tab.eval(() => document.forms[0].requestSubmit())",
        "await tab.waitFor('text=Comment posted')",
        "return tab.read({ selector: '#comments', focus: 'text' })"
      ].join('\n')
    })
    await turn.say('Posted. The comment is on ticket #4821, and Priya will be notified.')
  }
}

export async function runDemoTurn(step: Step, provider: ProviderId, profile: string, request: RunRequest, sink: TurnSink, signal: AbortSignal): Promise<RunResult> {
  const origin = process.env.CRAFT_UI_TEST_ORIGIN
  if (!origin) return { status: 'failed', error: 'The demo needs CRAFT_UI_TEST_ORIGIN; record it with scripts/demo-video.mjs.' }
  await step(new DemoTurn(provider, profile, request, sink, signal, origin))
  return { status: 'completed' }
}

class DemoTurn {
  private n = 0

  constructor(
    private readonly provider: ProviderId,
    private readonly profile: string,
    private readonly request: RunRequest,
    private readonly sink: TurnSink,
    private readonly signal: AbortSignal,
    readonly origin: string
  ) {}

  private pause(ms: number): Promise<void> {
    return delay(ms, undefined, { signal: this.signal })
  }

  /** Words arrive a few at a time, paced like a model's. */
  async say(text: string): Promise<void> {
    await this.stream('assistant', text, 45)
    await this.pause(500)
  }

  async think(text: string): Promise<void> {
    await this.stream('reasoning', text, 30)
  }

  private async stream(type: 'assistant' | 'reasoning', text: string, ms: number): Promise<void> {
    const id = `${this.request.turnId}:${type}${this.n++}`
    this.sink.item({ type, id, turnId: this.request.turnId, text: '', streaming: true })
    for (const word of text.split(' ')) {
      this.sink.delta(id, `${word} `)
      await this.pause(ms)
    }
    this.sink.item({ type, id, turnId: this.request.turnId, text, streaming: false })
  }

  /** A real call to the app's tool, labelled the way the Claude adapter labels MCP tools. */
  async tool(name: string, args: Record<string, unknown>, after = 600): Promise<void> {
    const id = `${this.request.turnId}:tool${this.n++}`
    const label = `rocket · ${name} ${JSON.stringify(args).slice(0, 120)}`
    this.sink.item({ type: 'tool', id, turnId: this.request.turnId, kind: 'mcp', label, output: '', status: 'running' })
    const { port, secret } = JSON.parse(readFileSync(join(this.profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
    const response = await fetch(`http://127.0.0.1:${port}/mcp/${secret}/${this.provider}/${encodeURIComponent(this.request.chatId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: this.signal
    })
    const { result } = await response.json() as { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> } }
    const output = result?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? ''
    this.sink.item({ type: 'tool', id, turnId: this.request.turnId, kind: 'mcp', label, output, status: result?.isError ? 'failed' : 'done' })
    if (result?.isError) throw new Error(`The demo's ${name} call failed: ${output}`)
    await this.pause(after)
  }
}

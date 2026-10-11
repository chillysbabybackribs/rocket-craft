import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { PROVIDERS, type ProviderId } from '../../shared/types.ts'
import { recordOf, stringOf } from '../json.ts'
import type { ToolRegistry } from './registry.ts'

// How every provider reaches the app's tools: one MCP server on loopback, speaking the
// streamable HTTP transport with plain JSON answers (no streams, no server-held sessions).
// MCP over HTTP is the one channel all four provider CLIs accept.
//
// A session's URL is /mcp/<secret>/<provider>/<key>. The secret keeps other local processes out.
// The key says which chat is calling: it is the chat's id, or an id later tied to a chat with
// `bind` (a process warmed up before its chat exists), or SHARED for a provider whose MCP
// config is global and cannot carry a chat at all.
//
// The port and secret are kept between runs, because a provider with a global MCP config
// (Antigravity) stores the URL outside the app.

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const BODY_LIMIT = 4_000_000

/** The key of a URL that is shared by every chat of a provider. */
export const SHARED = 'shared'

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

export class ToolChannel {
  private server: Server | null = null
  private port = 0
  private secret = ''
  private readonly bound = new Map<string, string>()

  constructor(
    private readonly registry: ToolRegistry,
    /** Where the port and secret are kept between runs; null keeps nothing. */
    private readonly stateFile: string | null,
    /** The one chat a provider is answering right now, for calls that arrive on its SHARED URL. */
    private readonly runningChat: (provider: ProviderId) => string | null = () => null
  ) {}

  async start(): Promise<void> {
    let saved: { port?: unknown; secret?: unknown } = {}
    try {
      if (this.stateFile) saved = JSON.parse(readFileSync(this.stateFile, 'utf8')) as typeof saved
    } catch {
      // First run.
    }
    this.secret = typeof saved.secret === 'string' && saved.secret ? saved.secret : randomBytes(24).toString('base64url')
    const wanted = typeof saved.port === 'number' ? saved.port : 0
    // The last run's port, so stored URLs stay good; any free one when something else has it.
    this.port = await this.listen(wanted).catch(() => this.listen(0))
    try {
      if (this.stateFile) writeFileSync(this.stateFile, JSON.stringify({ port: this.port, secret: this.secret }), { mode: 0o600 })
    } catch {
      // The URL changes next run; providers are told the new one when their sessions start.
    }
  }

  stop(): void {
    this.server?.close()
    this.server?.closeAllConnections()
    this.server = null
  }

  url(provider: ProviderId, key: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${this.secret}/${provider}/${encodeURIComponent(key)}`
  }

  /** Tie a key that was handed out before its chat existed to that chat. */
  /** The tools served here, as `tools/list` gives them. */
  list(chatId?: string): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return this.registry.list(chatId).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }

  bind(key: string, chatId: string): void {
    this.bound.set(key, chatId)
  }

  unbind(key: string): void {
    this.bound.delete(key)
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => { void this.serve(request, response) })
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      })
    })
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([^/]+)\/([^/]+)\/([^/?]+)/.exec(request.url ?? '')
    const provider = PROVIDERS.find((entry) => entry.id === match?.[2])?.id
    if (!match || match[1] !== this.secret || !provider) return void response.writeHead(404).end()
    // There is no server-to-client stream to open and no session to delete.
    if (request.method !== 'POST') return void response.writeHead(405, { Allow: 'POST' }).end()

    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(request))
    } catch {
      return void send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const key = decodeURIComponent(match[3]!)
    const chatId = key === SHARED ? this.runningChat(provider) : this.bound.get(key) ?? key
    const messages = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcMessage[]
    const answers: unknown[] = []
    for (const message of messages) {
      // A message without an id is a notification, and one without a method is a reply: neither is answered.
      if (message?.id === undefined || message.id === null || typeof message.method !== 'string') continue
      answers.push({ jsonrpc: '2.0', id: message.id, ...(await this.answer(message.method, recordOf(message.params), provider, chatId)) })
    }
    if (!answers.length) return void response.writeHead(202).end()
    send(response, 200, Array.isArray(parsed) ? answers : answers[0])
  }

  private async answer(
    method: string, params: Record<string, unknown>, provider: ProviderId, chatId: string | null
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    switch (method) {
      case 'initialize': {
        const asked = stringOf(params.protocolVersion)
        return {
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'craft-studio', title: 'Craft Studio', version: '0.1.0' }
          }
        }
      }
      case 'ping':
        return { result: {} }
      case 'tools/list':
        if (!chatId) return { error: { code: -32000, message: 'The shared tool connection cannot identify one active chat. Run only one Antigravity chat and try again.' } }
        return {
          result: {
            tools: this.list(chatId)
          }
        }
      case 'tools/call':
        if (!chatId) return { error: { code: -32000, message: 'The shared tool connection cannot identify one active chat. Run only one Antigravity chat and try again.' } }
        return { result: await this.registry.call(stringOf(params.name), recordOf(params.arguments), { provider, chatId }) }
      default:
        return { error: { code: -32601, message: `Method not found: ${method}` } }
    }
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('Request too large'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

import type { ProviderAttachment } from '../attachments.ts'
import type { Handoff } from '../handoff.ts'
import { planItemId, type Item, type ModelInfo, type PlanStep, type ProviderId, type TurnStatus, type TurnTokens, type UsageSnapshot } from '../../shared/types.ts'

// The one interface the hub talks to. An adapter owns its provider's process and session
// mechanics and translates the provider's stream into transcript items; it knows nothing about
// other providers, the store, or the renderer.

export type RunRequest = {
  /** Images and files of this message first, then earlier ones a handoff mentions. */
  attachments?: ProviderAttachment[]
  chatId: string
  turnId: string
  cwd: string
  /** The provider's own session for this chat, or null to start one. */
  sessionId: string | null
  /** The model to answer with, from this provider's `models()`; null leaves the provider's default. */
  model: string | null
  /** The user's message, as typed. */
  text: string
  /** The turns other providers answered since this provider's session last saw the chat. */
  handoff: Handoff | null
}

/** What a provider needs to get ready for a message that has not been sent yet. */
export type PrepareRequest = {
  /** The chat about to be answered, or null for the next new chat, which will start in `cwd`. */
  chatId: string | null
  cwd: string
  sessionId: string | null
  model: string | null
}

/** A tool as a model is told about it: `inputSchema` is the JSON Schema of its arguments. */
export type ToolBrief = { name: string; description: string; inputSchema: Record<string, unknown> }

/**
 * Where a provider's sessions find the app's tools: an MCP URL per session, whose key tells the
 * app which chat is calling (tools/channel.ts). Null when the app's tools are not being served.
 */
export type ToolEndpoint = {
  url: (provider: ProviderId, key: string) => string
  /** The tools served there, for a provider whose CLI does not put them in the model's prompt. */
  list: (chatId: string) => ToolBrief[]
  bind: (key: string, chatId: string) => void
  unbind: (key: string) => void
} | null

/** The name every provider knows the app's MCP server by. */
export const TOOL_SERVER = 'craft-studio'

export type TurnSink = {
  /** Add an item, or replace the one with the same id. */
  item: (item: Item) => void
  /** Append text to an assistant or reasoning item, or output to a tool item. */
  delta: (itemId: string, delta: string) => void
  /** The provider's session id for this chat, as soon as it is known. */
  session: (sessionId: string) => void
  model: (model: string) => void
  usage: (snapshot: UsageSnapshot) => void
  /** The turn's token totals so far; each report replaces the last. */
  tokens: (tokens: TurnTokens) => void
  /** What the turn is doing, shown in its head instead of "Thinking"; null to go back to thinking. */
  activity: (text: string | null) => void
}

export type RunResult = {
  status: Exclude<TurnStatus, 'running'>
  error?: string
  /**
   * The provider no longer holds the session it was asked to resume and nothing was sent. The
   * hub starts a fresh session and hands over the whole conversation instead.
   */
  sessionLost?: boolean
}

/**
 * A turn the provider started by itself, with no message from the app: Claude Code does this
 * when a background task it launched finishes. The hub records it like any turn.
 */
export type UnpromptedTurn = { turnId: string; sink: TurnSink; finish: (result: RunResult) => void }

/** Opens an unprompted turn in a chat; null when the chat cannot take one (it is gone, or busy). */
export type OpenUnprompted = (chatId: string, reason: string) => UnpromptedTurn | null

export interface ProviderAdapter {
  readonly id: ProviderId
  run(request: RunRequest, sink: TurnSink): Promise<RunResult>
  /**
   * Pay the cold start ahead of the message: start the process and open the session, but send
   * the model nothing. Safe to call any number of times; `run` works the same without it.
   */
  prepare(request: PrepareRequest): Promise<void>
  stop(chatId: string): Promise<void>
  /**
   * Add the user's words to the turn running in a chat, for the model to take in from its next
   * step; the turn keeps going and ends as usual. Resolves false when there is no turn that can
   * take them, and the hub then sends them once the turn has ended. Calls `taken` when the model
   * reads them, which may be well after this resolves.
   */
  steer?(chatId: string, text: string, taken: () => void): Promise<boolean>
  /** Drop whatever is held for a chat that was deleted. */
  forget(chatId: string): void
  usage(): Promise<UsageSnapshot>
  /** The models this account can use, read live from the provider, never hardcoded. */
  models(): Promise<ModelInfo[]>
  shutdown(): void
  /** For a provider that can start turns by itself: how to open one. */
  onUnprompted?(open: OpenUnprompted): void
}

export function unavailableUsage(provider: ProviderId, reason: string): UsageSnapshot {
  return { provider, account: null, plan: null, windows: [], note: null, unavailable: reason, updatedAt: Date.now() }
}

/** Item ids are scoped by turn so two providers' ids can never collide inside one chat. */
export function itemId(turnId: string, providerItemId: string): string {
  return `${turnId}:${providerItemId}`
}

/**
 * A turn's plan from a provider's own list of steps, each with its text and the provider's word
 * for its state. Every provider says done and in-progress the same way up to spelling; anything
 * else is still to do. Null when the list is empty, so an empty update clears nothing.
 */
export function planItem(turnId: string, entries: unknown, text: (entry: Record<string, unknown>) => string): Item | null {
  if (!Array.isArray(entries)) return null
  const steps: PlanStep[] = []
  for (const value of entries) {
    const entry = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const line = text(entry).trim()
    if (!line) continue
    const status = String(entry.status ?? '').toLowerCase().replace(/[_-]/g, '')
    steps.push({ text: line, status: status === 'completed' || status === 'done' ? 'done' : status === 'inprogress' || status === 'doing' ? 'doing' : 'todo' })
  }
  return steps.length ? { type: 'plan', id: planItemId(turnId), turnId, steps } : null
}

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Tool, ToolContext, ToolObserver, ObservedResult } from './tools/registry.ts'
import { recordOf, stringOf } from './json.ts'

// A separate profile database holds evidence, never prompt memory. Start/finish events are
// immutable; an unfinished call from another host instance is interrupted, not a guessed error.
const RETENTION_MS = 30 * 86_400_000
const MAX_CALLS = 10_000
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}

export function redactText(text: string): string {
  return text.replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [REDACTED]')
    .replace(/(\/mcp\/)[^/\s]+/g, '$1[REDACTED]')
    .replace(/([?&](?:token|secret|password|api_key|access_token)=)[^&\s"']*/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/((?:password|api[_-]?key|secret|(?:access[_-]?)?token)\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\])*?\2/gi, "$1'[REDACTED]'")
    .replace(/((?:password|api[_-]?key|secret|(?:access[_-]?)?token)\s*[:=]\s*)[^\s,"';}]+/gi, '$1[REDACTED]')
    .replace(/(\.(?:fill|type)\(\s*)(["'])(?:\\.|(?!\2)[^\\])*?\2/g, "$1'[REDACTED]'")
}

export function safeEvidence(value: unknown, budget = 16_000): unknown {
  const seen = new WeakSet<object>()
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') {
      const text = redactText(item)
      return text.length <= 4000 ? text : { truncated: true, length: text.length, preview: text.slice(0, 4000) }
    }
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item
    if (!item || typeof item !== 'object') return String(item)
    if (depth > 8 || seen.has(item)) return '[TRUNCATED]'
    seen.add(item)
    if (Array.isArray(item)) return item.slice(0, 50).map(child => walk(child, depth + 1))
    return Object.fromEntries(Object.entries(item).slice(0, 100).map(([key, child]) => [key,
      /authorization|cookie|password|secret|token|api.?key|base64/i.test(key) ? '[REDACTED]' : walk(child, depth + 1)]))
  }
  const safe = walk(value, 0), encoded = JSON.stringify(safe)
  return Buffer.byteLength(encoded) <= budget ? safe : { truncated: true, preview: encoded.slice(0, Math.floor(budget / 4)) }
}

export type LedgerQuery = { tool?: string; version?: string; code?: string; since?: number; until?: number; outcome?: string; limit?: number; callId?: string }
export const REVIEW_LIFECYCLES = ['diagnosed', 'regression_added', 'fixed', 'verified'] as const
export type ReviewLifecycle = typeof REVIEW_LIFECYCLES[number]
export type ReviewRecord = {
  callId: string; at: number; updatedAt: number; lifecycle: ReviewLifecycle; causeCode: string | null
  causeNote: string | null; proposedFix: string | null; retryCallId: string | null
}
export type ReviewInput = {
  lifecycle: ReviewLifecycle; causeCode?: string | null; causeNote?: string | null; proposedFix?: string | null; retryCallId?: string | null
}
export type ReviewQueueQuery = { since?: number; until?: number; lifecycle?: ReviewLifecycle | 'unreviewed'; limit?: number }
type Start = {
  id: string; at: number; instance: string; formatVersion: number; tool: string; toolVersion: string; schemaHash: string
  build: string; descriptionBytes: number; provider: string; model: string | null; chatId: string | null; turnId: string | null
  operation: string; arguments: unknown
}
type Finish = { at: number; durationMs: number; outcome: 'success' | 'failure'; error?: { code: string; origin: string; message: string }; artifacts: string[] }
type Call = Omit<Start, 'arguments'> & { arguments?: unknown; finish?: Finish; outcome: string }

/** Stable fallback grouping removes volatile addresses/IDs, not semantic error words. */
export function normalizedError(message: string): string {
  return message.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>').replace(/(?:https?:\/\/|file:\/\/\/|\/)[^\s"']+/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<number>').replace(/\s+/g, ' ').trim().slice(0, 500)
}

export class ToolLedger implements ToolObserver {
  private readonly db: DatabaseSync
  private readonly instance = randomUUID()
  private writes = 0

  constructor(readonly path: string, private readonly build: string, private readonly identity: (context: ToolContext) => { model: string | null; turnId: string | null } = () => ({ model: null, turnId: null }), private readonly now = Date.now) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, at INTEGER NOT NULL, instance TEXT NOT NULL, start TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_at ON calls(at);
      CREATE TABLE IF NOT EXISTS finishes (id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE, finish TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (
        call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lifecycle TEXT NOT NULL,
        cause_code TEXT, cause_note TEXT, proposed_fix TEXT,
        retry_call_id TEXT REFERENCES calls(id) ON DELETE SET NULL);
      CREATE INDEX IF NOT EXISTS reviews_lifecycle ON reviews(lifecycle);
      PRAGMA foreign_keys=ON;`)
    this.prune()
  }

  start(name: string, tool: Tool | undefined, args: Record<string, unknown>, context: ToolContext): string {
    const schemaHash = hash(JSON.stringify(canonical(tool?.inputSchema ?? {})))
    const toolVersion = hash(JSON.stringify({ version: tool?.version ?? 1, schemaHash, description: tool?.description ?? '' }))
    const row: Start = { id: randomUUID(), at: this.now(), instance: this.instance, formatVersion: 1, tool: name.slice(0, 200), toolVersion, schemaHash,
      build: this.build, descriptionBytes: Buffer.byteLength(tool?.description ?? ''), provider: context.provider, chatId: context.chatId, ...this.identity(context), operation: (stringOf(args.op) || stringOf(args.target) || (name === 'studio_ui_run' ? 'live' : 'call')).slice(0, 200), arguments: safeEvidence(args) }
    this.db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?)').run(row.id, row.at, this.instance, JSON.stringify(row))
    if (++this.writes % 100 === 0) this.prune()
    return row.id
  }

  finish(id: unknown, result: ObservedResult): void {
    if (typeof id !== 'string') return
    const start = this.db.prepare('SELECT at FROM calls WHERE id=?').get(id)
    if (!start) return
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    let metadata: Record<string, unknown> = {}
    try { metadata = recordOf(JSON.parse(result.content.find(block => block.type === 'text')?.text ?? '{}')) } catch { /* Plain tool text is valid. */ }
    const paths = new Set<string>()
    const collect = (value: unknown, depth = 0): void => {
      if (depth > 8 || !value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (['path', 'directory', 'fullResult'].includes(key) && typeof child === 'string') paths.add(redactText(child).slice(0, 1000))
        else collect(child, depth + 1)
      }
    }
    collect(metadata)
    const explicit = result.structuredContent?.error
    const message = redactText(explicit?.message ?? (stringOf(metadata.error) || text)).slice(0, 4000)
    const error = result.isError ? { code: explicit?.code ?? 'UNCLASSIFIED', origin: explicit?.origin ?? 'tool', message } : undefined
    const at = this.now()
    const row: Finish = { at, durationMs: Math.max(0, at - Number(start.at)), outcome: result.isError ? 'failure' : 'success', ...(error ? { error } : {}), artifacts: [...paths].slice(0, 20) }
    this.db.prepare('INSERT OR IGNORE INTO finishes VALUES (?, ?)').run(id, JSON.stringify(row))
  }

  private rows(query: LedgerQuery): Call[] {
    const rows = this.db.prepare(`SELECT ${query.callId ? 'c.start' : "CASE WHEN json_valid(c.start) THEN json_remove(c.start, '$.arguments') ELSE c.start END"} AS start, f.finish FROM calls c LEFT JOIN finishes f ON c.id=f.id WHERE c.at>=? AND c.at<=? AND (? IS NULL OR c.id=?) ORDER BY c.at DESC, c.id DESC LIMIT ?`).all(query.since ?? 0, query.until ?? this.now(), query.callId ?? null, query.callId ?? null, MAX_CALLS)
    return rows.flatMap(raw => {
      try {
        const start = JSON.parse(String(raw.start)) as Start
        const finish = raw.finish ? JSON.parse(String(raw.finish)) as Finish : undefined
        if (!start || start.formatVersion !== 1 || typeof start.id !== 'string' || typeof start.tool !== 'string') return []
        if (finish && !['success', 'failure'].includes(finish.outcome)) return []
        const outcome = finish?.outcome ?? (start.instance === this.instance ? 'running' : 'interrupted')
        if (query.tool && start.tool !== query.tool || query.version && start.toolVersion !== query.version || query.callId && start.id !== query.callId) return []
        return [{ ...start, ...(finish ? { finish } : {}), outcome }]
      } catch { return [] }
    })
  }

  private boundedNote(text: string | null | undefined, max = 2000): string | null {
    if (text == null || text === '') return null
    const cleaned = redactText(String(text)).trim()
    return cleaned ? cleaned.slice(0, max) : null
  }

  private callExists(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM calls WHERE id=?').get(id))
  }

  review(callId: string): ReviewRecord | null {
    const row = this.db.prepare('SELECT call_id, at, updated_at, lifecycle, cause_code, cause_note, proposed_fix, retry_call_id FROM reviews WHERE call_id=?').get(callId) as
      | { call_id: string; at: number; updated_at: number; lifecycle: string; cause_code: string | null; cause_note: string | null; proposed_fix: string | null; retry_call_id: string | null }
      | undefined
    if (!row || !REVIEW_LIFECYCLES.includes(row.lifecycle as ReviewLifecycle)) return null
    return { callId: row.call_id, at: row.at, updatedAt: row.updated_at, lifecycle: row.lifecycle as ReviewLifecycle,
      causeCode: row.cause_code, causeNote: row.cause_note, proposedFix: row.proposed_fix, retryCallId: row.retry_call_id }
  }

  upsertReview(callId: string, input: ReviewInput): ReviewRecord {
    if (!this.callExists(callId)) throw new Error(`Unknown call ID ${callId}.`)
    if (!REVIEW_LIFECYCLES.includes(input.lifecycle)) throw new Error(`Unsupported lifecycle ${input.lifecycle}.`)
    const retryCallId = input.retryCallId ?? null
    if (retryCallId && !this.callExists(retryCallId)) throw new Error(`Unknown retry call ID ${retryCallId}.`)
    const at = this.now()
    const existing = this.review(callId)
    const causeCode = input.causeCode === undefined ? existing?.causeCode ?? null : this.boundedNote(input.causeCode, 120)
    const causeNote = input.causeNote === undefined ? existing?.causeNote ?? null : this.boundedNote(input.causeNote)
    const proposedFix = input.proposedFix === undefined ? existing?.proposedFix ?? null : this.boundedNote(input.proposedFix)
    const row: ReviewRecord = { callId, at: existing?.at ?? at, updatedAt: at, lifecycle: input.lifecycle, causeCode, causeNote, proposedFix, retryCallId: retryCallId ?? existing?.retryCallId ?? null }
    this.db.prepare(`INSERT INTO reviews (call_id, at, updated_at, lifecycle, cause_code, cause_note, proposed_fix, retry_call_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(call_id) DO UPDATE SET updated_at=excluded.updated_at, lifecycle=excluded.lifecycle, cause_code=excluded.cause_code,
      cause_note=excluded.cause_note, proposed_fix=excluded.proposed_fix, retry_call_id=excluded.retry_call_id`).run(
      row.callId, row.at, row.updatedAt, row.lifecycle, row.causeCode, row.causeNote, row.proposedFix, row.retryCallId)
    return row
  }

  linkRetry(callId: string, retryCallId: string): ReviewRecord {
    if (callId === retryCallId) throw new Error('A call cannot retry itself.')
    const existing = this.review(callId)
    return this.upsertReview(callId, { lifecycle: existing?.lifecycle ?? 'diagnosed', retryCallId })
  }

  reviewQueue(query: ReviewQueueQuery = {}) {
    const since = query.since ?? this.now() - 86_400_000 * 7
    const until = query.until ?? this.now()
    const limit = Math.max(1, Math.min(50, Math.floor(query.limit ?? 20)))
    const rows = this.rows({ since, until, limit: MAX_CALLS }).filter(row => row.outcome === 'failure')
    const items = rows.flatMap(row => {
      const review = this.review(row.id)
      const lifecycle = review?.lifecycle ?? 'unreviewed'
      if (query.lifecycle === 'unreviewed' && review) return []
      if (query.lifecycle && query.lifecycle !== 'unreviewed' && lifecycle !== query.lifecycle) return []
      if (!query.lifecycle && lifecycle === 'verified') return []
      return [{ callId: row.id, at: row.at, tool: row.tool, operation: row.operation, code: row.finish?.error?.code ?? null,
        lifecycle, retryCallId: review?.retryCallId ?? null, causeCode: review?.causeCode ?? null }]
    })
    return { path: this.path, matching: items.length, queue: items.slice(0, limit), truncated: items.length > limit,
      lifecycleOrder: ['unreviewed', ...REVIEW_LIFECYCLES] }
  }

  query(query: LedgerQuery = {}) {
    const limit = Math.max(1, Math.min(50, Math.floor(query.limit ?? 20)))
    const rows = this.rows(query).filter(row => (!query.outcome || row.outcome === query.outcome) && (!query.code || row.finish?.error?.code === query.code))
    const calls = rows.slice(0, limit).map(row => {
      const review = query.callId ? this.review(row.id) : undefined
      return review ? { ...row, review } : row
    })
    return { path: this.path, matching: rows.length, calls, truncated: rows.length > limit }
  }

  summary(query: LedgerQuery = {}) {
    const rows = this.rows(query), scopes = new Map<string, { attempts: number; successes: number; failures: number; interrupted: number; running: number; descriptionBytes: number }>()
    const groups = new Map<string, Record<string, unknown> & { count: number; examples: string[] }>()
    for (const row of rows) {
      const scope = JSON.stringify([row.tool, row.toolVersion, row.operation])
      const totals = scopes.get(scope) ?? { attempts: 0, successes: 0, failures: 0, interrupted: 0, running: 0, descriptionBytes: row.descriptionBytes }
      totals.attempts++
      if (row.outcome === 'success') totals.successes++
      else if (row.outcome === 'failure') totals.failures++
      else if (row.outcome === 'interrupted') totals.interrupted++
      else totals.running++
      scopes.set(scope, totals)
      if (row.outcome !== 'failure' || !row.finish?.error || query.code && row.finish.error.code !== query.code) continue
      const error = row.finish.error
      const fallback = error.code === 'UNCLASSIFIED' ? normalizedError(error.message) : ''
      const key = hash(JSON.stringify([scope, error.code, error.origin, fallback]))
      const group = groups.get(key) ?? { key, tool: row.tool, toolVersion: row.toolVersion, descriptionBytes: row.descriptionBytes, operation: row.operation, code: error.code, origin: error.origin, ...(fallback ? { normalizedMessage: fallback } : {}), count: 0, examples: [] }
      group.count++
      if (group.examples.length < 3) group.examples.push(row.id)
      groups.set(key, group)
    }
    const ordered = [...groups.values()].sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key))).map(group => {
      const totals = scopes.get(JSON.stringify([group.tool, group.toolVersion, group.operation]))!
      return { ...group, ...totals, failureRate: totals.failures / Math.max(1, totals.successes + totals.failures) }
    })
    const limit = Math.max(1, Math.min(50, Math.floor(query.limit ?? 20)))
    return { path: this.path, retainedCalls: rows.length, contextPolicy: { historyInPrompts: false, maxQueryResponseBytes: 12_000, maxRetainedCalls: MAX_CALLS, retentionDays: RETENTION_MS / 86_400_000 },
      scopes: [...scopes].slice(0, limit).map(([key, totals]) => {
        const completed = totals.successes + totals.failures
        return { scope: JSON.parse(key), ...totals, successRate: completed ? totals.successes / completed : null, failureRate: completed ? totals.failures / completed : null }
      }), groups: ordered.slice(0, limit), truncated: ordered.length > limit || scopes.size > limit,
      denominator: 'All completed calls in the same tool version and operation; error-code filters do not remove successes. descriptionBytes tracks tool-description size beside rates.' }
  }

  prune(): void {
    this.db.prepare('DELETE FROM calls WHERE at < ? AND (instance != ? OR id IN (SELECT id FROM finishes))').run(this.now() - RETENTION_MS, this.instance)
    this.db.prepare('DELETE FROM calls WHERE id IN (SELECT c.id FROM calls c LEFT JOIN finishes f ON c.id=f.id WHERE c.instance != ? OR f.id IS NOT NULL ORDER BY c.at DESC, c.id DESC LIMIT -1 OFFSET ?)').run(this.instance, MAX_CALLS)
  }

  close(): void { this.db.close() }
}

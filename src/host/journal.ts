import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TurnTokens } from '../shared/types.ts'
import { recordOf, stringOf } from './json.ts'

// The app's memory of its own trouble. Console output vanishes; this keeps what went wrong, what
// ran slow and what a model noticed, one JSON object per line, so a model in the chat can read
// it back with `studio_diagnostics` and the user can read it with `tail`. It is a plain file
// rather than a table so it stays readable when the app itself is broken, and so main, which
// has no store, can append to it too.

export type Severity = 'info' | 'warn' | 'error'

export type JournalEntry = {
  at: number
  /** Where it came from: `host`, `main`, `tool:<name>`, `turn`, or `model` for a note a model filed. */
  source: string
  severity: Severity
  /** A short label for grouping: `crash`, `restart`, `tool-error`, `turn-failed`, `slow-turn`, `timing`, `observation`. */
  kind: string
  message: string
  details?: Record<string, unknown>
}

export type JournalQuery = { since?: number; severity?: Severity; source?: string; kind?: string; limit?: number }

/** A turn's timing, as the hub reports it; the journal needs only these fields. */
export type TimingReading = {
  chatId: string
  provider: string
  model: string | null
  status: string
  error?: string | null
  firstEventMs: number | null
  firstTextMs: number | null
  totalMs: number
  /** What the turn cost, when its provider says. */
  tokens?: TurnTokens | null
}

const MAX_BYTES = 2_000_000
const SLOW_MIN_SAMPLES = 5
/** A turn is slow when it took this many times the usual time to first text, and more than the floor. */
const SLOW_FACTOR = 3
const SLOW_FLOOR_MS = 8_000
const SAMPLES_KEPT = 30
const SEVERITIES: Severity[] = ['info', 'warn', 'error']
const rank = (severity: Severity): number => SEVERITIES.indexOf(severity)

/** Append one entry to a journal file from any process. Never throws: a journal must not add to the trouble. */
export function appendJournal(path: string, entry: JournalEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    // One generation of history is enough; an older one is a log nobody reads.
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
  } catch {
    // Nowhere to write; the console line that accompanied the event is all there is.
  }
}

export function parseEntries(text: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const raw = recordOf(JSON.parse(line))
      const severity = SEVERITIES.find((value) => value === raw.severity)
      if (typeof raw.at !== 'number' || !severity) continue
      entries.push({
        at: raw.at, severity, source: stringOf(raw.source), kind: stringOf(raw.kind), message: stringOf(raw.message),
        details: raw.details ? recordOf(raw.details) : undefined
      })
    } catch {
      // A torn last line from a crash; the rest is fine.
    }
  }
  return entries
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
}

export class Journal {
  /** Recent time-to-first-text per provider and model, to tell a slow turn from a usual one. */
  private readonly usual = new Map<string, number[]>()
  /** chatId → when that chat was last told about new trouble. A chat starts caught up with the host's start. */
  private readonly told = new Map<string, number>()
  private readonly startedAt: number

  constructor(readonly path: string, private readonly now: () => number = Date.now) {
    this.startedAt = now()
  }

  add(source: string, severity: Severity, kind: string, message: string, details?: Record<string, unknown>): void {
    appendJournal(this.path, { at: this.now(), source, severity, kind, message, ...(details ? { details } : {}) })
  }

  /** Entries newest last, from this file and the one before it. */
  read(query: JournalQuery = {}): JournalEntry[] {
    const load = (path: string): JournalEntry[] => (existsSync(path) ? parseEntries(readFileSync(path, 'utf8')) : [])
    const floor = query.severity ? rank(query.severity) : 0
    const matching = [...load(`${this.path}.1`), ...load(this.path)].filter((entry) =>
      entry.at >= (query.since ?? 0)
      && rank(entry.severity) >= floor
      && (!query.source || entry.source.startsWith(query.source))
      && (!query.kind || entry.kind === query.kind))
    return matching.slice(-(query.limit ?? 40))
  }

  /** Record how a turn went. Failures and slow turns are trouble; the rest is kept as timing for the averages. */
  noteTiming(timing: TimingReading): void {
    const label = `${timing.provider}${timing.model ? ` (${timing.model})` : ''}`
    const details = {
      chatId: timing.chatId, provider: timing.provider, model: timing.model,
      firstEventMs: timing.firstEventMs, firstTextMs: timing.firstTextMs, totalMs: Math.round(timing.totalMs),
      ...(timing.tokens ? { tokens: timing.tokens } : {})
    }
    if (timing.status === 'failed') {
      this.add('turn', 'error', 'turn-failed', `${label} failed: ${timing.error ?? 'no reason given'}`, details)
      return
    }
    const key = `${timing.provider}:${timing.model ?? ''}`
    const samples = this.usual.get(key) ?? []
    if (timing.firstTextMs !== null && timing.status === 'completed') {
      const median = percentile(samples, 0.5)
      if (samples.length >= SLOW_MIN_SAMPLES && timing.firstTextMs > Math.max(SLOW_FLOOR_MS, median * SLOW_FACTOR)) {
        this.add('turn', 'warn', 'slow-turn',
          `${label} took ${(timing.firstTextMs / 1000).toFixed(1)}s to first text; usually ${(median / 1000).toFixed(1)}s`, details)
        return
      }
      this.usual.set(key, [...samples, timing.firstTextMs].slice(-SAMPLES_KEPT))
    }
    this.add('turn', 'info', 'timing', `${label} ${timing.status} in ${(timing.totalMs / 1000).toFixed(1)}s${timing.tokens ? `; ${describeTokens(timing.tokens)}` : ''}`, details)
  }

  /** Time to first text, total time and tokens per provider and model, from the timings on record. */
  stats(since = 0): string {
    const groups = new Map<string, { first: number[]; total: number[]; failed: number; input: number[]; context: number[] }>()
    for (const entry of this.read({ since, limit: 5_000 })) {
      const d = recordOf(entry.details)
      if (entry.source !== 'turn' || typeof d.totalMs !== 'number') continue
      const key = `${stringOf(d.provider)}${stringOf(d.model) ? ` (${stringOf(d.model)})` : ''}`
      const group = groups.get(key) ?? { first: [], total: [], failed: 0, input: [], context: [] }
      group.total.push(d.totalMs)
      if (typeof d.firstTextMs === 'number') group.first.push(d.firstTextMs)
      const tokens = recordOf(d.tokens)
      if (typeof tokens.input === 'number') group.input.push(tokens.input)
      if (typeof tokens.context === 'number') group.context.push(tokens.context)
      if (entry.kind === 'turn-failed') group.failed++
      groups.set(key, group)
    }
    const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
    return [...groups].map(([key, g]) =>
      `${key}: ${g.total.length} turns, ${g.failed} failed; first text p50 ${s(percentile(g.first, 0.5))} p95 ${s(percentile(g.first, 0.95))}; total p50 ${s(percentile(g.total, 0.5))} p95 ${s(percentile(g.total, 0.95))}`
      + (g.input.length ? `; input tokens p50 ${kilo(percentile(g.input, 0.5))} p95 ${kilo(percentile(g.input, 0.95))}` : '')
      + (g.context.length ? `; context p50 ${kilo(percentile(g.context, 0.5))} max ${kilo(Math.max(...g.context))}` : '')
    ).join('\n')
  }

  /**
   * One line for the head of a message when warnings or errors arrived since this chat last heard,
   * otherwise null. Hearing is once: the same trouble is never announced twice.
   */
  nudge(chatId: string): string | null {
    const since = this.told.get(chatId) ?? this.startedAt
    this.told.set(chatId, this.now())
    const trouble = this.read({ since: since + 1, severity: 'warn', limit: 200 }).filter((entry) => entry.kind !== 'observation')
    if (!trouble.length) return null
    const errors = trouble.filter((entry) => entry.severity === 'error').length
    const counts = [errors && `${errors} error${errors === 1 ? '' : 's'}`, trouble.length - errors && `${trouble.length - errors} warning${trouble.length - errors === 1 ? '' : 's'}`]
    return `<self-check>\nRocket logged ${counts.filter(Boolean).join(' and ')} since you last heard. Latest: ${trouble.at(-1)!.message}\nCall studio_diagnostics to read them.\n</self-check>`
  }
}

/** A turn's tokens in a few words: "input 41.2k (38.0k cached), output 1.3k, context 30.1k of 200k". */
export function describeTokens(tokens: TurnTokens): string {
  const context = tokens.context === null ? '' : `, context ${kilo(tokens.context)}${tokens.contextWindow ? ` of ${kilo(tokens.contextWindow)}` : ''}`
  return `input ${kilo(tokens.input)} (${kilo(tokens.cached)} cached), output ${kilo(tokens.output)}${context}`
}

function kilo(count: number): string {
  return count < 1_000 ? String(Math.round(count)) : `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k`
}

/** Parse "30m", "2h" or "1d" into milliseconds; null when it is none of those. */
export function parseWindow(text: string): number | null {
  const match = /^(\d+)\s*([mhd])$/.exec(text.trim())
  if (!match) return null
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd']
}

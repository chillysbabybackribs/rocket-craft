import type { Tool } from './tools/registry.ts'
import type { ReviewLifecycle, ReviewRecord, ToolLedger } from './tool-ledger.ts'
import { REVIEW_LIFECYCLES } from './tool-ledger.ts'

export type ToolLedgerPanelScope = {
  scope: string[]
  attempts: number
  successes: number
  failures: number
  interrupted?: number
  running?: number
  descriptionBytes: number
  successRate: number | null
  failureRate: number | null
}

export type ToolLedgerPanelGroup = {
  tool: string
  operation: string
  code: string
  count: number
  failureRate: number
  examples: string[]
}

export type ToolLedgerPanelQueueRow = {
  callId: string
  tool: string
  code: string | null
  lifecycle: string
  at: number
}

export type ToolLedgerPanelData = {
  available: boolean
  message?: string
  path?: string
  syncedAt?: string
  contextPolicy?: Record<string, unknown>
  scopes?: ToolLedgerPanelScope[]
  groups?: ToolLedgerPanelGroup[]
  queue?: ToolLedgerPanelQueueRow[]
  registeredTools?: Array<{ name: string; descriptionBytes: number; version: number }>
  retryCandidates?: Array<{ callId: string; tool: string; at: number }>
}

export type ToolLedgerCallDetailData = {
  path?: string
  calls?: Array<Record<string, unknown>>
  matching?: number
  available?: boolean
  message?: string
}

/** Bounded payload for the Tools panel — same evidence as studio_tool_history, not prompt memory. */
export function loadToolLedgerPanel(ledger: ToolLedger | undefined, registered: Tool[]): ToolLedgerPanelData {
  if (!ledger) {
    return { available: false, message: 'Tool-call ledger is unavailable for this profile.' }
  }
  // Retention/pruning already bounds size; the UI shows the full retained ledger.
  const since = 0
  const summary = ledger.summary({ since, limit: 20 })
  const queue = ledger.reviewQueue({ since, limit: 20 })
  return {
    available: true,
    path: ledger.path,
    syncedAt: new Date().toISOString(),
    contextPolicy: summary.contextPolicy,
    scopes: summary.scopes as ToolLedgerPanelScope[],
    groups: (summary.groups as Array<Record<string, unknown>>).map(row => ({
      tool: String(row.tool ?? ''),
      operation: String(row.operation ?? ''),
      code: String(row.code ?? ''),
      count: Number(row.count ?? 0),
      failureRate: Number(row.failureRate ?? 0),
      examples: Array.isArray(row.examples) ? row.examples.filter((id): id is string => typeof id === 'string') : []
    })),
    queue: queue.queue as ToolLedgerPanelQueueRow[],
    registeredTools: registered.map(tool => ({
      name: tool.name,
      descriptionBytes: Buffer.byteLength(tool.description),
      version: tool.version ?? 1
    })).sort((a, b) => a.name.localeCompare(b.name)),
    retryCandidates: listToolLedgerRetryCandidates(ledger, 10)
  }
}

export function loadToolLedgerCallDetail(ledger: ToolLedger | undefined, callId: string): ToolLedgerCallDetailData {
  if (!ledger) return { available: false, message: 'Ledger unavailable.' }
  return ledger.query({ callId, since: 0, limit: 1 }) as ToolLedgerCallDetailData
}

export type SetReviewParams = {
  callId: string
  lifecycle?: ReviewLifecycle
  retryCallId?: string | null
  linkRetry?: boolean
  causeCode?: string | null
  causeNote?: string | null
  proposedFix?: string | null
}

/** Shared by MCP studio_tool_review and renderer toolLedger.setReview. */
export function setToolLedgerReview(ledger: ToolLedger, params: SetReviewParams): ReviewRecord {
  if (params.linkRetry) {
    if (!params.retryCallId) throw new Error('retryCallId is required for link_retry.')
    return ledger.linkRetry(params.callId, params.retryCallId)
  }
  if (!params.lifecycle || !REVIEW_LIFECYCLES.includes(params.lifecycle)) throw new Error('Unsupported lifecycle.')
  return ledger.upsertReview(params.callId, {
    lifecycle: params.lifecycle,
    ...(params.causeCode !== undefined ? { causeCode: params.causeCode } : {}),
    ...(params.causeNote !== undefined ? { causeNote: params.causeNote } : {}),
    ...(params.proposedFix !== undefined ? { proposedFix: params.proposedFix } : {}),
    ...(params.retryCallId !== undefined ? { retryCallId: params.retryCallId } : {})
  })
}

export function listToolLedgerRetryCandidates(ledger: ToolLedger, limit = 10): Array<{ callId: string; tool: string; at: number }> {
  const rows = ledger.query({ since: 0, outcome: 'success', limit }).calls ?? []
  return rows.flatMap(row => typeof row.id === 'string' && typeof row.tool === 'string' && typeof row.at === 'number'
    ? [{ callId: row.id, tool: row.tool, at: row.at }] : [])
}

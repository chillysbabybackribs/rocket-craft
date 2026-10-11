import type { ToolLedger } from '../tool-ledger.ts'
import { REVIEW_LIFECYCLES } from '../tool-ledger.ts'
import { setToolLedgerReview } from '../tool-ledger-panel.ts'
import { failureResult, textResult, type Tool } from './registry.ts'

// Review annotations stay outside prompts. They link investigator judgments to immutable call evidence.
export function toolReviewTools(ledger: ToolLedger): Tool[] {
  return [{
    name: 'studio_tool_review',
    description: 'Manage external review annotations for tool-call failures. action=get returns call evidence plus any review; action=annotate sets lifecycle and optional cause/fix notes; action=link_retry links a later successful call; action=queue lists failures still needing review. Lifecycles: diagnosed → regression_added → fixed → verified. Does not modify original ledger records.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'annotate', 'link_retry', 'queue'] },
      callId: { type: 'string' },
      retryCallId: { type: 'string' },
      lifecycle: { type: 'string', enum: ['unreviewed', ...REVIEW_LIFECYCLES], description: 'annotate: required stage. queue: optional filter.' },
      causeCode: { type: 'string', description: 'Short stable label, e.g. AMBIGUOUS_TARGET or SELECTOR_AMBIGUITY.' },
      causeNote: { type: 'string' },
      proposedFix: { type: 'string' },
      since: { type: 'number', description: 'Queue mode: inclusive start epoch ms. Default last 7 days.' },
      until: { type: 'number' },
      limit: { type: 'integer', minimum: 1, maximum: 50 }
    }, required: ['action'], additionalProperties: false },
    run: args => {
      const action = String(args.action)
      if (!['get', 'annotate', 'link_retry', 'queue'].includes(action)) return failureResult('INVALID_ARGUMENT', 'Choose a supported action.')
      for (const key of ['since', 'until', 'limit']) if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isFinite(args[key]))) return failureResult('INVALID_ARGUMENT', `Use a finite number for ${key}.`)
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 50)) return failureResult('INVALID_ARGUMENT', 'Use a result limit from 1 through 50.')
      for (const key of ['callId', 'retryCallId', 'lifecycle', 'causeCode', 'causeNote', 'proposedFix']) if (args[key] !== undefined && typeof args[key] !== 'string') return failureResult('INVALID_ARGUMENT', `Use a string for ${key}.`)
      if (args.lifecycle !== undefined && !REVIEW_LIFECYCLES.includes(args.lifecycle as typeof REVIEW_LIFECYCLES[number])) return failureResult('INVALID_ARGUMENT', 'Choose a supported lifecycle.')

      try {
        if (action === 'queue') {
          const since = typeof args.since === 'number' ? args.since : Date.now() - 7 * 86_400_000
          const until = typeof args.until === 'number' ? args.until : Date.now()
          if (since > until) return failureResult('INVALID_ARGUMENT', 'since must be at or before until.')
          const lifecycle = args.lifecycle === 'unreviewed' ? 'unreviewed' as const : args.lifecycle as typeof REVIEW_LIFECYCLES[number] | undefined
          const limit = typeof args.limit === 'number' ? args.limit : 20
          const data = ledger.reviewQueue({ since, until, lifecycle, limit })
          return textResult(JSON.stringify(data))
        }

        if (!args.callId) return failureResult('INVALID_ARGUMENT', 'callId is required for this action.')
        if (action === 'get') {
          const detail = ledger.query({ callId: String(args.callId), since: 0, limit: 1 })
          const call = detail.calls[0]
          if (!call) return failureResult('NOT_FOUND', `No call found for ID ${args.callId}.`)
          return textResult(JSON.stringify({ path: ledger.path, call, review: ledger.review(String(args.callId)) }))
        }

        if (action === 'link_retry') {
          if (!args.retryCallId) return failureResult('INVALID_ARGUMENT', 'retryCallId is required for link_retry.')
          const review = setToolLedgerReview(ledger, { callId: String(args.callId), linkRetry: true, retryCallId: String(args.retryCallId) })
          return textResult(JSON.stringify({ path: ledger.path, review }))
        }

        if (!args.lifecycle) return failureResult('INVALID_ARGUMENT', 'lifecycle is required for annotate.')
        const review = setToolLedgerReview(ledger, {
          callId: String(args.callId),
          lifecycle: args.lifecycle as typeof REVIEW_LIFECYCLES[number],
          ...(args.causeCode !== undefined ? { causeCode: String(args.causeCode) } : {}),
          ...(args.causeNote !== undefined ? { causeNote: String(args.causeNote) } : {}),
          ...(args.proposedFix !== undefined ? { proposedFix: String(args.proposedFix) } : {}),
          ...(args.retryCallId !== undefined ? { retryCallId: String(args.retryCallId) } : {})
        })
        return textResult(JSON.stringify({ path: ledger.path, review }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/Unknown call ID|Unknown retry call ID|cannot retry itself|Unsupported lifecycle/.test(message)) return failureResult('INVALID_ARGUMENT', message)
        return failureResult('TOOL_EXCEPTION', message, 'tool')
      }
    }
  }]
}

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import type { HostApi } from '../../../shared/types.ts'
import { act, go } from '../app-map.ts'
import { call } from '../host.ts'
import { openChatLink, useApp } from '../store.ts'

// The tool ledger beside the chat: how Craft Studio's MCP tools have been doing, the failures awaiting
// review, and a call's evidence. It reads the same ledger as studio_tool_history and
// studio_tool_review; Refresh goes through the app map, so tools.refresh does what the button does.

type PanelData = HostApi['toolLedger.loadPanel'][1]
type CallDetail = HostApi['toolLedger.callDetail'][1]
type CallRow = Record<string, unknown> & {
  id?: string
  tool?: string
  operation?: string
  outcome?: string
  finish?: { error?: { code?: string; message?: string }; artifacts?: string[] }
  review?: { lifecycle?: string; causeCode?: string | null; proposedFix?: string | null; retryCallId?: string | null }
}

const pct = (n: number | null | undefined): string => (n == null ? '—' : `${Math.round(n * 100)}%`)
const fmtDate = (ms: number): string => new Date(ms).toLocaleString()

export function ToolLedgerPanel() {
  return (
    <aside className="tools-panel" aria-label="Tools">
      <header className="tools-head">
        <h1 className="tools-title" data-nav="tools">Tool health</h1>
        <span className="tools-spacer" />
        <button type="button" className="icon-button" title="Refresh ledger" aria-label="Refresh ledger" onClick={() => void act('tools.refresh')}><RefreshCw size={14} /></button>
        <button type="button" className="icon-button" title="Close tools" aria-label="Close tools panel" onClick={() => void go('chat')}><X size={15} /></button>
      </header>
      <div className="tools-body">
        <ToolHealth />
      </div>
    </aside>
  )
}

function ToolHealth() {
  const refreshKey = useApp((state) => state.toolsRefresh)
  const [data, setData] = useState<PanelData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CallDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setData(await call('toolLedger.loadPanel', {}))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const loadDetail = useCallback(async (callId: string): Promise<void> => {
    setDetail(await call('toolLedger.callDetail', { callId }))
  }, [])

  useEffect(() => { void load() }, [load, refreshKey])

  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    void loadDetail(selectedId).catch(() => setDetail(null))
  }, [selectedId, loadDetail, refreshKey])

  const setReview = async (params: HostApi['toolLedger.setReview'][0]): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      await call('toolLedger.setReview', params)
      await load()
      if (selectedId) await loadDetail(selectedId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Captures and artifacts open inside the app, as a chat link would, never in a system app.
  const openPath = (path: string): void => { void openChatLink(path) }

  if (error) return <p className="tools-error">{error}</p>
  if (!data) return <p className="tools-muted">Loading tool ledger…</p>
  if (!data.available) return <p className="tools-muted">{data.message ?? 'Ledger unavailable.'}</p>

  const policy = data.contextPolicy ?? {}
  const selected = (detail?.calls?.[0] ?? null) as CallRow | null
  const artifacts = selected?.finish?.artifacts ?? []

  return (
    <div className="tools-ledger" aria-label="MCP tool ledger">
      <p className="tools-muted">
        Craft Studio MCP tool health — same evidence as <span className="tools-mono">studio_tool_history</span> /
        <span className="tools-mono"> studio_tool_review</span>. History is <strong>not</strong> injected into chat prompts.
      </p>

      {actionError && <p className="tools-error">{actionError}</p>}

      <div className="tools-cards">
        <div className="tools-metric">
          <div className="tools-metric-label">Prompt injection</div>
          <div className="tools-metric-value">{policy.historyInPrompts === false ? 'Off' : '—'}</div>
        </div>
        <div className="tools-metric">
          <div className="tools-metric-label">Retained calls</div>
          <div className="tools-metric-value">{data.scopes?.reduce((n, s) => n + s.attempts, 0) ?? 0}</div>
        </div>
        <div className="tools-metric">
          <div className="tools-metric-label">Review queue</div>
          <div className="tools-metric-value" aria-label="Review queue count">{data.queue?.length ?? 0}</div>
        </div>
        <div className="tools-metric">
          <div className="tools-metric-label">Registered MCP tools</div>
          <div className="tools-metric-value">{data.registeredTools?.length ?? 0}</div>
        </div>
      </div>

      {data.path && (
        <p className="tools-mono tools-muted tools-path">
          {data.path}
          {data.syncedAt && ` · synced ${fmtDate(Date.parse(data.syncedAt))}`}
        </p>
      )}

      <h2 className="tools-heading">Failure groups</h2>
      {(data.groups?.length ?? 0) === 0
        ? <p className="tools-muted">No grouped failures in the retained ledger.</p>
        : (
          <table className="tools-table">
            <thead>
              <tr><th>Tool</th><th>Operation</th><th>Code</th><th>Count</th><th>Failure rate</th><th>Example</th></tr>
            </thead>
            <tbody>
              {data.groups!.map((g) => (
                <tr key={`${g.tool}-${g.operation}-${g.code}`}>
                  <td className="tools-mono">{g.tool}</td>
                  <td>{g.operation}</td>
                  <td><span className="tools-badge tools-badge-kind">{g.code}</span></td>
                  <td>{g.count}</td>
                  <td>{pct(g.failureRate)}</td>
                  <td>
                    {g.examples[0] && (
                      <button type="button" className="tools-btn tools-btn-ghost" onClick={() => setSelectedId(g.examples[0])}>
                        {g.examples[0].slice(0, 8)}…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <h2 className="tools-heading">Review queue</h2>
      {(data.queue?.length ?? 0) === 0
        ? <p className="tools-muted">No failures awaiting review (verified items are hidden).</p>
        : (
          <table className="tools-table">
            <thead><tr><th>When</th><th>Tool</th><th>Code</th><th>Lifecycle</th><th /></tr></thead>
            <tbody>
              {data.queue!.map((row) => (
                <tr key={row.callId}>
                  <td className="tools-mono">{fmtDate(row.at)}</td>
                  <td>{row.tool}</td>
                  <td>{row.code ?? '—'}</td>
                  <td>{row.lifecycle}</td>
                  <td>
                    <button type="button" className="tools-btn tools-btn-ghost" onClick={() => setSelectedId(row.callId)}>Detail</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <h2 className="tools-heading">Scopes & description size</h2>
      <table className="tools-table">
        <thead><tr><th>Tool</th><th>Operation</th><th>Attempts</th><th>Success</th><th>Failure</th><th>Desc bytes</th></tr></thead>
        <tbody>
          {(data.scopes ?? []).map((s) => (
            <tr key={JSON.stringify(s.scope)}>
              <td className="tools-mono">{s.scope[0]}</td>
              <td>{s.scope[2] ?? s.scope[1]?.slice(0, 12)}</td>
              <td>{s.attempts}</td>
              <td>{pct(s.successRate)}</td>
              <td>{pct(s.failureRate)}</td>
              <td>{s.descriptionBytes}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="tools-heading">Registered tools</h2>
      <table className="tools-table">
        <thead><tr><th>Name</th><th>Version</th><th>Description bytes</th></tr></thead>
        <tbody>
          {(data.registeredTools ?? []).map((t) => (
            <tr key={t.name}><td className="tools-mono">{t.name}</td><td>{t.version}</td><td>{t.descriptionBytes}</td></tr>
          ))}
        </tbody>
      </table>

      {selectedId && selected && (
        <section className="tools-detail" aria-label="Call detail">
          <div className="tools-detail-head">
            <h2 className="tools-heading">Call {selectedId.slice(0, 8)}…</h2>
            <button type="button" className="tools-btn tools-btn-ghost" onClick={() => setSelectedId(null)}>Close</button>
          </div>
          <dl className="tools-dl">
            <div><dt>Tool</dt><dd className="tools-mono">{String(selected.tool ?? '—')}</dd></div>
            <div><dt>Operation</dt><dd>{String(selected.operation ?? '—')}</dd></div>
            <div><dt>Outcome</dt><dd>{String(selected.outcome ?? '—')}</dd></div>
            <div><dt>Error</dt><dd className="tools-mono">{selected.finish?.error?.code ?? '—'}</dd></div>
            <div><dt>Review</dt><dd>{selected.review?.lifecycle ?? 'unreviewed'}</dd></div>
            {selected.review?.proposedFix && <div><dt>Proposed fix</dt><dd>{selected.review.proposedFix}</dd></div>}
            {selected.review?.retryCallId && <div><dt>Retry call</dt><dd className="tools-mono">{selected.review.retryCallId}</dd></div>}
          </dl>
          {selected.finish?.error?.message && (
            <p className="tools-mono tools-error-msg">{selected.finish.error.message.slice(0, 500)}{selected.finish.error.message.length > 500 ? '…' : ''}</p>
          )}
          {artifacts.length > 0 && (
            <div className="tools-artifacts">
              <span className="tools-heading">Artifacts</span>
              {artifacts.map(path => (
                <button key={path} type="button" className="tools-btn tools-btn-ghost" onClick={() => openPath(path)}>{path.split('/').slice(-2).join('/')}</button>
              ))}
            </div>
          )}
          <div className="tools-actions">
            <button type="button" className="tools-btn" disabled={busy} aria-label="Mark call diagnosed"
              onClick={() => void setReview({ callId: selectedId, lifecycle: 'diagnosed' })}>Mark diagnosed</button>
            <button type="button" className="tools-btn" disabled={busy} aria-label="Mark call regression added"
              onClick={() => void setReview({ callId: selectedId, lifecycle: 'regression_added' })}>Regression added</button>
            <button type="button" className="tools-btn tools-btn-primary" disabled={busy} aria-label="Mark call verified"
              onClick={() => void setReview({ callId: selectedId, lifecycle: 'verified' })}>Mark verified</button>
            {(data.retryCandidates?.length ?? 0) > 0 && (
              <label className="tools-retry">
                Link retry
                <select disabled={busy} defaultValue="" onChange={ev => {
                  const retryCallId = ev.target.value
                  if (retryCallId) void setReview({ callId: selectedId, linkRetry: true, retryCallId })
                }}>
                  <option value="">Choose success…</option>
                  {data.retryCandidates!.map(row => (
                    <option key={row.callId} value={row.callId}>{row.tool} · {row.callId.slice(0, 8)}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="tools-muted tools-foot">Full redacted record lives in the ledger database above; open artifacts locally only.</p>
        </section>
      )}
    </div>
  )
}

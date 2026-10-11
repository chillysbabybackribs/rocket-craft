import { useEffect } from 'react'
import type { Orchestration } from '../../../shared/orchestrator.ts'
import { act } from '../app-map.ts'
import { PAUSE_FALLBACK } from '../notifications.ts'
import { boardRun, clearRunFocus, useApp } from '../store.ts'
import '../run-controls.css'

export function RunControls({ run }: { run: Orchestration }) {
  const pending = useApp(state => state.board.runAction?.runId === run.id)
  return <span className="run-controls">
    {run.status === 'paused' && <button type="button" className="run-control is-primary" disabled={pending} onClick={() => void act('run.resume')}>Resume</button>}
    {(run.status === 'running' || run.status === 'paused') && <button type="button" className="run-control" disabled={pending}
      title="Finish running workers, cancel queued workers, and write the final review." onClick={() => void act('run.wrapUp')}>Wrap up</button>}
  </span>
}

/** After mounting, notification focus wins over the worker reply box's ordinary autofocus. */
export function RunNotice({ run }: { run: Orchestration }) {
  const error = useApp(state => state.board.runActionError?.runId === run.id ? state.board.runActionError.message : null)
  const target = useApp(state => state.board.focusTarget)
  const shownRun = useApp(boardRun)
  useEffect(() => {
    if (!target || target.runId !== run.id || shownRun?.id !== run.id) return
    let frame = 0
    const focus = (): void => {
      const element = target.kind === 'run' ? document.querySelector<HTMLElement>('.orch-head')
        : Array.from(document.querySelectorAll<HTMLElement>('.worker-expanded')).find(node => node.dataset.chatId === target.chatId)?.querySelector<HTMLElement>('.worker-head')
      if (!element) return
      element.tabIndex = -1
      element.focus()
      clearRunFocus()
    }
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(focus) }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [target, run.id, shownRun?.id])
  const reason = run.reason || PAUSE_FALLBACK
  return <>
    {run.status === 'paused' && <div className="run-pause-banner" tabIndex={0} aria-label={reason}>
      <span className="run-pause-text">{reason}</span><span className="run-pause-tooltip" role="tooltip">{reason}</span>
    </div>}
    {error && <p className="run-action-error" role="alert">{error}</p>}
  </>
}

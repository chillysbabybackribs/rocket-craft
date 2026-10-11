import { RunControls, RunNotice } from './RunControls.tsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronLeft, ChevronRight, FileText, Maximize2, Square, X } from 'lucide-react'
import { mergeLabel, type Orchestration, type OrchestratorTask } from '../../../shared/orchestrator.ts'
import { providerLabel } from '../../../shared/types.ts'
import { act, go } from '../app-map.ts'
import { ShownChatContext, usePaneView, WorkerShownContext } from '../pane.ts'
import {
  boardRun, boardWorkers, loadWorkerChat, openWorkerReport, queuePlace, replyToWorker, setBoardRailOpen, setOrchWidth,
  setWorkerFilter, stopWorker, useApp, workerStatus, type WorkerFilter, type WorkerStatus
} from '../store.ts'
import { ProviderGlyph } from './glyphs.tsx'
import { PlanDrawer } from './PlanDrawer.tsx'
import { Split } from './Split.tsx'
import { AssignmentStrip, Transcript } from './Transcript.tsx'
import '../orchestrator.css'

// Craft Studio's shell (docs/mockups/orchestrator-shell.html). The orchestrator's chat is
// pane 0, full height on the left; beside it the board holds one small window per worker chat
// its run dispatched, each the real transcript drawn read-only and kept live by the store's
// events. There is no cap on workers: the board scrolls, running ones first. A worker expands
// over the board with a reply box of its own, which sends to that worker's chat, not to pane 0.
// The test ids and labels here are a contract with tests/ui/orchestra-shell.spec.ts.
//
// A side panel (browser, artifact, library, tools) keeps its usual share of the window, so the
// shell gives up width: the orchestrator column and the board each shrink to a smaller minimum,
// and when even those do not fit, the board folds to a rail of status counts that opens over the
// shell. The side panel itself is never moved or covered.

/** The orchestrator column's and the board's least widths, alone and beside a side panel. */
const ORCH_MIN = { alone: 420, beside: 340 }
const BOARD_MIN = { alone: 360, beside: 300 }
/** The divider between them, as styles.css's --gap. */
const GAP = 10

const STATUS_TEXT: Record<WorkerStatus, string> = {
  queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled'
}

const RUN_TEXT: Record<Orchestration['status'], string> = {
  running: 'Run running', draining: 'Finishing current workers', paused: 'Run paused', stopped: 'Run stopped'
}

/** The first line of a worker's assignment, for its window's title. */
function titleOf(task: string): string {
  return task.trim().split('\n')[0]!.trim() || 'Worker'
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** The time now, ticking each second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  return live ? now : Date.now()
}

/** How long the worker has run, or ran: the run's own times, else its dispatched turn's once its chat is loaded. */
function Elapsed({ task, live }: { task: OrchestratorTask; live: boolean }) {
  const turn = useApp((state) => state.views[task.chatId]?.turns.find((entry) => entry.id === task.turnId) ?? null)
  const startedAt = task.startedAt ?? turn?.startedAt ?? null
  const endedAt = task.endedAt ?? turn?.endedAt ?? null
  const now = useNow(live && endedAt === null)
  if (startedAt === null) return null
  return <span className="worker-time">{clock((endedAt ?? now) - startedAt)}</span>
}

/** Where a worktree task's work went once it has a verdict: merged, refused, discarded or on its way. */
function MergeState({ task }: { task: OrchestratorTask }) {
  const label = mergeLabel(task)
  if (!label) return null
  return <span className={`worker-merge is-${label.tone}`} data-merge={task.merge!.status} title={label.title || undefined}>{label.text}</span>
}

function StatusDot({ status }: { status: WorkerStatus | Orchestration['status'] }) {
  return <span className={`orch-dot is-${status}`} aria-hidden />
}

/** One worker's controls, shared by its window and its expanded view. */
function WorkerActions({ run, task, status, expanded }: { run: Orchestration; task: OrchestratorTask; status: WorkerStatus; expanded: boolean }) {
  // A reply sent to a finished worker is a turn of its own; Stop stops whatever the chat is running.
  const turnRunning = useApp((state) => state.running.has(task.chatId))
  const stoppable = status === 'running' || status === 'queued' || turnRunning
  const stopping = useApp((state) => status === 'running' && state.board.stopped[task.chatId] === true)
  const stopTitle = stopping ? 'Stop requested; the worker ends when its provider does'
    : status === 'queued' ? 'Take this worker out of the queue; it never starts' : 'Stop this worker’s turn'
  return (
    <>
      {!expanded && (
        <button type="button" className="worker-action" aria-label="Expand worker" title="Show this worker large, with a reply box" onClick={() => void act('worker.expand', { chatId: task.chatId })}>
          <Maximize2 size={12} aria-hidden /><span>Expand</span>
        </button>
      )}
      <button type="button" className="worker-action is-stop" aria-label="Stop worker" title={stopTitle} disabled={!stoppable || stopping} onClick={() => stopWorker(run, task)}>
        <Square size={10} aria-hidden /><span>{stopping ? 'Stopping…' : 'Stop'}</span>
      </button>
      <button type="button" className="worker-action" aria-label="Open report" title={status === 'running' || status === 'queued' ? 'The report opens once the worker finishes' : task.report} disabled={status === 'running' || status === 'queued'} onClick={() => void openWorkerReport(run, task)}>
        <FileText size={12} aria-hidden /><span>Report</span>
      </button>
    </>
  )
}

/**
 * A worker's transcript, loaded for its window and kept current by live events. Its chat is loaded
 * while it waits in the queue too, so the first events of its turn land in a view already there.
 */
function WorkerTranscript({ run, task, status, compact }: { run: Orchestration; task: OrchestratorTask; status: WorkerStatus; compact: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const loaded = useApp((state) => state.views[task.chatId] !== undefined)
  const shown = useMemo(() => ({ task: task.task, turnId: task.turnId, compact }), [task.task, task.turnId, compact])
  useEffect(() => {
    setError(null)
    loadWorkerChat(task.chatId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [task.chatId])
  if (status === 'queued') return <NotStarted task={task} note={`Waiting for a free ${providerLabel(task.provider)} slot · #${queuePlace(run, task)} in queue`} />
  if (status === 'cancelled' && task.turnId === null) return <NotStarted task={task} note="Taken out of the queue before it started." />
  if (error) return <p className="worker-note">This worker’s chat could not be read: {error}</p>
  if (!loaded) return <p className="worker-note">Loading…</p>
  return (
    <ShownChatContext.Provider value={task.chatId}>
      <WorkerShownContext.Provider value={shown}>
        {compact ? <Transcript /> : <WorkerPlanSplit />}
      </WorkerShownContext.Provider>
    </ShownChatContext.Provider>
  )
}

/**
 * An expanded worker's transcript, with its plan beside it when it is open: the drawer belongs to
 * this chat and lives in the expanded view, so it neither takes the leader's column nor covers the
 * board. The small window has no room for one and no plan line either.
 */
function WorkerPlanSplit() {
  const planTurn = usePaneView((view) => view.turns.find((turn) => turn.id === view.planTurnId) ?? null)
  const userItemId = usePaneView((view) => (view.planTurnId ? view.turnItems[view.planTurnId]?.[0] : undefined))
  return (
    <Split side={planTurn ? <PlanDrawer turn={planTurn} userItemId={userItemId} /> : null}>
      <Transcript />
    </Split>
  )
}

/** A worker with no turn yet: its assignment, and why it has not started. */
function NotStarted({ task, note }: { task: OrchestratorTask; note: string }) {
  return (
    <div className="worker-waiting">
      <AssignmentStrip task={task.task} />
      <p className="worker-note">{note}</p>
    </div>
  )
}

function WorkerWindow({ run, task, status }: { run: Orchestration; task: OrchestratorTask; status: WorkerStatus }) {
  return (
    <article className={`worker-window is-${status}`} data-testid="worker-window" data-chat-id={task.chatId} data-status={status} aria-label={`Worker: ${task.title || titleOf(task.task)}`}>
      <header className="worker-head" title={task.task}>
        <span className="worker-glyph" title={providerLabel(task.provider)}><ProviderGlyph provider={task.provider} size={14} /></span>
        <StatusDot status={status} />
        <span className="worker-title" title={task.task}>{task.title || titleOf(task.task)}</span>
        <Elapsed task={task} live={status === 'running'} />
      </header>
      <div className="worker-body">
        <WorkerTranscript run={run} task={task} status={status} compact />
      </div>
      <footer className="worker-foot">
        <span className="worker-provider">{providerLabel(task.provider)}</span>
        <span className="worker-state">{STATUS_TEXT[status]}</span>
        <MergeState task={task} />
        <span className="worker-spacer" />
        <WorkerActions run={run} task={task} status={status} expanded={false} />
      </footer>
    </article>
  )
}

/**
 * The reply box of an expanded worker: sends to the worker's chat with the provider it was
 * dispatched to. A queued worker has no turn to reply into yet (the host refuses it too).
 */
function WorkerReply({ task, queued }: { task: OrchestratorTask; queued: boolean }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { input.current?.focus() }, [task.chatId, queued])
  const submit = async (): Promise<void> => {
    const message = text.trim()
    if (!message || sending || queued) return
    setSending(true)
    if (await replyToWorker(task.chatId, task.provider, message)) setText('')
    setSending(false)
  }
  return (
    <div className="composer-dock worker-reply">
      <div className="composer-group">
        <div className="composer">
          <div className="composer-entry">
            <textarea
              ref={input}
              className="composer-input"
              rows={2}
              value={text}
              disabled={sending || queued}
              placeholder={queued ? 'Waiting in the queue — starts when a slot frees' : `Reply to this worker (${providerLabel(task.provider)})…`}
              aria-label="Message"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
          </div>
          <div className="composer-bar">
            <span className="worker-provider"><ProviderGlyph provider={task.provider} size={12} /> {providerLabel(task.provider)} · default model</span>
            <button type="button" className="send" aria-label="Send" disabled={!text.trim() || sending || queued} onClick={() => void submit()}>
              <ArrowUp size={15} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Whether a key press belongs to a text field, where the arrows move the caret instead. The reply
 * box takes the focus when a worker opens, so while it is empty the arrows still move between workers.
 */
function typing(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return target.value !== ''
  return target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'SELECT')
}

function WorkerExpanded({ run, task, status }: { run: Orchestration; task: OrchestratorTask; status: WorkerStatus }) {
  // Where this worker stands in the board's order, as "at/of".
  const place = useApp((state) => {
    const workers = boardWorkers(state, run)
    return `${workers.findIndex((worker) => worker.task.chatId === task.chatId) + 1}/${workers.length}`
  })
  const [at, of] = place.split('/').map(Number) as [number, number]
  useEffect(() => {
    const keys = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === 'Escape') void act('worker.collapse')
      else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !typing(event.target)) {
        event.preventDefault()
        void act(event.key === 'ArrowLeft' ? 'worker.previous' : 'worker.next')
      }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [])
  return (
    <section className={`worker-expanded is-${status}`} data-testid="worker-expanded" data-chat-id={task.chatId} data-status={status} aria-label={`Worker: ${task.title || titleOf(task.task)}`}>
      <header className="worker-head" title={task.task}>
        <span className="worker-glyph"><ProviderGlyph provider={task.provider} size={15} /></span>
        <StatusDot status={status} />
        <span className="worker-title" title={task.task}>{task.title || titleOf(task.task)}</span>
        <span className="worker-state">{providerLabel(task.provider)} · {STATUS_TEXT[status]}</span>
        <MergeState task={task} />
        <Elapsed task={task} live={status === 'running'} />
        <WorkerActions run={run} task={task} status={status} expanded />
        <span className="worker-step">
          <button type="button" className="icon-button" aria-label="Previous worker" title="Previous worker (←)" disabled={of < 2} onClick={() => void act('worker.previous')}>
            <ChevronLeft size={14} aria-hidden />
          </button>
          {at > 0 && <span className="worker-place">{at} of {of}</span>}
          <button type="button" className="icon-button" aria-label="Next worker" title="Next worker (→)" disabled={of < 2} onClick={() => void act('worker.next')}>
            <ChevronRight size={14} aria-hidden />
          </button>
        </span>
        <button type="button" className="icon-button" aria-label="Close expanded worker" title="Back to the board (Esc)" onClick={() => void act('worker.collapse')}>
          <X size={14} aria-hidden />
        </button>
      </header>
      <div className="worker-expanded-body">
        <WorkerTranscript run={run} task={task} status={status} compact={false} />
      </div>
      <WorkerReply task={task} queued={status === 'queued'} />
    </section>
  )
}

const FILTERS: Array<{ id: WorkerFilter; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'running', label: 'Running' }, { id: 'done', label: 'Done' }
]

type Counts = Record<WorkerStatus, number>

/** How many of a run's workers are in each state, for the board's head and its rail. */
function useCounts(run: Orchestration | null): Counts {
  const statuses = useApp((state) => run ? run.tasks.map((task) => workerStatus(state, run, task)).join(',') : '')
  return useMemo(() => {
    const counts: Counts = { running: 0, queued: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }
    for (const status of statuses.split(',')) if (status) counts[status as WorkerStatus]++
    return counts
  }, [statuses])
}

/** The workers beside the orchestrator chat, in the board's order (`boardWorkers`). */
function WorkerBoard({ run, onFold }: { run: Orchestration | null; onFold?: () => void }) {
  const filter = useApp((state) => state.board.filter)
  // The order as a string, so the board renders again only when a worker moves or changes state.
  const order = useApp((state) => boardWorkers(state, run).map((worker) => `${worker.task.id}:${worker.status}`).join(','))
  const shown = useMemo(() => {
    if (!run || !order) return []
    const byId = new Map(run.tasks.map((task) => [task.id, task]))
    return order.split(',').flatMap((entry) => {
      const [id, status] = entry.split(':') as [string, WorkerStatus]
      const task = byId.get(id)
      return task ? [{ task, status }] : []
    })
  }, [run, order])
  const counts = useCounts(run)
  const stopped = counts.interrupted + counts.cancelled

  return (
    <div className="worker-board" data-testid="worker-board" aria-label="Workers">
      {run && run.tasks.length > 0 ? (
        <>
          <div className="board-head">
            <span className="board-title">Workers</span>
            <span className="board-run" title={run.reason ?? undefined}><StatusDot status={run.status} />{RUN_TEXT[run.status]}</span>
            <span className="board-counts">
              <span><StatusDot status="running" />{counts.running} running</span>
              {counts.queued > 0 && <span><StatusDot status="queued" />{counts.queued} queued</span>}
              <span><StatusDot status="done" />{counts.done} done</span>
              {counts.failed > 0 && <span><StatusDot status="failed" />{counts.failed} failed</span>}
              {stopped > 0 && <span><StatusDot status="interrupted" />{stopped} stopped</span>}
            </span>
            <div className="board-filter" role="group" aria-label="Show workers">
              {FILTERS.map((entry) => (
                <button key={entry.id} type="button" className={filter === entry.id ? 'is-on' : undefined} aria-pressed={filter === entry.id} onClick={() => setWorkerFilter(entry.id)}>
                  {entry.label}
                </button>
              ))}
            </div>
            {onFold && (
              <button type="button" className="icon-button" aria-label="Fold workers" title="Fold the workers back to the rail (Esc)" onClick={onFold}>
                <X size={14} aria-hidden />
              </button>
            )}
          </div>
          {shown.length > 0 ? (
            <div className="board-grid">
              {shown.map(({ task, status }) => <WorkerWindow key={task.id} run={run} task={task} status={status} />)}
            </div>
          ) : (
            <p className="board-none">No {filter === 'running' ? 'running' : 'finished'} workers.</p>
          )}
        </>
      ) : (
        <div className="board-empty" data-testid="worker-board-empty">
          <div>
            <h2>{run ? 'No workers yet' : 'No workers'}</h2>
            <p>{run
              ? 'This run has not dispatched a worker yet. Each worker chat it starts appears here and streams live.'
              : 'Ask the chat on the left for continuous work, and every worker chat its orchestration dispatches appears here and streams live.'}</p>
          </div>
        </div>
      )}
    </div>
  )
}

/** The board folded beside a side panel: one button with a dot and a count per state. */
function BoardRail({ run }: { run: Orchestration | null }) {
  const counts = useCounts(run)
  const rows: Array<[WorkerStatus, number]> = [
    ['running', counts.running], ['queued', counts.queued], ['done', counts.done], ['failed', counts.failed],
    ['cancelled', counts.interrupted + counts.cancelled]
  ]
  const summary = rows.filter(([, count]) => count > 0).map(([status, count]) => `${count} ${STATUS_TEXT[status].toLowerCase()}`).join(', ')
  return (
    <button type="button" className="board-rail" data-testid="worker-rail" aria-label="Show workers" title={summary ? `Workers: ${summary}` : 'No workers yet'} onClick={() => setBoardRailOpen(true)}>
      <span className="board-rail-title">Workers</span>
      {rows.filter(([status, count]) => count > 0 || status === 'running').map(([status, count]) => (
        <span key={status} className="board-rail-count"><StatusDot status={status} />{count}</span>
      ))}
    </button>
  )
}

/** The orchestrator column's head: the run its chat owns, and its progress file. */
function RunHead({ run }: { run: Orchestration }) {
  return (
    <>
      <div className="orch-head" tabIndex={-1}>
        <StatusDot status={run.status} />
        <span className="orch-head-task" title={run.task}>{titleOf(run.task)}</span>
        <span className="orch-head-status" title={run.reason ?? undefined}>{RUN_TEXT[run.status]}</span>
        <RunControls run={run} />
        <button type="button" className="orch-head-link" title={run.progressFile} onClick={() => void go('progress')}>Progress</button>
      </div>
      <RunNotice run={run} />
    </>
  )
}

/** The shell's width, followed a frame after it changes so nothing is written while layout settles. */
function useWidth(element: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const target = element.current
    if (!target) return
    let frame = 0
    const read = (): void => setWidth(Math.round(target.getBoundingClientRect().width))
    read()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(read)
    })
    observer.observe(target)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [element])
  return width
}

/** The whole shell below the title strip. `children` is pane 0, the orchestrator's chat. */
export function OrchestratorShell({ children }: { children: React.ReactNode }) {
  const run = useApp(boardRun)
  const width = useApp((state) => state.board.width)
  const expandedId = useApp((state) => state.board.expanded)
  const railOpen = useApp((state) => state.board.railOpen)
  const beside = useApp((state) => state.browserOpen || state.artifact !== null || state.libraryOpen || state.toolsOpen)
  const expanded = run?.tasks.find((task) => task.chatId === expandedId) ?? null
  const expandedStatus = useApp((state) => (run && expanded ? workerStatus(state, run, expanded) : 'running'))
  const shell = useRef<HTMLDivElement>(null)
  const shellWidth = useWidth(shell)
  const orchMin = beside ? ORCH_MIN.beside : ORCH_MIN.alone
  const boardMin = beside ? BOARD_MIN.beside : BOARD_MIN.alone
  // Too narrow for both columns: the board folds to its rail, and opens over the shell on demand.
  const rail = shellWidth > 0 && shellWidth - orchMin - GAP < boardMin
  const overlay = rail && (railOpen || expanded !== null)

  // Leaving the rail (the side panel closed) puts the board back in place, closed.
  useEffect(() => { if (!rail) setBoardRailOpen(false) }, [rail])
  // Esc folds the open rail when no worker is expanded (an expanded worker's Esc collapses it first).
  useEffect(() => {
    if (!overlay || expanded) return
    const fold = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) setBoardRailOpen(false) }
    window.addEventListener('keydown', fold)
    return () => window.removeEventListener('keydown', fold)
  }, [overlay, expanded])

  const drag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('is-dragging')
    let last = width
    const move = (moved: PointerEvent): void => {
      const box = shell.current!.getBoundingClientRect()
      last = Math.round(Math.max(orchMin, Math.min(box.width - boardMin - GAP, moved.clientX - box.left)))
      setOrchWidth(last, false)
    }
    const up = (): void => {
      handle.classList.remove('is-dragging')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      setOrchWidth(last, true)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  const style = { '--orch-min': `${orchMin}px`, '--board-min': `${boardMin}px`, ...(width ? { '--orch-width': `${width}px` } : {}) } as React.CSSProperties
  return (
    <div ref={shell} className={`orch-shell${beside ? ' is-beside' : ''}${rail ? ' is-rail' : ''}`} style={style}>
      <section className="orch-chat" data-testid="orchestrator-chat" aria-label="Orchestrator chat">
        {run && <RunHead run={run} />}
        {children}
      </section>
      {rail
        ? <div className="orch-gap" />
        : <div className="orch-divider" role="separator" aria-orientation="vertical" aria-label="Resize the orchestrator chat" title="Drag to resize; double-click to reset" onPointerDown={drag} onDoubleClick={() => setOrchWidth(null, true)} />}
      {rail && <BoardRail run={run} />}
      {(!rail || overlay) && (
        <div className={`orch-board-side${overlay ? ' is-overlay' : ''}`}>
          <WorkerBoard run={run} onFold={overlay ? () => { setBoardRailOpen(false); if (expanded) void act('worker.collapse') } : undefined} />
          {run && expanded && <WorkerExpanded run={run} task={expanded} status={expandedStatus} />}
        </div>
      )}
    </div>
  )
}

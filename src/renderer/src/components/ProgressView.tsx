import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Lock, X } from 'lucide-react'
import type { Orchestration, OrchestratorTask, PlanItem } from '../../../shared/orchestrator.ts'
import { PLAN_ITEM_TEXT_MAX, changeLabel, firstSentence, isQuietReview, mergeActivityText, mergeLabel, pendingChanges, pendingChangesText } from '../../../shared/orchestrator.ts'
import { providerLabel } from '../../../shared/types.ts'
import { act, go } from '../app-map.ts'
import {
  PROGRESS_SECTIONS, closeArtifact, expandWorker, noteProgressSection, openChatLink, openWorkerReport, useApp, type ProgressSection
} from '../store.ts'
import '../progress.css'

// The orchestrator's progress.md as the user works with it (docs/mockups/progress-navigation):
// a contents column on the left and five sections. It is drawn from the run itself, so each
// orchestrator event updates it in place, keeping the scroll and whatever is open. The plan is
// editable: every change goes to the host's one plan edit (orchestrator-plan.ts), is locked, and
// shows in Activity until the orchestrator acknowledges it. Needs you holds only what work cannot
// continue without; next steps are in the plan. Colour is kept for what needs attention.
// Its controls go through the app map (`progress`, `plan.edit`, `need.answer`), as a model's do.

const TITLES: Record<ProgressSection, string> = { now: 'Now', needs: 'Needs you', plan: 'Plan', workers: 'Workers', activity: 'Activity' }
const COMPLETED_SHOWN = 5
const ACTIVITY_SHOWN = 12

const pad = (value: number): string => String(value).padStart(2, '0')
const timeOf = (at: number): string => { const date = new Date(at); return `${pad(date.getHours())}:${pad(date.getMinutes())}` }

function dayOf(at: number, now: number): string {
  const day = (ms: number) => new Date(ms).toDateString()
  if (day(at) === day(now)) return 'Today'
  if (day(at) === day(now - 86_400_000)) return 'Yesterday'
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function elapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The clock, a tick every half minute, for how long a worker has been at its step. */
function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Inline Markdown as the orchestrator writes it: `code`, **bold** and [links](path). */
function Inline({ text, cwd }: { text: string; cwd: string }) {
  const parts: ReactNode[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const key = match.index
    if (match[1] !== undefined) parts.push(<code key={key}>{match[1]}</code>)
    else if (match[2] !== undefined) parts.push(<b key={key}>{match[2]}</b>)
    else parts.push(<a key={key} href={match[4]} onClick={(event) => { event.preventDefault(); void openChatLink(match[4]!, cwd) }}>{match[3]}</a>)
    last = key + match[0].length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

function verdictOf(task: OrchestratorTask): string {
  if (task.review) return (task.review.trim().split(/\s+/)[0] ?? '').replace(/[^\w-]/g, '') || 'Reviewed'
  if (task.status === 'running' || task.status === 'queued') return task.status === 'running' ? 'Running' : 'Queued'
  return task.status === 'completed' ? 'Awaiting review' : task.status[0]!.toUpperCase() + task.status.slice(1)
}

function verdictTone(task: OrchestratorTask): string {
  const verdict = verdictOf(task)
  if (/^(Rejected|Failed|Interrupted)/i.test(verdict)) return ' is-bad'
  if (/^(Mixed|Partial|Awaiting)/i.test(verdict)) return ' is-warn'
  return ''
}

/** Where a worktree task's work went after its verdict, under the verdict; nothing for a task in the main folder. */
function MergeState({ task }: { task: OrchestratorTask }) {
  const label = mergeLabel(task)
  if (!label) return null
  return <span className={`pv-merge pv-verdict${label.tone === 'warn' ? ' is-warn' : ''}`} data-merge={task.merge!.status} title={label.title || undefined}>{label.text}</span>
}

type PlanChangeName = 'done' | 'reopen' | 'restore' | 'keep' | 'drop' | 'up' | 'down' | 'reword' | 'add' | 'undo'

/** One plan change through the app map; false when it was refused (the app shows why). */
async function changePlan(change: PlanChangeName, params: { item?: string; text?: string; changeId?: string } = {}): Promise<boolean> {
  return (await act('plan.edit', { change, ...params })).ok
}

const whoOf = (task: OrchestratorTask): string => `${providerLabel(task.provider)}${task.model ? ` · ${task.model}` : ''}`

function workersOf(run: Orchestration, item: PlanItem): OrchestratorTask[] {
  return run.tasks.filter((task) => task.planItem === item.id || item.tasks.includes(task.id))
}

// ── Plan ──────────────────────────────────────────────────────────────

type RowProps = {
  run: Orchestration
  item: PlanItem
  isNext?: boolean
  now: number
  open: boolean
  onOpen: () => void
  menu: boolean
  onMenu: (open: boolean) => void
}

function PlanRow({ run, item, isNext, now, open, onOpen, menu, onMenu }: RowProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const edit = (change: PlanChangeName, text?: string) => { onMenu(false); void changePlan(change, { item: item.id, text }) }
  const off = item.status === 'kept' || item.status === 'dropped'
  const canMove = item.status === 'planned' || item.status === 'active'
  const workers = workersOf(run, item)
  const working = workers.filter((task) => task.status === 'running' || task.status === 'queued')
  const left = editing === null ? 0 : PLAN_ITEM_TEXT_MAX - editing.trim().length
  const label = item.status === 'done' ? 'Done. Click to reopen.' : item.status === 'active' ? 'In progress. Click to mark done.' : 'To do. Click to mark done.'
  return (
    <li className={`pv-item is-${item.status}${open ? ' is-open' : ''}${menu ? ' is-menu' : ''}`} data-item={item.id}>
      <div className="pv-row">
        {off
          ? <span className="pv-check is-off" title={item.status === 'kept' ? 'Kept: not being done' : 'Dropped'}>–</span>
          : (
            <button
              type="button" role="checkbox" aria-checked={item.status === 'done'} aria-label={`${item.status === 'done' ? 'Reopen' : 'Mark done'}: ${item.text}`}
              className={`pv-check is-${item.status}`} title={label}
              onClick={() => edit(item.status === 'done' ? 'reopen' : 'done')}
            >✓</button>
          )}
        {editing !== null ? (
          <span className="pv-editing">
            <input
              autoFocus value={editing} aria-label="Plan step wording" onChange={(event) => setEditing(event.target.value)}
              onFocus={(event) => event.target.select()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setEditing(null)
                if (event.key === 'Enter' && left >= 0) { const text = editing; setEditing(null); edit('reword', text) }
              }}
            />
            <span className={`pv-left${left < 0 ? ' is-over' : ''}`}>{left >= 0 ? left : `${-left} too long`}</span>
          </span>
        ) : (
          <span className="pv-text" title={item.id} onClick={(event) => { if (!(event.target as HTMLElement).closest('a, button')) onOpen() }}>
            <span className="pv-words"><Inline text={item.text} cwd={run.cwd} /></span>
            {isNext && <span className="pv-tag is-next">Next</span>}
            {item.status === 'kept' && <span className="pv-tag">kept</span>}
            {item.by === 'user' && <span className="pv-lock" title="Set by you. The orchestrator asks before changing it."><Lock size={10} /></span>}
            {working.map((task) => (
              <button key={task.id} type="button" className="pv-who" title={`Worker ${task.id}: ${task.title}`} onClick={() => expandWorker(task.chatId)}>
                {providerLabel(task.provider)} · {task.status === 'queued' ? 'queued' : elapsed(now - (task.startedAt ?? now))}
              </button>
            ))}
          </span>
        )}
        <button type="button" className="pv-more" aria-label={`Actions for ${item.text}`} aria-haspopup="menu" aria-expanded={menu} onClick={(event) => { event.stopPropagation(); onMenu(!menu) }}>···</button>
      </div>
      {menu && (
        <div className="pv-menu" role="menu" onClick={(event) => event.stopPropagation()}>
          <div className="pv-menu-id">{item.id}</div>
          {item.status !== 'done' && (off
            ? <button type="button" role="menuitem" onClick={() => edit('restore')}>Put back in the plan</button>
            : <>
              <button type="button" role="menuitem" onClick={() => edit('keep')}>Keep, don't do this</button>
              <button type="button" role="menuitem" onClick={() => edit('drop')}>Drop</button>
            </>)}
          <button type="button" role="menuitem" onClick={() => { onMenu(false); setEditing(item.text) }}>Edit wording</button>
          {canMove && <>
            <hr />
            <button type="button" role="menuitem" onClick={() => edit('up')}>Move up</button>
            <button type="button" role="menuitem" onClick={() => edit('down')}>Move down</button>
          </>}
        </div>
      )}
      {open && (
        <div className="pv-detail">
          {workers.length ? workers.map((task) => (
            <div key={task.id} className="pv-detail-row">
              <span className="pv-faint">{task.id}</span>
              <span>{whoOf(task)}</span>
              <button type="button" className="pv-detail-title" title={task.task} onClick={() => expandWorker(task.chatId)}>{task.title}</button>
              <span className={`pv-verdict${verdictTone(task)}`}>{verdictOf(task)}</span>
              <MergeState task={task} />
              <button type="button" className="pv-link" onClick={() => void openWorkerReport(run, task)}>report</button>
            </div>
          )) : <span className="pv-faint">No worker yet.</span>}
        </div>
      )}
    </li>
  )
}

function AddStep() {
  const [text, setText] = useState<string | null>(null)
  if (text === null) return <button type="button" className="pv-link pv-add-open" onClick={() => setText('')}>+ Add a step</button>
  const left = PLAN_ITEM_TEXT_MAX - text.trim().length
  return (
    <form className="pv-add" onSubmit={async (event) => {
      event.preventDefault()
      if (!text.trim() || left < 0) return
      if (await changePlan('add', { text })) setText(null)
    }}>
      <input autoFocus value={text} placeholder="Describe the step" aria-label="New plan step" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setText(null) }} />
      {left < 20 && <span className={`pv-left${left < 0 ? ' is-over' : ''}`}>{left >= 0 ? left : `${-left} too long`}</span>}
      <button type="submit" className="pv-button is-primary">Add</button>
      <button type="button" className="pv-button" onClick={() => setText(null)}>Cancel</button>
    </form>
  )
}

function Plan({ run, now }: { run: Orchestration; now: number }) {
  const [showDone, setShowDone] = useState(true)
  const [allDone, setAllDone] = useState(false)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  useEffect(() => {
    if (!menuFor) return
    const close = () => setMenuFor(null)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('click', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', key) }
  }, [menuFor])
  const done = run.plan.filter((item) => item.status === 'done')
  const next = run.plan.filter((item) => item.status === 'planned' || item.status === 'active')
  const notDoing = run.plan.filter((item) => item.status === 'kept' || item.status === 'dropped')
  const counted = done.length + next.length
  // The most recent steps finished are the ones worth seeing; the rest wait behind Show all.
  const doneShown = allDone ? done : done.slice(-COMPLETED_SHOWN)
  const row = (item: PlanItem, isNext = false) => (
    <PlanRow
      key={item.id} run={run} item={item} isNext={isNext} now={now}
      open={opened.has(item.id)}
      onOpen={() => setOpened((current) => { const copy = new Set(current); if (!copy.delete(item.id)) copy.add(item.id); return copy })}
      menu={menuFor === item.id} onMenu={(open) => setMenuFor(open ? item.id : null)}
    />
  )
  return (
    <>
      <div className="pv-progress">
        <div className="pv-bar"><div className="pv-fill" style={{ width: `${counted ? Math.round((done.length / counted) * 100) : 0}%` }} /></div>
        <span className="pv-progress-label">{done.length} of {counted} done</span>
      </div>
      {done.length > 0 && (
        <div className="pv-group">
          <div className="pv-group-head">
            <button type="button" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>{showDone ? '▾' : '▸'} Completed <span className="pv-count">{done.length}</span></button>
          </div>
          {showDone && <>
            <ol className="pv-items">{doneShown.map((item) => row(item))}</ol>
            {done.length > COMPLETED_SHOWN && <button type="button" className="pv-link pv-indent" onClick={() => setAllDone(!allDone)}>{allDone ? 'Show the last five' : `Show all ${done.length}`}</button>}
          </>}
        </div>
      )}
      <div className="pv-group">
        <div className="pv-group-head">Next steps <span className="pv-count">{next.length}</span></div>
        <ol className="pv-items">{next.map((item, index) => row(item, index === 0))}</ol>
        <div className="pv-indent"><AddStep /></div>
      </div>
      {notDoing.length > 0 && (
        <div className="pv-group">
          <div className="pv-group-head">Not doing <span className="pv-count">{notDoing.length}</span></div>
          <ol className="pv-items">{notDoing.map((item) => row(item))}</ol>
        </div>
      )}
    </>
  )
}

// ── Needs you ─────────────────────────────────────────────────────────

function Needs({ run }: { run: Orchestration }) {
  const [typed, setTyped] = useState<Record<string, string>>({})
  const open = run.needs.filter((need) => need.answer === null)
  if (!open.length) return <p className="pv-none">Nothing is waiting on you.</p>
  return (
    <>
      {open.map((need) => (
        <div key={need.id} className="pv-ask">
          <span className="pv-ask-q">{need.text}{need.from && <span className="pv-ask-from">{need.from}</span>}</span>
          {need.options.length ? (
            <span className="pv-ask-opts">
              {need.options.map((option, index) => (
                <button key={option} type="button" className={`pv-button${index === 0 ? ' is-primary' : ''}`} onClick={() => void act('need.answer', { need: need.id, answer: option })}>{option}</button>
              ))}
            </span>
          ) : (
            <form className="pv-ask-opts" onSubmit={(event) => { event.preventDefault(); const text = typed[need.id]?.trim(); if (text) void act('need.answer', { need: need.id, answer: text }) }}>
              <input value={typed[need.id] ?? ''} placeholder="Your answer" aria-label={`Answer: ${need.text}`} onChange={(event) => setTyped({ ...typed, [need.id]: event.target.value })} />
              <button type="submit" className="pv-button is-primary">Answer</button>
            </form>
          )}
        </div>
      ))}
    </>
  )
}

// ── Workers ───────────────────────────────────────────────────────────

function Workers({ run }: { run: Orchestration }) {
  if (!run.tasks.length) return <p className="pv-none">No workers dispatched yet.</p>
  return (
    <table className="pv-table">
      <tbody>
        {[...run.tasks].reverse().map((task) => (
          <tr key={task.id}>
            <td className="pv-td-id">{task.id}</td>
            <td className="pv-td-title"><button type="button" title={task.task} onClick={() => expandWorker(task.chatId)}>{task.title}</button></td>
            <td className="pv-td-who" title={whoOf(task)}>{whoOf(task)}</td>
            <td className={`pv-td-verdict pv-verdict${verdictTone(task)}`}>{verdictOf(task)}<MergeState task={task} /></td>
            <td className="pv-td-report"><button type="button" className="pv-link" onClick={() => void openWorkerReport(run, task)}>report</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Activity ──────────────────────────────────────────────────────────

type Event = { at: number; seq: number; you: boolean; body: ReactNode }

function events(run: Orchestration): Event[] {
  const list: Event[] = []
  run.changes.forEach((change, index) => list.push({
    at: change.at, seq: index, you: true,
    body: <>
      {changeLabel(change, run.plan)}{change.source === 'file' && <span className="pv-faint"> · edited in progress.md</span>}
      <span className={`pv-state${change.ack ? '' : ' is-wait'}`}>
        {change.ack
          ? `Seen in review ${change.ack.cycle}: ${change.ack.text}`
          : <>Not yet seen by the orchestrator · <button type="button" className="pv-link" onClick={() => void changePlan('undo', { changeId: change.id })}>Undo</button></>}
      </span>
    </>
  }))
  run.updates.forEach((text, index) => {
    const linked = run.plan.filter((item) => item.from === index)
    const short = text.length > 140 ? `${text.slice(0, 140)}…` : text
    list.push({
      at: run.updateTimes[index] ?? run.createdAt, seq: index, you: true,
      body: <>{/^Answered "/.test(text) ? short : `Message: ${short}`}{linked.length > 0 && <span className="pv-state">Became {linked.map((item) => item.text).join('; ')}</span>}</>
    })
  })
  run.decisions.forEach((decision, index) => list.push({ at: decision.at, seq: index, you: false, body: <>Decided: <Inline text={decision.text} cwd={run.cwd} /></> }))
  run.history.forEach((entry, index) => {
    if (isQuietReview(entry)) return
    const sentence = firstSentence(entry.summary)
    list.push({ at: entry.at, seq: index, you: false, body: <Inline text={entry.taskId ? `Reviewed ${entry.taskId}: ${sentence}` : sentence} cwd={run.cwd} /> })
  })
  run.tasks.forEach((task, index) => {
    const text = mergeActivityText(task)
    if (text) list.push({ at: task.merge!.at, seq: index, you: false, body: <Inline text={text} cwd={run.cwd} /> })
  })
  // Newest first; within the same moment, the later entry first.
  return list.sort((a, b) => b.at - a.at || b.seq - a.seq)
}

function Activity({ run, now }: { run: Orchestration; now: number }) {
  const [all, setAll] = useState(false)
  const list = useMemo(() => events(run), [run])
  const pending = pendingChanges(run).length
  const shown = all ? list : list.slice(0, ACTIVITY_SHOWN)
  let day = ''
  return (
    <>
      {pending > 0 && (
        <div className="pv-notice">
          <span className="pv-warn">{pending} {pending === 1 ? 'change' : 'changes'} not yet seen by the orchestrator.</span> It must acknowledge each one before it dispatches more work.
          <details><summary>What it will be told</summary><pre>{pendingChangesText(run)}</pre></details>
        </div>
      )}
      {!list.length && <p className="pv-none">Nothing has happened yet.</p>}
      {shown.map((event, index) => {
        const label = dayOf(event.at, now)
        const head = label !== day ? <div className="pv-day">{label}</div> : null
        day = label
        return (
          <div key={index}>
            {head}
            <div className="pv-event">
              <span className="pv-time">{timeOf(event.at)}</span>
              <span className={`pv-by${event.you ? ' is-you' : ''}`}>{event.you ? 'You' : 'Orchestrator'}</span>
              <span className="pv-what">{event.body}</span>
            </div>
          </div>
        )
      })}
      {list.length > ACTIVITY_SHOWN && <button type="button" className="pv-link" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${list.length}`}</button>}
    </>
  )
}

// ── The view ──────────────────────────────────────────────────────────

const STATUS_TEXT: Record<Orchestration['status'], string> = { running: 'Running', draining: 'Finishing', paused: 'Paused', stopped: 'Stopped' }

function Checks({ run }: { run: Orchestration }) {
  const { checks } = run
  if (!checks) return null
  const count = (name: string, value: { passed: number; total: number } | null) => value && (
    <span className={value.passed === value.total ? '' : 'pv-warn'}> · {name} {value.passed}/{value.total}</span>
  )
  return (
    <p className="pv-checks" title={`Reported ${timeOf(checks.at)}`}>
      Checks{checks.typecheck && <span className={checks.typecheck === 'pass' ? '' : 'pv-warn'}>: typecheck {checks.typecheck === 'pass' ? '✓' : '✗'}</span>}
      {count('tests', checks.tests)}{count('UI', checks.ui)}
    </p>
  )
}

export function ProgressView({ run }: { run: Orchestration }) {
  const progress = useApp((state) => state.progress)
  const now = useNow()
  const content = useRef<HTMLDivElement>(null)
  const jumping = useRef(0)
  const sections = useRef<Partial<Record<ProgressSection, HTMLElement | null>>>({})
  const [flash, setFlash] = useState<ProgressSection | null>(null)
  const pending = pendingChanges(run).length
  const needs = run.needs.filter((need) => need.answer === null).length
  const done = run.plan.filter((item) => item.status === 'done').length
  const counted = run.plan.filter((item) => item.status !== 'kept' && item.status !== 'dropped').length

  // A section asked for, by the contents column or the app map, scrolls into view.
  useEffect(() => {
    const target = sections.current[progress.section]
    const box = content.current
    if (!target || !box || !progress.jump) return
    jumping.current = Date.now()
    box.scrollTo({ top: target.offsetTop - 4, behavior: 'smooth' })
    setFlash(progress.section)
    const timer = setTimeout(() => setFlash(null), 900)
    return () => clearTimeout(timer)
  }, [progress.jump])

  const spy = () => {
    const box = content.current
    if (!box || Date.now() - jumping.current < 700) return
    let current: ProgressSection = PROGRESS_SECTIONS[0]
    for (const id of PROGRESS_SECTIONS) if ((sections.current[id]?.offsetTop ?? Infinity) <= box.scrollTop + 60) current = id
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) current = PROGRESS_SECTIONS.at(-1)!
    noteProgressSection(current)
  }

  const step = (delta: 1 | -1) => {
    const at = PROGRESS_SECTIONS.indexOf(progress.section)
    void go('progress', { section: PROGRESS_SECTIONS[Math.min(PROGRESS_SECTIONS.length - 1, Math.max(0, at + delta))]! })
  }

  const body: Record<ProgressSection, ReactNode> = {
    now: <>
      {run.reason && <p className={`pv-reason${run.status === 'paused' ? ' pv-warn' : ''}`}>{run.reason}</p>}
      <div className="pv-now"><Inline text={run.summary} cwd={run.cwd} /></div>
      {run.next && <div className="pv-next"><span className="pv-faint">Next</span><span><Inline text={run.next} cwd={run.cwd} /></span></div>}
      <Checks run={run} />
      <details className="pv-brief"><summary>The brief</summary><p>{run.task}</p></details>
    </>,
    needs: <Needs run={run} />,
    plan: <Plan run={run} now={now} />,
    workers: <Workers run={run} />,
    activity: <Activity run={run} now={now} />
  }

  return (
    <section
      className="artifact progress-view" aria-label="Orchestrator progress"
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('input, textarea') || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key === 'j') step(1)
        if (event.key === 'k') step(-1)
      }}
    >
      <header className="artifact-head pv-head">
        <span className="pv-title">
          <span className={`pv-dot is-${run.status}`} />
          <span>Progress</span>
          <span className="pv-meta">{STATUS_TEXT[run.status]} · updated {timeOf(run.updatedAt)} · review {run.cycle}</span>
        </span>
        <span className="artifact-actions">
          {pending > 0 && <button type="button" className="pv-pending" onClick={() => void go('progress', { section: 'activity' })}>{pending} {pending === 1 ? 'change' : 'changes'} not yet seen</button>}
          <button type="button" className="icon-button" aria-label="Close progress" onClick={closeArtifact}><X size={15} /></button>
        </span>
      </header>
      <div className="pv-body">
        <nav className="pv-nav" aria-label="Sections">
          {PROGRESS_SECTIONS.map((id) => (
            <button key={id} type="button" aria-current={progress.section === id} onClick={() => void go('progress', { section: id })}>
              {TITLES[id]}
              {id === 'needs' && needs > 0 && <span className="pv-n is-attn">{needs}</span>}
              {id === 'plan' && <span className="pv-n">{done}/{counted}</span>}
              {id === 'workers' && run.tasks.length > 0 && <span className="pv-n">{run.tasks.length}</span>}
            </button>
          ))}
        </nav>
        <div ref={content} className="pv-content" tabIndex={-1} onScroll={() => requestAnimationFrame(spy)}>
          <div className="pv-doc">
            {PROGRESS_SECTIONS.map((id) => (
              <section key={id} id={`progress-${id}`} ref={(element) => { sections.current[id] = element }} className={`pv-section${flash === id ? ' is-flash' : ''}`} aria-label={TITLES[id]}>
                <h2>{TITLES[id]}</h2>
                {body[id]}
              </section>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

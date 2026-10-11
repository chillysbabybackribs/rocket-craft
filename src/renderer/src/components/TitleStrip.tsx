import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { PROVIDERS, providerLabel, type ProviderId, type UsageSnapshot, type UsageWindow } from '../../../shared/types.ts'
import { refreshUsage, useApp } from '../store.ts'
import { ProviderGlyph } from './glyphs.tsx'
import { Toolbar } from './Toolbar.tsx'

// The title strip: window lights, the toolbar (Toolbar.tsx) and the usage notch
// (docs/mockups/usage-in-titlebar.html). The notch is the app's signature: a black tab hanging from
// the window's top edge with one ring per provider, each showing how much of that subscription's
// nearest limit is used. There is no rail; the chat card starts at the window's left edge.

const RING = 26
const STROKE = 2.5
const FLYOUT_WIDTH = 264
const RADIUS = (RING - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Green while there is room, yellow past half, red when the limit is close. */
function levelOf(percent: number): 'ok' | 'warn' | 'high' {
  return percent >= 70 ? 'high' : percent >= 45 ? 'warn' : 'ok'
}

function resetText(resetsAt: number | null, now: number): string {
  if (!resetsAt) return ''
  const minutes = Math.round((resetsAt - now) / 60_000)
  if (minutes <= 0) return 'Resetting now'
  if (minutes < 60) return `Resets in ${minutes} min`
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return `Resets in ${hours} h${rest ? ` ${rest} min` : ''}`
  }
  const date = new Date(resetsAt)
  const day = date.toLocaleDateString(undefined, { weekday: 'short' })
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `Resets ${day} ${time}`
}

/** A window control's mark, drawn on the light's own 12px grid so it sits dead centre. */
function LightGlyph({ d }: { d: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d={d} />
    </svg>
  )
}

function Ring({ provider, usage }: { provider: ProviderId; usage: UsageSnapshot | undefined }) {
  const lead: UsageWindow | undefined = usage?.windows[0]
  const percent = lead?.percent ?? 0
  return (
    <>
      <span className="ring">
        <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} aria-hidden>
          <circle className="ring-track" cx={RING / 2} cy={RING / 2} r={RADIUS} strokeWidth={STROKE} />
          {lead && (
            <circle
              className={`ring-value level-${levelOf(percent)}`}
              cx={RING / 2}
              cy={RING / 2}
              r={RADIUS}
              strokeWidth={STROKE}
              strokeDasharray={`${(Math.max(percent, 1.5) / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
            />
          )}
        </svg>
        <span className="ring-glyph"><ProviderGlyph provider={provider} size={13} /></span>
      </span>
      <span className="ring-percent">{lead ? `${percent}%` : usage ? '–' : '···'}</span>
    </>
  )
}

function Flyout({ provider, usage, at, keepOpen, hide }: {
  provider: ProviderId
  usage: UsageSnapshot | undefined
  at: { left: number; top: number }
  keepOpen: () => void
  hide: () => void
}) {
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refreshUsage(provider, true)
    } finally {
      setRefreshing(false)
    }
  }
  const now = Date.now()
  const detail = [usage?.plan, usage?.account].filter(Boolean).join(' · ')
  return (
    <div className="flyout" style={at} role="group" aria-label={`${providerLabel(provider)} usage`}
      onMouseEnter={keepOpen} onMouseLeave={hide} onFocus={keepOpen} onBlur={hide}>
      <div className="flyout-title">
        <ProviderGlyph provider={provider} size={18} />
        <span>{providerLabel(provider)} Usage</span>
        <button
          type="button"
          className={`flyout-refresh${refreshing ? ' is-refreshing' : ''}`}
          aria-label={`Refresh ${providerLabel(provider)} usage`}
          aria-disabled={refreshing}
          title={refreshing ? 'Refreshing usage…' : 'Refresh usage'}
          onClick={refresh}
        >
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      {!usage && <p className="flyout-empty">Reading usage…</p>}
      {usage?.windows.map((window) => (
        <div className="flyout-window" key={window.label}>
          <div className="flyout-row">
            <span>{window.label}</span>
            <span className="flyout-reset">{resetText(window.resetsAt, now)}</span>
          </div>
          <div className="flyout-bar">
            <div className={`flyout-fill level-${levelOf(window.percent)}`} style={{ width: `${Math.max(window.percent, 1.5)}%` }} />
          </div>
          <div className="flyout-used">{window.percent}% Used</div>
        </div>
      ))}
      {usage && usage.windows.length === 0 && <p className="flyout-empty">{usage.unavailable ?? 'No usage reported.'}</p>}
      {usage?.note && <p className="flyout-note">{usage.note}</p>}
      {detail && <p className="flyout-note">{detail}</p>}
    </div>
  )
}

/**
 * Where a ring's flyout opens: centred under the ring, then pulled left until it ends inside the
 * chat card. The centre of the strip sits over the seam between chat and browser, and the
 * browser's page is a native view that paints over anything drawn across it.
 */
function flyoutPlace(element: HTMLElement): { left: number; top: number } {
  const ring = element.getBoundingClientRect()
  const notch = element.closest('.notch')!.getBoundingClientRect()
  const chat = document.querySelector('.chat')?.getBoundingClientRect()
  const limit = (chat ? chat.right : window.innerWidth) - 8 - FLYOUT_WIDTH
  return { left: Math.max(8, Math.min(ring.left + ring.width / 2 - FLYOUT_WIDTH / 2, limit)), top: notch.bottom + 6 }
}

function UsageNotch() {
  const usage = useApp((state) => state.usage)
  const [hovered, setHovered] = useState<{ provider: ProviderId; at: { left: number; top: number } } | null>(null)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current) }, [])

  const keepOpen = (): void => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
  }
  const show = (provider: ProviderId, element: HTMLElement): void => {
    keepOpen()
    setHovered({ provider, at: flyoutPlace(element) })
    // The host reuses a reading younger than a minute, so hovering is cheap.
    refreshUsage(provider)
  }
  // A flyout pulled left of its ring is a longer reach, so leaving waits a little before closing.
  const hide = (): void => {
    keepOpen()
    closeTimer.current = window.setTimeout(() => setHovered(null), 240)
  }

  return (
    <div className="notch" aria-label="Subscription usage">
      {PROVIDERS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className="notch-item"
          aria-label={`${label} usage${usage[id]?.windows[0] ? `: ${usage[id]!.windows[0]!.percent}% used` : ''}`}
          onMouseEnter={(event) => show(id, event.currentTarget)}
          onMouseLeave={hide}
          onFocus={(event) => show(id, event.currentTarget)}
          onBlur={hide}
          onClick={() => refreshUsage(id, true)}
        >
          <Ring provider={id} usage={usage[id]} />
        </button>
      ))}
      {hovered && <Flyout key={hovered.provider} provider={hovered.provider} usage={usage[hovered.provider]} at={hovered.at} keepOpen={keepOpen} hide={hide} />}
    </div>
  )
}

function Traffic() {
  return (
    <div className="traffic" role="group" aria-label="Window controls">
      <button type="button" className="light light-close" aria-label="Close window" onClick={() => window.rocket.window.close()}>
        <LightGlyph d="M4 4l4 4M8 4l-4 4" />
      </button>
      <button type="button" className="light light-min" aria-label="Minimize window" onClick={() => window.rocket.window.minimize()}>
        <LightGlyph d="M3.5 6h5" />
      </button>
      <button type="button" className="light light-max" aria-label="Zoom window" onClick={() => window.rocket.window.toggleMaximize()}>
        <LightGlyph d="M3.5 6h5M6 3.5v5" />
      </button>
    </div>
  )
}

/**
 * The strip above the cards: the window lights and the toolbar at its start, the usage tab at its
 * centre. The grid's two outer columns share the width equally, so the tab sits at the window's
 * centre until the toolbar outgrows its half, and then it moves right rather than overlapping.
 */
export function TitleStrip() {
  return (
    <header className="titlebar">
      <div className="titlebar-start">
        <Traffic />
        <Toolbar />
      </div>
      <UsageNotch />
    </header>
  )
}

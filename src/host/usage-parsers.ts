import type { UsageWindow } from '../shared/types.ts'
import { clampPercent, recordOf } from './json.ts'

// Each provider reports subscription usage in its own shape and units. Everything lands here as
// rolling windows of percent used plus a reset time in epoch milliseconds.

export type ParsedUsage = { plan: string | null; windows: UsageWindow[]; note: string | null }

/** Names a rolling window by its length, the way each provider's own UI names it. */
export function windowLabel(minutes: number): string {
  if (!(minutes > 0)) return 'Usage'
  if (minutes === 10_080) return 'Weekly'
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440
    return days === 1 ? 'Daily' : `${days}-day`
  }
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-minute`
}

const PLAN_NAMES: Record<string, string> = { prolite: 'Pro Lite', edu: 'Edu' }

/** Prettify a provider's plan id; unknown ids are humanized rather than hidden. */
export function planName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const raw = value.trim()
  return PLAN_NAMES[raw] ?? raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** The app-server's `RateLimitSnapshot`, from `account/rateLimits/read` or its notification. */
export function codexUsage(value: unknown): ParsedUsage | null {
  const snapshot = recordOf(value)
  if (!('primary' in snapshot) && !('secondary' in snapshot)) return null
  const windows = [snapshot.primary, snapshot.secondary].flatMap((entry) => {
    const window = recordOf(entry)
    if (typeof window.usedPercent !== 'number') return []
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : 0
    // The app-server reports the reset in epoch seconds.
    const resetsAt = typeof window.resetsAt === 'number' && window.resetsAt > 0 ? window.resetsAt * 1_000 : null
    return [{ label: windowLabel(minutes), percent: clampPercent(window.usedPercent), resetsAt }]
  })
  // Shortest window first, so the ring shows the limit that bites soonest.
  windows.sort((a, b) => windowOrder(a.label) - windowOrder(b.label))
  const credits = recordOf(snapshot.credits)
  const note = credits.unlimited === true
    ? 'Unlimited credits'
    : credits.hasCredits === true && typeof credits.balance === 'string' ? `${credits.balance} credits` : null
  return { plan: planName(snapshot.planType), windows, note }
}

function windowOrder(label: string): number {
  return label === 'Weekly' ? 2 : /day/i.test(label) ? 1 : 0
}

/** Claude's named buckets, in the order the flyout should read them. */
const CLAUDE_WINDOWS: ReadonlyArray<[key: string, label: string]> = [
  ['five_hour', '5-hour'],
  ['seven_day', 'Weekly'],
  ['seven_day_opus', 'Weekly (Opus)'],
  ['seven_day_sonnet', 'Weekly (Sonnet)']
]

/** The Agent SDK's experimental `usage` control response. */
export function claudeUsage(value: unknown): (ParsedUsage & { unavailable: string | null }) | null {
  const response = recordOf(value)
  if (response.rate_limits_available === false) {
    return {
      plan: planName(response.subscription_type),
      windows: [],
      note: null,
      unavailable: 'Plan limits do not apply to this Claude sign-in.'
    }
  }
  const limits = recordOf(response.rate_limits)
  if (Object.keys(limits).length === 0) return null
  const windows: UsageWindow[] = []
  for (const [key, label] of CLAUDE_WINDOWS) {
    const window = claudeWindow(limits[key], label)
    if (window) windows.push(window)
  }
  if (Array.isArray(limits.model_scoped)) {
    for (const entry of limits.model_scoped) {
      const window = claudeWindow(entry, `Weekly (${String(recordOf(entry).display_name ?? 'model')})`)
      if (window) windows.push(window)
    }
  }
  const extra = recordOf(limits.extra_usage)
  const note = extra.is_enabled === true && typeof extra.used_credits === 'number'
    ? `Extra usage: ${extra.used_credits}${typeof extra.monthly_limit === 'number' ? ` of ${extra.monthly_limit}` : ''}`
    : null
  return { plan: planName(response.subscription_type), windows, note, unavailable: null }
}

function claudeWindow(value: unknown, label: string): UsageWindow | null {
  const window = recordOf(value)
  if (typeof window.utilization !== 'number') return null
  const resets = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN
  return { label, percent: clampPercent(window.utilization), resetsAt: Number.isFinite(resets) ? resets : null }
}

const CLAUDE_EVENT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_overage_included: 'Weekly'
}

/** The one window a mid-turn `rate_limit_event` reports; its `resetsAt` is epoch seconds. */
export function claudeRateLimitWindow(info: Record<string, unknown>): UsageWindow | null {
  const label = CLAUDE_EVENT_LABELS[String(info.rateLimitType ?? '')]
  if (!label || typeof info.utilization !== 'number') return null
  const resetsAt = typeof info.resetsAt === 'number' && info.resetsAt > 0 ? info.resetsAt * 1_000 : null
  return { label, percent: clampPercent(info.utilization), resetsAt }
}

/** Replace the window with the same label, or add it. */
export function mergeWindow(windows: UsageWindow[], window: UsageWindow): UsageWindow[] {
  return windows.some((entry) => entry.label === window.label)
    ? windows.map((entry) => (entry.label === window.label ? window : entry))
    : [...windows, window]
}

/** Cursor's dashboard responses; percentages are of the monthly included amount. */
export function cursorUsage(current: unknown, planResponse: unknown): ParsedUsage {
  const root = recordOf(current)
  const included = recordOf(root.planUsage)
  const info = recordOf(recordOf(planResponse).planInfo)
  const plan = typeof info.planName === 'string' && info.planName.trim() ? info.planName : null
  const resetsAt = epochMs(root.billingCycleEnd) ?? epochMs(info.billingCycleEnd)
  const windows: UsageWindow[] = []
  const add = (label: string, percent: number | null): void => {
    if (percent !== null) windows.push({ label, percent: clampPercent(percent), resetsAt })
  }
  const limit = positive(included.limit)
  const spent = positive(included.includedSpend)
  add('Monthly included', positive(included.totalPercentUsed) ?? (limit && spent !== null ? spent / limit * 100 : null))
  // Missing scoped fields mean unknown, not zero usage.
  add('Monthly Auto', positive(included.autoPercentUsed))
  add('Monthly API', positive(included.apiPercentUsed))
  const spend = recordOf(root.spendLimitUsage)
  const used = positive(spend.individualUsed)
  const note = used ? `On-demand: $${(used / 100).toFixed(2)} spent` : null
  return { plan, windows, note }
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function epochMs(value: unknown): number | null {
  const time = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : positive(value)
  return time && Number.isSafeInteger(time) ? time : null
}

/** The agy CLI's `/quota` JSON: model groups with remaining fractions and reset times. */
export function antigravityUsage(value: unknown): ParsedUsage | null {
  const root = recordOf(value)
  const data = recordOf(recordOf(root.command).data)
  const groups = Array.isArray(data.groups) ? data.groups.map(recordOf) : []
  const windows: UsageWindow[] = []
  for (const group of groups) {
    const name = stringOrEmpty(group.name)
    const groupLabel = /gemini/i.test(name)
      ? 'Gemini'
      : /claude|gpt|3p/i.test(name) ? 'Claude & GPT' : name.replace(/\s*models\s*/i, '').trim() || name
    const buckets = (Array.isArray(group.buckets) ? group.buckets.map(recordOf) : [])
      .sort((a, b) => (a.window === '5h' ? 0 : 1) - (b.window === '5h' ? 0 : 1))
    for (const bucket of buckets) {
      if (typeof bucket.remaining_fraction !== 'number') continue
      const key = stringOrEmpty(bucket.window)
      const base = key === '5h' ? '5-hour' : key === 'weekly' ? 'Weekly' : key || 'Usage'
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN
      windows.push({
        label: groups.length > 1 ? `${base} (${groupLabel})` : base,
        percent: clampPercent((1 - bucket.remaining_fraction) * 100),
        resetsAt: Number.isFinite(reset) ? reset : null
      })
    }
  }
  return windows.length ? { plan: null, windows, note: null } : null
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

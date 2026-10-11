import { type Orchestration } from '../../shared/orchestrator.ts'
import { providerLabel, type OrchestratorNotification } from '../../shared/types.ts'

export const PAUSE_FALLBACK = 'This orchestration is paused. Resume when ready.'

/** Baselines are reset at hydration/reconnect; foreground suppression belongs to main. */
export class RunNotificationObserver {
  private runs = new Map<string, Orchestration>()
  private pauses = new Map<string, number>()
  private ready = false

  reset(): void { this.ready = false; this.runs.clear() }
  seed(runs: Orchestration[]): void {
    this.runs = new Map(runs.map(run => [run.id, run]))
    this.ready = true
  }

  observe(run: Orchestration): OrchestratorNotification[] {
    const previous = this.runs.get(run.id)
    this.runs.set(run.id, run)
    if (!this.ready || !previous) return []
    const notices: OrchestratorNotification[] = []
    for (const task of run.tasks) {
      const before = previous.tasks.find(each => each.id === task.id)
      if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(task.status)) continue
      if (before && !['queued', 'running'].includes(before.status)) continue
      // Cancelled queued assignments produced no evidence and need no desktop interruption.
      if (task.status === 'cancelled' && (before?.status === 'queued' || task.turnId === null)) continue
      const outcome = task.status === 'completed' ? 'finished' : task.status
      const review = task.status === 'cancelled' ? '' : task.review !== null ? ', reviewed' : ', awaiting review'
      notices.push({ key: `${run.id}:task:${task.id}:terminal`,
        title: `Worker ${task.id} (${providerLabel(task.provider)}) ${outcome}${review}`,
        body: task.task.trim().split('\n')[0]!.trim() || 'Worker assignment finished.',
        target: { kind: 'worker', runId: run.id, chatId: run.chatId, workerChatId: task.chatId, taskId: task.id } })
    }
    if (previous.status !== 'paused' && run.status === 'paused') {
      const entry = (this.pauses.get(run.id) ?? 0) + 1
      this.pauses.set(run.id, entry)
      if (/review ended without (?:a progress )?checkpoint/i.test(run.reason ?? '')) {
        notices.push({ key: `${run.id}:pause:${entry}`, title: 'Orchestration paused',
          body: run.reason || PAUSE_FALLBACK, target: { kind: 'run', runId: run.id, chatId: run.chatId } })
      }
    }
    return notices
  }
}

/** A rejected bridge submission must never become an unhandled promise rejection. */
export async function submitNotices(notices: OrchestratorNotification[], show: (notice: OrchestratorNotification) => Promise<unknown>): Promise<void> {
  await Promise.all(notices.map(async notice => { try { await show(notice) } catch { /* Delivery is best effort. */ } }))
}

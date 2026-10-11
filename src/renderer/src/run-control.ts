import type { Orchestration } from '../../shared/orchestrator.ts'

export type RunAction = 'wrapUp' | 'resume'
export type RunControlState = {
  runAction: { runId: string; action: RunAction } | null
  runActionError: { runId: string; message: string } | null
}

type Boundary = {
  pending: () => boolean
  patch: (patch: Partial<RunControlState>) => void
  request: (action: RunAction, runId: string) => Promise<Orchestration>
  update: (run: Orchestration) => void
}

/** Capture the run identity so navigation during a request cannot retarget its result or refusal. */
export async function executeRunControl(boundary: Boundary, runId: string, action: RunAction): Promise<void> {
  if (boundary.pending()) {
    const message = 'A run action is already in progress. Wait for it to finish.'
    boundary.patch({ runActionError: { runId, message } })
    throw new Error(message)
  }
  boundary.patch({ runAction: { runId, action }, runActionError: null })
  try {
    boundary.update(await boundary.request(action, runId))
  } catch (error) {
    boundary.patch({ runActionError: { runId, message: error instanceof Error ? error.message : String(error) } })
    throw error
  } finally {
    boundary.patch({ runAction: null })
  }
}

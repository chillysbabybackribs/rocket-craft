import type { Orchestrator } from './orchestrator.ts'
import { recordOf } from './json.ts'

/** Validate the shell boundary without booting the host in tests. */
export function dispatchRunControl(host: Pick<Orchestrator, 'stateError' | 'wrapUp' | 'resumeRun'> | null, action: 'wrapUp' | 'resumeRun', params: unknown) {
  if (host?.stateError) throw new Error(host.stateError)
  if (!host) throw new Error('The orchestration host is unavailable. Try again when Craft Studio has connected.')
  const { runId } = recordOf(params)
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('Give the run ID shown on the worker board.')
  return host[action](runId)
}

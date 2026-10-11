import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchRunControl } from './orchestrator-control.ts'
import type { Orchestration } from '../shared/orchestrator.ts'

test('run control boundary preserves diagnostic precedence and validates IDs', () => {
  const calls: string[] = []
  const result = {} as Orchestration
  const host = { stateError: null as string | null,
    wrapUp: (id: string) => { calls.push(`wrap:${id}`); return result },
    resumeRun: (id: string) => { calls.push(`resume:${id}`); return result } }
  assert.throws(() => dispatchRunControl(null, 'wrapUp', null), { message: 'The orchestration host is unavailable. Try again when Craft Studio has connected.' })
  for (const params of [null, {}, { runId: '' }, { runId: ' ' }, { runId: 4 }, []]) {
    assert.throws(() => dispatchRunControl(host, 'wrapUp', params), { message: 'Give the run ID shown on the worker board.' })
  }
  host.stateError = 'Cannot read saved orchestration state at /saved/file: bad. The file was preserved.'
  assert.throws(() => dispatchRunControl(host, 'wrapUp', null), { message: host.stateError })
  host.stateError = null
  assert.equal(dispatchRunControl(host, 'wrapUp', { runId: 'run' }), result)
  assert.equal(dispatchRunControl(host, 'resumeRun', { runId: 'run' }), result)
  assert.deepEqual(calls, ['wrap:run', 'resume:run'])
})

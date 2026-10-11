import assert from 'node:assert/strict'
import test from 'node:test'
import type { Orchestration } from '../../shared/orchestrator.ts'
import { executeRunControl, type RunControlState } from './run-control.ts'

function fixture() {
  let state: RunControlState = { runAction: null, runActionError: null }
  const runs: Record<string, Orchestration> = {}
  let resolve!: (run: Orchestration) => void
  let reject!: (error: Error) => void
  const response = new Promise<Orchestration>((yes, no) => { resolve = yes; reject = no })
  const requests: Array<{ action: string; runId: string }> = []
  const boundary = {
    pending: () => state.runAction !== null,
    patch: (patch: Partial<RunControlState>) => { state = { ...state, ...patch } },
    request: (action: 'wrapUp' | 'resume', runId: string) => { requests.push({ action, runId }); return response },
    update: (run: Orchestration) => { runs[run.chatId] = run }
  }
  return { boundary, requests, runs, resolve, reject, state: () => state }
}

test('pending controls refuse duplicates without clearing the original request', async () => {
  const f = fixture()
  const first = executeRunControl(f.boundary, 'r1', 'wrapUp')
  await assert.rejects(executeRunControl(f.boundary, 'r2', 'resume'), /A run action is already in progress. Wait for it to finish./)
  assert.deepEqual(f.requests, [{ action: 'wrapUp', runId: 'r1' }])
  assert.deepEqual(f.state().runAction, { runId: 'r1', action: 'wrapUp' })
  assert.equal(f.state().runActionError?.runId, 'r2')
  f.resolve({ id: 'r1', chatId: 'owner', status: 'draining' } as Orchestration)
  await first
  assert.equal(f.state().runAction, null)
})

test('late result updates its returned owner while another owner remains unchanged', async () => {
  const f = fixture()
  const other = { id: 'r2', chatId: 'new-owner', status: 'paused' } as Orchestration
  f.runs['new-owner'] = other
  const request = executeRunControl(f.boundary, 'r1', 'resume')
  const result = { id: 'r1', chatId: 'old-owner', status: 'running' } as Orchestration
  f.resolve(result)
  await request
  assert.equal(f.runs['old-owner'], result)
  assert.equal(f.runs['new-owner'], other)
  assert.equal(f.state().runAction, null)
})

test('host refusal preserves its full sentence and run ID and always clears pending', async () => {
  const f = fixture()
  const request = executeRunControl(f.boundary, 'old-run', 'resume')
  const sentence = 'Resume is available only while this orchestration is paused.'
  f.reject(new Error(sentence))
  await assert.rejects(request, { message: sentence })
  assert.deepEqual(f.state(), { runAction: null, runActionError: { runId: 'old-run', message: sentence } })
  assert.deepEqual(f.runs, {})
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Orchestration, OrchestratorTask } from '../../shared/orchestrator.ts'
import { RunNotificationObserver, submitNotices } from './notifications.ts'

const task = (status: OrchestratorTask['status'], more: Partial<OrchestratorTask> = {}): OrchestratorTask => ({
  id: '0003', chatId: 'worker', provider: 'cursor', task: 'Inspect the board. More text\nDetails',
  status, turnId: 'turn', review: null, ...more
} as OrchestratorTask)
const run = (tasks: OrchestratorTask[], more: Partial<Orchestration> = {}): Orchestration => ({ id: 'run', chatId: 'owner', status: 'running', reason: null, tasks, ...more } as Orchestration)

test('hydration, reconnect, duplicate snapshots and checkpoint updates stay silent', () => {
  const observer = new RunNotificationObserver()
  assert.deepEqual(observer.observe(run([task('completed')])), [])
  observer.seed([run([task('completed')])])
  assert.deepEqual(observer.observe(run([task('completed', { review: 'Accepted.' })])), [])
  observer.reset()
  assert.deepEqual(observer.observe(run([task('failed')])), [])
  observer.seed([run([task('failed')])])
  assert.deepEqual(observer.observe(run([task('failed')])), [])
  assert.deepEqual(observer.observe(run([task('completed')], { id: 'unseen' })), [])
})

test('terminal transitions use persisted outcomes; synchronous failures and reviewed tasks notify', () => {
  for (const status of ['completed', 'failed', 'interrupted', 'cancelled'] as const) {
    const observer = new RunNotificationObserver()
    observer.seed([run([task('running')])])
    const notices = observer.observe(run([task(status)]))
    assert.equal(notices.length, 1)
    assert.equal(notices[0].key, 'run:task:0003:terminal')
    assert.equal(notices[0].body, 'Inspect the board. More text')
    assert.match(notices[0].title, status === 'cancelled' ? /cancelled$/ : /awaiting review$/)
    assert.deepEqual(notices[0].target, { kind: 'worker', runId: 'run', chatId: 'owner', workerChatId: 'worker', taskId: '0003' })
    assert.deepEqual(observer.observe(run([task(status)])), [])
  }
  const observer = new RunNotificationObserver()
  observer.seed([run([])])
  assert.match(observer.observe(run([task('failed')]))[0].title, /failed, awaiting review/)
  observer.seed([run([task('queued')])])
  assert.match(observer.observe(run([task('completed', { review: 'Accepted.' })]))[0].title, /finished, reviewed/)
})

test('queued cancellations stay silent but queued launch failures notify', () => {
  const observer = new RunNotificationObserver()
  observer.seed([run([task('queued', { turnId: null })])])
  assert.deepEqual(observer.observe(run([task('cancelled', { turnId: null })])), [])
  observer.seed([run([task('queued', { turnId: null })])])
  assert.equal(observer.observe(run([task('failed', { turnId: null })])).length, 1)
})

test('only missing-checkpoint pause entries notify, with distinct keys even at identical timestamps', () => {
  const observer = new RunNotificationObserver()
  const reason = 'The review ended without a progress checkpoint. Inspect its reply and resume.'
  observer.seed([run([])])
  const paused = run([], { status: 'paused', reason, updatedAt: 5 })
  const first = observer.observe(paused)
  assert.equal(first[0].title, 'Orchestration paused')
  assert.equal(first[0].body, reason)
  assert.deepEqual(observer.observe({ ...paused, reason: reason + ' Updated.' }), [])
  observer.observe(run([]))
  const second = observer.observe(paused)
  assert.notEqual(first[0].key, second[0].key)
  observer.observe(run([]))
  assert.deepEqual(observer.observe(run([], { status: 'paused', reason: 'Host restarted.' })), [])
})

test('submission rejection is caught and does not prevent independent notices', async () => {
  const observer = new RunNotificationObserver()
  observer.seed([run([task('running')])])
  const notices = observer.observe(run([task('completed')]))
  let calls = 0
  await submitNotices([...notices, ...notices], async () => { calls++; throw new Error('bridge closed') })
  assert.equal(calls, 2)
})

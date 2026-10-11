import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { OrchestratorNotifications, type NotificationWindow } from './orchestrator-notifications.ts'
import type { OrchestratorNotification } from '../shared/types.ts'

const notice: OrchestratorNotification = { key: 'worker:r:1', title: 'Craft Studio', body: 'Worker finished, awaiting review.', target: { kind: 'worker', runId: 'r', chatId: 'c', workerChatId: 'w', taskId: '1' } }
function fixture() {
  const order: unknown[] = []
  const diagnostics: string[] = []
  let visible = false, minimized = false, focused = false, destroyed = false, supported = true
  let mode: 'ok' | 'throw' | 'fail' = 'ok'
  const natives: Array<EventEmitter & { show(): void; close(): void }> = []
  const window: NotificationWindow = {
    webContents: { send: (channel, target) => { order.push([channel, target]) } },
    isVisible: () => visible, isMinimized: () => minimized, isFocused: () => focused, isDestroyed: () => destroyed,
    restore: () => { order.push('restore'); minimized = false }, show: () => { order.push('show'); visible = true }, focus: () => { order.push('focus'); focused = true }
  }
  const broker = new OrchestratorNotifications({ window: () => window, supported: () => supported,
    diagnostic: message => { diagnostics.push(message) }, create: () => {
      const native = Object.assign(new EventEmitter(), {
        show: () => { if (mode === 'throw') throw new Error('Platform failure'); if (mode === 'fail') native.emit('failed', {}, 'failure') },
        close: () => { order.push('close'); native.emit('close') }
      })
      natives.push(native)
      return native
    } })
  return { broker, window, order, diagnostics, natives,
    set: (state: { visible?: boolean; minimized?: boolean; focused?: boolean; destroyed?: boolean; supported?: boolean; mode?: typeof mode }) => {
      visible = state.visible ?? visible; minimized = state.minimized ?? minimized; focused = state.focused ?? focused
      destroyed = state.destroyed ?? destroyed; supported = state.supported ?? supported; mode = state.mode ?? mode
    } }
}

test('native notices deliver only in background and consume duplicate foreground keys', () => {
  for (const state of [{ visible: false, focused: true }, { visible: true, minimized: true, focused: true }, { visible: true, focused: false }]) {
    const f = fixture(); f.set(state)
    assert.equal(f.broker.show(f.window.webContents, notice), 'shown')
    assert.equal(f.broker.show(f.window.webContents, notice), 'suppressed')
    assert.equal(f.natives.length, 1)
    f.broker.dispose()
  }
  const f = fixture(); f.set({ visible: true, focused: true })
  assert.equal(f.broker.show(f.window.webContents, notice), 'suppressed')
  f.set({ focused: false })
  assert.equal(f.broker.show(f.window.webContents, notice), 'suppressed')
  assert.equal(f.natives.length, 0)
})

test('native notification validates sender and bounded discriminated payload before delivery', () => {
  const f = fixture()
  assert.throws(() => f.broker.show({}, null), { message: "Notifications are only available from Craft Studio's window." })
  for (const payload of [null, {}, { ...notice, key: '' }, { ...notice, title: 'a'.repeat(257) }, { ...notice, body: '\0' }, { ...notice, target: { kind: 'run', runId: 3, chatId: 'c' } }, { ...notice, target: { kind: 'worker', runId: 'r', chatId: 'c' } }, { ...notice, target: { kind: 'other', runId: 'r', chatId: 'c' } }]) {
    assert.throws(() => f.broker.show(f.window.webContents, payload), { message: 'Give a valid orchestration notification and destination.' })
  }
  assert.equal(f.broker.show(f.window.webContents, { ...notice, target: { kind: 'run', runId: 'r', chatId: 'c' } }), 'shown')
  f.broker.dispose()
})

test('native click restores shows focuses and sends typed target; destroyed window does nothing', () => {
  const f = fixture(); f.set({ minimized: true })
  f.broker.show(f.window.webContents, notice)
  f.natives[0].emit('click')
  assert.deepEqual(f.order, ['restore', 'show', 'focus', ['rocket:orchestrator-notification-activate', notice.target]])
  f.set({ destroyed: true }); f.order.length = 0
  f.natives[0].emit('click')
  assert.deepEqual(f.order, [])
  f.broker.dispose()
  assert.equal(f.natives[0].eventNames().length, 0)
  assert.deepEqual(f.order, ['close'])
})

test('native unsupported, synchronous failure, thrown failure, late diagnostics and close cleanup', () => {
  for (const mode of ['fail', 'throw'] as const) {
    const f = fixture(); f.set({ mode })
    assert.equal(f.broker.show(f.window.webContents, notice), 'failed')
    assert.equal(f.natives[0].eventNames().length, 0)
    f.broker.dispose()
  }
  const f = fixture(); f.set({ supported: false })
  assert.equal(f.broker.show(f.window.webContents, notice), 'unsupported')
  assert.equal(f.natives.length, 0)
  f.set({ supported: true })
  assert.equal(f.broker.show(f.window.webContents, { ...notice, key: 'late' }), 'shown')
  f.natives[0].emit('failed', {}, 'late failure')
  assert.match(f.diagnostics[0], /late failure/)
  assert.equal(f.natives[0].eventNames().length, 0)
  f.broker.show(f.window.webContents, { ...notice, key: 'close' })
  f.natives[1].emit('close')
  assert.equal(f.natives[1].eventNames().length, 0)
  f.broker.dispose()
  assert.equal(f.broker.show(f.window.webContents, { ...notice, key: 'disposed' }), 'suppressed')
})

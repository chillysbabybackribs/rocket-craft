import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { CHROME_OBJECT_SCRIPT } from './chrome-object.ts'

// A page world with an empty window.chrome, as Electron gives a page, and just enough of the
// performance API for the script to read.
function pageWorld(chrome: object = {}, navigationEntry: Record<string, unknown> | null = { type: 'navigate', responseStart: 120, domContentLoadedEventEnd: 400, loadEventEnd: 900, nextHopProtocol: 'h2' }) {
  const performance = {
    timeOrigin: 1_700_000_000_000,
    now: () => 1234.5,
    getEntriesByType: (kind: string) => kind === 'navigation' ? (navigationEntry ? [navigationEntry] : []) : kind === 'paint' ? [{ name: 'first-paint', startTime: 300 }] : []
  }
  const window: Record<string, unknown> = { chrome, performance }
  window.window = window
  const context = { window, setTimeout }
  runInNewContext(CHROME_OBJECT_SCRIPT, context)
  return chrome as Record<string, any>
}

// Expected names and values were read from the installed Chrome 152 (see chrome-object.ts).
test('an empty window.chrome gets Chrome\'s three members, in Chrome\'s order and with its descriptors', () => {
  const chrome = pageWorld()
  assert.deepEqual(Object.getOwnPropertyNames(chrome), ['loadTimes', 'csi', 'app'])
  for (const name of ['loadTimes', 'csi', 'app']) {
    const d = Object.getOwnPropertyDescriptor(chrome, name)!
    assert.deepEqual({ e: d.enumerable, w: d.writable, c: d.configurable }, { e: true, w: true, c: true }, name)
  }
  // Chrome's loadTimes and csi are anonymous; its app methods are named.
  assert.equal(chrome.loadTimes.name, '')
  assert.equal(chrome.csi.name, '')
  assert.equal(chrome.app.getDetails.name, 'getDetails')
})

test('loadTimes() has Chrome\'s thirteen fields with the right types and values', () => {
  const times = pageWorld().loadTimes()
  assert.deepEqual(Object.keys(times), [
    'requestTime', 'startLoadTime', 'commitLoadTime', 'finishDocumentLoadTime', 'finishLoadTime', 'firstPaintTime',
    'firstPaintAfterLoadTime', 'navigationType', 'wasFetchedViaSpdy', 'wasNpnNegotiated', 'npnNegotiatedProtocol',
    'wasAlternateProtocolAvailable', 'connectionInfo'
  ])
  assert.equal(times.requestTime, 1_700_000_000)
  assert.equal(times.commitLoadTime, 1_700_000_000.12)
  assert.equal(times.finishLoadTime, 1_700_000_000.9)
  assert.equal(times.firstPaintTime, 1_700_000_000.3)
  assert.equal(times.navigationType, 'Other')
  assert.equal(times.wasFetchedViaSpdy, true)
  assert.equal(times.npnNegotiatedProtocol, 'h2')
  assert.equal(times.connectionInfo, 'h2')
})

test('before any network navigation the values are the zeros and "unknown" Chrome shows', () => {
  const times = pageWorld({}, null).loadTimes()
  assert.equal(times.finishLoadTime, 0)
  assert.equal(times.wasFetchedViaSpdy, false)
  assert.equal(times.npnNegotiatedProtocol, '')
  assert.equal(times.connectionInfo, 'unknown')
  assert.equal(pageWorld({}, null).csi().onloadT, 0)
})

test('csi() has startE, onloadT (DOMContentLoaded), pageT and tran 15 for an ordinary navigation', () => {
  const csi = pageWorld().csi()
  assert.deepEqual(Object.keys(csi), ['startE', 'onloadT', 'pageT', 'tran'])
  assert.equal(csi.startE, 1_700_000_000_000)
  assert.equal(csi.onloadT, 1_700_000_000_400)
  assert.equal(csi.pageT, 1234.5)
  assert.equal(csi.tran, 15)
})

test('a reload and a back/forward navigation are reported as Chrome reports them', () => {
  const reload = pageWorld({}, { type: 'reload', responseStart: 50, domContentLoadedEventEnd: 100, loadEventEnd: 200, nextHopProtocol: 'http/1.1' })
  assert.equal(reload.loadTimes().navigationType, 'Reload')
  assert.equal(reload.loadTimes().wasFetchedViaSpdy, false)
  assert.equal(reload.loadTimes().connectionInfo, 'http/1.1')
  assert.equal(reload.csi().tran, 16)
  const back = pageWorld({}, { type: 'back_forward', responseStart: 50, domContentLoadedEventEnd: 100, loadEventEnd: 200, nextHopProtocol: 'h3' })
  assert.equal(back.loadTimes().navigationType, 'BackForward')
  assert.equal(back.csi().tran, 6)
})

test('app has Chrome\'s members and enum values', () => {
  const { app } = pageWorld()
  assert.deepEqual(Object.getOwnPropertyNames(app), ['isInstalled', 'getDetails', 'getIsInstalled', 'installState', 'runningState', 'InstallState', 'RunningState'])
  assert.equal(app.isInstalled, false)
  assert.equal(app.getDetails(), null)
  assert.equal(app.getIsInstalled(), false)
  assert.equal(app.runningState(), 'cannot_run')
  assert.deepEqual({ ...app.InstallState }, { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' })
  assert.deepEqual({ ...app.RunningState }, { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' })
})

test('a window.chrome that already has members is left alone, so running twice changes nothing', () => {
  const filled = pageWorld()
  const loadTimes = filled.loadTimes
  const again = pageWorld(filled)
  assert.equal(again.loadTimes, loadTimes)
  const custom = pageWorld({ runtime: {} })
  assert.deepEqual(Object.getOwnPropertyNames(custom), ['runtime'])
})

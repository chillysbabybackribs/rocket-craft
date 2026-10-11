// What Chrome puts on `window.chrome` for an ordinary page, which Electron leaves as an empty
// object. Bot checks read it: a user agent that says Chrome beside an empty `window.chrome` is
// one of the tells that gets a person a "Verify you are human" loop. The shape below was read
// from the installed Chrome 152 itself (headless, scratch profile, 2026-10-06): exactly three own
// properties, `loadTimes`, `csi` and `app`, all enumerable, writable and configurable; `loadTimes`
// and `csi` are anonymous functions returning the objects shown; `chrome.runtime` is not there on
// a page without an extension that talks to it. The pane runs this at document start in every
// frame of a tab (browser-pane.ts, presentAsChrome). It does nothing where the object is already
// filled, so running twice is harmless, and nothing else on the page is touched.

export const CHROME_OBJECT_SCRIPT = `(() => {
  const chrome = window.chrome
  if (!chrome || typeof chrome !== 'object' || Object.getOwnPropertyNames(chrome).length !== 0) return
  const perf = window.performance
  const origin = perf.timeOrigin
  const navigation = () => perf.getEntriesByType('navigation')[0]
  const at = (ms) => ms > 0 ? (origin + ms) / 1000 : 0
  const spdy = (n) => !!n && /^h[23]/.test(n.nextHopProtocol || '')
  chrome.loadTimes = function () {
    const n = navigation()
    const paint = perf.getEntriesByType('paint').find((e) => e.name === 'first-paint')
    return {
      requestTime: origin / 1000,
      startLoadTime: origin / 1000,
      commitLoadTime: n ? at(n.responseStart) : origin / 1000,
      finishDocumentLoadTime: n ? at(n.domContentLoadedEventEnd) : 0,
      finishLoadTime: n ? at(n.loadEventEnd) : 0,
      firstPaintTime: paint ? at(paint.startTime) : 0,
      firstPaintAfterLoadTime: 0,
      navigationType: n && n.type === 'reload' ? 'Reload' : n && n.type === 'back_forward' ? 'BackForward' : 'Other',
      wasFetchedViaSpdy: spdy(n),
      wasNpnNegotiated: spdy(n),
      npnNegotiatedProtocol: spdy(n) ? n.nextHopProtocol : '',
      wasAlternateProtocolAvailable: false,
      connectionInfo: n && n.nextHopProtocol ? n.nextHopProtocol : 'unknown'
    }
  }
  // Per chrome/renderer/loadtimes_bindings.cc: onloadT is DOMContentLoaded's end, and tran is the
  // transition type (6 back/forward, 16 reload, 15 other; a link click's 0 cannot be told apart).
  chrome.csi = function () {
    const n = navigation()
    return {
      startE: Math.round(origin),
      onloadT: n && n.domContentLoadedEventEnd > 0 ? Math.round(origin + n.domContentLoadedEventEnd) : 0,
      pageT: perf.now(),
      tran: n && n.type === 'back_forward' ? 6 : n && n.type === 'reload' ? 16 : 15
    }
  }
  chrome.app = {
    isInstalled: false,
    getDetails: function getDetails() { return null },
    getIsInstalled: function getIsInstalled() { return false },
    installState: function installState(callback) {
      if (typeof callback === 'function') setTimeout(() => callback('not_installed'), 0)
    },
    runningState: function runningState() { return 'cannot_run' },
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
  }
})()`

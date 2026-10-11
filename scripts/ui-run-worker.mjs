import { parentPort, workerData } from 'node:worker_threads'

// User scripts run off the Playwright supervisor thread, so even an infinite loop can be
// terminated. Only UI operations cross the port; page and locator objects stay in the runner.
let seq = 0
const pending = new Map()
const failures = new WeakMap()
const call = op => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  parentPort.postMessage({ type: 'call', id, op })
})
parentPort.on('message', reply => {
  const waiting = pending.get(reply.id)
  if (!waiting) return
  pending.delete(reply.id)
  if (reply.ok) waiting.resolve(reply.value)
  else {
    const error = new Error(reply.error)
    failures.set(error, { errorCode: reply.errorCode || 'UI_OPERATION_FAILED', errorOrigin: 'operation' })
    waiting.reject(error)
  }
})
const expression = (fn, arg) => `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`
function locator(surface, chain = []) {
  const result = {}
  for (const method of ['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'locator', 'filter', 'nth', 'first', 'last']) {
    result[method] = (...args) => locator(surface, [...chain, { method, args }])
  }
  for (const method of ['click', 'dblclick', 'fill', 'press', 'pressSequentially', 'hover', 'check', 'uncheck', 'selectOption', 'scrollIntoViewIfNeeded', 'waitFor', 'count', 'isVisible', 'isEnabled', 'textContent', 'innerText', 'inputValue', 'getAttribute', 'boundingBox']) {
    result[method] = (...args) => call({ type: 'locator', surface, chain, method, args })
  }
  result.evaluate = (fn, arg) => call({ type: 'evaluate', surface, chain, expression: `(element) => (${fn})(element, ${arg === undefined ? 'undefined' : JSON.stringify(arg)})` })
  return result
}
function page(surface) {
  return {
    ...locator(surface),
    title: () => call({ type: 'page', surface, method: 'title' }),
    url: () => call({ type: 'page', surface, method: 'url' }),
    evaluate: (fn, arg) => call({ type: 'evaluate', surface, expression: expression(fn, arg) }),
    waitForFunction: (fn, arg, options) => call({ type: 'waitForFunction', surface, expression: expression(fn, arg), options }),
    keyboard: { press: key => call({ type: 'keyboard', surface, method: 'press', value: key }), type: text => call({ type: 'keyboard', surface, method: 'type', value: text }) }
  }
}
const ui = {
  pane: index => {
    const n = Number(index)
    if (!Number.isInteger(n) || n < 0) throw new Error('ui.pane(index) requires a non-negative integer pane index.')
    return locator('shell', [{ method: 'locator', args: [`.pane[data-pane-index="${n}"]`] }])
  },
  surface: async kind => { await call({ type: 'surface', surface: kind }); return page(kind) },
  resize: (width, height) => call({ type: 'resize', width, height }),
  release: () => call({ type: 'release' }),
  request: () => call({ type: 'request' }),
  snapshot: () => call({ type: 'snapshot' }),
  read: () => call({ type: 'read' }),
  restart: () => call({ type: 'restart' })
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...values) => parentPort.postMessage({ type: 'log', text: values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ') })
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
try {
  const value = await new AsyncFunction('page', 'ui', 'sleep', 'console', workerData.code)(page('shell'), ui, sleep, { log, warn: log, error: log, info: log })
  parentPort.postMessage({ type: 'done', ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) })
} catch (error) {
  parentPort.postMessage({ type: 'done', ok: false, error: error instanceof Error ? error.message : String(error), ...(failures.get(error) || { errorCode: 'SCRIPT_ERROR', errorOrigin: 'script' }) })
}

// Tells main when the app's first frame after start-up is drawn: the page's loading element is
// removed or hidden by the app once its WebAssembly runs, then two animation frames later the
// canvas has been painted with the app.
const { ipcRenderer } = require('electron')

const selector = (process.argv.find((a) => a.startsWith('--craft-loader=')) || '').slice('--craft-loader='.length)
let seen = false
let done = false

function gone(el) {
  if (!el) return true
  if (!el.isConnected) return true
  const style = getComputedStyle(el)
  return style.display === 'none' || style.visibility === 'hidden' || el.offsetParent === null
}

function check() {
  if (done) return
  const el = document.querySelector(selector)
  if (el) seen = true
  if (!seen || !gone(el)) return
  done = true
  const readyAt = performance.timeOrigin + performance.now()
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const wasm = performance.getEntriesByType('resource').find((r) => r.name.includes('.wasm'))
    ipcRenderer.send('craft-ready', {
      timeOrigin: performance.timeOrigin, readyAt, frameAt: performance.timeOrigin + performance.now(),
      wasmEnd: wasm ? wasm.responseEnd : null, wasmBytes: wasm ? wasm.encodedBodySize : null
    })
  }))
}

const observer = new MutationObserver(check)
function attach() {
  observer.observe(document, { subtree: true, childList: true, attributes: true })
  check()
}
if (document.documentElement) attach()
else document.addEventListener('readystatechange', attach, { once: true })
// Some apps hide the loader by style change only; a slow poll catches what mutations miss.
const poll = setInterval(() => { check(); if (done) clearInterval(poll) }, 50)

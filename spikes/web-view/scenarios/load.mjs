// Load each app in turn (cold or warm depends on the profile), wait for its first frame, then
// record memory at idle, what it puts on window, and a screenshot.
export async function run(host, { sleep, APPS }) {
  host.results.apps = {}
  const order = (process.env.SPIKE_APPS || Object.keys(APPS).join(',')).split(',')
  for (const name of order) {
    const r = {}
    try {
      r.timing = await host.open(name)
      host.log(`${name} timing`, r.timing)
      await sleep(Number(process.env.SPIKE_SETTLE_MS || 5000))
      r.idle = host.mem(name)
      r.globals = await host.js(name, `(() => {
        const base = new Set(Object.getOwnPropertyNames(document.createElement('iframe').contentWindow || {}))
        return Object.getOwnPropertyNames(window).filter((k) => !base.has(k) && !/^(on|webkit)/.test(k)).slice(0, 80)
      })()`).catch((e) => `error ${e.message}`)
      r.page = await host.js(name, `(async () => ({ isolated: self.crossOriginIsolated, secure: isSecureContext, webgpu: navigator.gpu ? await navigator.gpu.requestAdapter().then((a) => a ? (a.info?.vendor || 'adapter') + ' ' + (a.info?.architecture || '') : 'no adapter', (e) => 'error ' + e.message) : 'no navigator.gpu', sab: typeof SharedArrayBuffer, title: document.title,
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null }))()`)
      if (name === 'filmcraft') r.info = await host.js(name, 'window.filmcraft ? filmcraft.info() : null').catch((e) => `error ${e.message}`)
      r.shot = await host.shot(name, `${process.env.SPIKE_LABEL}-${name}.png`)
      host.log(`${name} idle`, r.idle, r.page)
    } catch (error) {
      r.error = String(error.stack || error)
      host.log(`${name} failed: ${r.error}`)
    }
    host.results.apps[name] = r
    // Leave it open but hidden, the way a background app would be.
    if (host.views.has(name)) host.hide(name)
  }
  await host.windowShot(`${process.env.SPIKE_LABEL}-window.png`)
  host.results.all = host.allMem()
  host.results.cache = host.codeCacheBytes()
}

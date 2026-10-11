// What each upstream build puts on window that a host could drive: names compared with a blank
// page of the same scheme, the wasm-bindgen exports Trunk exposes, and FilmCraft's API surface.
export async function run(host, { sleep, APPS }) {
  const out = host.results.api = {}
  for (const name of Object.keys(APPS)) {
    await host.open(name)
    await sleep(1500)
    out[name] = await host.js(name, `(async () => {
      const blank = document.createElement('iframe')
      blank.style.display = 'none'
      document.body.appendChild(blank)
      const base = new Set(Object.getOwnPropertyNames(blank.contentWindow))
      blank.remove()
      const added = Object.getOwnPropertyNames(window).filter((k) => !base.has(k))
      const describe = (v) => v && typeof v === 'object' ? Object.keys(v).slice(0, 40) : typeof v
      const r = { added, details: {} }
      for (const k of added) r.details[k] = describe(window[k])
      if (window.filmcraft) {
        const cmds = await filmcraft.commands()
        const list = Array.isArray(cmds) ? cmds : (cmds.commands || [])
        r.filmcraftCommandCount = list.length
        r.filmcraftMethods = Object.keys(filmcraft)
        const els = await filmcraft.request('ui.elements', {}).catch((e) => 'error ' + e)
        r.uiElementCount = Array.isArray(els) ? els.length : (els && els.elements ? els.elements.length : String(els).slice(0, 200))
        const shot = await filmcraft.screenshot({}).catch((e) => 'error ' + e)
        r.screenshot = shot && shot.width ? { width: shot.width, height: shot.height, base64Length: shot.pngBase64.length } : String(shot).slice(0, 200)
        r.cut = await filmcraft.execute('sequence.addEdit', { seconds: 1 }).catch((e) => 'error ' + e)
      }
      return r
    })()`)
    host.log(name, JSON.stringify(out[name]).slice(0, 1500))
    host.hide(name, 'removed')
  }
}

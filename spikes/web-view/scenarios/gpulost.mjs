// After FilmCraft's start-up makes the SwiftShader GPU process restart, do the other apps (sharing
// that GPU process) still draw? Capture each before and after.
export async function run(host, { sleep }) {
  const out = host.results.gpulost = {}
  for (const name of ['photocraft', 'gridcraft']) { await host.open(name); await sleep(1500); await host.shot(name, `gpulost-before-${name}.png`); host.hide(name, 'removed') }
  await host.open('filmcraft'); await sleep(6000)
  await host.shot('filmcraft', 'gpulost-filmcraft.png')
  for (const name of ['photocraft', 'gridcraft']) {
    host.show(name, 'removed'); await sleep(2500)
    const r = await host.shot(name, `gpulost-after-${name}.png`)
    out[name] = { lost: host.views.get(name).consoles.some((c) => c.includes('CONTEXT_LOST')), shot: r.path }
  }
  out.filmcraftLost = host.views.get('filmcraft').consoles.filter((c) => /CONTEXT_LOST|lost/i.test(c))
  host.log(out)
}

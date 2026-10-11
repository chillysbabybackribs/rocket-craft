// Does a FilmCraft export keep advancing while its view is hidden? Start an export while shown,
// then spend 30 s in each hide mode and read the job's progress when shown again.
export async function run(host, { sleep }) {
  const out = host.results.hiddenwork = []
  await host.open('filmcraft')
  host.show('filmcraft')
  await sleep(2000)
  await host.js('filmcraft', `(async () => {
    const imp = await filmcraft.importUrl('/__media/clip-720p-10s.mp4', 'clip.mp4')
    await filmcraft.execute('file.newSequence', { fromItem: imp.items[0] })
  })()`)
  await sleep(2000)
  const done = () => host.js('filmcraft', `filmcraft.execute('jobs.list', {}).then((j) => j[0] ? j[0].done : null)`)
  await host.js('filmcraft', `filmcraft.execute('file.exportMedia', { format: 'h264', crf: 23, path: '/exports/hidden.mp4' })`)
  for (const mode of ['shown', 'parked', 'hidden', 'removed']) {
    host.show('filmcraft')
    const start = await done()
    if (mode !== 'shown') host.hide('filmcraft', mode)
    host.contents('filmcraft').setBackgroundThrottling(mode === 'removed')
    await sleep(30_000)
    host.contents('filmcraft').setBackgroundThrottling(false)
    host.show('filmcraft')
    const end = await done()
    const row = { mode, framesAtStart: start, framesAfter30s: end, advanced: end - start }
    out.push(row)
    host.log(row)
  }
  await host.js('filmcraft', `filmcraft.execute('jobs.cancel', { job: 1 }).catch(() => null)`)
}

// Pictures of the whole window with each app shown over the right side, each with a document.
import { join } from 'node:path'

const MEDIA = join(process.cwd(), 'media')

export async function run(host, { sleep }) {
  // Electron's capture of the window leaves out its child views, so the picture is the shell's
  // capture with the shown view's capture pasted at its bounds (compose-shots.py).
  const grab = async (file, name) => {
    await host.windowShot(`${file}-shell.png`)
    await host.shot(name, `${file}-view.png`)
  }
  const waitTitle = async (name, text) => { for (let i = 0; i < 300; i++) { if (host.views.get(name).consoles.some((c) => c.includes(text))) return true; await sleep(100) } return false }
  const label = process.env.SPIKE_LABEL
  for (const name of ['photocraft', 'gridcraft', 'filmcraft']) { await host.open(name); host.hide(name, 'removed') }

  host.show('photocraft', 'removed')
  const dbg = await host.cdp('photocraft')
  await dbg.sendCommand('Page.enable'); await dbg.sendCommand('DOM.enable')
  await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
  const opened = new Promise((done) => dbg.on('message', async (_e, m, p) => {
    if (m === 'Page.fileChooserOpened') { await dbg.sendCommand('DOM.setFileInputFiles', { files: [join(MEDIA, 'photo-4000x3000.jpg')], backendNodeId: p.backendNodeId }); done() }
  }))
  await sleep(2000); host.click('photocraft', 560, 500); await sleep(200); host.key('photocraft', 'O', ['control'])
  await opened
  host.log('photocraft opened', await waitTitle('photocraft', 'Title("photo-4000x3000.jpg'))
  await sleep(1500)
  await grab(`${label}-window-photocraft`, 'photocraft')

  host.show('gridcraft', 'removed')
  const g = await host.cdp('gridcraft')
  const data = { items: [], files: [join(MEDIA, 'table-20000x10.csv')], dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await g.sendCommand('Input.dispatchDragEvent', { type, x: 560, y: 430, data })
  host.log('gridcraft opened', await waitTitle('gridcraft', 'Title("table-20000x10.csv'))
  await sleep(1500)
  await grab(`${label}-window-gridcraft`, 'gridcraft')

  host.show('filmcraft', 'removed')
  await host.js('filmcraft', `(async () => { const imp = await filmcraft.importUrl('/__media/clip-720p-10s.mp4', 'clip.mp4'); await filmcraft.execute('file.newSequence', { fromItem: imp.items[0] }) })()`)
  await sleep(4000)
  await grab(`${label}-window-filmcraft`, 'filmcraft')
}

// File open and save in the upstream web builds: does Open reach a file the host names (through
// the file chooser, intercepted over CDP, or a synthetic drop), and does Save arrive as a
// download the host can redirect to a path without a prompt?
import { join } from 'node:path'

const MEDIA = join(process.cwd(), 'media')

async function interceptChooser(host, name, file) {
  const dbg = await host.cdp(name)
  await dbg.sendCommand('Page.enable')
  await dbg.sendCommand('DOM.enable')
  await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
  return new Promise((done) => {
    const timer = setTimeout(() => { dbg.removeListener('message', on); done({ opened: false }) }, 8000)
    const on = async (_e, method, params) => {
      if (method !== 'Page.fileChooserOpened') return
      clearTimeout(timer)
      dbg.removeListener('message', on)
      try {
        await dbg.sendCommand('DOM.setFileInputFiles', { files: [file], backendNodeId: params.backendNodeId })
        done({ opened: true, mode: params.mode })
      } catch (error) { done({ opened: true, error: String(error) }) }
    }
    dbg.on('message', on)
  })
}

async function drop(host, name, file, x = 560, y = 430) {
  const dbg = await host.cdp(name)
  const data = { items: [], files: [file], dragOperationsMask: 1 }
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await dbg.sendCommand('Input.dispatchDragEvent', { type, x, y, data })
    return 'sent'
  } catch (error) { return String(error) }
}

export async function run(host, { sleep }) {
  const label = process.env.SPIKE_LABEL
  const out = host.results.files = {}

  // PhotoCraft: Ctrl+O with the chooser intercepted.
  await host.open('photocraft')
  host.show('photocraft')
  await sleep(1500)
  host.click('photocraft', 560, 500)
  await sleep(300)
  const chooser = interceptChooser(host, 'photocraft', join(MEDIA, 'photo-4000x3000.jpg'))
  host.key('photocraft', 'O', ['control'])
  out.photocraftOpen = await chooser
  await sleep(4000)
  await host.shot('photocraft', `${label}-photocraft-opened.png`)
  // Save As: no save dialog on the web, so it should become a download.
  host.key('photocraft', 'S', ['control', 'shift'])
  await sleep(2500)
  await host.shot('photocraft', `${label}-photocraft-saveas.png`)
  host.key('photocraft', 'Return')
  await sleep(3000)
  await host.shot('photocraft', `${label}-photocraft-saved.png`)

  // GridCraft: drop a CSV, then Ctrl+O, then Ctrl+S.
  await host.open('gridcraft')
  host.show('gridcraft')
  await sleep(1500)
  out.gridcraftDrop = await drop(host, 'gridcraft', join(MEDIA, 'table-20000x10.csv'))
  await sleep(4000)
  await host.shot('gridcraft', `${label}-gridcraft-dropped.png`)
  host.click('gridcraft', 300, 400)
  const gchooser = interceptChooser(host, 'gridcraft', join(MEDIA, 'table-20000x10.csv'))
  host.key('gridcraft', 'O', ['control'])
  await sleep(1500)
  await host.shot('gridcraft', `${label}-gridcraft-ctrl-o.png`)
  out.gridcraftOpen = await gchooser
  await sleep(3000)
  await host.shot('gridcraft', `${label}-gridcraft-opened.png`)
  host.key('gridcraft', 'S', ['control'])
  await sleep(3000)
  await host.shot('gridcraft', `${label}-gridcraft-saved.png`)

  // FilmCraft: its own API, plus a drop for comparison.
  await host.open('filmcraft')
  host.show('filmcraft')
  await sleep(1500)
  out.filmcraftImport = await host.js('filmcraft', `filmcraft.importUrl('/__media/clip-720p-10s.mp4', 'clip.mp4').then((r) => JSON.parse(JSON.stringify(r)), (e) => 'error ' + e)`)
  await sleep(2000)
  out.filmcraftFiles = await host.js('filmcraft', `JSON.parse(JSON.stringify(filmcraft.files()))`)
  await host.shot('filmcraft', `${label}-filmcraft-imported.png`)
  host.log(out)
  await sleep(1000)
}

// Is the page cross-origin isolated when served from craft:// with COOP/COEP, compared with the
// same files and headers from a loopback HTTP server?
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export async function run(host, { sleep }) {
  const root = join(process.cwd(), 'web/gridcraft/gridcraft-web-0.5.0')
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]
    try {
      const body = readFileSync(join(root, path))
      res.writeHead(200, { 'Content-Type': path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.js') ? 'text/javascript' : 'text/html',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' })
      res.end(body)
    } catch { res.writeHead(404); res.end() }
  }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = server.address().port
  await host.open('gridcraft')
  const probe = `(async () => ({ isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, headers: [...(await fetch(location.href)).headers].filter(([k]) => k.startsWith('cross')) }))()`
  host.results.craftScheme = await host.js('gridcraft', probe)
  await host.contents('gridcraft').loadURL(`http://127.0.0.1:${port}/index.html`)
  await sleep(2500)
  host.results.loopbackHttp = await host.js('gridcraft', probe)
  host.log(host.results.craftScheme, host.results.loopbackHttp)
  server.close()
}

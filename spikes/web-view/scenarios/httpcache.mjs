// Does Chromium keep compiled WebAssembly between launches when the build comes from a loopback
// HTTP server (fixed port, immutable caching) instead of the craft:// scheme? Run twice with the
// same profile and compare start-up and the Code Cache/wasm folder.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export async function run(host, { sleep, APPS }) {
  const name = process.env.SPIKE_APP || 'photocraft'
  const root = join(process.cwd(), APPS[name].dir)
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]
    try {
      const body = readFileSync(join(root, path))
      const type = path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': path.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable', 'Last-Modified': 'Sat, 10 Oct 2026 00:00:00 GMT' })
      res.end(body)
    } catch { res.writeHead(404); res.end() }
  }).listen(18731, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const { app } = await import('electron')
  // Reuse the harness's view plumbing by loading the loopback URL in place of craft://.
  const t = await host.open(name, { query: '' , url: `http://127.0.0.1:18731/index.html${APPS[name].query}` })
  host.results.timing = t
  host.log('http timing', t)
  await sleep(4000)
  host.results.cache = host.codeCacheBytes()
  host.log(JSON.stringify(host.results.cache))
  server.close()
}

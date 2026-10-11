// One request to the spike's control socket: node ctl.mjs <op> '<json args>'
import net from 'node:net'
import path from 'node:path'
const [op, args = '{}'] = process.argv.slice(2)
const c = net.connect(path.join(import.meta.dirname, 'run', 'ctl.sock'))
let buf = ''
c.on('data', (d) => {
  buf += d
  if (buf.includes('\n')) {
    const m = JSON.parse(buf)
    if (m.result?.images) for (const i of m.result.images) i.data = `<${i.data.length} b64>`
    console.log(JSON.stringify(m.ok ? m.result : m, null, 1))
    c.end()
  }
})
c.write(JSON.stringify({ id: 1, op, ...JSON.parse(args) }) + '\n')

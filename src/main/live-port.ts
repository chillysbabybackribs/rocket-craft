import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Only the single-instance lock owner publishes this file. Chromium owns a different
// file, DevToolsActivePort, and a stray Electron launch can replace that one.
export async function publishLivePort(profile: string, pid: number, port: number): Promise<void> {
  await mkdir(profile, { recursive: true })
  const temporary = join(profile, `live-port-${pid}.tmp`)
  await writeFile(temporary, JSON.stringify({ pid, port }), { mode: 0o600 })
  await rename(temporary, join(profile, 'live-port.json'))
}

export async function readLiveEndpoint(profile: string, expectedPid: number): Promise<string> {
  const record = JSON.parse(await readFile(join(profile, 'live-port.json'), 'utf8'))
  if (record?.pid !== expectedPid || !Number.isInteger(record?.port) || record.port < 1 || record.port > 65535) {
    throw new Error('The live UI connection is not ready. Restart Craft Studio and try again.')
  }
  // Playwright discovers the browser WebSocket through /json/version on this port.
  return `http://127.0.0.1:${record.port}`
}

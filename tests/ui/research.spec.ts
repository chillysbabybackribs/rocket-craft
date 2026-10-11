import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './app'

test('all provider MCP endpoints expose research tools and return readable source evidence', async ({ rocket }) => {
  // Deliberate 404s exercise blocked-source handling; all other console errors still fail.
  rocket.allowConsoleError(/^http:\/\/127\.0\.0\.1:\d+\/missing-source: Failed to load resource: the server responded with a status of 404 \(Not Found\)$/)
  const { port, secret } = JSON.parse(await readFile(join(rocket.profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  for (const provider of ['claude', 'codex', 'cursor', 'antigravity']) {
    const endpoint = `http://127.0.0.1:${port}/mcp/${secret}/${provider}/research-check`
    const rpc = async (method: string, params: unknown) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      return await response.json()
    }
    const listed = await rpc('tools/list', {})
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['web_read', 'web_search']))
    const read = await rpc('tools/call', { name: 'web_read', arguments: { url: `${rocket.origin}/one` } })
    expect(read.result.isError).toBeFalsy()
    expect(read.result.content[0].text).toContain('Craft Studio browser check')
    expect(read.result.content[0].text).toContain('Saved text:')
    const missing = await rpc('tools/call', { name: 'web_read', arguments: { url: `${rocket.origin}/missing-source` } })
    expect(missing.result.isError).toBe(true)
    expect(missing.result.content[0].text).toContain('HTTP 404')
    const pdf = await rpc('tools/call', { name: 'web_read', arguments: { url: `${rocket.origin}/files/report.pdf` } })
    expect(pdf.result.isError).toBe(true)
    expect(pdf.result.content[0].text).toContain('PDF saved at')
  }
})

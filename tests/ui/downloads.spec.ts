import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './app'

// Models save files with browser_download, or by clicking a download link in browser_run, and
// neither waits on a save dialog. Called over MCP the way a provider calls them.
test('browser_download and a download click in browser_run save files without a dialog', async ({ rocket }) => {
  const { app, profile, origin } = rocket
  const downloads = join(profile, 'downloads')
  await app.evaluate(({ app }, folder) => app.setPath('downloads', folder), downloads)
  const state = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const url = `http://127.0.0.1:${state.port}/mcp/${state.secret}/claude/download-check`
  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    const { result } = await response.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }
    return { text: result.content.map(each => each.text).join('\n'), isError: result.isError }
  }

  const saved = join(profile, 'saved')
  const first = await call('browser_download', { url: `${origin}/files/report.pdf`, saveTo: `${saved}/` })
  expect(first.isError).toBeFalsy()
  expect(first.text).toContain(`to ${join(saved, 'report.pdf')}`)
  expect(await readFile(join(saved, 'report.pdf'), 'utf8')).toBe('%PDF-1.4 Craft Studio download check')
  // A second copy never overwrites the first.
  expect((await call('browser_download', { url: `${origin}/files/report.pdf`, saveTo: `${saved}/` })).text).toContain('report (1).pdf')

  // A click inside browser_run that starts a download is saved to the downloads folder and reported.
  const run = await call('browser_run', { code: `await tab.goto(${JSON.stringify(`${origin}/downloads`)}); await tab.click('#get'); await sleep(1500); return 'clicked'` })
  expect(run.isError).toBeFalsy()
  expect(run.text).toContain(`[download: Downloaded notes.txt`)
  expect(await readFile(join(downloads, 'notes.txt'), 'utf8')).toBe('Craft Studio download check\n')

  // browser_download can press the button itself.
  const clicked = await call('browser_download', { click: '#get' })
  expect(clicked.text).toContain(`to ${join(downloads, 'notes (1).txt')}`)
  const nothing = await call('browser_download', { click: 'text=Downloads' })
  expect(nothing.isError).toBe(true)
  expect(nothing.text).toContain('did not start a download')
  expect((await readdir(downloads)).sort()).toEqual(['notes (1).txt', 'notes.txt'])
})

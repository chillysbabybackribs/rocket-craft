import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, section } from './app'

for (const active of [0, 8]) test(`closing every restored tab with active index ${active} keeps Craft Studio and its draft alive`, async ({ rocket }) => {
  await writeFile(join(rocket.profile, 'browser-tabs.json'), JSON.stringify({ active, tabs: Array.from({ length: 9 }, (_, i) => ({
    url: `${rocket.origin}/${i % 2 ? 'two' : 'one'}`, title: `Restored ${i}`, favicon: null, pinned: false
  })) }))
  // Restore only happens when the browser is first used; the fixture has not opened it yet.
  const pid = await rocket.app.evaluate(() => process.pid)
  await rocket.page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft')
  await (await section(rocket.page, 'Browser')).click()
  await expect((await rocket.surface('browser')).getByRole('heading', { name: 'Craft Studio browser check' })).toBeVisible()
  await rocket.app.evaluate(({ app }) => {
    const state = globalThis as typeof globalThis & { createdForCloseTest: number }
    state.createdForCloseTest = 0
    app.on('web-contents-created', () => { state.createdForCloseTest++ })
  })
  const state = JSON.parse(await readFile(join(rocket.profile, 'tool-channel.json'), 'utf8'))
  const response = await fetch(`http://127.0.0.1:${state.port}/mcp/${state.secret}/codex/close-inspector`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_run', arguments: {
      code: 'const tabs = await browser.tabs(); for (const t of tabs) { await browser.tab(t.id).close(); } return { closed: tabs.length, remaining: await browser.tabs() };'
    } } })
  })
  const result = (await response.json()).result
  expect(result.isError, JSON.stringify(result)).toBe(false)
  const value = JSON.parse(result.content[0].text)
  expect(value.closed).toBe(9)
  expect(value.remaining).toHaveLength(1)
  expect(value.remaining[0].agent).toBe(false)
  if (active === 8) expect(await rocket.app.evaluate(() => (globalThis as typeof globalThis & { createdForCloseTest: number }).createdForCloseTest)).toBe(1)
  expect(await rocket.app.evaluate(() => process.pid)).toBe(pid)
  await expect(rocket.page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Keep this draft')
  await expect(rocket.page.getByRole('tablist', { name: 'Browser tabs', exact: true }).getByRole('tab')).toHaveCount(1)
  await (await rocket.surface('browser')).getByRole('textbox', { name: 'Test input', exact: true }).fill('The remaining tab still works')
  await rocket.capture('Craft Studio survives closing every browser tab')
})

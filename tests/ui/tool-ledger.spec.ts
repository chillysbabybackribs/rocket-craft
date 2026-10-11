import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, section } from './app'
import { openWorkerBeside } from './orch.ts'

test('the Tools section shows the tool ledger and supports mark verified', async ({ rocket }) => {
  const { page } = rocket
  test.setTimeout(180_000)
  const state = JSON.parse(await readFile(join(rocket.profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${state.port}/mcp/${state.secret}/codex/tool-ledger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    const payload = await response.json()
    const result = payload.result as { isError?: boolean; structuredContent?: { error?: { code: string } }; content: Array<{ type: string; text?: string }> }
    let data: any
    try { data = JSON.parse(result.content[0].text!) } catch { data = { error: result.content[0].text } }
    return { result, data }
  }
  const ui = (args: Record<string, unknown>) => mcp('studio_ui_run', { ...args, target: 'isolated' })

  await openWorkerBeside(ui)

  const failed = await ui({ capture: false, code: `
    await page.getByRole('textbox', {name:'Message', exact:true}).fill('Wrong pane draft')
    return 'should not run'
  ` })
  expect(failed.result.structuredContent?.error?.code).toBe('AMBIGUOUS_TARGET')

  const history = await mcp('studio_tool_history', { mode: 'calls', tool: 'studio_ui_run', outcome: 'failure', since: 0, limit: 5 })
  const failId = history.data.calls.find((row: { finish?: { error?: { code: string } } }) => row.finish?.error?.code === 'AMBIGUOUS_TARGET')?.id
  expect(failId).toBeTruthy()

  await (await section(page, 'Tools')).click()
  await expect(page.getByRole('complementary', { name: 'Tools' }).getByRole('heading', { name: 'Tool health', exact: true })).toBeVisible()
  // Only Health is left: the Scenarios and Evaluate tabs went with the eval panel.
  await expect(page.getByRole('tab', { name: 'Evaluate', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Scenarios', exact: true })).toHaveCount(0)
  const ledger = page.getByLabel('MCP tool ledger')
  await expect(ledger).toBeVisible()
  await expect(ledger.getByText('Prompt injection').locator('..').getByText('Off')).toBeVisible()
  await expect(ledger.getByRole('cell', { name: 'studio_tool_history' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh ledger', exact: true })).toBeVisible()

  const queueBefore = await ledger.getByLabel('Review queue count').textContent()
  expect(Number(queueBefore ?? 0)).toBeGreaterThan(0)

  await ledger.getByRole('button', { name: 'Detail' }).first().click()
  await expect(page.getByLabel('Call detail')).toBeVisible()
  await page.getByRole('button', { name: 'Mark call verified', exact: true }).click()

  await page.getByRole('button', { name: 'Refresh ledger', exact: true }).click()
  const queueAfter = await ledger.getByLabel('Review queue count').textContent()
  expect(Number(queueAfter ?? 0)).toBeLessThan(Number(queueBefore ?? 0))

  const queue = await mcp('studio_tool_review', { action: 'queue', since: 0, limit: 20 })
  expect(queue.data.queue.some((row: { callId: string }) => row.callId === failId)).toBe(false)
})

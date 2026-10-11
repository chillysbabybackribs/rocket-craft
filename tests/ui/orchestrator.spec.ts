import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './app'
import type { Orchestration } from '../../src/shared/orchestrator'

test('orchestrator keeps Stop available while waiting and its progress view takes hand edits to progress.md', async ({ rocket }) => {
  const { page, profile } = rocket
  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Research continuously\nUI check: stream')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toContainText('Streaming from')
  const owner = await page.evaluate(() => (window as any).rocketMap.where().panes[0].chatId) as string
  const initial = await rocket.request()
  const channel = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const call = async (args: Record<string, unknown>): Promise<Orchestration> => {
    const response = await fetch(`http://127.0.0.1:${channel.port}/mcp/${channel.secret}/codex/${owner}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestrator', arguments: args } })
    })
    const body = await response.json()
    expect(body.result.isError, JSON.stringify(body)).toBeUndefined()
    return JSON.parse(body.result.content[0].text)
  }
  const run = await call({ action: 'start', task: 'Research the fixture and review each result.' })
  const workers = await call({ action: 'dispatch', provider: 'claude', task: 'Check the fixture.' })
  expect(workers.tasks[0].status).toBe('running')
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`[Progress](<${run.progressFile}>)`)
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter')
  await expect(page.getByRole('link', { name: 'Progress', exact: true }).first()).toBeVisible()
  await page.getByRole('link', { name: 'Progress', exact: true }).first().click()
  // A link to a run's progress.md opens the progress view, drawn from the run.
  const artifact = page.getByRole('region', { name: 'Orchestrator progress' })
  await expect(artifact.getByRole('heading', { name: 'Now', exact: true })).toBeVisible()
  await call({ action: 'checkpoint', summary: 'Checked progress rendering', next: 'Wait for the held worker' })
  await expect(artifact).toContainText('Checked progress rendering')
  const md = await readFile(run.progressFile, 'utf8')
  // A step added by hand to the Plan section becomes the user's plan change, and wakes a review.
  await writeFile(run.progressFile, md.replace('## Plan\n\n', '## Plan\n\n- [ ] Investigate the changed requirement.\n'))
  await writeFile(join(profile, `ui-release-${initial.turnId}`), 'release')
  await expect.poll(async () => (await call({ action: 'status' })).cycle).toBeGreaterThan(0)
  const reviewId = (await call({ action: 'status' })).leaderTurnId!
  await expect.poll(async () => (await rocket.request()).turnId).toBe(reviewId)
  const review = await rocket.request()
  expect(review.model).toBeNull()
  expect((await call({ action: 'status' })).changes.map(change => change.text)).toEqual(['Added u1 "Investigate the changed requirement."'])
  await call({ action: 'checkpoint', summary: 'Read the user note', next: 'Wait for worker evidence', acknowledge: [{ change: 'c1', text: 'Planned; scoped at the next dispatch.' }] })
  await writeFile(join(profile, `ui-release-${review.turnId}`), 'release')
  await expect.poll(async () => {
    const where = await page.evaluate(() => (window as any).rocketMap.where())
    return where.panes[0].running
  }).toBe(false)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(artifact).toContainText('Investigate the changed requirement.')
  await rocket.capture('orchestrator-progress-waiting')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(async () => (await call({ action: 'status' })).status).toBe('stopped')
  await expect.poll(async () => (await call({ action: 'status' })).tasks[0].status).toBe('interrupted')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  const cycles = (await call({ action: 'status' })).cycle
  await rocket.restart()
  expect((await readFile(run.progressFile, 'utf8'))).toContain('Investigate the changed requirement.')
  const persisted = JSON.parse(await readFile(join(profile, 'orchestrator.json'), 'utf8')) as Orchestration[]
  expect(persisted[0].status).toBe('stopped')
  expect(persisted[0].cycle).toBe(cycles)
})

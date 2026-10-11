import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Page } from 'playwright'
import { test, expect } from './app'
import type { Orchestration, OrchestratorTask } from '../../src/shared/orchestrator'

async function start(rocket: { page: Page; profile: string }) {
  const { page, profile } = rocket
  await page.locator('.composer-folder').first().click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true }).first()
  await composer.fill('Continuously exercise the isolated worker board.\nUI check: orchestra-shell')
  await page.getByRole('button', { name: 'Send', exact: true }).first().click()
  await expect.poll(async () => readFile(join(profile, 'ui-orchestra.json'), 'utf8').then(() => true).catch(() => false)).toBe(true)
  const fixture = JSON.parse(await readFile(join(profile, 'ui-orchestra.json'), 'utf8')) as {
    chatId: string; turnId: string; results: Array<{ isError?: boolean; content: Array<{ text: string }> }>
  }
  const channel = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const callRaw = async (args: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${channel.port}/mcp/${channel.secret}/codex/${fixture.chatId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestrator', arguments: args } })
    })
    expect(response.ok).toBe(true)
    const body = await response.json()
    expect(body.error).toBeUndefined()
    return body.result as { isError?: boolean; content: Array<{ text: string }> }
  }
  const call = async (args: Record<string, unknown>): Promise<Orchestration> => {
    const result = await callRaw(args)
    expect(result.isError, JSON.stringify(result)).toBeUndefined()
    return JSON.parse(result.content[0].text)
  }
  const release = async (task: OrchestratorTask) => {
    expect(task.turnId).toBeTruthy()
    await writeFile(join(profile, `ui-release-${task.turnId}`), '')
    await expect.poll(async () => (await call({ action: 'status' })).tasks.find(each => each.id === task.id)?.status).toBe('completed')
  }
  const review = async (task: OrchestratorTask) => call({ action: 'checkpoint', taskId: task.id,
    summary: 'Controlled fixture inspected.', next: 'Continue isolated board checks.',
    review: 'Accepted fixture report and observed stream; external provider behavior is outside this check.' })
  expect(fixture.results).toHaveLength(7)
  expect(fixture.results.every(result => !result.isError)).toBe(true)
  return { fixture, call, callRaw, release, review }
}

const evidence = resolve(process.env.CRAFT_UI_OUTPUT || '.artifacts/ui/manual', 'evidence', 'run-controls')

test.afterEach(async ({ rocket }) => {
  await rocket.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  const journal = await readFile(join(rocket.profile, 'journal.jsonl'), 'utf8').catch(() => '')
  expect(journal.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.kind === 'crash')).toEqual([])
})

test('run controls refuse absent runs', async ({ rocket }) => {
  const result = await rocket.page.evaluate(() => window.rocketMap.act('run.wrapUp'))
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toBe('The orchestrator chat owns no run. Open the chat that started the run first.')
  await expect(rocket.page.getByRole('button', { name: 'Wrap up', exact: true })).toHaveCount(0)
})

test('run controls and automatic notifications route real worker and review transitions', async ({ rocket }) => {
  const { page, profile } = rocket
  const { fixture, call, release, review } = await start(rocket)
  const run = await call({ action: 'status' })
  await expect(page.getByRole('button', { name: 'Wrap up', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
  await mkdir(evidence, { recursive: true })
  await page.locator('.orch-head').screenshot({ path: join(evidence, 'running.png') })
  const mapped = await page.evaluate(() => window.rocketMap.where())
  expect(mapped.board?.run).toMatchObject({ id: run.id, canWrapUp: true, canResume: false, actionPending: false, reason: null })
  await page.getByRole('button', { name: 'Running', exact: true }).click()
  await page.evaluate(() => window.rocketMap.act('chat.new'))
  await rocket.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await release(run.tasks[2])
  const attempts = () => rocket.app.evaluate(() => (globalThis as unknown as { rocketNotificationTest: { attempts: Array<{ title: string; target: unknown }> } }).rocketNotificationTest.attempts)
  await expect.poll(async () => (await attempts()).length).toBe(1)
  expect((await attempts())[0]).toMatchObject({ title: 'Worker 0003 (Antigravity) finished, awaiting review',
    target: { kind: 'worker', runId: run.id, chatId: run.chatId, taskId: '0003', workerChatId: run.tasks[2].chatId } })
  const click = (index: number) => rocket.app.evaluate((_electron, index) => {
    (globalThis as unknown as { rocketNotificationTest: { click(index: number): void } }).rocketNotificationTest.click(index)
  }, index)
  await click(0)
  await expect(page.getByTestId('worker-expanded')).toHaveAttribute('data-chat-id', run.tasks[2].chatId)
  await expect(page.getByTestId('worker-expanded').locator('.worker-head')).toBeFocused()
  expect((await page.evaluate(() => window.rocketMap.where())).board?.filter).toBe('all')
  expect((await page.evaluate(() => window.rocketMap.where())).panes[0].chatId).toBe(run.chatId)
  expect(await rocket.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)
  await page.getByRole('button', { name: 'Close expanded worker', exact: true }).click()
  await review(run.tasks[2])
  // Visible/focused completion is consumed by main, not delayed until the next blur.
  await release(run.tasks[0])
  expect((await attempts()).length).toBe(1)
  await review(run.tasks[0])
  await page.evaluate(chatId => window.rocketMap.act('worker.expand', { chatId }), run.tasks[2].chatId)
  await page.evaluate(() => window.rocketMap.go('progress'))
  await rocket.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await writeFile(join(profile, `ui-release-${fixture.turnId}`), '')
  const leaderTurn = async () => {
    const saved = JSON.parse(await readFile(join(profile, 'orchestrator.json'), 'utf8')) as Orchestration[]
    return saved.find(each => each.id === run.id)?.leaderTurnId
  }
  await expect.poll(leaderTurn).toBeTruthy()
  await writeFile(join(profile, `ui-release-${await leaderTurn()}`), '')
  await expect.poll(async () => (await call({ action: 'status' })).status).toBe('paused')
  await expect.poll(async () => (await attempts()).length).toBe(2)
  expect((await attempts())[1]).toMatchObject({ title: 'Orchestration paused', target: { kind: 'run', runId: run.id, chatId: run.chatId } })
  await click(1)
  await expect(page.getByTestId('worker-expanded')).toHaveCount(0)
  await expect(page.locator('.orch-head')).toBeFocused()
  await expect(page.locator('.run-pause-banner')).toContainText('review ended without a progress checkpoint')
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
  const head = (await page.locator('.orch-head').boundingBox())!
  const banner = (await page.locator('.run-pause-banner').boundingBox())!
  await page.screenshot({ path: join(evidence, 'paused.png'), clip: { x: head.x, y: head.y, width: head.width, height: banner.y + banner.height - head.y } })
  expect((await page.evaluate(() => window.rocketMap.where())).side).toBe('artifact')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect.poll(async () => (await call({ action: 'status' })).status).toBe('running')
  await expect(page.locator('.run-pause-banner')).toHaveCount(0)
  const refusal = await page.evaluate(() => window.rocketMap.act('run.resume'))
  expect(refusal.ok).toBe(false)
  await expect(page.locator('.run-action-error')).toHaveText('Resume is available only while this orchestration is paused.')
  await page.getByRole('button', { name: 'Wrap up', exact: true }).click()
  await expect.poll(async () => (await call({ action: 'status' })).status).toBe('draining')
  await expect(page.getByRole('button', { name: 'Wrap up', exact: true })).toHaveCount(0)
  const draining = await call({ action: 'status' })
  expect(draining.tasks.filter(task => task.status === 'running').length).toBeGreaterThan(0)
  await writeFile(join(profile, 'ui-orchestra-review-mode'), 'checkpoint')
  for (const task of draining.tasks.filter(task => task.status === 'running')) await release(task)
  await expect.poll(leaderTurn).toBeTruthy()
  await writeFile(join(profile, `ui-release-${await leaderTurn()}`), '')
  await expect.poll(async () => (await call({ action: 'status' })).status).toBe('stopped')
  // The native seam supplies a stale destination through the real bridge, without editing state.
  await rocket.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await page.evaluate(async target => {
    await window.rocket.notifications.show({ key: 'stale-run', title: 'Stale run', body: 'Gone.', target })
  }, { kind: 'run' as const, runId: 'gone', chatId: run.chatId })
  const staleIndex = (await attempts()).length - 1
  await click(staleIndex)
  await expect(page.getByText("This notification's orchestration is no longer available.", { exact: true })).toBeVisible()
  await rocket.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await page.evaluate(async target => {
    await window.rocket.notifications.show({ key: 'stale-worker', title: 'Stale worker', body: 'Gone.', target })
  }, { kind: 'worker' as const, runId: run.id, chatId: run.chatId, taskId: 'gone', workerChatId: 'gone' })
  await click((await attempts()).length - 1)
  await expect(page.getByText("This notification's worker is no longer available.", { exact: true })).toBeVisible()
  await writeFile(join(evidence, 'notification-attempts.json'), JSON.stringify(await attempts(), null, 2))
})

test('paused wrap up cancels queued tasks silently and keeps the narrow banner above the composer', async ({ rocket }) => {
  const { page, profile } = rocket
  const { fixture, call, release } = await start(rocket)
  const run = await call({ action: 'status' })
  await release(run.tasks[0])
  await writeFile(join(profile, `ui-release-${fixture.turnId}`), '')
  const leaderTurn = async () => (JSON.parse(await readFile(join(profile, 'orchestrator.json'), 'utf8')) as Orchestration[]).find(each => each.id === run.id)?.leaderTurnId
  await expect.poll(leaderTurn).toBeTruthy()
  await writeFile(join(profile, `ui-release-${await leaderTurn()}`), '')
  await expect.poll(async () => (await call({ action: 'status' })).status).toBe('paused')
  await page.evaluate(() => window.rocketMap.go('progress'))
  await rocket.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 860))
  const banner = page.locator('.run-pause-banner')
  await banner.focus()
  await expect(banner.getByRole('tooltip')).toBeVisible()
  await expect(banner.getByRole('tooltip')).toContainText('review ended without a progress checkpoint')
  await page.locator('.orch-head').focus()
  await expect(banner.getByRole('tooltip')).toBeHidden()
  const headBox = await banner.boundingBox()
  const composerBox = await page.getByTestId('orchestrator-chat').locator('.composer-dock').boundingBox()
  expect(headBox!.y + headBox!.height).toBeLessThan(composerBox!.y)
  expect((await page.evaluate(() => window.rocketMap.where())).side).toBe('artifact')
  await rocket.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  const result = await page.evaluate(() => window.rocketMap.act('run.wrapUp'))
  expect(result.ok).toBe(true)
  expect((await call({ action: 'status' })).tasks[5].status).toBe('cancelled')
  expect((await call({ action: 'status' })).tasks.filter(task => task.status === 'running').length).toBe(4)
  expect(await rocket.app.evaluate(() => (globalThis as unknown as { rocketNotificationTest: { attempts: unknown[] } }).rocketNotificationTest.attempts)).toEqual([])
  await call({ action: 'stop', drain: false })
})


test('restored terminal workers and restarted host snapshots do not notify', async ({ rocket }) => {
  const { call, release } = await start(rocket)
  const run = await call({ action: 'status' })
  await release(run.tasks[0])
  await rocket.restart()
  await expect(rocket.page.locator(`[data-testid="worker-window"][data-chat-id="${run.tasks[0].chatId}"]`)).toHaveAttribute('data-status', 'done')
  const attempts = () => rocket.app.evaluate(() => (globalThis as unknown as { rocketNotificationTest: { attempts: unknown[] } }).rocketNotificationTest.attempts)
  expect(await attempts()).toEqual([])
  // A replacement port exercises the renderer's reconnect baseline against the same host.
  await rocket.page.evaluate(() => window.rocket.requestHostPort())
  await expect(rocket.page.locator(`[data-testid="worker-window"][data-chat-id="${run.tasks[0].chatId}"]`)).toHaveAttribute('data-status', 'done')
  expect(await attempts()).toEqual([])
})

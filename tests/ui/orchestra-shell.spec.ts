import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { test, expect } from './app'
import type { Orchestration, OrchestratorTask } from '../../src/shared/orchestrator'

// The fixture launches a fresh marked profile, real host/store and controlled providers only.
// Every accepted assignment gets a window immediately, including queued workers.
test('orchestra-shell fresh profile keeps the leader full height below the title strip', async ({ rocket }) => {
  const { page } = rocket
  await rocket.capture('01-fresh-profile')
  await expect(page.locator('.orch-shell')).toBeVisible()
  const leader = page.getByTestId('orchestrator-chat')
  await expect(leader).toBeVisible()
  await expect(page.getByTestId('worker-board-empty')).toBeVisible()
  const shell = await page.locator('.orch-shell').boundingBox()
  const column = await leader.boundingBox()
  expect(shell).not.toBeNull()
  expect(column).not.toBeNull()
  const title = await page.locator('.titlebar').boundingBox()
  expect(title).not.toBeNull()
  expect(Math.abs(shell!.y - title!.y - title!.height)).toBeLessThanOrEqual(2)
  expect(Math.abs(column!.y - shell!.y)).toBeLessThanOrEqual(2)
  expect(Math.abs(column!.height - shell!.height)).toBeLessThanOrEqual(2)
  expect(Math.abs(shell!.y + shell!.height - await page.evaluate(() => innerHeight))).toBeLessThanOrEqual(2)
})

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

test.afterEach(async ({ rocket }) => {
  const text = await readFile(join(rocket.profile, 'journal.jsonl'), 'utf8').catch(() => '')
  const crashes = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.kind === 'crash')
  expect(crashes, 'No journal crash entries, including renderer errors').toEqual([])
})

test('orchestra-shell controlled queue releases slots and delivers reports', async ({ rocket }, info) => {
  const { fixture, call, callRaw, release, review } = await start(rocket)
  await info.attach('Controlled tool results', { body: JSON.stringify(fixture, null, 2), contentType: 'application/json' })
  const run = await call({ action: 'status' })
  expect(run.tasks).toHaveLength(6)
  // Limits are per provider (Claude and Cursor three each, Antigravity one), with no global cap:
  // the six dispatches alternate claude, cursor, antigravity, so only the second Antigravity
  // worker (task 6) waits, and it starts when the first Antigravity worker finishes.
  expect(run.tasks.filter(task => task.status === 'running').map(task => task.id)).toEqual(['0001', '0002', '0003', '0004', '0005'])
  expect(run.tasks.filter(task => task.status === 'queued').map(task => task.id)).toEqual(['0006'])
  expect(new Set(run.tasks.filter(task => task.status === 'running').map(task => task.provider)).size).toBe(3)
  await rocket.capture('02-six-accepted-dispatches')
  await release(run.tasks[2])
  await expect.poll(async () => (await call({ action: 'status' })).tasks[5].status).toBe('running')
  expect(await readFile(run.tasks[2].report, 'utf8')).toContain('Controlled worker report')
  const blocked = await callRaw({ action: 'dispatch', provider: 'claude', task: 'UI shell worker blocked before review' })
  expect(blocked.isError).toBe(true)
  expect(blocked.content[0].text).toContain('Review the finished worker evidence')
  await review(run.tasks[2])
  for (const original of run.tasks.filter(task => task.id !== run.tasks[2].id)) {
    const task = (await call({ action: 'status' })).tasks.find(each => each.id === original.id)!
    expect(task.status).toBe('running')
    await release(task)
    await review(task)
  }
  await info.attach('Six-worker host state', { body: await readFile(join(rocket.profile, 'orchestrator.json'), 'utf8'), contentType: 'application/json' })
  await call({ action: 'stop', drain: false })
})

test('orchestra-shell streams queued workers and supports cancel expand reply stop reports and scrolling', async ({ rocket }, info) => {
  const { page } = rocket
  const { fixture, call, release, review } = await start(rocket)
  await info.attach('Controlled tool results', { body: JSON.stringify(fixture, null, 2), contentType: 'application/json' })
  const leader = page.getByTestId('orchestrator-chat')
  const initialWidth = (await leader.boundingBox())!.width
  const windows = page.getByTestId('worker-window')
  const windowOf = (task: OrchestratorTask) => windows.and(page.locator(`[data-chat-id="${task.chatId}"]`))
  const run = await call({ action: 'status' })
  await expect(windows).toHaveCount(6)
  for (const task of run.tasks) {
    const worker = windowOf(task)
    await expect(worker).toHaveAttribute('data-status', task.status)
    await expect(worker).toContainText(task.title)
    await expect(worker).toContainText(new RegExp(task.provider, 'i'))
    if (task.status === 'running') await expect(worker).toContainText(`Streaming from ${task.provider}.`)
    else await expect(worker).not.toContainText('Streaming from')
  }
  await rocket.capture('04-five-running-one-queued')
  const cancelled = run.tasks[5]
  await windowOf(cancelled).getByRole('button', { name: 'Stop worker', exact: true }).click()
  await expect(windowOf(cancelled)).toHaveAttribute('data-status', 'cancelled')
  const cancelledState = (await call({ action: 'status' })).tasks.find(each => each.id === cancelled.id)!
  expect(cancelledState.turnId).toBeNull()
  expect(cancelledState.startedAt).toBeNull()
  expect(cancelledState.endedAt).not.toBeNull()
  await expect(windowOf(cancelled)).not.toContainText('Streaming from')
  await rocket.capture('05-queued-worker-cancelled')
  const finished = run.tasks[0]
  await release(finished)
  await expect(windowOf(finished)).toHaveAttribute('data-status', 'done')
  await expect(windowOf(run.tasks[3])).toHaveAttribute('data-status', 'running')
  await expect(windowOf(run.tasks[3])).toContainText('Streaming from claude.')
  await review(finished)
  await windowOf(finished).getByRole('button', { name: 'Open report', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Artifact preview' })).toContainText('Controlled worker report')
  await rocket.capture('06-report-artifact')
  await page.getByRole('button', { name: 'Close artifact', exact: true }).click()
  await windowOf(finished).getByRole('button', { name: 'Expand worker', exact: true }).click()
  const expanded = page.getByTestId('worker-expanded')
  await expect(expanded).toBeVisible()
  await expanded.getByRole('textbox', { name: 'Message', exact: true }).fill('Reply observed in worker transcript\nUI check: good evening')
  await expanded.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(expanded).toContainText('Reply observed in worker transcript')
  await expect(expanded).toContainText('Good evening.')
  await rocket.capture('07-expanded-reply')
  await expanded.getByRole('button', { name: 'Close expanded worker', exact: true }).click()
  const stopped = run.tasks[1]
  await windowOf(stopped).getByRole('button', { name: 'Stop worker', exact: true }).click()
  await expect(windowOf(stopped)).toHaveAttribute('data-status', 'cancelled')
  await expect.poll(async () => (await call({ action: 'status' })).tasks.find(task => task.id === stopped.id)?.status).toBe('interrupted')
  await review(stopped)
  await expect(windowOf(run.tasks[4])).toHaveAttribute('data-status', 'running')
  for (const original of [run.tasks[2], run.tasks[3], run.tasks[4]]) {
    const task = (await call({ action: 'status' })).tasks.find(each => each.id === original.id)!
    await release(task)
    await expect(windowOf(task)).toHaveAttribute('data-status', 'done')
    await review(task)
  }
  for (let index = 7; index <= 9; index++) {
    const state = await call({ action: 'dispatch', provider: 'claude', task: `UI shell worker ${index}` })
    const task = state.tasks.find(each => each.title === `UI shell worker ${index}`)!
    await expect(windows).toHaveCount(index)
    await expect(windowOf(task)).toContainText('Streaming from claude.')
    if (index < 9) {
      await release(task)
      await expect(windowOf(task)).toHaveAttribute('data-status', 'done')
      await review(task)
    }
  }
  const board = page.getByTestId('worker-board')
  const sizes = await board.evaluate(element => ({ scroll: element.scrollHeight, client: element.clientHeight }))
  expect(sizes.scroll).toBeGreaterThan(sizes.client)
  expect(Math.abs((await leader.boundingBox())!.width - initialWidth)).toBeLessThanOrEqual(2)
  await board.evaluate(element => { element.scrollTop = element.scrollHeight })
  // Finished windows follow running windows in the renderer's status sort.
  await expect(windows.last()).toBeInViewport()
  await expect(windowOf(cancelled)).not.toContainText('Streaming from')
  expect((await call({ action: 'status' })).tasks.find(task => task.id === cancelled.id)!.turnId).toBeNull()
  await rocket.capture('08-nine-workers-scrolled')
  await call({ action: 'stop', drain: false })
})

test('orchestra-shell run controls round trip and preload notifications use isolated main transport', async ({ rocket }) => {
  const { page } = rocket
  const { fixture, call } = await start(rocket)
  const run = await call({ action: 'status' })
  // Completing the held leader without a checkpoint produces a real host pause.
  await writeFile(join(rocket.profile, `ui-release-${fixture.turnId}`), '')
  const leaderTurn = async () => {
    const saved = JSON.parse(await readFile(join(rocket.profile, 'orchestrator.json'), 'utf8')) as Orchestration[]
    return saved.find(each => each.id === run.id)?.leaderTurnId
  }
  await expect.poll(leaderTurn).toBeTruthy()
  await writeFile(join(rocket.profile, `ui-release-${await leaderTurn()}`), '')
  await expect.poll(async () => (await call({ action: 'status' })).status).toBe('paused')
  const responses = await page.evaluate(async runId => {
    const port = await new Promise<MessagePort>(resolve => {
      const receive = (event: MessageEvent) => {
        if (event.data?.type !== 'rocket:host-port' || !event.ports[0]) return
        window.removeEventListener('message', receive)
        resolve(event.ports[0])
      }
      window.addEventListener('message', receive)
      window.rocket.requestHostPort()
    })
    let next = 100000
    const rpc = (method: string, params: unknown) => new Promise<{ ok: boolean; result?: { status: string; reason: string | null }; error?: string }>(resolve => {
      const id = next++
      const receive = (event: MessageEvent) => {
        if (event.data.kind !== 'response' || event.data.id !== id) return
        port.removeEventListener('message', receive)
        resolve(event.data)
      }
      port.addEventListener('message', receive)
      port.postMessage({ kind: 'request', id, method, params })
    })
    return [await rpc('orchestrator.resume', { runId }), await rpc('orchestrator.resume', { runId }),
      await rpc('orchestrator.wrapUp', { runId }), await rpc('orchestrator.wrapUp', { runId }),
      await rpc('orchestrator.wrapUp', {}), await rpc('orchestrator.resume', { runId: 'unknown' })]
  }, run.id)
  expect(responses[0].result).toMatchObject({ status: 'running', reason: null })
  expect(responses[1].error).toBe('Resume is available only while this orchestration is paused.')
  expect(responses[2].result?.status).toBe('draining')
  expect(responses[3].error).toBe('Wrap up is available only while this orchestration is running or paused.')
  expect(responses[4].error).toBe('Give the run ID shown on the worker board.')
  expect(responses[5].error).toBe('This orchestration does not exist.')
  expect((await call({ action: 'status' })).tasks[5].status).toBe('cancelled')
  await rocket.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  const target = { kind: 'run' as const, runId: run.id, chatId: run.chatId }
  const outcomes = await page.evaluate(async target => {
    const unsubscribe = window.rocket.notifications.onActivate(value => {
      document.documentElement.dataset.notificationTarget = JSON.stringify(value)
      unsubscribe()
    })
    const notice = { key: 'transport-smoke', title: 'Craft Studio', body: 'Run paused: the review turn ended without a checkpoint.', target }
    return [await window.rocket.notifications.show(notice), await window.rocket.notifications.show(notice)]
  }, target)
  expect(outcomes).toEqual(['shown', 'suppressed'])
  const attempt = await rocket.app.evaluate(() => {
    const seam = (globalThis as unknown as { rocketNotificationTest: { attempts: unknown[]; click(index: number): void } }).rocketNotificationTest
    seam.click(0)
    return seam.attempts
  })
  expect(attempt).toEqual([{ key: 'transport-smoke', title: 'Craft Studio', body: 'Run paused: the review turn ended without a checkpoint.', target }])
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.notificationTarget)).toBe(JSON.stringify(target))
  expect(await rocket.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)
  await call({ action: 'stop', drain: false })
})

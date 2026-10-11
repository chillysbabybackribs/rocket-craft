import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './app'
import { maxActiveForProvider, type Orchestration } from '../../src/shared/orchestrator'

// The fixture dispatches to these three in turn; each runs up to its own limit at once, and the
// machine's limit (cores and free memory, read by the host at startup) caps them all together.
const PROVIDER_RUNNING = (['claude', 'cursor', 'antigravity'] as const).reduce((sum, provider) => sum + maxActiveForProvider(provider), 0)
// scripts/ui-check.mjs sets this for `npm run check:ui -- --visible`.
const VISIBLE = process.env.CRAFT_UI_VISIBLE === '1'

test.afterEach(async ({ rocket }) => {
  const journal = await readFile(join(rocket.profile, 'journal.jsonl'), 'utf8').catch(() => '')
  expect(journal.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.kind === 'crash'),
    'No journal crash entries, including renderer errors').toEqual([])
})

test('orchestra-stress forty workers stream within frame and interaction budgets', async ({ rocket }, info) => {
  const { page, profile } = rocket
  // Avoid full DOM snapshots on every streaming action in this performance workload.
  // Keep API/source tracing, dedicated screenshots and the CPU profile, without DOM snapshots.
  await rocket.app.context().tracing.stop()
  await rocket.app.context().tracing.start({ screenshots: false, snapshots: false, sources: true })
  const capture = async (name: string) => {
    const path = info.outputPath(`${name}-shell.png`)
    await page.screenshot({ path })
    await info.attach(name, { path, contentType: 'image/png' })
  }
  await expect(page.getByTestId('worker-window')).toHaveCount(0)
  await page.locator('.composer-folder').first().click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).first().fill('Exercise forty workers with controlled providers.\nUI check: orchestra-stress')
  await page.getByRole('button', { name: 'Send', exact: true }).first().click()
  await expect.poll(async () => readFile(join(profile, 'ui-orchestra.json'), 'utf8').then(() => true).catch(() => false), { timeout: 20_000 }).toBe(true)
  const fixture = JSON.parse(await readFile(join(profile, 'ui-orchestra.json'), 'utf8'))
  expect(fixture.results).toHaveLength(41)
  expect(fixture.results.every((result: { isError?: boolean }) => !result.isError)).toBe(true)
  await info.attach('Forty accepted dispatches', { body: JSON.stringify(fixture, null, 2), contentType: 'application/json' })
  const channel = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8'))
  const call = async (args: Record<string, unknown>): Promise<Orchestration> => {
    const response = await fetch(`http://127.0.0.1:${channel.port}/mcp/${channel.secret}/${fixture.provider}/${fixture.chatId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestrator', arguments: args } })
    })
    expect(response.ok).toBe(true)
    const body = await response.json()
    expect(body.error).toBeUndefined()
    expect(body.result.isError, JSON.stringify(body.result)).toBeUndefined()
    // The tool intentionally limits summaries to twelve pending tasks. The real persisted
    // host state is the complete source for this forty-worker evaluation.
    const runs = JSON.parse(await readFile(join(profile, 'orchestrator.json'), 'utf8')) as Orchestration[]
    return runs.find(run => run.chatId === fixture.chatId)!
  }
  const limits = await fetch(`http://127.0.0.1:${channel.port}/mcp/${channel.secret}/${fixture.provider}/${fixture.chatId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestrator', arguments: { action: 'status' } } })
  }).then(response => response.json()).then(body => JSON.parse(body.result.content[0].text) as { machineWorkerLimit: number })
  const RUNNING = Math.min(PROVIDER_RUNNING, limits.machineWorkerLimit)
  const windows = page.getByTestId('worker-window')
  await expect(windows).toHaveCount(40)
  // The forty dispatches alternate claude, cursor, antigravity, and start in that order until a
  // provider or the machine is full, so all three providers are running at once.
  await expect(page.locator('[data-testid="worker-window"][data-status="running"]')).toHaveCount(RUNNING)
  await expect(page.locator('[data-testid="worker-window"][data-status="queued"]')).toHaveCount(40 - RUNNING)
  const initial = await call({ action: 'status' })
  expect(new Set(initial.tasks.filter(task => task.status === 'running').map(task => task.provider)).size).toBe(3)
  await capture('stress-start-40-cards')

  // Observe the renderer itself, including offscreen cards. Keep the lifecycle sampler running
  // until the queue drains; performance budgets apply to the initial full-queue stream window.
  await page.evaluate(() => {
    const frames: number[] = [], longTasks: number[] = []
    const states: Array<{ time: number; running: number; queued: number; done: number; total: number }> = []
    const started = performance.now()
    let previous = 0, raf = 0
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)))
    observer.observe({ type: 'longtask' })
    const frame = (time: number) => { if (previous) frames.push(time - previous); previous = time; raf = requestAnimationFrame(frame) }
    raf = requestAnimationFrame(frame)
    const sample = () => {
      const cards = [...document.querySelectorAll('[data-testid="worker-window"]')]
      const count = (status: string) => cards.filter(card => card.getAttribute('data-status') === status).length
      states.push({ time: performance.now() - started, total: cards.length, running: count('running'), queued: count('queued'), done: count('done') })
    }
    sample()
    const timer = setInterval(sample, 100)
    Object.assign(window, { stressProbe: {
      endStream: () => {
        cancelAnimationFrame(raf)
        longTasks.push(...observer.takeRecords().map(entry => entry.duration)); observer.disconnect()
        const sorted = [...frames].sort((a, b) => a - b)
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory
        return { durationMs: performance.now() - started, frameCount: frames.length,
          p95FrameMs: sorted[Math.ceil(sorted.length * .95) - 1] ?? 0,
          maxFrameMs: Math.max(0, ...frames), longTaskCount: longTasks.length,
          longTaskTotalMs: longTasks.reduce((sum, value) => sum + value, 0), maxLongTaskMs: Math.max(0, ...longTasks),
          heap: memory ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit } : null,
          domNodes: document.querySelectorAll('*').length, longTasks, frames }
      },
      endStates: () => { clearInterval(timer); sample(); return states }
    } })
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')
  await writeFile(join(profile, 'ui-stress-ready'), '')
  // This wait measures four seconds of actual frame callbacks rather than polling Node timers.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 4_000)))
  const stream = await page.evaluate(() => (window as unknown as { stressProbe: { endStream: () => Record<string, unknown> } }).stressProbe.endStream())
  const cpu = await cdp.send('Profiler.stop')
  const cpuPath = info.outputPath('stream.cpuprofile')
  await writeFile(cpuPath, JSON.stringify(cpu.profile))
  await info.attach('Streaming CPU profile', { path: cpuPath, contentType: 'application/json' })
  await cdp.detach()
  await expect(page.locator('[data-testid="worker-window"][data-status="queued"]')).toHaveCount(40 - RUNNING)
  await expect(page.locator('[data-testid="worker-window"][data-status="running"]')).toHaveCount(RUNNING)

  // Use a real click; measure its event-to-visible latency inside the renderer, excluding
  // Playwright's actionability wait. Also retain the full automation latency for context.
  const expand = page.locator('[data-testid="worker-window"][data-status="running"]').first().getByRole('button', { name: 'Expand worker', exact: true })
  await expand.evaluate(button => {
    button.addEventListener('click', () => {
      const start = performance.now()
      const check = () => {
        const element = document.querySelector('[data-testid="worker-expanded"]')
        if (element && element.getBoundingClientRect().height > 0) Object.assign(window, { stressExpandMs: performance.now() - start })
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    }, { once: true })
  })
  const clicked = Date.now()
  await expand.click()
  await expect(page.getByTestId('worker-expanded')).toBeVisible()
  const expandAutomationMs = Date.now() - clicked
  await expect.poll(() => page.evaluate(() => (window as unknown as { stressExpandMs?: number }).stressExpandMs)).toBeDefined()
  const expandMs = await page.evaluate(() => (window as unknown as { stressExpandMs: number }).stressExpandMs)
  await page.getByRole('button', { name: 'Close expanded worker', exact: true }).click()
  await expect.poll(async () => (await call({ action: 'status' })).tasks.filter(task => task.status === 'completed').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3)
  await capture('stress-mid-streaming')
  const board = page.getByTestId('worker-board')
  const scroll = await board.evaluate(element => { element.scrollTop = element.scrollHeight; return { height: element.scrollHeight, client: element.clientHeight } })
  expect(scroll.height).toBeGreaterThan(scroll.client)
  await expect(windows.last()).toBeInViewport()
  await board.evaluate(element => { element.scrollTop = 0 })
  await expect(page.locator('[data-testid="worker-window"][data-status="done"]')).toHaveCount(40, { timeout: 85_000 })
  const final = await call({ action: 'status' })
  expect(final.tasks.filter(task => task.status === 'completed')).toHaveLength(40)
  for (const task of final.tasks) expect(await readFile(task.report, 'utf8')).toContain('Completed 100 deltas')
  const states = await page.evaluate(() => (window as unknown as { stressProbe: { endStates: () => unknown } }).stressProbe.endStates()) as Array<{ running: number; queued: number; done: number; total: number }>
  await board.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(windows.last()).toBeInViewport()
  await capture('stress-end-40-reports')
  const metrics = { stream, expandMs, expandAutomationMs, scroll, states, completed: final.tasks.length,
    finalDomNodes: await page.evaluate(() => document.querySelectorAll('*').length),
    budgets: { p95FrameMs: 50, maxLongTaskMs: 200, expandMs: 500, maxRunning: RUNNING }, visible: VISIBLE }
  const metricsPath = info.outputPath('stress-metrics.json')
  await writeFile(metricsPath, JSON.stringify(metrics, null, 2))
  await info.attach('Worker board performance metrics', { path: metricsPath, contentType: 'application/json' })
  await call({ action: 'stop', drain: false })
  expect(states.every(state => state.total === 40 && state.running <= RUNNING && state.running + state.queued + state.done === 40)).toBe(true)
  expect(states.some(state => state.done > 0 && state.queued > 0 && state.running === RUNNING)).toBe(true)
  expect(Number(stream.frameCount)).toBeGreaterThan(30)
  // The frame and interaction budgets hold on the private Xvfb display. A visible run shares the
  // user's compositor and a loaded desktop, so there the numbers are recorded in the metrics only.
  if (VISIBLE) return
  expect.soft(Number(stream.p95FrameMs), 'p95 frame interval <50ms').toBeLessThan(50)
  expect.soft(Number(stream.maxLongTaskMs), 'No main-thread long task >=200ms').toBeLessThan(200)
  expect.soft(expandMs, 'Expand click event to visible worker <500ms').toBeLessThan(500)
})

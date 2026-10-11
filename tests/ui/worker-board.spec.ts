import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test, expect } from './app'
import { leaderId, releaseTurn, toolCall } from './orch'
import type { Orchestration, OrchestratorTask } from '../../src/shared/orchestrator'

// Plan step 08: the board keeps live transcripts and controls, and two defects stay fixed. A
// worker's changed-files line opens the diff of the worker's own chat (not the leader's), and the
// plan drawer belongs to the chat it describes: the leader's in its own column, a worker's in its
// expanded view, and never over the board's controls. Worktrees are on and committing is allowed,
// so a worktree worker records its turn's changes on its own chat as well.
test.use({ rocketEnv: { CRAFT_WORKTREES: '1', CRAFT_AUTO_COMMIT: '1' } })

const git = async (cwd: string, ...args: string[]): Promise<string> => (await promisify(execFile)('git', args, { cwd })).stdout.trim()

async function setup(rocket: { page: import('playwright').Page; profile: string; workspace: string; release: () => Promise<void> }) {
  const { page, profile, workspace } = rocket
  await git(workspace, 'init', '-q', '-b', 'main')
  await git(workspace, 'config', 'user.name', 'Craft Studio UI check')
  await git(workspace, 'config', 'user.email', 'ui-check@rocket.invalid')
  await writeFile(join(workspace, 'notes.md'), '# These are plain notes\n')
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'scratch', private: true, scripts: { typecheck: 'node -e 0', test: 'node -e 0' } }, null, 2))
  await git(workspace, 'add', '-A')
  await git(workspace, 'commit', '-q', '-m', 'Initial commit')
  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Dispatch workers\nUI check: stream')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toContainText('Streaming from')
  await rocket.release()
  const owner = await leaderId(page)
  const call = async (args: Record<string, unknown>): Promise<Orchestration> => {
    const { result, data } = await toolCall(profile, owner, 'orchestrator', args)
    expect(result.isError, JSON.stringify(data)).toBeFalsy()
    return data as Orchestration
  }
  // Each result wakes the leader for a review on another controlled stream; let each one finish.
  let releasing = true
  const released = new Set<string>()
  const releaser = (async () => {
    while (releasing) {
      const run = await toolCall(profile, owner, 'orchestrator', { action: 'status' }).catch(() => null)
      const turn = run?.data?.leaderTurnId as string | null | undefined
      if (turn && !released.has(turn)) {
        released.add(turn)
        await releaseTurn(profile, turn)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  })()
  const stop = async (): Promise<void> => { releasing = false; await releaser }
  await call({ action: 'start', task: 'Exercise the board.' })
  return { owner, call, stop }
}

const windowOf = (page: import('playwright').Page, worker: OrchestratorTask) => page.locator(`[data-testid="worker-window"][data-chat-id="${worker.chatId}"]`)

test('a worker\'s changed-files line opens that worker\'s own diff, compact and expanded, in the main folder and in a worktree', async ({ rocket }) => {
  test.setTimeout(120_000)
  const { page, profile } = rocket
  const { owner, call, stop } = await setup(rocket)
  try {
    await call({ action: 'dispatch', provider: 'claude', worktree: false, title: 'Worker P', task: 'UI shell worker P: UI check: edit as P' })
    await call({ action: 'dispatch', provider: 'claude', worktree: true, title: 'Worker W', task: 'UI shell worker W: UI check: edit as W' })
    await expect.poll(async () => (await call({ action: 'status' })).tasks.map((each) => Boolean(each.turnId)).join(','), { timeout: 20_000 }).toBe('true,true')
    const detail = async (id: string): Promise<OrchestratorTask> => (await toolCall(profile, owner, 'orchestrator', { action: 'detail', taskId: id })).data as OrchestratorTask
    const [p, w] = [await detail('0001'), await detail('0002')]
    expect(p.worktree ?? null).toBeNull()
    expect(w.worktree, 'the second worker has a worktree').toBeTruthy()
    await releaseTurn(profile, p.turnId!)
    await releaseTurn(profile, w.turnId!)
    await expect.poll(async () => (await call({ action: 'status' })).tasks.map((each) => each.status).join(','), { timeout: 20_000 }).toBe('completed,completed')

    // The leader's own chat changed nothing, so its column has no changed-files line to confuse.
    await expect(page.locator('.orch-chat > .chat .changes-line')).toHaveCount(0)

    // Compact window of the main-folder worker.
    const line = windowOf(page, p).locator('.changes-line')
    await expect(line).toContainText('Changed 2 files')
    await line.click()
    const panel = page.getByRole('region', { name: 'Turn changes' })
    await expect(panel.getByRole('tab')).toHaveCount(2)
    await expect(panel.locator('.diff-line.is-add').filter({ hasText: 'Written by worker P' })).toHaveCount(1)
    await rocket.capture('worker-diff-compact')
    await page.getByRole('button', { name: 'Close artifact' }).click()
    await expect(panel).toHaveCount(0)

    // Compact window of the worktree worker.
    const lineW = windowOf(page, w).locator('.changes-line')
    await lineW.click()
    await expect(panel.locator('.diff-line.is-add').filter({ hasText: 'Written by worker W' })).toHaveCount(1)
    await page.getByRole('button', { name: 'Close artifact' }).click()

    // Expanded view of each worker.
    for (const [worker, name] of [[w, 'W'], [p, 'P']] as const) {
      await windowOf(page, worker).getByRole('button', { name: 'Expand worker' }).click()
      const expanded = page.getByTestId('worker-expanded')
      await expect(expanded).toHaveAttribute('data-chat-id', worker.chatId)
      await expanded.locator('.changes-line').click()
      await expect(panel.locator('.diff-line.is-add').filter({ hasText: `Written by worker ${name}` })).toHaveCount(1)
      await page.getByRole('button', { name: 'Close artifact' }).click()
      await page.getByRole('button', { name: 'Close expanded worker' }).click()
      await expect(expanded).toHaveCount(0)
    }
  } finally {
    await stop()
  }
})

/** Whether the point at the middle of `selector`'s box hits that element, i.e. nothing lies over it. */
async function uncovered(locator: import('playwright').Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return hit !== null && element.contains(hit)
  })
}

test('the leader\'s plan drawer stays in the leader\'s column and the board\'s controls stay clickable', async ({ rocket }) => {
  test.setTimeout(120_000)
  const { page } = rocket
  const { call, stop } = await setup(rocket)
  try {
    await call({ action: 'dispatch', provider: 'claude', worktree: false, title: 'Worker Q', task: 'UI shell worker Q: UI check: plan' })
    await expect(page.getByTestId('worker-window')).toHaveCount(1)
    const message = page.locator('.orch-chat').getByRole('textbox', { name: 'Message', exact: true })
    await message.fill('UI check: plan')
    await page.locator('.orch-chat').getByRole('button', { name: 'Send', exact: true }).click()
    const drawer = page.getByRole('complementary', { name: 'Plan' })
    await expect(drawer).toBeVisible()
    const column = (await page.getByTestId('orchestrator-chat').boundingBox())!
    const shown = (await drawer.boundingBox())!
    const typed = (await message.boundingBox())!
    console.log(JSON.stringify({ column, drawer: shown, message: typed }))
    await rocket.capture('leader-plan-drawer')
    // The drawer sits inside the leader's column, where it can be read, and leaves the composer a usable width.
    expect(shown.x).toBeGreaterThanOrEqual(column.x)
    expect(shown.x + shown.width).toBeLessThanOrEqual(column.x + column.width + 1)
    expect(shown.width).toBeGreaterThanOrEqual(220)
    expect(typed.width).toBeGreaterThanOrEqual(240)
    // Beside Craft Studio's right side there is no room for the leader, its plan and the board at
    // 1360px, so the board folds to its rail; the rail opens the board with its controls usable.
    const rail = page.getByTestId('worker-rail')
    await expect(rail).toBeVisible()
    expect(await uncovered(rail)).toBe(true)
    await rail.click()
    const board = page.getByTestId('worker-board')
    for (const control of [board.getByRole('button', { name: 'Running' }), board.getByRole('button', { name: 'Stop worker' }), board.getByRole('button', { name: 'Expand worker' })]) {
      await expect(control).toBeVisible()
      expect(await uncovered(control)).toBe(true)
    }
    await expect(page.getByRole('complementary', { name: 'Plan' })).toHaveCount(1)
    await rocket.release()
  } finally {
    await stop()
  }
})

test('a worker\'s plan belongs to the worker: it opens in its expanded view and never in the leader\'s column', async ({ rocket }) => {
  test.setTimeout(120_000)
  const { page } = rocket
  const { call, stop } = await setup(rocket)
  try {
    await call({ action: 'dispatch', provider: 'claude', worktree: false, title: 'Worker Q', task: 'UI shell worker Q: UI check: plan' })
    const small = page.getByTestId('worker-window')
    // The small window has no head line to open a plan and no room for a drawer: nothing opens over the board.
    await expect(small.locator('.turn-head')).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Plan' })).toHaveCount(0)
    await small.getByRole('button', { name: 'Expand worker' }).click()
    const expanded = page.getByTestId('worker-expanded')
    const drawer = expanded.getByRole('complementary', { name: 'Plan' })
    await expect(drawer).toBeVisible()
    await expect(expanded.locator('.turn-head .plan-toggle')).toHaveText('Planning · 1 of 3')
    await expect(drawer.locator('.gp-line')).toHaveCount(3)
    await expect(drawer.locator('.gp-title')).toContainText('UI shell worker Q')
    const box = (await expanded.boundingBox())!
    const side = (await drawer.boundingBox())!
    console.log(JSON.stringify({ expanded: box, drawer: side }))
    await rocket.capture('worker-plan-drawer')
    expect(side.x + side.width).toBeLessThanOrEqual(box.x + box.width + 1)
    expect(side.width).toBeGreaterThanOrEqual(220)
    // The head line, with the worker's controls, and the reply box stay reachable.
    for (const control of [expanded.getByRole('button', { name: 'Stop worker' }), expanded.getByRole('button', { name: 'Close expanded worker' }), expanded.getByRole('textbox', { name: 'Message' })]) {
      expect(await uncovered(control)).toBe(true)
    }
    // The leader's column has no drawer of its own, and hiding the worker's plan keeps it that way.
    await expect(page.getByTestId('orchestrator-chat').getByRole('complementary', { name: 'Plan' })).toHaveCount(0)
    await drawer.getByRole('button', { name: 'Hide the plan' }).click()
    await expect(drawer).toHaveCount(0)
    await expect(expanded.locator('.turn-head .plan-toggle')).toBeVisible()
    await expanded.locator('.turn-head .plan-toggle').click()
    await expect(drawer).toBeVisible()
  } finally {
    await stop()
  }
})

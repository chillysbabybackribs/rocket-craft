import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test, expect } from './app'
import { leaderId, releaseTurn, toolCall } from './orch'
import type { Orchestration } from '../../src/shared/orchestrator'

const git = async (cwd: string, ...args: string[]): Promise<string> => (await promisify(execFile)('git', args, { cwd })).stdout.trim()

// The progress view: a run's progress.md as sections the user works in. Plan changes made here
// are locked, wait in Activity until the orchestrator acknowledges them, and gate its dispatches.
test('progress view edits the plan, shows unseen changes until acknowledged, and answers open questions', async ({ rocket }) => {
  const { page, profile } = rocket
  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Research continuously\nUI check: stream')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toContainText('Streaming from')
  const owner = await page.evaluate(() => (window as any).rocketMap.where().panes[0].chatId) as string
  const channel = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const tool = async (args: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${channel.port}/mcp/${channel.secret}/codex/${owner}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestrator', arguments: args } })
    })
    return (await response.json()).result as { isError?: boolean; content: Array<{ text: string }> }
  }
  const call = async (args: Record<string, unknown>): Promise<Orchestration> => {
    const result = await tool(args)
    expect(result.isError, result.content[0]?.text).toBeUndefined()
    return JSON.parse(result.content[0]!.text)
  }
  await call({ action: 'start', task: 'Trim the app and keep what the user wants.' })
  await call({
    action: 'checkpoint', summary: 'Passes 1 to 4 are done; the layouts pass is next (see `progress.md`).', next: 'Remove the multi-pane layouts.',
    plan: [
      { id: '01-goals', text: 'Remove Goals', status: 'done' },
      { id: '05-reading', text: 'Remove hands-free reading', status: 'planned' },
      { id: '06-layouts', text: 'Remove unused multi-pane layouts', status: 'planned' }
    ],
    needs: [{ id: 'agy', text: 'Antigravity is signed out.', from: 'Worker 0024 cannot start', options: ['Skip it this run', 'I signed in'] }],
    checks: { typecheck: 'pass', tests: { passed: 253, total: 253 }, ui: { passed: 58, total: 59 } }
  })

  const opened = await page.evaluate(() => (window as any).rocketMap.go('progress', { section: 'plan' }))
  expect(opened.ok, JSON.stringify(opened)).toBe(true)
  const view = page.getByRole('region', { name: 'Orchestrator progress' })
  await expect(view).toContainText('Checks: typecheck ✓ · tests 253/253 · UI 58/59')
  await expect(view.getByRole('navigation', { name: 'Sections' })).toContainText('1/3')
  const plan = view.getByRole('region', { name: 'Plan', exact: true })
  await expect(plan).toContainText('1 of 3 done')
  await expect(plan.locator('.pv-tag.is-next')).toHaveCount(1)
  await expect(plan.locator('[data-item="05-reading"] .pv-tag.is-next')).toHaveCount(1)
  await expect(plan).not.toContainText('06-layouts', { useInnerText: true })

  // Keep the step the plan meant to remove.
  await plan.locator('[data-item="06-layouts"]').hover()
  await plan.getByRole('button', { name: 'Actions for Remove unused multi-pane layouts' }).click()
  await plan.getByRole('menuitem', { name: 'Keep, don\'t do this' }).click()
  await expect(plan.getByText('Not doing')).toBeVisible()
  await expect(plan.locator('[data-item="06-layouts"] .pv-lock')).toHaveCount(1)
  await expect(view.getByRole('button', { name: '1 change not yet seen' })).toBeVisible()

  // A checkbox marks a step done; Undo in Activity takes it back.
  await plan.getByRole('checkbox', { name: 'Mark done: Remove hands-free reading' }).click()
  await expect(plan).toContainText('2 of 2 done')
  const activity = view.getByRole('region', { name: 'Activity' })
  await expect(activity).toContainText('2 changes not yet seen by the orchestrator.')
  await activity.locator('.pv-event', { hasText: 'Marked "Remove hands-free reading" done' }).getByRole('button', { name: 'Undo' }).click()
  await expect(plan).toContainText('1 of 2 done')

  // Add a step of the user's own.
  await plan.getByRole('button', { name: '+ Add a step' }).click()
  await plan.getByRole('textbox', { name: 'New plan step' }).fill('Write the release notes')
  await plan.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(plan).toContainText('Write the release notes')

  // The orchestrator may not dispatch or checkpoint past unseen changes, nor drop the user's step.
  const refused = await tool({ action: 'dispatch', provider: 'claude', task: 'Remove the layouts.', planItem: '06-layouts' })
  expect(refused.isError).toBe(true)
  expect(refused.content[0]!.text).toContain('Acknowledge each change')
  const status = await call({ action: 'status' })
  expect(status.changes.filter(change => change.ack === null).map(change => change.id)).toEqual(['c1', 'c2'])
  await rocket.capture('progress-view-unseen')

  await call({
    action: 'checkpoint', summary: 'Took the user\'s plan changes.', next: 'Start the reading pass.',
    acknowledge: [{ change: 'c1', text: 'Layouts stay; no worker will remove them.' }, { change: 'c2', text: 'Planned; scoped at the next dispatch.' }]
  })
  await expect(activity).toContainText('Seen in review 0: Layouts stay; no worker will remove them.')
  await expect(view.getByRole('button', { name: /not yet seen/ })).toHaveCount(0)

  // Answering an open question clears Needs you and reaches the orchestrator as a user update.
  const needs = view.getByRole('region', { name: 'Needs you' })
  await expect(view.getByRole('navigation', { name: 'Sections' }).locator('.pv-n.is-attn')).toHaveText('1')
  await needs.getByRole('button', { name: 'Skip it this run' }).click()
  await expect(needs).toContainText('Nothing is waiting on you.')
  // The tool reply gives updates with their indexes, so plan items' `from` stays readable.
  const replied = await call({ action: 'status' }) as unknown as { updates: Array<{ index: number; text: string }> }
  expect(replied.updates.at(-1)?.text).toBe('Answered "Antigravity is signed out.": Skip it this run')

  // The app map reads the view and edits the plan by name.
  const where = await page.evaluate(() => (window as any).rocketMap.where())
  expect(where.place).toBe('progress')
  expect(where.progress.plan.map((item: { id: string }) => item.id)).toEqual(['01-goals', '05-reading', '06-layouts', 'u1'])
  const moved = await page.evaluate(() => (window as any).rocketMap.act('plan.edit', { change: 'up', item: 'u1' }))
  expect(moved.ok, JSON.stringify(moved)).toBe(true)
  await expect(plan.locator('.pv-tag.is-next')).toHaveCount(1)
  await expect(plan.locator('[data-item="u1"] .pv-tag.is-next')).toHaveCount(1)
  const progress = await readFile(status.progressFile, 'utf8')
  expect(progress).toContain('- [k] 06-layouts · Remove unused multi-pane layouts (yours)')
  await rocket.capture('progress-view')
})

test.describe('merge activity', () => {
  test.use({ rocketEnv: { CRAFT_WORKTREES: '1', CRAFT_AUTO_COMMIT: '1' } })

  test('activity lists a merged worktree task', async ({ rocket }) => {
    test.setTimeout(90_000)
    const { page, profile, workspace } = rocket
    await git(workspace, 'init', '-q', '-b', 'main')
    await git(workspace, 'config', 'user.name', 'Craft Studio UI check')
    await git(workspace, 'config', 'user.email', 'ui-check@rocket.invalid')
    await writeFile(join(workspace, 'notes.md'), '# Notes\n')
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'scratch', private: true, scripts: { typecheck: 'node -e 0', test: 'node -e 0' } }, null, 2))
    await git(workspace, 'add', '-A')
    await git(workspace, 'commit', '-q', '-m', 'Initial commit')

    await page.locator('.composer-folder').click()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Merge in activity\nUI check: stream')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.prose').last()).toContainText('Streaming from')
    await rocket.release()
    const owner = await leaderId(page)
    const call = async (args: Record<string, unknown>): Promise<Orchestration> => {
      const { result, data } = await toolCall(profile, owner, 'orchestrator', args)
      expect(result.isError, JSON.stringify(data)).toBeFalsy()
      return data as Orchestration
    }
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
    try {
      await call({ action: 'start', task: 'One worktree edit for the activity feed.' })
      await call({ action: 'dispatch', provider: 'claude', worktree: true, title: 'Activity merge', task: 'UI shell worker: UI check: edit as A' })
      await expect.poll(async () => {
        const task = (await call({ action: 'status' })).tasks[0]!
        return Boolean(task.turnId && task.worktree)
      }, { timeout: 30_000 }).toBe(true)
      const worker = (await call({ action: 'status' })).tasks[0]!
      await releaseTurn(profile, worker.turnId!)
      await expect.poll(async () => (await call({ action: 'status' })).tasks[0]!.status, { timeout: 30_000 }).toBe('completed')
      await call({ action: 'checkpoint', summary: 'Worker merged.', next: 'Done.', taskId: '0001', review: 'Accepted.', verdict: 'accept' })
      let merged!: NonNullable<Orchestration['tasks'][0]['merge']>
      await expect.poll(async () => {
        const detail = await toolCall(profile, owner, 'orchestrator', { action: 'detail', taskId: '0001' })
        merged = (detail.data as { merge: typeof merged }).merge
        return merged?.status
      }, { timeout: 30_000 }).toBe('merged')
      const opened = await page.evaluate(() => (window as any).rocketMap.go('progress', { section: 'activity' }))
      expect(opened.ok, JSON.stringify(opened)).toBe(true)
      const activity = page.getByRole('region', { name: 'Orchestrator progress' }).getByRole('region', { name: 'Activity' })
      const sha = merged.commit!.slice(0, 7)
      await expect(activity).toContainText(`Merged 0001 Activity merge (2 files, ${sha})`, { timeout: 30_000 })
    } finally {
      releasing = false
      await releaser
    }
  })
})

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test, expect } from './app'
import { leaderId, releaseTurn, toolCall } from './orch'
import type { Orchestration, OrchestratorTask } from '../../src/shared/orchestrator'

// Code workers in worktrees, end to end (docs/worktree-plan.md, step 7). The scratch workspace is
// a git repository of its own, so the app may commit in it: worktrees are on, and so is
// committing, which UI checks otherwise keep off. Two controlled workers make the same edit from
// the same base, each signing auth.js, so once the first is merged the second conflicts.
test.use({ rocketEnv: { CRAFT_WORKTREES: '1', CRAFT_AUTO_COMMIT: '1' } })

const git = async (cwd: string, ...args: string[]): Promise<string> => (await promisify(execFile)('git', args, { cwd })).stdout.trim()

test('worktree workers merge, a conflicting one is refused with its file, and a rejected one is discarded', async ({ rocket }) => {
  test.setTimeout(120_000)
  const { page, profile, workspace } = rocket
  await git(workspace, 'init', '-q', '-b', 'main')
  await git(workspace, 'config', 'user.name', 'Craft Studio UI check')
  await git(workspace, 'config', 'user.email', 'ui-check@rocket.invalid')
  await writeFile(join(workspace, 'notes.md'), '# These are plain notes\n')
  // The merge runs typecheck and unit tests on the merged result; here they have nothing to check.
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'scratch', private: true, scripts: { typecheck: 'node -e 0', test: 'node -e 0' } }, null, 2))
  await git(workspace, 'add', '-A')
  await git(workspace, 'commit', '-q', '-m', 'Initial commit')

  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Edit in worktrees\nUI check: stream')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toContainText('Streaming from')
  await rocket.release()
  const owner = await leaderId(page)
  const call = async (args: Record<string, unknown>): Promise<Orchestration> => {
    const { result, data } = await toolCall(profile, owner, 'orchestrator', args)
    expect(result.isError, JSON.stringify(data)).toBeFalsy()
    return data as Orchestration
  }
  const task = async (id: string): Promise<OrchestratorTask> => {
    const { result, data } = await toolCall(profile, owner, 'orchestrator', { action: 'detail', taskId: id })
    expect(result.isError, JSON.stringify(data)).toBeFalsy()
    return data as OrchestratorTask
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

  try {
    await call({ action: 'start', task: 'Add a login check, one worker per worktree.' })
    for (const name of ['A', 'B']) {
      await call({ action: 'dispatch', provider: 'claude', worktree: true, title: `Worker ${name}`, task: `UI shell worker ${name}: UI check: edit as ${name}` })
    }
    // Both worktrees are made from the same base before either worker is released.
    await expect.poll(async () => (await call({ action: 'status' })).tasks.map((each) => Boolean(each.turnId)).join(','), { timeout: 20_000 }).toBe('true,true')
    const [a, b] = await Promise.all([task('0001'), task('0002')])
    expect(a.worktree && b.worktree, 'both tasks have worktrees').toBeTruthy()
    for (const worker of [a, b]) {
      expect(existsSync(join(worker.worktree!.folder, 'notes.md')), 'a worktree holds the main folder').toBe(true)
      expect(existsSync(join(worker.worktree!.folder, 'auth.js')), 'neither worker has edited yet').toBe(false)
    }
    await releaseTurn(profile, a.turnId!)
    await releaseTurn(profile, b.turnId!)
    await expect.poll(async () => (await call({ action: 'status' })).tasks.map((each) => each.status).join(','), { timeout: 20_000 }).toBe('completed,completed')
    // The edits stayed in the worktrees; the reports went to the run folder in the main folder.
    expect(await readFile(join(a.worktree!.folder, 'auth.js'), 'utf8')).toContain('Written by worker A')
    expect(existsSync(join(workspace, 'auth.js'))).toBe(false)
    expect(existsSync(a.report) && a.report.startsWith(workspace)).toBe(true)

    // Accept A: merged as one commit, its files in the main folder.
    await call({ action: 'checkpoint', summary: 'Worker A is accepted.', next: 'Review worker B.', taskId: '0001', review: 'Accepted: the login check is in auth.js.', verdict: 'accept' })
    const board = page.getByTestId('worker-board')
    const windowOf = (worker: OrchestratorTask) => board.locator(`[data-testid="worker-window"][data-chat-id="${worker.chatId}"]`)
    await expect(windowOf(a).locator('.worker-merge')).toHaveText(/^Merged [0-9a-f]{7}$/, { timeout: 30_000 })
    await expect(windowOf(b).locator('.worker-merge')).toHaveCount(0)
    expect(await readFile(join(workspace, 'auth.js'), 'utf8')).toContain('Written by worker A')
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toContain('notes with login')
    expect(await git(workspace, 'status', '--porcelain', '--', 'auth.js', 'notes.md')).toBe('')
    // One squashed commit of the worker's two files; the review's report commit may follow it.
    const merged = (await task('0001')).merge!
    expect(merged.status).toBe('merged')
    expect([...merged.files].sort()).toEqual(['auth.js', 'notes.md'])
    expect(await git(workspace, 'log', '-1', '--format=%s', merged.commit!)).toBe('Task 0001: Worker A')
    expect((await git(workspace, 'show', '--name-only', '--format=', merged.commit!)).split('\n').sort()).toEqual(['auth.js', 'notes.md'])
    expect(await git(workspace, 'merge-base', '--is-ancestor', merged.commit!, 'HEAD').then(() => true, () => false)).toBe(true)
    expect(existsSync(a.worktree!.folder), 'a merged worktree is removed').toBe(false)

    const opened = await page.evaluate(() => (window as any).rocketMap.go('progress', { section: 'workers' }))
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    const workers = page.getByRole('region', { name: 'Orchestrator progress' }).getByRole('region', { name: 'Workers', exact: true })
    const rowOf = (id: string) => workers.locator('tr', { has: page.locator('.pv-td-id', { hasText: id }) })
    await expect(rowOf('0001').locator('.pv-merge')).toHaveText(`Merged ${merged.commit!.slice(0, 7)}`)
    await expect(rowOf('0002').locator('.pv-merge')).toHaveCount(0)

    // Accept B: auth.js changed in both, so the merge is refused and names it; nothing is written.
    await call({ action: 'checkpoint', summary: 'Worker B is accepted.', next: 'Merge worker B.', taskId: '0002', review: 'Accepted: the same login check.', verdict: 'accept' })
    const refused = rowOf('0002').locator('.pv-merge')
    await expect(refused).toHaveText('Refused: conflict', { timeout: 30_000 })
    await expect(refused).toHaveClass(/is-warn/)
    await expect(refused).toHaveAttribute('title', /auth\.js/)
    expect((await task('0002')).merge).toMatchObject({ status: 'refused', reason: 'conflict', files: ['auth.js'] })
    expect(await readFile(join(workspace, 'auth.js'), 'utf8')).not.toContain('Written by worker B')
    expect(await git(workspace, 'status', '--porcelain', '--', 'auth.js', 'notes.md')).toBe('')
    expect(existsSync(join(workspace, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(existsSync(b.worktree!.folder), 'a refused worktree is kept for a fix-up').toBe(true)
    await rocket.capture('worktree-refused')

    // Reject B: its worktree and branch go; its report stays.
    await call({ action: 'checkpoint', summary: 'Worker B is rejected.', next: 'Done.', taskId: '0002', review: 'Rejected: it conflicts with worker A, which already landed.', verdict: 'reject' })
    await expect(rowOf('0002').locator('.pv-merge')).toHaveText('Discarded', { timeout: 30_000 })
    expect(existsSync(b.worktree!.folder), 'a discarded worktree is removed').toBe(false)
    expect(await git(workspace, 'branch', '--list', 'rocket/*')).toBe('')
    expect(existsSync(b.report)).toBe(true)

    await page.getByRole('button', { name: 'Close progress', exact: true }).click()
    await expect(windowOf(b).locator('.worker-merge')).toHaveText('Discarded')
    await expect(windowOf(a).locator('.worker-merge')).toHaveText(`Merged ${merged.commit!.slice(0, 7)}`)
    await rocket.capture('worktree-board')
  } finally {
    releasing = false
    await releaser
  }
})

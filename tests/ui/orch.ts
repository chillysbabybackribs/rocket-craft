import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { Orchestration, OrchestratorTask } from '../../src/shared/orchestrator.ts'

type ToolPayload = {
  result: {
    isError?: boolean
    structuredContent?: { error?: { code: string; origin?: string } }
    content: Array<{ type: string; text?: string }>
  }
  data: any
}

/** Call one host tool on a marked UI-test profile. `chatId` is the tool route's chat. */
export async function toolCall(profile: string, chatId: string, name: string, args: Record<string, unknown>): Promise<ToolPayload> {
  const state = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const response = await fetch(`http://127.0.0.1:${state.port}/mcp/${state.secret}/codex/${chatId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const payload = await response.json() as { result: ToolPayload['result'] }
  let data: any
  try { data = JSON.parse(payload.result.content[0].text!) } catch { data = { error: payload.result.content[0]?.text } }
  return { result: payload.result, data }
}

// The fixture writes the worker's report only when the assignment contains this phrase, and the
// host marks a completed turn failed when that file is missing.
const SHELL_ASSIGNMENT = 'UI shell worker'

/** Start a run on `chatId` if it has none, and dispatch one Claude worker. The worker streams until `releaseTurn`. */
export async function dispatchClaude(profile: string, chatId: string, task: string): Promise<OrchestratorTask> {
  const assignment = task.includes(SHELL_ASSIGNMENT) ? task : `${SHELL_ASSIGNMENT} ${task}`
  const started = await toolCall(profile, chatId, 'orchestrator', { action: 'start', task: 'Exercise the one-pane board.' })
  const startError = JSON.stringify(started.data)
  if (started.result.isError && !startError.includes('already owns an orchestration')) throw new Error(startError)
  const run = await toolCall(profile, chatId, 'orchestrator', { action: 'dispatch', provider: 'claude', task: assignment })
  if (run.result.isError) throw new Error(JSON.stringify(run.data))
  const worker = (run.data as Orchestration).tasks.find((entry) => entry.title === assignment)
  if (!worker?.chatId || !worker.turnId) throw new Error(`Dispatch did not start "${assignment}": ${JSON.stringify(run.data.tasks)}`)
  return worker
}

/** Release the worker, wait until its card is done, then release the review turn the host starts on the leader. */
export async function finishWorker(page: Page, profile: string, chatId: string, task: string): Promise<OrchestratorTask> {
  const worker = await dispatchClaude(profile, chatId, task)
  await releaseTurn(profile, worker.turnId!)
  await expect(page.locator(`[data-chat-id="${worker.chatId}"]`)).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await releaseLeaderReview(profile, chatId)
  // An empty composer keeps Send disabled. Idle means the review turn has left the pane.
  await expect(page.locator('.pane').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  return worker
}

async function waitUntilSettled(profile: string, chatId: string, workerChatId: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const run = await toolCall(profile, chatId, 'orchestrator', { action: 'status' })
    const task = (run.data?.tasks as OrchestratorTask[] | undefined)?.find((entry) => entry.chatId === workerChatId)
    if (task && task.status !== 'running' && task.status !== 'queued') {
      if (task.status !== 'completed') throw new Error(`Worker ${task.status}: ${task.result}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('The worker did not finish.')
}

/** The host's review tick (about 2s) holds the leader on another controlled stream. Let that finish. */
async function releaseLeaderReview(profile: string, chatId: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const run = await toolCall(profile, chatId, 'orchestrator', { action: 'status' })
    const leaderTurn = run.data?.leaderTurnId as string | null | undefined
    if (leaderTurn) {
      await releaseTurn(profile, leaderTurn)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

export async function releaseTurn(profile: string, turnId: string): Promise<void> {
  await writeFile(join(profile, `ui-release-${turnId}`), '')
}

/** The chat in the only pane. It must already have been sent, so it has an id. */
export async function leaderId(page: Page): Promise<string> {
  const id = await page.evaluate(() => (window as unknown as { rocketMap: { where: () => { panes: Array<{ chatId: string | null }> } } }).rocketMap.where().panes[0].chatId)
  expect(id).toBeTruthy()
  return id!
}

/**
 * Inside an isolated `studio_ui_run` session: the leader and one expanded worker, both Claude,
 * both showing "Good evening.", so an unscoped Message box is ambiguous and `ui.pane(0)` is not.
 * `ui` must call `studio_ui_run` with `target: "isolated"` on a stable route, so the calls share a session.
 */
export async function openWorkerBeside(ui: (args: Record<string, unknown>) => Promise<ToolPayload>): Promise<void> {
  const setup = await ui({ timeout: 60, code: `
    await page.locator('.composer-folder').click()
    await ui.pane(0).getByRole('textbox', {name:'Message', exact:true}).fill('UI check: good evening')
    await ui.pane(0).getByRole('button', {name:'Send', exact:true}).click()
    await page.waitForFunction(() => document.querySelector('.pane .prose')?.textContent?.includes('Good evening.'))
    return await page.evaluate(() => window.rocketMap.where().panes[0].chatId)
  ` })
  expect(setup.result.isError, JSON.stringify(setup.data)).toBeFalsy()
  const profile = setup.data.session.profile as string
  const chatId = setup.data.value as string
  const worker = await dispatchClaude(profile, chatId, 'Same greeting beside the orchestrator')
  await releaseTurn(profile, worker.turnId!)
  await waitUntilSettled(profile, chatId, worker.chatId)
  await releaseLeaderReview(profile, chatId)
  const replied = await ui({ timeout: 60, code: `
    await page.waitForFunction(() => document.querySelector('[data-testid="worker-window"]')?.getAttribute('data-status') === 'done')
    await page.getByRole('button', {name:'Expand worker', exact:true}).click()
    const box = page.getByTestId('worker-expanded').getByRole('textbox', {name:'Message', exact:true})
    await box.fill('UI check: good evening')
    await page.getByTestId('worker-expanded').getByRole('button', {name:'Send', exact:true}).click()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="worker-expanded"] .prose')].some(node => node.textContent?.includes('Good evening.')))
    return await page.getByRole('textbox', {name:'Message', exact:true}).count()
  ` })
  expect(replied.result.isError, JSON.stringify(replied.data)).toBeFalsy()
  expect(replied.data.value).toBe(2)
}

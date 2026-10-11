import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './app'
import { PLACES } from '../../src/shared/app-map.ts'
import { finishWorker } from './orch.ts'

// The app map is only honest if every place it names can be reached by name in the real app and
// the shell then says it is there. This walks the whole map through the dispatcher, then through
// the host's tools, so the host → main → renderer path is covered too.
test('every place in the app map is reachable by name and reports itself', async ({ rocket }) => {
  const { page } = rocket
  const go = (place: string, params: Record<string, unknown> = {}) => page.evaluate(([place, params]) => window.rocketMap.go(place as string, params as Record<string, unknown>), [place, params] as const)
  const act = (action: string, params: Record<string, unknown> = {}) => page.evaluate(([action, params]) => window.rocketMap.act(action as string, params as Record<string, unknown>), [action, params] as const)

  await test.step('Every parameterless place round-trips, and its control is marked', async () => {
    for (const [place, spec] of Object.entries(PLACES)) {
      if ('params' in spec && spec.params && Object.values(spec.params).some((what) => what.includes('required'))) continue
      // The progress view needs a run; it is reached in the worker step below, once there is one.
      if (place === 'progress') {
        const refused = await go(place)
        expect(refused.ok ? '' : refused.error).toContain('no progress to show')
        continue
      }
      const result = await go(place)
      expect(result.ok, `${place}: ${result.ok ? '' : result.error}`).toBe(true)
      expect(result.where.place).toBe(place)
      expect(result.where.side).toBe(place)
      // The dock's control for the place shows as on.
      await expect(page.locator(`.dock [data-nav="${place}"]`)).toHaveAttribute('aria-pressed', 'true')
    }
    // An app is reached by id, and only an installed one; with none installed the choices say so.
    const noApp = await go('app')
    expect(noApp.ok ? '' : noApp.error).toContain('Give id')
    const notInstalled = await go('app', { id: 'no-such-app' })
    expect(notInstalled.ok).toBe(false)
    // The tool ledger's panel and the chat-alone place are not in Craft Studio's map.
    for (const gone of ['tools', 'chat']) expect((await go(gone)).ok).toBe(false)
    expect((await act('tools.refresh')).ok).toBe(false)
  })

  await test.step('A required parameter that is missing or wrong is refused with the choices', async () => {
    const missing = await act('chat.open')
    expect(missing.ok).toBe(false)
    expect(missing.ok ? '' : missing.error).toContain('Give chatId')
    const wrong = await act('chat.open', { chatId: 'no-such-chat' })
    expect(wrong.ok ? '' : wrong.error).toContain('There is no chat "no-such-chat"')
    const noFile = await act('library.open')
    expect(noFile.ok ? '' : noFile.error).toContain('Give id')
    // The eval scenario panel's places are gone from the map.
    const gone = await go('evals.scenario', { id: 'matrix-smoke' })
    expect(gone.ok ? '' : gone.error).toContain('There is no place')
  })

  await test.step('Actions run the same code as the buttons, and only pane 0 exists', async () => {
    for (const gone of ['pane.add', 'pane.close', 'pane.focus']) {
      const missing = await act(gone)
      expect(missing.ok ? '' : missing.error).toContain('There is no action')
    }
    const other = await act('chat.new', { pane: 1 })
    expect(other.ok ? '' : other.error).toContain('There is no pane 1')
    const fresh = await act('chat.new', { pane: 0 })
    expect(fresh.ok).toBe(true)
    expect(fresh.where.panes).toHaveLength(1)
    await expect(page.locator('.pane')).toHaveCount(1)
    // An action belonging to a place opens that place first.
    await go('shelf')
    const cleared = await act('library.clear')
    expect(cleared.ok).toBe(true)
    expect(cleared.where.place).toBe('library')
    expect(cleared.where.side).toBe('library')
    await expect(page.getByRole('complementary', { name: 'Library', exact: true })).toBeVisible()
    const shelf = await act('shelf.open')
    expect(shelf.ok).toBe(true)
    expect(shelf.where.side).toBe('shelf')
  })

  await test.step('The host’s tools reach the same dispatcher and add the image', async () => {
    const state = JSON.parse(await readFile(join(rocket.profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${state.port}/mcp/${state.secret}/codex/app-map`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      })
      const payload = await response.json() as { result: { isError?: boolean; content: Array<{ type: string; text?: string }> } }
      return { result: payload.result, data: JSON.parse(payload.result.content[0]!.text!) as { where: { place: string; yourPane: number | null }; summary: string } }
    }
    const seen = await mcp('studio_ui_where', {})
    expect(seen.data.where.place).toBe('shelf')
    expect(seen.data.summary).toContain('the app shelf is shown on the right side')
    const went = await mcp('studio_ui_go', { place: 'library', params: { view: 'list' } })
    expect(went.result.isError).toBeFalsy()
    expect(went.data.where.place).toBe('library')
    expect(went.result.content.some((part) => part.type === 'image')).toBe(true)
    await expect(page.getByRole('region', { name: 'Apps shelf' })).toHaveCount(0)
    const refused = await mcp('studio_ui_act', { action: 'chat.open', params: { chatId: 'no-such-chat' }, capture: false })
    expect(refused.result.isError).toBe(true)
    expect(refused.result.content[0]!.text).toContain('There is no chat')
  })

  await test.step('A worker expands over the board and collapses back', async () => {
    await go('shelf')
    await page.locator('.composer-folder').click()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('UI check: good evening')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.prose').last()).toHaveText('Good evening.')
    const chatId = await page.evaluate(() => window.rocketMap.where().panes[0].chatId) as string
    const worker = await finishWorker(page, rocket.profile, chatId, 'Map expand check')
    const expanded = await act('worker.expand', { chatId: worker.chatId })
    expect(expanded.ok, expanded.ok ? '' : expanded.error).toBe(true)
    expect(expanded.where.board?.expanded).toBe(worker.chatId)
    await expect(page.getByTestId('worker-expanded')).toBeVisible()
    const collapsed = await act('worker.collapse')
    expect(collapsed.ok, collapsed.ok ? '' : collapsed.error).toBe(true)
    expect(collapsed.where.board?.expanded ?? null).toBeNull()
    await expect(page.getByTestId('worker-expanded')).toHaveCount(0)
    await page.getByRole('button', { name: 'Expand worker', exact: true }).click()
    await expect(page.getByTestId('worker-expanded')).toBeVisible()
    await page.getByRole('button', { name: 'Close expanded worker', exact: true }).click()
    await expect(page.getByTestId('worker-expanded')).toHaveCount(0)
    const missing = await act('worker.expand', {})
    expect(missing.ok).toBe(false)
    expect(missing.ok ? '' : missing.error).toContain(worker.chatId)
    const none = await act('worker.collapse')
    expect(none.ok).toBe(false)
    expect(none.ok ? '' : none.error).toContain('No worker is expanded')

    // With a run, the progress view is a place of its own, and its plan actions take it there.
    const progress = await go('progress', { section: 'workers' })
    expect(progress.ok, progress.ok ? '' : progress.error).toBe(true)
    expect(progress.where.place).toBe('progress')
    expect(progress.where.progress?.section).toBe('workers')
    await expect(page.getByRole('region', { name: 'Orchestrator progress' })).toBeVisible()
    const wrongSection = await go('progress', { section: 'notes' })
    expect(wrongSection.ok ? '' : wrongSection.error).toContain('section is one of now, needs, plan, workers, activity')
    await go('shelf')
    const added = await act('plan.edit', { change: 'add', text: 'A step from the map' })
    expect(added.ok, added.ok ? '' : added.error).toBe(true)
    expect(added.where.place).toBe('progress')
    expect(added.where.progress?.pending.map((change) => change.text)).toEqual(['Added u1 "A step from the map"'])
    const noItem = await act('plan.edit', { change: 'drop', item: 'nope' })
    expect(noItem.ok ? '' : noItem.error).toContain('There is no plan step "nope"')
  })
})

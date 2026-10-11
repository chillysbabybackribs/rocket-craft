import { createServer } from 'node:http'
import { test, expect, section } from './app'
import { assertNetworkBlocked, assertOverlay, nativeViews } from './safeguards'

test('network isolation blocks outside origins and detects a removed browser filter', async ({ rocket }) => {
  let hits = 0
  const server = createServer((_request, response) => { hits++; response.end('Outside the fixture') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const forbidden = `http://127.0.0.1:${address.port}/`
    await assertNetworkBlocked(rocket.app, forbidden)
    expect(hits).toBe(0)
    // Deliberately restore the old bug. The same assertion must now reject.
    await rocket.app.evaluate(({ session }) => session.fromPartition('persist:browser').webRequest.onBeforeRequest(null))
    await expect(assertNetworkBlocked(rocket.app, forbidden)).rejects.toThrow('Both app and browser sessions')
    expect(hits).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('native overlay checks detect shifted pages, hidden dropdowns and incorrect stacking', async ({ rocket }) => {
  const { app, page, origin } = rocket
  await (await section(page, 'Browser')).click()
  await expect(await rocket.surface('browser')).toHaveTitle('UI page one')
  const browser = (await nativeViews(app)).find(view => view.visible && view.url === `${origin}/one`)!
  expect(browser).toBeDefined()
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill(new URL(origin).host)
  await expect((await rocket.surface('suggestions')).locator('body')).toContainText('Open page')
  await assertOverlay(app, browser)
  for (const fault of ['bounds', 'visibility', 'stacking']) {
    await test.step(`Detect deliberately broken ${fault}`, async () => {
      await app.evaluate(({ BrowserWindow, WebContentsView }, { id, bounds, fault }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const content = window.contentView.children.find(view => view instanceof WebContentsView && view.webContents.id === id)!
        const dropdown = window.contentView.children.find(view => view instanceof WebContentsView && view.webContents.getURL().endsWith('/suggest.html'))!
        content.setBounds(bounds)
        dropdown.setVisible(true)
        window.contentView.addChildView(dropdown)
        if (fault === 'bounds') content.setBounds({ ...bounds, x: bounds.x + 100, width: bounds.width - 100 })
        if (fault === 'visibility') dropdown.setVisible(false)
        if (fault === 'stacking') window.contentView.addChildView(content)
      }, { id: browser.id, bounds: browser.bounds, fault })
      await expect(assertOverlay(app, browser, 250)).rejects.toThrow('native dropdown')
    })
  }
})

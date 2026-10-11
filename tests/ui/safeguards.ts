import { expect } from '@playwright/test'
import type { ElectronApplication } from 'playwright'

export async function nativeViews(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0].contentView.children
    .flatMap((view, z) => view instanceof WebContentsView ? [{
      id: view.webContents.id, url: view.webContents.getURL(), bounds: view.getBounds(), visible: view.getVisible(), z
    }] : []))
}

type NativeView = Awaited<ReturnType<typeof nativeViews>>[number]

export async function assertOverlay(app: ElectronApplication, browser: NativeView, timeout = 10_000): Promise<void> {
  await expect.poll(async () => {
    const views = await nativeViews(app)
    const page = views.find(view => view.id === browser.id)
    const dropdown = views.find(view => view.url.endsWith('/suggest.html'))
    return {
      browserVisible: page?.visible,
      browserBounds: page?.bounds,
      dropdownVisible: dropdown?.visible,
      dropdownAbovePage: !!page && !!dropdown && dropdown.z > page.z,
      dropdownOverlapsPage: !!page && !!dropdown && dropdown.bounds.width > 0 && dropdown.bounds.height > 0
        && dropdown.bounds.x < page.bounds.x + page.bounds.width
        && dropdown.bounds.x + dropdown.bounds.width > page.bounds.x
        && dropdown.bounds.y < page.bounds.y + page.bounds.height
        && dropdown.bounds.y + dropdown.bounds.height > page.bounds.y
    }
  }, { timeout, message: 'The native dropdown must overlay the unchanged, visible browser page.' }).toEqual({
    browserVisible: true, browserBounds: browser.bounds, dropdownVisible: true, dropdownAbovePage: true, dropdownOverlapsPage: true
  })
}

export async function assertNetworkBlocked(app: ElectronApplication, forbidden: string): Promise<void> {
  const results = await app.evaluate(async ({ session }, url) => Promise.all(
    [session.defaultSession, session.fromPartition('persist:browser')].map(async target => {
      try { await target.fetch(url); return 'allowed' }
      catch (error) { return error instanceof Error && error.message.includes('ERR_BLOCKED_BY_CLIENT') ? 'blocked' : String(error) }
    })
  ), forbidden)
  expect(results, 'Both app and browser sessions must block origins outside the fixture.').toEqual(['blocked', 'blocked'])
}

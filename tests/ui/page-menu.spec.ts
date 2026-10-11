import type { Page } from '@playwright/test'
import { detectCookieSources } from '../../src/main/cookie-import.ts'
import { test, expect, section } from './app'

type Entry = { label?: string; submenu?: Entry[] }

// The page's right-click menu (browser-pane.ts pageMenu). A native menu cannot be read from a
// test, so its template is caught as main builds it. Cookie import is offered whenever an OS
// browser is found under the same home folder, which this spec reads the same way main does, and
// nothing from the removed Fill with Craft Studio is left in it.
test('the page menu offers cookie import and nothing from Fill with Craft Studio', async ({ rocket }) => {
  const { page, app, origin } = rocket
  await app.evaluate(({ Menu }) => {
    const scope = globalThis as unknown as { menus: unknown[][] }
    scope.menus = []
    const build = Menu.buildFromTemplate.bind(Menu)
    Menu.buildFromTemplate = (template) => {
      // Submenus are built the same way; only the page's own menu, which ends with Inspect, counts.
      if (template.some((item) => (item as Entry).label === 'Inspect')) scope.menus.push(template as never)
      const menu = build(template)
      menu.popup = () => {}
      return menu
    }
  })
  const menuOn = async (browser: Page, selector: string): Promise<Entry[]> => {
    const count = (): Promise<number> => app.evaluate(() => (globalThis as unknown as { menus: unknown[] }).menus.length)
    const before = await count()
    await browser.locator(selector).click({ button: 'right' })
    await expect.poll(count).toBeGreaterThan(before)
    return await app.evaluate(() => {
      const strip = (items: Entry[]): Entry[] => items.map((item) => ({ label: item.label ?? '-', ...(item.submenu ? { submenu: strip(item.submenu) } : {}) }))
      return strip((globalThis as unknown as { menus: Entry[][] }).menus.at(-1) ?? [])
    })
  }
  const labels = (items: Entry[]): string[] => items.map((item) => item.label ?? '-')
  const sources = detectCookieSources()

  await (await section(page, 'Browser')).click()
  const browser = await rocket.surface('browser')
  await expect(browser).toHaveTitle('UI page one')
  expect(browser.url()).toBe(`${origin}/one`)

  for (const [where, selector, expected] of [
    ['the page', 'h1', ['Back', 'Forward', 'Reload']],
    ['a field', 'input', ['Cut', 'Copy', 'Paste', 'Select all']]
  ] as const) {
    await test.step(`On ${where}: its own entries, cookie import when a browser is found, no Fill`, async () => {
      const items = await menuOn(browser, selector)
      const shown = labels(items)
      for (const label of expected) expect(shown, `menu was: ${shown.join(' | ')}`).toContain(label)
      expect(shown.at(-1)).toBe('Inspect')
      expect(shown.filter((label) => /fill/i.test(label)), `menu was: ${shown.join(' | ')}`).toEqual([])
      const cookies = items.find((item) => item.label === 'Import login cookies')
      if (!sources.length) {
        expect(cookies, 'no OS browser profile here, so no import entry').toBeUndefined()
        return
      }
      expect(cookies, `menu was: ${shown.join(' | ')}`).toBeDefined()
      expect(labels(cookies!.submenu ?? [])).toEqual(sources.map((source) => source.label))
      for (const browserEntry of cookies!.submenu ?? []) {
        expect(labels(browserEntry.submenu ?? [])).toEqual(['This site (127.0.0.1)', 'All sites'])
      }
    })
  }
  test.info().annotations.push({ type: 'cookie sources', description: sources.map((source) => source.label).join(', ') || 'none' })
})

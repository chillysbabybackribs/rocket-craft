import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const output = process.env.CRAFT_UI_OUTPUT || resolve('.artifacts/ui/manual')

export default defineConfig({
  testDir: './tests/ui',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: resolve(output, 'results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(output, 'report'), open: 'never' }],
    ['json', { outputFile: resolve(output, 'results.json') }]
  ]
})

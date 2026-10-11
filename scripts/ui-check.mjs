#!/usr/bin/env node
// One entry point: build the current source, then test a fresh Electron profile. Each run
// keeps its own report, including failures during build, rather than replacing the last run.
import { runCommand } from './ui-process.mjs'
import { acquireUiSlots, isExclusiveUiCheck } from './ui-slots.mjs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(join(root, '.artifacts/ui'), { recursive: true })
const output = await mkdtemp(join(root, '.artifacts/ui', `${new Date().toISOString().replace(/[:.]/g, '-')}-`))
const env = { ...process.env, NODE_ENV: 'test', CRAFT_UI_OUTPUT: output }
const visible = process.argv.includes('--visible')
// Specs that hold frame budgets only on the private display read this.
if (visible) env.CRAFT_UI_VISIBLE = '1'
const args = process.argv.slice(2).filter(arg => arg !== '--visible')
const skipBuild = process.env.CRAFT_UI_SKIP_BUILD === '1'
const skipUnit = process.env.CRAFT_UI_SKIP_UNIT === '1'
const slotLock = await acquireUiSlots({ exclusive: isExclusiveUiCheck(args) })
const log = createWriteStream(join(output, 'runner.log'))
const controller = new AbortController()
let interrupted = 0
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted ||= signal === 'SIGINT' ? 130 : 143
  controller.abort()
})
const run = (command, args) => runCommand(command, args, {
  cwd: root, env, signal: controller.signal,
  onOutput: data => { process.stdout.write(data); log.write(data) }
})
console.log(`UI check artifacts: ${output}`)
let status = skipBuild && skipUnit ? 0 : 1
try {
  if (!skipBuild) status = await run('npm', ['run', 'build'])
  if (!status && !skipUnit) status = await run('npm', ['test'])
  if (!status) {
    const command = [process.execPath, join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...args]
    status = visible
      ? await run(command[0], command.slice(1))
      : await run('xvfb-run', ['-a', '--server-args=-screen 0 1440x960x24', ...command])
  }
} catch (error) {
  status = 1
  console.error(error)
  log.write(String(error))
} finally {
  status = interrupted || status
  await writeFile(join(output, 'summary.json'), JSON.stringify({ status: status === 0 ? 'passed' : 'failed', exitCode: status, output }, null, 2))
  log.end()
  await slotLock.release()
  console.log(`\n${status === 0 ? 'PASS' : 'FAIL'} — UI check artifacts: ${output}`)
  process.exitCode = status
}

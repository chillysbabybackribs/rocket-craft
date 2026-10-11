#!/usr/bin/env node
// `npm run open -- <path or URL>`: open something inside Craft Studio, as a link in the chat would.
// With the app running it lands there in a browser tab (a page) or the artifact panel (a text
// file) and this exits at once; otherwise the app starts and opens it. Runs the built app, so
// `npm run build` first after changing the source.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronEnv } from './electron-env.mjs'
import { ensureElectronSandbox } from './electron-sandbox.mjs'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const target = process.argv[2]
if (!target) {
  console.error('Give a file path or URL to open: npm run open -- docs/mockups/craft-studio.html')
  process.exit(2)
}
// A worktree has no build of its own until it runs one; the main folder's build serves, since
// this only forwards the path to the running app.
function mainFolder() {
  try {
    const common = execFileSync('git', ['-C', here, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
    return dirname(common)
  } catch {
    return null
  }
}
const built = (folder) => existsSync(join(folder, 'out', 'main', 'index.js'))
const root = built(here) ? here : mainFolder() && built(mainFolder()) ? mainFolder() : null
if (!root) {
  console.error('The app is not built yet. Run npm run build first.')
  process.exit(1)
}
const href = /^(https?|file):/i.test(target) ? target : resolve(process.cwd(), target)
// The app's own directory, so Electron reads package.json and the launch shares the running
// instance's identity; `out/main/index.js` as the entry would make a second, separate app.
const electron = join(root, 'node_modules', '.bin', 'electron')
const env = electronEnv()
ensureElectronSandbox(env)
const child = spawn(electron, [root, href], { cwd: root, env, stdio: 'inherit', detached: true })
child.unref()

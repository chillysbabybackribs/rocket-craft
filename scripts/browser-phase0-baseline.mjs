#!/usr/bin/env node
/**
 * Phase 0 harness baseline: deterministic browser capability checks (no LLM).
 * Writes a short JSON summary under .artifacts/browser-phase0/.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join(root, '.artifacts', 'browser-phase0', stamp)

await mkdir(outDir, { recursive: true })

const args = ['run', 'check:ui', '--', 'browser-capabilities.spec.ts']
const child = spawn('npm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })

const code = await new Promise((resolveCode) => child.on('close', resolveCode))
const summary = {
  at: new Date().toISOString(),
  spec: 'tests/ui/browser-capabilities.spec.ts',
  exitCode: code,
  passed: code === 0,
  note: 'Gap test: hash goto with ?slow=1200 should read Loading without ALPHA-42 until waitFor (Phase 1 settle targets this).'
}
await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
await writeFile(join(outDir, 'stdout.txt'), stdout)
await writeFile(join(outDir, 'stderr.txt'), stderr)

process.stdout.write(stdout)
process.stderr.write(stderr)
process.exit(code ?? 1)

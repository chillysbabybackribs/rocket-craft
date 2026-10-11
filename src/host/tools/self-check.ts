import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipOutput, recordOf, stringOf } from '../json.ts'
import { type Journal, parseWindow, type Severity } from '../journal.ts'
import { textResult, type Tool } from './registry.ts'

// The tools that let a model look at the app's own trouble, say what it saw, and check its own
// edits. They are served only when CRAFT_SELF_CHECK=1, so ordinary chats do not carry them.

const CHECK = `Run the chat folder's typecheck and tests (the "typecheck" and "test" scripts in package.json) and return what failed, or that all passed. Run it after every edit you make.`
const CHECK_TIMEOUT_MS = 120_000

/** Run an npm script in `cwd`; its exit status and the tail of its output, where the errors are. */
function runScript(cwd: string, script: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('npm', ['run', '--silent', script], { cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 8_000_000 }, (error, stdout, stderr) => {
      const timedOut = error && 'killed' in error && error.killed
      resolve({ ok: !error, output: clipOutput(`${stdout}${stderr}`.trim() + (timedOut ? `\n(stopped after ${CHECK_TIMEOUT_MS / 1000}s)` : ''), 4_000) })
    })
  })
}

const DIAGNOSTICS = `Read Craft Studio's own journal: errors, crashes, failed or slow turns, tool failures, and notes models filed. Returns the latest entries plus time-to-first-text and total time per provider and model.
Use it when the app misbehaves or feels slow, and after a change you made, to see whether it caused anything. Filter with severity, source and window.`

const NOTE = `File an observation about Craft Studio itself: something that failed, ran inefficiently or could be done better. Give what you saw, what you think causes it, and the change you would make. This only records the note; it edits nothing.
Use it for anything you see but were not asked to fix. Change code only for what the user asked, or a clear defect in code you are already working on; propose anything larger in the chat.`

const SEVERITIES = ['info', 'warn', 'error']

/** `cwdOf` names the folder of the chat that is calling. */
export function selfCheckTools(journal: Journal, cwdOf: (chatId: string | null) => string | null): Tool[] {
  return [
    {
      name: 'studio_check',
      description: CHECK,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async (_args, context) => {
        const cwd = cwdOf(context.chatId)
        const manifest = cwd ? join(cwd, 'package.json') : null
        if (!cwd || !manifest || !existsSync(manifest)) {
          return { ...textResult('This chat\'s folder has no package.json, so there is nothing to check. Run the project\'s own checks in the shell instead.'), isError: true }
        }
        const scripts = recordOf(recordOf(JSON.parse(readFileSync(manifest, 'utf8'))).scripts)
        const names = ['typecheck', 'test'].filter((name) => name in scripts)
        if (!names.length) return { ...textResult('package.json has no "typecheck" or "test" script. Run the project\'s own checks in the shell instead.'), isError: true }
        const lines: string[] = []
        let failed = false
        for (const name of names) {
          const { ok, output } = await runScript(cwd, name)
          failed ||= !ok
          lines.push(ok ? `${name}: passed` : `${name}: FAILED\n${output}`)
        }
        return { ...textResult(lines.join('\n\n')), ...(failed ? { isError: true } : {}) }
      }
    },
    {
      name: 'studio_diagnostics',
      description: DIAGNOSTICS,
      inputSchema: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: SEVERITIES, description: 'Lowest severity to show. Default: warn.' },
          source: { type: 'string', description: 'Only entries whose source starts with this: host, main, turn, tool, model.' },
          window: { type: 'string', description: 'How far back, such as 30m, 2h or 1d. Default: 1d.' },
          limit: { type: 'number', description: 'Most entries to return. Default: 30.' }
        },
        additionalProperties: false
      },
      run: (args) => {
        const severity = SEVERITIES.includes(stringOf(args.severity)) ? stringOf(args.severity) as Severity : 'warn'
        const span = parseWindow(stringOf(args.window)) ?? 86_400_000
        const since = Date.now() - span
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, Math.round(args.limit))) : 30
        const entries = journal.read({ since, severity, source: stringOf(args.source) || undefined, limit })
        const lines = entries.map((entry) =>
          `${new Date(entry.at).toISOString()} ${entry.severity} ${entry.source}/${entry.kind}: ${entry.message}`
          + (entry.details && entry.kind !== 'timing' ? ` ${JSON.stringify(entry.details)}` : ''))
        const stats = journal.stats(since)
        return textResult([
          lines.length ? lines.join('\n') : `Nothing at ${severity} or above in this window.`,
          stats ? `\nTimings:\n${stats}` : '',
          `\nThe journal is ${journal.path}.`
        ].join('\n'))
      }
    },
    {
      name: 'studio_note',
      description: NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          saw: { type: 'string', description: 'What you observed, with the evidence: an error, a timing, a repeated step.' },
          cause: { type: 'string', description: 'What you think is behind it.' },
          fix: { type: 'string', description: 'The change you would make, naming files where you can.' },
          severity: { type: 'string', enum: SEVERITIES, description: 'Default: info.' }
        },
        required: ['saw'],
        additionalProperties: false
      },
      run: (args, context) => {
        const saw = stringOf(args.saw).trim()
        if (!saw) return { ...textResult('Say what you saw in `saw`, then file the note again.'), isError: true }
        const severity = SEVERITIES.includes(stringOf(args.severity)) ? stringOf(args.severity) as Severity : 'info'
        journal.add('model', severity, 'observation', saw, {
          provider: context.provider, chatId: context.chatId,
          ...(stringOf(args.cause) ? { cause: stringOf(args.cause) } : {}),
          ...(stringOf(args.fix) ? { fix: stringOf(args.fix) } : {})
        })
        return textResult('Noted. Carry on; tell the user about it in your reply if it matters to what they asked.')
      }
    }
  ]
}

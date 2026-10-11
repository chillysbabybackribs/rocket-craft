import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Orchestrator, HELD_OPEN_RESULT, NOTES_MARKER, compactWorkerRecord, formatWorkersPrompt, type OrchestratorHub, type OrchestratorOptions } from './orchestrator.ts'
import { HELD_OPEN_LIMIT_MS, machineWorkerLimit, maxActiveForProvider } from '../shared/orchestrator.ts'
import { orchestratorTools } from './tools/orchestrator.ts'
import { Store } from './store.ts'
import { Teamwork } from './teamwork.ts'
import { Worktrees } from './worktrees.ts'
import type { Chat, Item, ProviderId, Turn } from '../shared/types.ts'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/**
 * A real repository for the run's folder, with the worktrees service and teamwork's queue and
 * report commits as the host wires them. The pre-merge check is stubbed out.
 */
function gitRepo(root: string): { cwd: string; options: () => OrchestratorOptions } {
  const cwd = join(root, 'main')
  mkdirSync(join(cwd, 'node_modules'), { recursive: true })
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Test')
  git(cwd, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n')
  writeFileSync(join(cwd, 'a.ts'), 'a\n')
  writeFileSync(join(cwd, 'b.ts'), 'b\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'start')
  const dataDir = join(root, 'profile')
  const teamwork = new Teamwork(new Store(':memory:'), () => [], { commit: true })
  const service = new Worktrees({ folder: cwd, dataDir, serial: (top, work) => teamwork.serial(top, work), checkCommand: null })
  return { cwd, options: () => ({ worktrees: () => service, commitReport: (folder, paths, message) => teamwork.commitReport(folder, paths, message) }) }
}

function fixture(options: { machineWorkerLimit?: number; git?: boolean; merged?: OrchestratorOptions['merged'] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rocket-orchestrator-')))
  const repo = options.git ? gitRepo(root) : null
  const chats = new Map<string, Chat>()
  const live = new Map<string, Turn>()
  const sent: Array<{ turn: Turn; text: string; model: string | null }> = []
  const stopped: string[] = []
  const posted: Array<{ chatId: string; provider: ProviderId; model: string | null; text: string }> = []
  const items = new Map<string, Item[]>()
  const events: ReturnType<Orchestrator['list']> = []
  let seq = 0
  let now = 100
  const hub: OrchestratorHub = {
    createChat(cwd, title) {
      const chat = { id: `chat-${++seq}`, cwd, title, lastProvider: null, createdAt: 1, updatedAt: 1 }
      chats.set(chat.id, chat)
      return chat
    },
    send(chatId, provider, model, text) {
      assert.ok(![...live.values()].some(turn => turn.chatId === chatId), 'no duplicate send to busy owner')
      const turn: Turn = { id: `turn-${++seq}`, chatId, provider, model, status: 'running', error: null, handoffTurns: 0, changes: null, sources: null, tokens: null, startedAt: 1, endedAt: null }
      live.set(turn.id, turn)
      sent.push({ turn, text, model })
      return turn.id
    },
    async post(chatId, provider, model, text) { posted.push({ chatId, provider, model, text }) },
    models: async () => [{ id: 'fast', label: 'Fast', description: 'Test model', isDefault: true }, { id: 'strong', label: 'Strong', description: 'Test model', isDefault: false }],
    working: () => [...live.values()],
    liveTurn(chatId) {
      return [...live.values()].find(turn => turn.chatId === chatId) ?? null
    },
    turnItems: (_chat, turn) => items.get(turn) ?? [],
    async stop(chatId) { stopped.push(chatId) },
    setCwd(chatId, cwd) {
      const chat = { ...chats.get(chatId)!, cwd }
      chats.set(chatId, chat)
      return chat
    }
  }
  const store = { chat: (id: string) => chats.get(id) ?? null }
  const stateFile = join(root, 'profile', 'orchestrator.json')
  const runner = new Orchestrator(stateFile, store, hub, run => events.push(run), {
    machineWorkerLimit: options.machineWorkerLimit ?? 100,
    now: () => now,
    merged: options.merged,
    ...repo?.options()
  })
  const owner = hub.createChat(repo?.cwd ?? root, 'User task').id
  const end = (id: string, status: Turn['status'] = 'completed', error: string | null = null) => {
    const turn = live.get(id)!
    assert.ok(turn)
    live.delete(id)
    runner.turnEnded({ ...turn, status, error, endedAt: 2 })
  }
  const start = () => runner.start(owner, 'codex', 'Investigate the codebase, review evidence, and deepen the useful questions.')
  return { root, cwd: repo?.cwd ?? root, repo, hub, store, chats, stateFile, runner, owner, sent, posted, live, stopped, items, events, end, start, get now() { return now }, set now(value: number) { now = value }, close: () => { runner.shutdown(); rmSync(root, { recursive: true, force: true }) } }
}

const gib = (n: number) => n * 1024 ** 3

test('machineWorkerLimit uses cores and 0.75 GiB available memory', () => {
  assert.equal(machineWorkerLimit({ cores: 8, availableBytes: gib(9) }), 8)
  assert.equal(machineWorkerLimit({ cores: 16, availableBytes: gib(4) }), 5)
  assert.equal(machineWorkerLimit({ cores: 1, availableBytes: gib(0.5) }), 1)
})

test('machine worker cap queues globally and starts the next when one finishes', async () => {
  const f = fixture({ machineWorkerLimit: 2 })
  try {
    f.start()
    await f.runner.dispatch(f.owner, 'claude', 'Claude 1')
    await f.runner.dispatch(f.owner, 'codex', 'Codex 1')
    await f.runner.dispatch(f.owner, 'cursor', 'Cursor 1')
    await f.runner.dispatch(f.owner, 'claude', 'Claude 2')
    await f.runner.dispatch(f.owner, 'codex', 'Codex 2')
    const tasks = f.runner.get(f.owner)!.tasks
    assert.equal(tasks.filter(task => task.status === 'running').length, 2)
    assert.equal(tasks.filter(task => task.status === 'queued').length, 3)
    assert.equal(f.sent.length, 2)
    const first = tasks.find(task => task.status === 'running')!
    writeFileSync(first.report, 'Evidence')
    f.end(first.turnId!)
    assert.equal(f.runner.get(f.owner)!.tasks.filter(task => task.status === 'running').length, 2)
    assert.equal(f.sent.length, 3)
  } finally { f.close() }
})

test('per-provider limits still apply when the machine cap is larger', async () => {
  const f = fixture({ machineWorkerLimit: 100 })
  try {
    f.start()
    const cap = maxActiveForProvider('claude')
    for (let i = 0; i < cap + 1; i++) await f.runner.dispatch(f.owner, 'claude', `Fill ${i}`)
    const tasks = f.runner.get(f.owner)!.tasks
    assert.equal(tasks.filter(task => task.status === 'running').length, cap)
    assert.equal(tasks.filter(task => task.status === 'queued').length, 1)
  } finally { f.close() }
})

test('continuous review uses defaults, waits for workers, then dispatches fresh deeper chats', async () => {
  const f = fixture()
  try {
    const run = f.start()
    f.runner.tick()
    const leader = f.sent.at(-1)!.turn.id
    f.runner.tick()
    assert.equal(f.sent.length, 1)
    const first = (await f.runner.dispatch(f.owner, 'claude', 'Check the startup path')).tasks[0]!
    f.runner.checkpoint(f.owner, 'Investigating startup', 'Review the experiment')
    f.end(leader)
    f.runner.tick()
    assert.equal(f.sent.length, 2, 'wait rather than empty leader turns while worker runs')
    writeFileSync(first.report, '# Evidence\nAn isolated reproduction and its limitations.')
    f.end(first.turnId!)
    await assert.rejects(() => f.runner.dispatch(f.owner, 'cursor', 'Unreviewed follow-up'), /Review the finished worker evidence/)
    f.runner.tick()
    assert.match(f.sent.at(-1)!.text, /Review the experiment/)
    assert.match(f.sent.at(-1)!.text, /task-0001-claude.md/)
    f.runner.checkpoint(f.owner, 'Reproduction reviewed', 'Check the underlying startup ordering', first.id, 'Accepted the isolated result; production incidence unknown.')
    const next = (await f.runner.dispatch(f.owner, 'claude', 'Investigate why the startup ordering causes the observed result')).tasks[1]!
    assert.notEqual(next.chatId, first.chatId)
    assert.ok(f.sent.every(each => each.model === null))
    assert.match(readFileSync(run.progressFile, 'utf8'), /\| 0001 \| claude \| default \| completed \| Accepted \|/)
    assert.equal(readFileSync(join(dirname(first.report), 'task-0001-review.md'), 'utf8'), 'Accepted the isolated result; production incidence unknown.')
  } finally { f.close() }
})

test('user file edits survive checkpoints and wake an idle owner without spurious self-updates', async () => {
  const f = fixture()
  try {
    const run = f.start()
    f.runner.tick()
    await f.runner.dispatch(f.owner, 'cursor', 'Measure a limit')
    f.runner.checkpoint(f.owner, 'Measuring', 'Review results')
    f.end(f.sent[0]!.turn.id)
    const before = f.sent.length
    f.runner.tick(); f.runner.tick()
    assert.equal(f.sent.length, before, 'writing progress must not look like a new user note')
    const doc = readFileSync(run.progressFile, 'utf8')
    writeFileSync(run.progressFile, doc.slice(0, doc.indexOf(NOTES_MARKER) + NOTES_MARKER.length) + '\nFocus on cancellation.\n')
    f.runner.tick()
    assert.match(f.sent.at(-1)!.text, /Focus on cancellation/)
    f.runner.checkpoint(f.owner, 'Changed direction', 'Inspect cancel ownership')
    assert.ok(readFileSync(run.progressFile, 'utf8').endsWith('Focus on cancellation.\n'))
    f.runner.userMessage(f.owner, 'Keep all changes isolated')
    assert.match(readFileSync(run.progressFile, 'utf8'), /Keep all changes isolated/)
  } finally { f.close() }
})

test('drain refuses new dispatch and produces one final review after all workers finish', async () => {
  const f = fixture()
  try {
    f.start(); f.runner.tick()
    const leader = f.sent[0]!.turn.id
    const task = (await f.runner.dispatch(f.owner, 'claude', 'Research')).tasks[0]!
    f.runner.stop(f.owner, true)
    await assert.rejects(() => f.runner.dispatch(f.owner, 'cursor', 'More'), /Resume/)
    f.end(leader)
    f.runner.tick()
    assert.equal(f.sent.length, 2)
    assert.deepEqual(f.stopped, [])
    writeFileSync(task.report, 'Evidence')
    f.end(task.turnId!)
    f.runner.tick()
    assert.match(f.sent.at(-1)!.text, /Final review/)
    f.runner.checkpoint(f.owner, 'Final accepted findings', 'Resume later with the remaining question', task.id, 'Reviewed')
    f.end(f.sent.at(-1)!.turn.id)
    assert.equal(f.runner.get(f.owner)!.status, 'stopped')
    f.runner.tick()
    assert.equal(f.sent.length, 3)
  } finally { f.close() }
})

test('Stop requests cancellation only for owned workers, retains unresolved work, and never restarts on late completion', async () => {
  const f = fixture()
  try {
    f.start()
    const task = (await f.runner.dispatch(f.owner, 'claude', 'Research')).tasks[0]!
    const other = f.hub.createChat(f.root, 'Unrelated')
    f.hub.send(other.id, 'cursor', null, 'Unrelated work')
    f.runner.stop(f.owner)
    assert.deepEqual(f.stopped, [task.chatId])
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.status, 'running', 'stop request is not completion')
    writeFileSync(task.report, 'Late result')
    f.end(task.turnId!)
    f.runner.tick()
    assert.equal(f.sent.length, 2)
    assert.equal(f.runner.get(f.owner)!.status, 'stopped')
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.status, 'completed')
  } finally { f.close() }
})

test('completed-with-error-prose but missing report is not accepted as a successful worker', async () => {
  const f = fixture()
  try {
    f.start()
    const task = (await f.runner.dispatch(f.owner, 'cursor', 'Research')).tasks[0]!
    f.items.set(task.turnId!, [{ type: 'assistant', id: 'error', turnId: task.turnId!, text: 'Error: PING timed out', streaming: false }])
    f.end(task.turnId!)
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.status, 'failed')
    assert.match(f.runner.get(f.owner)!.tasks[0]!.result, /No report was delivered/)
    f.runner.tick()
    assert.match(f.sent.at(-1)!.text, /PING timed out/)
  } finally { f.close() }
})

test('failed or empty leader turns pause rather than spend usage in automatic retries', () => {
  for (const status of ['failed', 'completed'] as const) {
    const f = fixture()
    try {
      f.start(); f.runner.tick()
      f.end(f.sent[0]!.turn.id, status, status === 'failed' ? 'Quota reached' : null)
      assert.equal(f.runner.get(f.owner)!.status, 'paused')
      f.runner.tick()
      assert.equal(f.sent.length, 1)
      f.runner.resume(f.owner); f.runner.tick()
      assert.equal(f.sent.length, 2)
    } finally { f.close() }
  }
})

test('restart preserves evidence and pauses; damaged user-note boundary is never overwritten', async () => {
  const f = fixture()
  try {
    const run = f.start()
    await f.runner.dispatch(f.owner, 'antigravity', 'Research')
    const recovered = new Orchestrator(f.stateFile, f.store, f.hub, () => {}, { machineWorkerLimit: 100 })
    assert.equal(recovered.get(f.owner)!.status, 'paused')
    assert.equal(recovered.get(f.owner)!.tasks[0]!.status, 'interrupted')
    recovered.tick()
    assert.equal(f.sent.length, 1)
    writeFileSync(run.progressFile, 'My replacement notes; preserve these.')
    f.runner.tick()
    assert.equal(f.runner.get(f.owner)!.status, 'paused')
    assert.equal(readFileSync(run.progressFile, 'utf8'), 'My replacement notes; preserve these.')
  } finally { f.close() }
})

test('tool context cannot control another chat and worker concurrency is bounded', async () => {
  const f = fixture()
  try {
    f.start()
    for (let i = 0; i < maxActiveForProvider('codex'); i++) await f.runner.dispatch(f.owner, 'codex', `Codex ${i}`)
    assert.equal((await f.runner.dispatch(f.owner, 'codex', 'Fourth codex worker')).tasks[maxActiveForProvider('codex')]!.status, 'queued')
    const worker = f.runner.get(f.owner)!.tasks[0]!
    assert.throws(() => f.runner.start(worker.chatId, 'claude', 'Nested'), /nested/)
    const tool = orchestratorTools(() => f.runner)[0]!
    assert.equal((await tool.run({ action: 'checkpoint', summary: 'Hijack', next: 'More' }, { chatId: worker.chatId, provider: 'claude' })).isError, true)
    assert.equal((await tool.run({ action: 'start', task: 'Task' }, { chatId: null, provider: 'antigravity' })).isError, true)
    assert.equal((await tool.run({ action: 'dispatch', provider: 'bad', task: 'Task' }, { chatId: f.owner, provider: 'codex' })).isError, true)
  } finally { f.close() }
})

test('a damaged saved state disables orchestration without losing evidence or preventing host startup', async () => {
  const f = fixture()
  try {
    f.start()
    writeFileSync(f.stateFile, '{broken json')
    const recovered = new Orchestrator(f.stateFile, f.store, f.hub, () => {}, { machineWorkerLimit: 100 })
    assert.match(recovered.stateError!, /file was preserved/)
    assert.throws(() => recovered.start(f.owner, 'codex', 'Retry'), /Cannot read/)
    recovered.shutdown()
    assert.equal(readFileSync(f.stateFile, 'utf8'), '{broken json')
  } finally { f.close() }
})

test('Antigravity shared identity is not used concurrently with another active chat', async () => {
  const f = fixture()
  try {
    f.start()
    const other = f.hub.createChat(f.root, 'Other Antigravity chat')
    f.hub.send(other.id, 'antigravity', null, 'Existing work')
    await assert.rejects(() => f.runner.dispatch(f.owner, 'antigravity', 'Research'), /shared tool identity/)
    assert.equal(f.runner.get(f.owner)!.tasks.length, 0)
  } finally { f.close() }
})


test('unlimited dispatch persists queued chats and broadcasts every queue transition', async () => {
  const f = fixture()
  try {
    const run = f.start()
    for (const provider of ['claude', 'cursor', 'antigravity'] as const) await f.runner.dispatch(f.owner, provider, provider)
    for (let i = 0; i < 30; i++) await f.runner.dispatch(f.owner, 'codex', `Queued ${i}`)
    const tasks = f.runner.get(f.owner)!.tasks
    const codexCap = maxActiveForProvider('codex')
    assert.equal(tasks.length, 33)
    assert.equal(tasks.filter(task => task.status === 'running').length, 3 + codexCap)
    assert.equal(tasks.filter(task => task.status === 'queued').length, 30 - codexCap)
    assert.equal(f.sent.length, 3 + codexCap)
    for (const task of tasks.filter(each => each.status === 'queued')) {
      assert.ok(f.store.chat(task.chatId))
      assert.equal(task.turnId, null)
      assert.equal(task.createdAt, 100)
      assert.equal(task.startedAt, null)
      assert.equal(task.endedAt, null)
      assert.ok(f.events.some(event => event.tasks.find(each => each.id === task.id)?.status === 'queued'))
    }
    assert.match(readFileSync(run.progressFile, 'utf8'), /\| .* \| codex \| default \| queued \|/)
    const queuedCodex = tasks.find(task => task.provider === 'codex' && task.status === 'queued')!
    assert.throws(() => f.runner.checkpoint(f.owner, 'Summary', 'Next', queuedCodex.id, 'Review'), /finished task/)
    const firstCodex = tasks.find(task => task.provider === 'codex' && task.status === 'running')!
    writeFileSync(firstCodex.report, 'Evidence')
    f.end(firstCodex.turnId!)
    const started = f.runner.get(f.owner)!.tasks.find(task => task.id === queuedCodex.id)!
    assert.equal(started.status, 'running')
    assert.ok(started.turnId)
    assert.ok(f.events.some(event => event.tasks.some(each => each.id === started.id && each.status === 'running')))
    assert.equal(f.runner.get(f.owner)!.tasks.find(task => task.id === firstCodex.id)!.endedAt, 100)
    await assert.rejects(() => f.runner.dispatch(f.owner, 'claude', 'New work'), /Review the finished/)
  } finally { f.close() }
})

test('provider queues run FIFO independently and bypass review only for previously approved work', async () => {
  const f = fixture()
  try {
    f.start()
    const cap = maxActiveForProvider('claude')
    for (let i = 1; i <= cap + 1; i++) await f.runner.dispatch(f.owner, 'claude', `Claude ${i}`)
    await f.runner.dispatch(f.owner, 'cursor', 'Cursor 1')
    await f.runner.dispatch(f.owner, 'cursor', 'Cursor 2')
    const tasks = f.runner.get(f.owner)!.tasks
    assert.deepEqual(
      tasks.map(task => task.status),
      [...Array.from({ length: cap }, () => 'running'), 'queued', 'running', 'running']
    )
    writeFileSync(tasks[0]!.report, 'Evidence')
    f.end(tasks[0]!.turnId!)
    assert.equal(f.runner.get(f.owner)!.tasks[cap]!.status, 'running')
    const claudeNames = Array.from({ length: cap + 1 }, (_, i) => `Claude ${i + 1}`)
    assert.deepEqual(f.sent.map(each => each.text.match(/Assignment: ([^\n]+)/)?.[1]), [...claudeNames.slice(0, cap), 'Cursor 1', 'Cursor 2', claudeNames[cap]])
  } finally { f.close() }
})

test('failed and interrupted turns release their provider queue slot', async () => {
  for (const status of ['failed', 'interrupted'] as const) {
    const f = fixture()
    try {
      f.start()
      const cap = maxActiveForProvider('claude')
      for (let i = 0; i < cap; i++) await f.runner.dispatch(f.owner, 'claude', `Fill ${i}`)
      const queued = (await f.runner.dispatch(f.owner, 'claude', 'Second')).tasks[cap]!
      assert.equal(queued.status, 'queued')
      f.end(f.runner.get(f.owner)!.tasks[0]!.turnId!, status, 'Provider ended')
      assert.equal(f.runner.get(f.owner)!.tasks[cap]!.status, 'running')
      assert.equal(f.sent.length, cap + 1)
    } finally { f.close() }
  }
})

test('synchronous send failures release slots for already-approved FIFO work', async () => {
  const f = fixture()
  try {
    f.start()
    const cap = maxActiveForProvider('claude')
    for (let i = 0; i < cap; i++) await f.runner.dispatch(f.owner, 'claude', `Fill ${i}`)
    await f.runner.dispatch(f.owner, 'claude', 'Fourth')
    const send = f.hub.send
    let fail = true
    f.hub.send = (...args) => {
      if (fail) { fail = false; throw new Error('Launch failed') }
      return send(...args)
    }
    f.end(f.runner.get(f.owner)!.tasks[0]!.turnId!, 'failed')
    const tasks = f.runner.get(f.owner)!.tasks
    assert.equal(tasks[cap]!.status, 'failed')
    assert.equal(tasks[cap]!.endedAt, 100)
    assert.equal(tasks.filter(task => task.provider === 'claude' && task.status === 'running').length, cap - 1)
  } finally { f.close() }
})

test('stop and drain cancel queued tasks without starting or stopping their chats', async () => {
  for (const drain of [false, true]) {
    const f = fixture()
    try {
      f.start()
      const first = (await f.runner.dispatch(f.owner, 'antigravity', 'First')).tasks[0]!
      await f.runner.dispatch(f.owner, 'antigravity', 'Second')
      const stopped = f.runner.stop(f.owner, drain)!
      assert.equal(stopped.tasks[1]!.status, 'cancelled')
      assert.equal(stopped.tasks[1]!.startedAt, null)
      assert.equal(stopped.tasks[1]!.endedAt, 100)
      assert.equal(stopped.tasks[1]!.turnId, null)
      assert.deepEqual(f.stopped, drain ? [] : [first.chatId])
      assert.ok(f.events.some(event => event.tasks[1]?.status === 'cancelled'))
      writeFileSync(first.report, 'Evidence')
      f.end(first.turnId!)
      f.runner.tick()
      assert.equal(f.sent.filter(each => each.turn.chatId === stopped.tasks[1]!.chatId).length, 0)
      if (drain) {
        assert.match(f.sent.at(-1)!.text, /Final review/)
        f.runner.checkpoint(f.owner, 'Final', 'Done', first.id, 'Reviewed')
        f.end(f.sent.at(-1)!.turn.id)
        assert.equal(f.runner.get(f.owner)!.status, 'stopped')
      }
      f.runner.checkpoint(f.owner, 'Accepted', 'Next', first.id, 'Reviewed')
      f.runner.resume(f.owner)
      assert.equal(f.runner.get(f.owner)!.tasks[1]!.status, 'cancelled', 'cancelled work is not resurrected')
      await assert.doesNotReject(() => f.runner.dispatch(f.owner, 'cursor', 'Fresh task'))
    } finally { f.close() }
  }
})

test('restart leaves queued work paused and resume starts it without reapproval', async () => {
  const f = fixture()
  try {
    f.start()
    const cap = maxActiveForProvider('claude')
    for (let i = 0; i < cap; i++) await f.runner.dispatch(f.owner, 'claude', `Fill ${i}`)
    await f.runner.dispatch(f.owner, 'claude', 'Second; strong model for deeper analysis', 'strong')
    const queuedIndex = cap
    const sentBefore = f.sent.length
    f.runner.shutdown()
    f.live.clear() // Old host processes are gone.
    const recovered = new Orchestrator(f.stateFile, f.store, f.hub, run => f.events.push(run), { machineWorkerLimit: 100, now: () => 200 })
    try {
      assert.equal(recovered.get(f.owner)!.status, 'paused')
      assert.deepEqual(
        recovered.get(f.owner)!.tasks.map(task => task.status),
        [...Array.from({ length: cap }, () => 'interrupted'), 'queued']
      )
      assert.equal(recovered.get(f.owner)!.tasks[queuedIndex]!.startedAt, null)
      recovered.tick()
      assert.equal(f.sent.length, sentBefore)
      recovered.resume(f.owner)
      assert.equal(f.sent.length, sentBefore + 1)
      assert.equal(f.sent.at(-1)!.model, 'strong')
      assert.equal(recovered.get(f.owner)!.tasks[queuedIndex]!.model, 'strong')
      assert.equal(recovered.get(f.owner)!.tasks[queuedIndex]!.startedAt, 200)
      assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8'))[0].tasks[queuedIndex].status, 'running')
    } finally { recovered.shutdown() }
  } finally { f.close() }
})

test('old state backfills task timing while preserving valid timestamps', async () => {
  const f = fixture()
  try {
    f.start()
    const first = (await f.runner.dispatch(f.owner, 'claude', 'First')).tasks[0]!
    writeFileSync(first.report, 'Evidence')
    f.end(first.turnId!)
    f.runner.checkpoint(f.owner, 'Accepted', 'Next', first.id, 'Reviewed')
    const cap = maxActiveForProvider('claude')
    for (let i = 2; i <= cap + 2; i++) await f.runner.dispatch(f.owner, 'claude', `Worker ${i}`)
    const queuedIndex = cap + 1
    const saved = JSON.parse(readFileSync(f.stateFile, 'utf8'))
    const updatedAt = saved[0].updatedAt
    for (const task of saved[0].tasks) {
      delete task.createdAt; delete task.startedAt; delete task.endedAt; delete task.model
    }
    saved[0].tasks.push({ ...saved[0].tasks[0], id: '0005', createdAt: 10, startedAt: 20, endedAt: 30 })
    writeFileSync(f.stateFile, JSON.stringify(saved))
    const recovered = new Orchestrator(f.stateFile, f.store, f.hub, () => {}, { machineWorkerLimit: 100, now: () => 200 })
    try {
      const tasks = recovered.get(f.owner)!.tasks
      assert.deepEqual([tasks[0]!.createdAt, tasks[0]!.startedAt, tasks[0]!.endedAt], [100, 100, updatedAt])
      assert.deepEqual([tasks[1]!.createdAt, tasks[1]!.startedAt, tasks[1]!.endedAt], [100, 100, 200])
      assert.deepEqual([tasks[2]!.createdAt, tasks[2]!.startedAt, tasks[2]!.endedAt], [100, 100, 200])
      assert.deepEqual([tasks[3]!.createdAt, tasks[3]!.startedAt, tasks[3]!.endedAt], [100, 100, 200])
      assert.deepEqual([tasks[queuedIndex]!.createdAt, tasks[queuedIndex]!.startedAt, tasks[queuedIndex]!.endedAt], [100, null, null])
      assert.deepEqual([tasks.at(-1)!.createdAt, tasks.at(-1)!.startedAt, tasks.at(-1)!.endedAt], [10, 20, 30])
      assert.ok(tasks.every(task => task.model === null))
      assert.ok(JSON.parse(readFileSync(f.stateFile, 'utf8'))[0].tasks.every((task: { model: unknown }) => task.model === null))
      assert.equal(recovered.stateError, null)
    } finally { recovered.shutdown() }
  } finally { f.close() }
})

test('Codex workers cap at per-provider limit until one finishes', async () => {
  const f = fixture()
  try {
    f.start()
    const cap = maxActiveForProvider('codex')
    for (let i = 0; i < cap + 1; i++) await f.runner.dispatch(f.owner, 'codex', `Codex ${i + 1}`)
    const tasks = f.runner.get(f.owner)!.tasks
    assert.deepEqual(tasks.map(task => task.status), [...Array.from({ length: cap }, () => 'running'), 'queued'])
    assert.equal(f.sent.length, cap)
    writeFileSync(tasks[0]!.report, 'Evidence')
    f.end(tasks[0]!.turnId!)
    assert.equal(f.runner.get(f.owner)!.tasks[cap]!.status, 'running')
    assert.equal(f.sent.length, cap + 1)
  } finally { f.close() }
})

test('all four providers can reach per-provider caps concurrently', async () => {
  const f = fixture()
  try {
    f.start()
    let expected = 0
    for (const provider of ['claude', 'codex', 'cursor'] as const) {
      const cap = maxActiveForProvider(provider)
      expected += cap
      for (let i = 0; i < cap; i++) await f.runner.dispatch(f.owner, provider, `${provider} ${i}`)
    }
    expected += maxActiveForProvider('antigravity')
    await f.runner.dispatch(f.owner, 'antigravity', 'Antigravity solo')
    const tasks = f.runner.get(f.owner)!.tasks
    assert.equal(tasks.length, expected)
    assert.equal(tasks.filter(task => task.status === 'running').length, expected)
    assert.equal(f.sent.length, expected)
  } finally { f.close() }
})

test('queued Antigravity starts only after its shared identity is free', async () => {
  const f = fixture()
  try {
    f.start()
    const first = (await f.runner.dispatch(f.owner, 'antigravity', 'First')).tasks[0]!
    await f.runner.dispatch(f.owner, 'antigravity', 'Second')
    const other = f.hub.createChat(f.root, 'Unrelated Antigravity')
    const external = f.hub.send(other.id, 'antigravity', null, 'External').toString()
    f.end(first.turnId!, 'interrupted')
    assert.equal(f.runner.get(f.owner)!.tasks[1]!.status, 'queued')
    f.live.delete(external)
    f.runner.tick()
    assert.equal(f.runner.get(f.owner)!.tasks[1]!.status, 'running')
  } finally { f.close() }
})

test('single-task cancellation persists queued cancellation without launching it or stopping peers', async () => {
  const f = fixture()
  try {
    const run = f.start()
    const cap = maxActiveForProvider('claude')
    for (let i = 0; i < cap; i++) await f.runner.dispatch(f.owner, 'claude', `Fill ${i}`)
    const queued = (await f.runner.dispatch(f.owner, 'claude', 'Waiting')).tasks[cap]!
    const before = f.sent.length
    const state = f.runner.cancelTask(run.id, queued.id)
    assert.equal(state.tasks[cap]!.status, 'cancelled')
    assert.equal(state.tasks[cap]!.endedAt, 100)
    assert.equal(state.tasks[cap]!.startedAt, null)
    assert.equal(state.tasks[cap]!.turnId, null)
    assert.equal(f.sent.length, before)
    assert.deepEqual(f.stopped, [])
    assert.equal(f.events.at(-1)!.tasks[cap]!.status, 'cancelled')
    assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8'))[0].tasks[cap].status, 'cancelled')
    assert.match(readFileSync(run.progressFile, 'utf8'), /\| .* \| claude \| default \| cancelled \|/)
    f.runner.resume(f.owner)
    f.end(state.tasks[0]!.turnId!, 'interrupted')
    assert.equal(f.sent.length, before)
    assert.throws(() => f.runner.cancelTask(run.id, queued.id), /This worker has already finished and cannot be cancelled\./)
    assert.throws(() => f.runner.cancelTask('missing', queued.id), /does not exist/)
    assert.throws(() => f.runner.cancelTask(run.id, 'missing'), /does not belong/)
  } finally { f.close() }
})

test('single running cancellation waits for the actual end, releases its slot and reports stop failure', async () => {
  const f = fixture()
  try {
    const run = f.start()
    const cap = maxActiveForProvider('claude')
    for (let i = 0; i < cap; i++) await f.runner.dispatch(f.owner, 'claude', `Fill ${i}`)
    await f.runner.dispatch(f.owner, 'claude', 'Next')
    const running = f.runner.get(f.owner)!.tasks[0]!
    const state = f.runner.cancelTask(run.id, running.id)
    assert.equal(state.status, 'running')
    assert.equal(state.tasks[0]!.status, 'running')
    assert.equal(state.tasks[0]!.endedAt, null)
    assert.deepEqual(f.stopped, [running.chatId])
    f.end(running.turnId!, 'interrupted')
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.status, 'interrupted')
    assert.equal(f.runner.get(f.owner)!.tasks[cap]!.status, 'running')
    assert.throws(() => f.runner.cancelTask(run.id, running.id), /already finished/)
    f.hub.stop = async () => { throw new Error('Provider unavailable.') }
    f.runner.cancelTask(run.id, String(cap + 1).padStart(4, '0'))
    await Promise.resolve()
    assert.match(f.runner.get(f.owner)!.tasks[cap]!.result, /Stop request failed: Provider unavailable/)
    assert.equal(f.runner.get(f.owner)!.tasks[cap]!.status, 'running')
  } finally { f.close() }
})

test('user replies to queued worker chats are rejected before a provider turn can start', async () => {
  const f = fixture()
  try {
    f.start()
    const cap = maxActiveForProvider('claude')
    for (let i = 0; i < cap; i++) await f.runner.dispatch(f.owner, 'claude', `Fill ${i}`)
    const queued = (await f.runner.dispatch(f.owner, 'claude', 'Next')).tasks[cap]!
    const sent = f.sent.length
    assert.throws(() => f.runner.userMessage(queued.chatId, 'Hello'), {
      message: 'This worker is waiting in the queue; it starts when a slot frees. Cancel it or wait.'
    })
    assert.equal(f.sent.length, sent)
    assert.equal(f.runner.get(f.owner)!.tasks[cap]!.turnId, null)
    f.end(f.runner.get(f.owner)!.tasks[0]!.turnId!, 'interrupted')
    assert.doesNotThrow(() => f.runner.userMessage(queued.chatId, 'Hello'))
    assert.doesNotThrow(() => f.runner.userMessage(f.owner, 'Keep going'))
  } finally { f.close() }
})

test('checkpoint upserts plan items, links user updates, and refuses over-cap text', async () => {
  const f = fixture()
  try {
    f.start()
    f.runner.userMessage(f.owner, 'Add worker board')
    f.runner.checkpoint(f.owner, 'Planning', 'Dispatch board work', undefined, undefined, [
      { id: 'pass-1', text: 'Remove goals', status: 'done', tasks: ['0001'] },
      { id: 'board', text: 'Build worker board', status: 'planned', from: 0 }
    ], ['Use mockup as source of truth'])
    const run = f.runner.get(f.owner)!
    assert.equal(run.plan.length, 2)
    assert.equal(run.plan[1]!.from, 0)
    assert.equal(run.decisions.length, 1)
    f.runner.checkpoint(f.owner, 'Planning', 'Continue', undefined, undefined, [
      { id: 'board', text: 'Build worker board', status: 'active' }
    ])
    assert.equal(f.runner.get(f.owner)!.plan.find(item => item.id === 'board')!.status, 'active')
    assert.throws(
      () => f.runner.checkpoint(f.owner, 'x'.repeat(601), 'Next'),
      /summary must be at most 600/
    )
    assert.throws(
      () => f.runner.checkpoint(f.owner, 'Ok', 'x'.repeat(401)),
      /next step must be at most 400/
    )
    assert.throws(
      () => f.runner.checkpoint(f.owner, 'Ok', 'Next', undefined, undefined, [{ id: 'big', text: 'y'.repeat(141) }]),
      /Plan item text must be at most 140/
    )
    assert.throws(
      () => f.runner.checkpoint(f.owner, 'Ok', 'Next', undefined, undefined, undefined, ['z'.repeat(201)]),
      /decision must be at most 200/
    )
  } finally { f.close() }
})

test('a refused checkpoint leaves no review, plan change, or partial decisions', async () => {
  const f = fixture()
  try {
    f.start()
    f.runner.tick()
    const leader = f.sent[0]!.turn.id
    const task = (await f.runner.dispatch(f.owner, 'claude', 'Measure limits')).tasks[0]!
    writeFileSync(task.report, '# Evidence\nDone.')
    f.end(task.turnId!)
    f.end(leader)
    f.runner.tick()
    const beforePlan = structuredClone(f.runner.get(f.owner)!.plan)
    const beforeDecisions = f.runner.get(f.owner)!.decisions.length
    assert.throws(
      () => f.runner.checkpoint(
        f.owner,
        'Reviewed limits',
        'Continue',
        task.id,
        'Accepted the measurement approach.',
        [{ id: 'next-step', text: 'Tighten worker caps', status: 'planned' }],
        ['First decision is fine.', 'z'.repeat(201)]
      ),
      /decision must be at most 200/
    )
    const after = f.runner.get(f.owner)!
    assert.equal(after.tasks[0]!.review, null)
    assert.equal(after.plan.length, beforePlan.length)
    assert.deepEqual(after.plan, beforePlan)
    assert.equal(after.decisions.length, beforeDecisions)
    assert.equal(existsSync(join(dirname(task.report), `task-${task.id}-review.md`)), false)
  } finally { f.close() }
})

test('structured progress markdown lists sections, verdicts, and omits pasted task results', async () => {
  const f = fixture()
  try {
    const run = f.start()
    const task = (await f.runner.dispatch(f.owner, 'cursor', 'Long output')).tasks[0]!
    const long = 'x'.repeat(12_000)
    writeFileSync(task.report, '# Full report\nEverything is here.')
    f.items.set(task.turnId!, [{ type: 'assistant', id: 'a', turnId: task.turnId!, text: long, streaming: false }])
    f.end(task.turnId!)
    f.runner.checkpoint(
      f.owner, 'Worker done', 'Review it', task.id, 'Rejected huge noise in the transcript.',
      [{ id: 'p4', text: 'Per-provider worker limits', status: 'active', tasks: [task.id], from: 0 }],
      ['Keep reports isolated']
    )
    const doc = readFileSync(run.progressFile, 'utf8')
    for (const section of ['## Task', '## Plan', '## Added since the start', '## Now', '## Workers', '## Decisions', '## Reviews']) {
      assert.ok(doc.includes(section), `missing ${section}`)
    }
    assert.doesNotMatch(doc, /Work and review history/)
    assert.doesNotMatch(doc, /Progress log/)
    assert.doesNotMatch(doc, /x{5000}/)
    assert.match(doc, /\| 0001 \| cursor \| default \| completed \| Rejected \|/)
    // Plan lines carry the id the "Added since the start" section refers to.
    assert.match(doc, /^- \[~\] p4 · Per-provider worker limits \(0001\) \(added\)$/m)
    // Report links are relative to progress.md, which sits beside the reports.
    assert.match(doc, /\[task-0001-cursor\.md\]\(task-0001-cursor\.md\)/)
    assert.doesNotMatch(doc, /\]\(\//)
    // Times are local minute stamps, never ISO strings.
    assert.doesNotMatch(doc, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
    assert.match(doc, /Updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Review/)
    assert.match(doc, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} — Keep reports isolated$/m)
    assert.match(doc, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} — task 0001 — Worker done$/m)
    assert.equal(readFileSync(join(dirname(task.report), 'task-0001-review.md'), 'utf8'), 'Rejected huge noise in the transcript.')
    const notes = '\nSteer structured progress here.\n'
    writeFileSync(run.progressFile, doc.slice(0, doc.indexOf(NOTES_MARKER) + NOTES_MARKER.length) + notes)
    f.runner.checkpoint(f.owner, 'Notes ok', 'Continue')
    assert.ok(readFileSync(run.progressFile, 'utf8').endsWith(notes))
  } finally { f.close() }
})

test('progress markdown stays small for many large worker results', async () => {
  const f = fixture()
  try {
    const run = f.start()
    for (let i = 0; i < 20; i++) {
      const id = String(i + 1).padStart(4, '0')
      const task = (await f.runner.dispatch(f.owner, 'codex', `Task ${i}`)).tasks[i]!
      writeFileSync(task.report, `# Report ${i}\n${'payload '.repeat(400)}`)
      f.items.set(task.turnId!, [{ type: 'assistant', id: `a-${i}`, turnId: task.turnId!, text: 'y'.repeat(2048), streaming: false }])
      f.end(task.turnId!)
      f.runner.checkpoint(f.owner, `Reviewed ${i}`, `Next ${i}`, id, `Accepted findings for task ${i}.`)
    }
    const doc = readFileSync(run.progressFile, 'utf8')
    assert.ok(doc.length < 8_192, `progress should stay terse (${doc.length} bytes)`)
    assert.doesNotMatch(doc, /payload payload payload/)
  } finally { f.close() }
})

test('legacy orchestration state backfills plan, decisions, and update times', async () => {
  const f = fixture()
  try {
    const run = f.start()
    f.runner.userMessage(f.owner, 'Scope change')
    f.runner.shutdown()
    const saved = JSON.parse(readFileSync(f.stateFile, 'utf8'))
    delete saved[0].plan
    delete saved[0].decisions
    delete saved[0].updateTimes
    writeFileSync(f.stateFile, JSON.stringify(saved))
    const recovered = new Orchestrator(f.stateFile, f.store, f.hub, () => {}, { machineWorkerLimit: 100, now: () => 200 })
    try {
      const state = recovered.get(f.owner)!
      assert.deepEqual(state.plan, [])
      assert.deepEqual(state.decisions, [])
      assert.equal(state.updateTimes.length, state.updates.length)
      recovered.checkpoint(f.owner, 'Recovered', 'Continue', undefined, undefined, [{ id: 'a', text: 'First plan item' }])
      assert.equal(recovered.get(f.owner)!.plan.length, 1)
    } finally { recovered.shutdown() }
    assert.match(readFileSync(run.progressFile, 'utf8'), /Scope change/)
  } finally { f.close() }
})


test('dispatch validates and persists explicit models, while null and leader turns keep defaults', async () => {
  const f = fixture()
  try {
    const run = f.start()
    f.runner.tick()
    assert.equal(f.sent[0]!.model, null)
    assert.match(f.sent[0]!.text, /Haiku 5.5/)
    let calls = 0
    const read = f.hub.models
    f.hub.models = async provider => { calls++; assert.equal(provider, 'claude'); return read(provider) }
    const task = (await f.runner.dispatch(f.owner, 'claude', 'Strong model for complex analysis', 'strong')).tasks[0]!
    assert.equal(task.model, 'strong')
    assert.equal(f.sent.at(-1)!.model, 'strong')
    assert.equal(calls, 1)
    assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8'))[0].tasks[0].model, 'strong')
    assert.match(readFileSync(run.progressFile, 'utf8'), /\| 0001 \| claude \| strong \|/)
    await f.runner.dispatch(f.owner, 'cursor', 'Default for routine work', null)
    assert.equal(f.sent.at(-1)!.model, null)
    assert.equal(calls, 1, 'default dispatch needs no discovery')
    assert.match(readFileSync(run.progressFile, 'utf8'), /\| 0002 \| cursor \| default \|/)
  } finally { f.close() }
})

test('unknown model refuses dispatch with all available IDs and no worker side effects', async () => {
  const f = fixture()
  try {
    f.start()
    await assert.rejects(() => f.runner.dispatch(f.owner, 'claude', 'Investigate', 'missing'), {
      message: 'Model "missing" is not available for claude. Choose one of the available model IDs: fast, strong.'
    })
    assert.equal(f.runner.get(f.owner)!.tasks.length, 0)
    assert.equal(f.sent.length, 0)
  } finally { f.close() }
})

test('unreadable or empty model lists report fallback and send the provider default', async () => {
  for (const empty of [false, true]) {
    const f = fixture()
    try {
      const run = f.start()
      f.hub.models = async () => { if (empty) return []; throw new Error('Discovery unavailable.') }
      const state = await f.runner.dispatch(f.owner, 'claude', 'Investigate', 'strong')
      assert.equal(state.tasks[0]!.model, null)
      assert.equal(f.sent.at(-1)!.model, null)
      assert.match(state.updates.at(-1)!, /The model list for claude could not be read:.*Using the provider default instead of requested model strong\./)
      assert.match(readFileSync(run.progressFile, 'utf8'), /The model list for claude could not be read/)
    } finally { f.close() }
  }
})

test('models action returns provider lists with defaults, caches per run and retries failures', async () => {
  const f = fixture()
  try {
    f.start()
    const calls: ProviderId[] = []
    const read = f.hub.models
    f.hub.models = async provider => {
      calls.push(provider)
      if (provider === 'antigravity') throw new Error('Offline.')
      return read(provider)
    }
    const tool = orchestratorTools(() => f.runner)[0]!
    const response = await tool.run({ action: 'models' }, { chatId: f.owner, provider: 'codex' })
    assert.equal(response.isError, undefined)
    const text = response.content.find(block => block.type === 'text')!
    assert.equal(text.type, 'text')
    if (text.type !== 'text') throw new Error('Expected text.')
    const lists = JSON.parse(text.text)
    assert.equal(lists.length, 4)
    assert.equal(lists.find((entry: { provider: string }) => entry.provider === 'claude').models[0].isDefault, true)
    assert.match(lists.find((entry: { provider: string }) => entry.provider === 'antigravity').warning, /could not be read/)
    await f.runner.models(f.owner)
    assert.equal(calls.length, 5, 'three successes cached; failed provider retried')
    await f.runner.models(f.owner, 'claude')
    assert.equal(calls.length, 5)
    assert.equal(f.sent.length, 0, 'discovery never launches a turn')
    const other = f.hub.createChat(f.root, 'Another owner').id
    f.runner.start(other, 'codex', 'Another task')
    await f.runner.models(other, 'claude')
    assert.equal(calls.length, 6, 'each run has its own cache')
  } finally { f.close() }
})

test('stop during model discovery prevents a late worker acceptance', async () => {
  const f = fixture()
  try {
    f.start()
    let resolve!: (models: Awaited<ReturnType<OrchestratorHub['models']>>) => void
    f.hub.models = () => new Promise(done => { resolve = done })
    const pending = f.runner.dispatch(f.owner, 'claude', 'Investigate', 'strong')
    f.runner.stop(f.owner)
    resolve([{ id: 'strong', label: 'Strong', description: '', isDefault: false }])
    await assert.rejects(pending, /Resume the orchestrator/)
    assert.equal(f.runner.get(f.owner)!.tasks.length, 0)
    assert.equal(f.sent.length, 0)
  } finally { f.close() }
})


test('worker assignment text tells workers to stop background work and not wait for answers', async () => {
  const f = fixture()
  try {
    f.start()
    await f.runner.dispatch(f.owner, 'claude', 'Check logs')
    const assignment = f.sent.at(-1)!.text
    assert.match(assignment, /stop any background command or watcher/)
    assert.match(assignment, /Never wait for an answer/)
  } finally { f.close() }
})

test('held-open workers with a report are stopped after the limit; others are left alone', async () => {
  const f = fixture()
  try {
    const run = f.start()
    f.runner.tick()
    f.runner.checkpoint(f.owner, 'Starting', 'Dispatch a worker')
    f.end(f.sent[0]!.turn.id)
    const task = (await f.runner.dispatch(f.owner, 'claude', 'Background watcher')).tasks[0]!
    f.live.get(task.turnId!)!.activity = 'Waiting for 1 background task'
    writeFileSync(task.report, '# Done\nReport written.')
    f.runner.tick()
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.status, 'running')
    f.now = 100 + HELD_OPEN_LIMIT_MS + 1
    f.runner.tick()
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.status, 'completed')
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.result, HELD_OPEN_RESULT)
    assert.deepEqual(f.stopped, [task.chatId])
    assert.match(readFileSync(run.progressFile, 'utf8'), /\| 0001 \| claude \| default \| completed \| awaiting review \|/)
    f.live.delete(task.turnId!)
    f.runner.checkpoint(f.owner, 'Held-open stopped', 'Check no-report case', task.id, 'Report was in; host ended the hung turn.')
    assert.match(readFileSync(run.progressFile, 'utf8'), /\| 0001 \| claude \| default \| completed \| Report \|/)
    const noReport = (await f.runner.dispatch(f.owner, 'cursor', 'No report yet')).tasks[1]!
    f.live.get(noReport.turnId!)!.activity = 'Waiting for 1 background task'
    f.now = 100 + HELD_OPEN_LIMIT_MS * 2
    f.runner.tick()
    assert.equal(f.runner.get(f.owner)!.tasks[1]!.status, 'running')
    assert.deepEqual(f.stopped, [task.chatId], 'held-open stop never targets the leader chat')
  } finally { f.close() }
})

test('reply steers running workers, reopens finished ones with stored model, and refuses bad targets', async () => {
  const f = fixture()
  try {
    f.start()
    const running = (await f.runner.dispatch(f.owner, 'claude', 'Work')).tasks[0]!
    await f.runner.reply(f.owner, running.id, 'Stop the watcher')
    assert.deepEqual(f.posted.at(-1), { chatId: running.chatId, provider: 'claude', model: null, text: 'Stop the watcher' })
    const finished = (await f.runner.dispatch(f.owner, 'claude', 'Strong follow-up', 'strong')).tasks[1]!
    writeFileSync(finished.report, 'Evidence')
    f.end(finished.turnId!)
    f.runner.checkpoint(f.owner, 'Reviewed', 'Continue', finished.id, 'Accepted')
    const sentBefore = f.sent.length
    await f.runner.reply(f.owner, finished.id, 'Use assumption A for the API key name')
    const reopened = f.runner.get(f.owner)!.tasks[1]!
    assert.equal(reopened.status, 'running')
    assert.equal(reopened.review, null)
    assert.equal(f.sent.length, sentBefore + 1)
    assert.equal(f.sent.at(-1)!.model, 'strong')
    assert.match(f.sent.at(-1)!.text, /assumption A/)
    const cap = maxActiveForProvider('claude')
    for (let i = 0; i < cap - 1; i++) await f.runner.dispatch(f.owner, 'claude', `Fill ${i}`)
    const queued = (await f.runner.dispatch(f.owner, 'claude', 'Queued')).tasks.at(-1)!
    await assert.rejects(() => f.runner.reply(f.owner, queued.id, 'Hello'), {
      message: 'This worker is waiting in the queue; it starts when a slot frees. Cancel it or wait.'
    })
    await assert.rejects(() => f.runner.reply(f.owner, '9999', 'Hello'), {
      message: 'This worker does not belong to this orchestration.'
    })
    const tool = orchestratorTools(() => f.runner)[0]!
    const bad = await tool.run({ action: 'reply', taskId: queued.id, text: 'Hi' }, { chatId: f.owner, provider: 'codex' })
    assert.equal(bad.isError, true)
    assert.match(JSON.stringify(bad.content), /waiting in the queue/)
  } finally { f.close() }
})

test('dispatch tool forwards a model and surfaces unknown IDs as an operation error', async () => {
  const f = fixture()
  try {
    f.start()
    const tool = orchestratorTools(() => f.runner)[0]!
    const context = { chatId: f.owner, provider: 'codex' as const }
    const response = await tool.run({ action: 'dispatch', provider: 'claude', task: 'Fast model for routine checking', model: 'fast' }, context)
    assert.equal(response.isError, undefined)
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.model, 'fast')
    assert.equal(f.sent.at(-1)!.model, 'fast')
    const invalid = await tool.run({ action: 'dispatch', provider: 'claude', task: 'Routine task', model: 'unknown' }, context)
    assert.equal(invalid.isError, true)
    assert.match(JSON.stringify(invalid.content), /Choose one of the available model IDs: fast, strong/)
    assert.equal(f.runner.get(f.owner)!.tasks.length, 1)
  } finally { f.close() }
})

test('user plan changes gate dispatch and checkpoints until each is acknowledged', async () => {
  const f = fixture()
  try {
    const run = f.start()
    f.runner.checkpoint(f.owner, 'Planned', 'Start', undefined, undefined, [
      { id: '05-reading', text: 'Remove hands-free reading', status: 'planned' },
      { id: '06-layouts', text: 'Remove multi-pane layouts', status: 'planned' }
    ])
    f.runner.planEdit(run.id, { type: 'status', item: '06-layouts', status: 'kept' })
    const change = f.runner.get(f.owner)!.changes[0]!
    assert.equal(change.ack, null)
    assert.equal(f.runner.get(f.owner)!.plan[1]!.by, 'user')
    await assert.rejects(() => f.runner.dispatch(f.owner, 'claude', 'Remove layouts'), /The user changed the plan \(c1: Kept 06-layouts/)
    assert.throws(() => f.runner.checkpoint(f.owner, 'Reviewed', 'Next'), /Acknowledge each one in this checkpoint/)
    assert.throws(
      () => f.runner.checkpoint(f.owner, 'Reviewed', 'Next', undefined, undefined, [{ id: '06-layouts', text: 'Remove multi-pane layouts', status: 'dropped' }], undefined, { acknowledge: [{ change: 'c1', text: 'Layouts stay.' }] }),
      /set by the user \(kept\)/
    )
    assert.equal(f.runner.get(f.owner)!.changes[0]!.ack, null, 'a refused checkpoint saves nothing')
    f.runner.tick()
    assert.match(f.sent.at(-1)!.text, /c1: Kept 06-layouts \(do not do or remove it\)/)
    f.runner.checkpoint(f.owner, 'Reviewed', 'Next', undefined, undefined, undefined, undefined, { acknowledge: [{ change: 'c1', text: 'Layouts stay; no worker will remove them.' }] })
    const acked = f.runner.get(f.owner)!.changes[0]!
    assert.equal(acked.ack?.text, 'Layouts stay; no worker will remove them.')
    assert.throws(() => f.runner.planEdit(run.id, { type: 'undo', change: 'c1' }), /already acknowledged/)
    await assert.rejects(() => f.runner.dispatch(f.owner, 'claude', 'Remove layouts', null, { planItem: '06-layouts' }), /is kept/)
    const progress = readFileSync(run.progressFile, 'utf8')
    assert.match(progress, /- \[k\] 06-layouts · Remove multi-pane layouts \(yours\)/)
  } finally { f.close() }
})

test('dispatch records a short title and links the worker to its plan step', async () => {
  const f = fixture()
  try {
    f.start()
    f.runner.checkpoint(f.owner, 'Planned', 'Start', undefined, undefined, [{ id: '05-reading', text: 'Remove hands-free reading' }])
    const worker = (await f.runner.dispatch(f.owner, 'cursor', 'Remove the reading scroll. Keep the panel reader buttons until the mockup is agreed.', null, { title: 'Remove reading scroll', planItem: '05-reading' })).tasks[0]!
    assert.equal(worker.title, 'Remove reading scroll')
    assert.equal(worker.planItem, '05-reading')
    const step = f.runner.get(f.owner)!.plan[0]!
    assert.deepEqual(step.tasks, ['0001'])
    assert.equal(step.status, 'active')
    await assert.rejects(() => f.runner.dispatch(f.owner, 'cursor', 'Other', null, { title: 'x'.repeat(61) }), /60 characters/)
    await assert.rejects(() => f.runner.dispatch(f.owner, 'cursor', 'Other', null, { planItem: 'nope' }), /no plan item "nope"/)
    const derived = (await f.runner.dispatch(f.owner, 'codex', 'Check the scroll jump in progress.md and long chats. Then report.')).tasks[1]!
    assert.equal(derived.title, 'Check the scroll jump in progress.md and long chats')
    // A checkpoint's own task list adds to the dispatch links rather than replacing them.
    f.runner.checkpoint(f.owner, 'Planned', 'Start', undefined, undefined, [{ id: '05-reading', text: 'Remove hands-free reading', tasks: ['0009'] }])
    assert.deepEqual(f.runner.get(f.owner)!.plan[0]!.tasks, ['0001', '0009'])
  } finally { f.close() }
})

test('hand edits to the Plan section reach the plan as user changes', async () => {
  const f = fixture()
  try {
    const run = f.start()
    f.runner.checkpoint(f.owner, 'Planned', 'Start', undefined, undefined, [
      { id: 'a', text: 'First step' },
      { id: 'b', text: 'Second step' }
    ])
    const text = readFileSync(run.progressFile, 'utf8')
    writeFileSync(run.progressFile, text.replace('- [ ] a · First step', '- [x] a · First step').replace('- [ ] b · Second step', '- [ ] b · Second step')
      .replace(/(- \[ \] b · Second step\n)/, '$1- [ ] My own step\n'))
    // A host change since the last write is not a hand edit.
    f.runner.tick()
    const updated = f.runner.get(f.owner)!
    assert.equal(updated.plan[0]!.status, 'done')
    assert.equal(updated.plan[2]!.text, 'My own step')
    assert.deepEqual(updated.changes.map(change => [change.source, change.text.split(' ')[0]]), [['file', 'Marked'], ['file', 'Added']])
    assert.match(readFileSync(run.progressFile, 'utf8'), /- \[ \] u1 · My own step \(yours\)/)
    f.runner.tick()
    assert.equal(f.runner.get(f.owner)!.changes.length, 2, 'the host\'s own rewrite is not read back')
  } finally { f.close() }
})

test('worker and leader prompts wrap filesystem paths that contain spaces in backticks', () => {
  const harness = Object.create(Orchestrator.prototype) as Orchestrator
  const root = '/home/user/Craft Studio'
  const run = {
    id: 'run', chatId: 'owner', cwd: `${root}/repo`, provider: 'claude' as const, task: 'User task',
    progressFile: `${root}/docs/orchestrator/run/progress.md`,
    status: 'running' as const, reason: null, summary: 's', next: 'n', notes: '', updates: [], updateTimes: [],
    plan: [], decisions: [], history: [], changes: [], needs: [], checks: null, checkpointCycle: 1, cycle: 1,
    leaderTurnId: null, createdAt: 1, updatedAt: 1, tasks: []
  }
  const worker = {
    id: '0001', chatId: 'c1', turnId: null, provider: 'claude' as const, model: null, task: 'Fix auth', title: 'Auth fix',
    planItem: null, report: `${root}/docs/orchestrator/run/task-0001-claude.md`, status: 'running' as const,
    createdAt: 1, startedAt: 1, endedAt: null, result: '', review: null,
    worktree: { folder: `${root}/worktrees/abc`, branch: 'rocket/run/0001', base: 'deadbeef' },
    wantsWorktree: true, merge: null, fixes: null
  }
  const leader = (harness as unknown as { prompt(r: typeof run): string }).prompt(run)
  assert.match(leader, new RegExp(`maintain \`${run.progressFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``))
  const assignment = (harness as unknown as { workerPrompt(r: typeof run, w: typeof worker): string }).workerPrompt(run, worker)
  assert.match(assignment, new RegExp(`worktree at \`${worker.worktree!.folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``))
  assert.match(assignment, new RegExp(`report to \`${worker.report.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``))
  assert.match(assignment, new RegExp(`evidence beside it in \`${dirname(worker.report)}/task-0001-evidence/\`.`.replace(/\//g, '\\/')))
})

test('review prompt keeps compact workers under budget and lists report paths', () => {
  const harness = Object.create(Orchestrator.prototype) as Orchestrator
  const big = 'x'.repeat(5000)
  const run = {
    id: 'run', chatId: 'owner', cwd: '/', provider: 'claude' as const, task: 'User task', progressFile: '/p.md',
    status: 'running' as const, reason: null, summary: 's', next: 'n', notes: '', updates: [], updateTimes: [],
    plan: [], decisions: [], history: [], changes: [], needs: [], checks: null, checkpointCycle: 1, cycle: 1,
    leaderTurnId: null, createdAt: 1, updatedAt: 1,
    tasks: [
      { id: '0001', chatId: 'c1', turnId: null, provider: 'claude' as const, model: null, task: big, title: 'One', planItem: null, report: '/docs/orchestrator/run/task-0001-claude.md', status: 'completed' as const, createdAt: 1, startedAt: 1, endedAt: 2, result: 'done', review: null, worktree: null, wantsWorktree: false, merge: null, fixes: null },
      { id: '0002', chatId: 'c2', turnId: null, provider: 'cursor' as const, model: null, task: big, title: 'Two', planItem: null, report: '/docs/orchestrator/run/task-0002-cursor.md', status: 'running' as const, createdAt: 1, startedAt: 1, endedAt: null, result: '', review: null, worktree: null, wantsWorktree: false, merge: null, fixes: null }
    ]
  }
  const prompt = (harness as unknown as { prompt(r: typeof run): string }).prompt(run)
  const workersPart = prompt.split('\n\n').filter(part => part.startsWith('Workers:') || part.startsWith('Omitted workers')).join('\n\n')
  assert.ok(workersPart.length < 3000, `workers part was ${workersPart.length} chars`)
  assert.match(workersPart, /task-0001-claude\.md/)
  assert.match(workersPart, /task-0002-cursor\.md/)
  assert.doesNotMatch(workersPart, /x{100}/)
})

test('compact worker result keeps a failed error sentence whole', () => {
  const error = 'The provider quota was exceeded for this workspace; retry after billing is updated.'
  const record = compactWorkerRecord({
    id: '0003', chatId: 'c', turnId: null, provider: 'codex', model: null, task: 'Work', title: 'Work', planItem: null,
    report: '/r.md', status: 'failed', createdAt: 1, startedAt: 1, endedAt: 2, result: error, review: null, worktree: null, wantsWorktree: false, merge: null, fixes: null
  })
  assert.equal(record.result, error)
})

test('formatWorkersPrompt lists twenty recent unreviewed workers and omits the rest by id', () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    id: String(index + 1).padStart(4, '0'),
    chatId: `c${index}`, turnId: null, provider: 'claude' as const, model: null, task: 't', title: `Task ${index}`, planItem: null,
    report: `/r${index}.md`, status: 'completed' as const, createdAt: 1, startedAt: 1, endedAt: 2, result: 'ok', review: null, worktree: null, wantsWorktree: false, merge: null, fixes: null
  }))
  const text = formatWorkersPrompt(tasks)
  const workers = JSON.parse(text.split('\n\n')[0]!.slice('Workers: '.length)) as Array<{ id: string }>
  assert.equal(workers.length, 20)
  assert.deepEqual(workers.map(entry => entry.id), tasks.slice(-20).map(entry => entry.id))
  assert.match(text, /Omitted workers \(5 more\): 0001, 0002, 0003, 0004, 0005/)
})

test('orchestrator status reply stays compact for large assignments', async () => {
  const f = fixture()
  try {
    f.start()
    const big = 'y'.repeat(8000)
    await f.runner.dispatch(f.owner, 'claude', big)
    const tool = orchestratorTools(() => f.runner)[0]!
    const reply = await tool.run({ action: 'status' }, { chatId: f.owner, provider: 'codex' })
    const text = (reply.content[0] as { text: string }).text
    assert.ok(text.length < 6000, `status reply was ${text.length} chars`)
    assert.doesNotMatch(text, /y{100}/)
  } finally { f.close() }
})

test('orchestrator detail returns full assignment and refuses unknown ids', async () => {
  const f = fixture()
  try {
    f.start()
    const assignment = 'Inspect the scroll jump in progress.md and report.'
    await f.runner.dispatch(f.owner, 'cursor', assignment)
    const tool = orchestratorTools(() => f.runner)[0]!
    const ok = await tool.run({ action: 'detail', taskId: '0001' }, { chatId: f.owner, provider: 'codex' })
    const task = JSON.parse((ok.content[0] as { text: string }).text) as { task: string }
    assert.equal(task.task, assignment)
    const bad = await tool.run({ action: 'detail', taskId: '9999' }, { chatId: f.owner, provider: 'codex' })
    assert.equal(bad.isError, true)
    assert.match((bad.content[0] as { text: string }).text, /There is no worker "9999" in this orchestration\./)
  } finally { f.close() }
})

test('open questions, answers, checks and quiet reviews', async () => {
  const f = fixture()
  try {
    const run = f.start()
    f.runner.checkpoint(f.owner, 'Blocked on sign-in', 'Wait', undefined, undefined, undefined, undefined, {
      needs: [{ id: 'agy', text: 'Antigravity is signed out.', from: 'Worker 0024 cannot start', options: ['Skip it this run', 'I signed in'] }],
      checks: { typecheck: 'pass', tests: { passed: 240, total: 240 } }
    })
    let state = f.runner.get(f.owner)!
    assert.equal(state.needs[0]!.answer, null)
    assert.deepEqual(state.checks?.tests, { passed: 240, total: 240 })
    assert.match(readFileSync(run.progressFile, 'utf8'), /Checks: typecheck ✓ · tests 240\/240/)
    f.runner.answer(run.id, 'agy', 'Skip it this run')
    state = f.runner.get(f.owner)!
    assert.equal(state.needs[0]!.answer, 'Skip it this run')
    assert.equal(state.updates.at(-1), 'Answered "Antigravity is signed out.": Skip it this run')
    assert.throws(() => f.runner.answer(run.id, 'agy', 'Again'), /already been answered/)
    // Repeating an answered question does not reopen it; leaving out an open one resolves it.
    f.runner.checkpoint(f.owner, 'Asked', 'Wait', undefined, undefined, undefined, undefined, { needs: [{ id: 'agy', text: 'Antigravity is signed out.' }, { id: 'disk', text: 'Delete eval-live?' }], checks: { ui: { passed: 58, total: 59 } } })
    assert.equal(f.runner.get(f.owner)!.needs.find(need => need.id === 'agy')!.answer, 'Skip it this run')
    assert.deepEqual(f.runner.get(f.owner)!.checks?.tests, { passed: 240, total: 240 }, 'checks left out keep their value')
    f.runner.checkpoint(f.owner, 'Resolved', 'Go', undefined, undefined, undefined, undefined, { needs: [] })
    assert.equal(f.runner.get(f.owner)!.needs.some(need => need.id === 'disk'), false)
    f.runner.checkpoint(f.owner, 'Review 9: no new reports.', 'Wait')
    assert.equal(f.runner.get(f.owner)!.history.at(-1)!.quiet, true)
    assert.doesNotMatch(readFileSync(run.progressFile, 'utf8').split('## Reviews')[1]!, /Review 9/)
    assert.match(readFileSync(run.progressFile, 'utf8'), /## Needs you\n\nNothing is waiting on you\./)
  } finally { f.close() }
})

test('saved chat roles and worker titles survive completion, reply and restart', async () => {
  const f = fixture()
  let rebuilt: Orchestrator | undefined
  try {
    assert.equal(f.runner.roleOf(f.owner), 'ordinary')
    f.start()
    assert.equal(f.runner.roleOf(f.owner), 'leader')
    const worker = (await f.runner.dispatch(f.owner, 'codex', 'Check worker identity', null, { title: 'Check saved roles' })).tasks[0]!
    assert.equal(f.runner.roleOf(worker.chatId), 'worker')
    assert.equal(f.runner.workerTitle(worker.chatId), 'worker 0001: Check saved roles')
    f.end(worker.turnId!)
    await f.runner.reply(f.owner, worker.id, 'Check once more')
    assert.equal(f.runner.roleOf(worker.chatId), 'worker')
    rebuilt = new Orchestrator(f.stateFile, f.store, f.hub, () => {}, { machineWorkerLimit: 100 })
    assert.equal(rebuilt.roleOf(worker.chatId), 'worker')
    assert.equal(rebuilt.workerTitle(worker.chatId), 'worker 0001: Check saved roles')
    assert.equal(rebuilt.roleOf(f.owner), 'leader')
    assert.equal(rebuilt.roleOf('unrelated'), 'ordinary')
  } finally { rebuilt?.shutdown(); f.close() }
})

// Worktrees, with a real repository (docs/worktree-plan.md, step 3).

/** Start a worktree worker, let its worktree be made, and return it with its folder. */
async function startedWorker(f: ReturnType<typeof fixture>, provider: ProviderId, task: string, options: { worktree?: boolean; fixes?: string } = {}) {
  const run = await f.runner.dispatch(f.owner, provider, task, null, options)
  await f.runner.idle()
  return f.runner.get(f.owner)!.tasks.find(each => each.id === run.tasks.at(-1)!.id)!
}

/** The worker edits, writes its report and its turn ends. */
function finish(f: ReturnType<typeof fixture>, task: { id: string; turnId: string | null; report: string }, edits: Record<string, string> = {}) {
  const worker = f.runner.get(f.owner)!.tasks.find(each => each.id === task.id)!
  for (const [path, text] of Object.entries(edits)) writeFileSync(join(f.chats.get(worker.chatId)!.cwd, path), text)
  writeFileSync(task.report, `# Report ${task.id}`)
  f.end(worker.turnId!)
}

const subjects = (cwd: string) => git(cwd, 'log', '--format=%s').split('\n')

test('a worktree worker starts in its own worktree, made at start rather than at dispatch', async () => {
  const f = fixture({ git: true, machineWorkerLimit: 1 })
  try {
    f.start()
    const first = await startedWorker(f, 'claude', 'First change')
    const queued = (await f.runner.dispatch(f.owner, 'codex', 'Second change')).tasks[1]!
    assert.equal(queued.status, 'queued')
    assert.equal(queued.wantsWorktree, true)
    assert.equal(queued.worktree, null)
    assert.equal(f.chats.get(queued.chatId)!.cwd, f.cwd, 'a queued worker has no worktree yet')
    assert.ok(!existsSync(join(f.root, 'profile', 'worktrees', `${f.runner.get(f.owner)!.id.slice(0, 8)}-0002`)))
    // The main folder moves on while the second waits; its worktree starts from the folder as it is then.
    writeFileSync(join(f.cwd, 'later.ts'), 'written after dispatch\n')
    finish(f, first)
    await f.runner.idle()
    const started = f.runner.get(f.owner)!.tasks[1]!
    assert.equal(started.status, 'running')
    assert.ok(started.worktree)
    assert.equal(started.worktree.branch, `rocket/${f.runner.get(f.owner)!.id.slice(0, 8)}/0002`)
    assert.equal(f.chats.get(started.chatId)!.cwd, started.worktree.folder)
    assert.equal(readFileSync(join(started.worktree.folder, 'later.ts'), 'utf8'), 'written after dispatch\n')
    const prompt = f.sent.find(each => each.turn.id === started.turnId)!.text
    assert.match(prompt, new RegExp(`own git worktree at ${started.worktree.folder}`))
    assert.match(prompt, /Do not run npm install or npm run dev/)
    assert.match(prompt, new RegExp(`evidence beside it in ${dirname(started.report)}/task-0002-evidence/`))
  } finally { f.close() }
})

test('an accept merges the worker into the main folder as one commit, and the record says merged', async () => {
  const f = fixture({ git: true })
  try {
    const run = f.start()
    f.runner.tick()
    const leader = f.sent.at(-1)!.turn.id
    const worker = await startedWorker(f, 'claude', 'Change a.ts', {})
    f.runner.checkpoint(f.owner, 'Working', 'Review the change')
    f.end(leader)
    finish(f, worker, { 'a.ts': 'a changed by the worker\n' })
    f.runner.tick()
    const before = subjects(f.cwd).length
    f.runner.checkpoint(f.owner, 'Accepted', 'Next', worker.id, 'Accepted: a.ts changed as asked.', undefined, undefined, { verdict: 'accept' })
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.merge?.status, 'queued', 'the merge is queued after the checkpoint saves')
    f.end(f.sent.at(-1)!.turn.id)
    f.runner.tick()
    assert.equal(f.sent.length, 3, 'no new review while the merge is in flight')
    await f.runner.idle()
    const task = f.runner.get(f.owner)!.tasks[0]!
    assert.equal(readFileSync(join(f.cwd, 'a.ts'), 'utf8'), 'a changed by the worker\n')
    assert.equal(task.merge?.status, 'merged')
    assert.deepEqual(task.merge?.files, ['a.ts'])
    assert.ok(task.merge?.commit)
    const log = subjects(f.cwd)
    assert.equal(log.filter(subject => subject.startsWith('Task 0001: ')).length, 1, 'one squashed commit')
    assert.equal(git(f.cwd, 'show', '--format=', '--name-only', task.merge!.commit!), 'a.ts')
    assert.ok(log.includes('Task 0001 report: Change a.ts'), 'the reviewed report is committed by the host')
    assert.equal(log.length, before + 2)
    assert.ok(!existsSync(task.worktree!.folder), 'a clean merge removes its worktree')
    assert.equal(compactWorkerRecord(task).merge?.status, 'merged')
    assert.match(readFileSync(run.progressFile, 'utf8'), /\| 0001 \| claude \| default \| completed \| Accepted \| merged [0-9a-f]{7} · 1 files \|/)
    f.runner.tick()
    assert.match(f.sent.at(-1)!.text, /Merges[^\n]*\n- 0001 Change a.ts: merged \(a.ts\)\. Merged task 0001 \(1 files\)/, 'the result wakes the leader')
  } finally { f.close() }
})

test('a merge reports the files it wrote, once, and a reject reports nothing', async () => {
  const merged: Array<{ id: string; main: string; files: string[] }> = []
  const f = fixture({ git: true, merged: (task, main, files) => { merged.push({ id: task.id, main, files }) } })
  try {
    f.start()
    f.runner.tick()
    const leader = f.sent.at(-1)!.turn.id
    const worker = await startedWorker(f, 'claude', 'Write notes and a.ts', {})
    f.runner.checkpoint(f.owner, 'Working', 'Review the change')
    f.end(leader)
    finish(f, worker, { 'a.ts': 'a changed by the worker\n', 'notes.md': '# Notes\n' })
    f.runner.tick()
    f.runner.checkpoint(f.owner, 'Accepted', 'Next', worker.id, 'Accepted.', undefined, undefined, { verdict: 'accept' })
    f.end(f.sent.at(-1)!.turn.id)
    f.runner.tick()
    await f.runner.idle()
    assert.equal(merged.length, 1, 'the hook is called once for the merge')
    assert.equal(merged[0]!.id, '0001')
    assert.equal(merged[0]!.main, f.cwd, 'the hook is told the repository root')
    assert.deepEqual([...merged[0]!.files].sort(), ['a.ts', 'notes.md'], 'only the files the merge wrote')
  } finally { f.close() }
  const rejected: string[] = []
  const g = fixture({ git: true, merged: (task) => { rejected.push(task.id) } })
  try {
    g.start()
    g.runner.tick()
    const leader = g.sent.at(-1)!.turn.id
    const worker = await startedWorker(g, 'claude', 'Write notes', {})
    g.runner.checkpoint(g.owner, 'Working', 'Review the change')
    g.end(leader)
    finish(g, worker, { 'notes.md': '# Notes\n' })
    g.runner.tick()
    g.runner.checkpoint(g.owner, 'Rejected', 'Next', worker.id, 'Rejected.', undefined, undefined, { verdict: 'reject' })
    g.end(g.sent.at(-1)!.turn.id)
    g.runner.tick()
    await g.runner.idle()
    assert.equal(g.runner.get(g.owner)!.tasks[0]!.merge?.status, 'discarded')
    assert.deepEqual(rejected, [], 'a discarded task reports no files')
  } finally { g.close() }
})

test('a reject discards the worktree and its branch, and leaves the main folder alone', async () => {
  const f = fixture({ git: true })
  try {
    f.start()
    const worker = await startedWorker(f, 'cursor', 'Try something')
    finish(f, worker, { 'b.ts': 'rejected\n' })
    f.runner.checkpoint(f.owner, 'Rejected', 'Next', worker.id, 'Rejected: wrong approach.', undefined, undefined, { verdict: 'reject' })
    await f.runner.idle()
    const task = f.runner.get(f.owner)!.tasks[0]!
    assert.equal(task.merge?.status, 'discarded')
    assert.ok(!existsSync(task.worktree!.folder))
    assert.equal(git(f.cwd, 'branch', '--list', task.worktree!.branch), '')
    assert.equal(readFileSync(join(f.cwd, 'b.ts'), 'utf8'), 'b\n')
    await assert.rejects(() => f.runner.reply(f.owner, worker.id, 'Try again'), /was discarded.*Dispatch a follow-up/)
  } finally { f.close() }
})

test('a conflict is refused with its files, and a fix-up dispatched with fixes merges both', async () => {
  const f = fixture({ git: true })
  try {
    f.start()
    const worker = await startedWorker(f, 'claude', 'Change a.ts one way')
    finish(f, worker, { 'a.ts': 'the worker\'s a\n' })
    // Someone else changed a.ts in the main folder meanwhile.
    writeFileSync(join(f.cwd, 'a.ts'), 'the main folder\'s a\n')
    git(f.cwd, 'commit', '-q', '-am', 'main moved on')
    f.runner.checkpoint(f.owner, 'Accepted', 'Next', worker.id, 'Accepted.', undefined, undefined, { verdict: 'accept' })
    await f.runner.idle()
    const refused = f.runner.get(f.owner)!.tasks[0]!
    assert.equal(refused.merge?.status, 'refused')
    assert.equal(refused.merge?.reason, 'conflict')
    assert.deepEqual(refused.merge?.files, ['a.ts'])
    assert.match(refused.merge!.message!, /^Task 0001 was not merged: a\.ts changed in both/)
    assert.ok(!subjects(f.cwd).some(subject => subject.startsWith('Task 0001: ')), 'nothing was merged')
    assert.equal(git(f.cwd, 'status', '--porcelain', 'a.ts'), '')
    assert.ok(!existsSync(join(f.cwd, '.git', 'MERGE_HEAD')))
    assert.equal(readFileSync(join(f.cwd, 'a.ts'), 'utf8'), 'the main folder\'s a\n')
    assert.ok(existsSync(refused.worktree!.folder), 'a refused merge keeps its worktree')
    f.runner.tick()
    const review = f.sent.at(-1)!.turn.id
    assert.match(f.sent.at(-1)!.text, /0001 Change a.ts one way: refused \(a\.ts\)\. Task 0001 was not merged: a\.ts changed in both[^\n]*Dispatch a fix-up with fixes: "0001"/)

    await assert.rejects(() => f.runner.dispatch(f.owner, 'claude', 'Fix nothing', null, { fixes: '0009' }), /no task "0009"/)
    await assert.rejects(() => f.runner.dispatch(f.owner, 'claude', 'Fix it', null, { fixes: '0001', worktree: false }), /needs a worktree/)
    const fixup = await startedWorker(f, 'claude', 'Resolve the a.ts conflict', { fixes: '0001' })
    assert.equal(fixup.fixes, '0001')
    assert.equal(readFileSync(join(fixup.worktree!.folder, 'a.ts'), 'utf8'), 'the main folder\'s a\n', 'the fix-up starts from the main folder as it is now')
    const prompt = f.sent.find(each => each.turn.id === fixup.turnId)!.text
    assert.match(prompt, new RegExp(`fix-up for task 0001[^\\n]*Files named: a\\.ts\\.[^\\n]*on branch ${refused.worktree!.branch}`))
    assert.match(prompt, new RegExp(refused.worktree!.folder))
    finish(f, fixup, { 'a.ts': 'both, resolved\n' })
    f.runner.checkpoint(f.owner, 'Fixed', 'Next', fixup.id, 'Accepted the resolution.', undefined, undefined, { verdict: 'accept' })
    f.end(review)
    await f.runner.idle()
    const [original, fixed] = f.runner.get(f.owner)!.tasks
    assert.equal(fixed!.merge?.status, 'merged')
    assert.equal(readFileSync(join(f.cwd, 'a.ts'), 'utf8'), 'both, resolved\n')
    assert.equal(original!.merge?.status, 'merged')
    assert.match(original!.merge!.message!, /fix-up task 0002/)
    assert.ok(!existsSync(original!.worktree!.folder))
  } finally { f.close() }
})

test('a refused checkpoint with a verdict queues nothing', async () => {
  const f = fixture({ git: true })
  try {
    f.start()
    const worker = await startedWorker(f, 'claude', 'Change b.ts')
    assert.throws(() => f.runner.checkpoint(f.owner, 'Too early', 'Next', worker.id, 'Not finished', undefined, undefined, { verdict: 'accept' }), /Review a finished task/)
    finish(f, worker, { 'b.ts': 'worker b\n' })
    assert.throws(() => f.runner.checkpoint(f.owner, 'No task', 'Next', undefined, undefined, undefined, undefined, { verdict: 'accept' }), /verdict goes with taskId and review/)
    assert.throws(() => f.runner.checkpoint(f.owner, 'Bad plan', 'Next', worker.id, 'Accepted.', [{ id: 'x', text: 'y'.repeat(200) }], undefined, { verdict: 'accept' }), /at most 140/)
    assert.throws(() => f.runner.checkpoint(f.owner, 'Bad verdict', 'Next', worker.id, 'Accepted.', undefined, undefined, { verdict: 'maybe' as 'accept' }), /accept or reject/)
    await f.runner.idle()
    const task = f.runner.get(f.owner)!.tasks[0]!
    assert.equal(task.merge, null)
    assert.equal(task.review, null)
    assert.ok(existsSync(task.worktree!.folder))
    assert.equal(readFileSync(join(f.cwd, 'b.ts'), 'utf8'), 'b\n')
  } finally { f.close() }
})

test('a restart keeps an interrupted worker\'s worktree, resumes a queued merge, cleans orphans and names missing folders', async () => {
  const f = fixture({ git: true })
  try {
    f.start()
    const running = await startedWorker(f, 'claude', 'Long change')
    const accepted = await startedWorker(f, 'codex', 'Short change')
    const lost = await startedWorker(f, 'cursor', 'Lost change')
    writeFileSync(join(running.worktree!.folder, 'a.ts'), 'half done\n')
    finish(f, accepted, { 'b.ts': 'accepted b\n' })
    finish(f, lost, { 'c.ts': 'lost c\n' })
    f.runner.checkpoint(f.owner, 'Lost reviewed', 'Next', lost.id, 'Looked at it.')
    f.runner.checkpoint(f.owner, 'Accepted', 'Next', accepted.id, 'Accepted.', undefined, undefined, { verdict: 'accept' })
    // Craft Studio stops before the merge runs.
    f.runner.shutdown()
    await f.runner.idle()
    assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8'))[0].tasks[1].merge.status, 'queued')
    assert.equal(readFileSync(join(f.cwd, 'b.ts'), 'utf8'), 'b\n')
    f.live.clear()
    rmSync(lost.worktree!.folder, { recursive: true, force: true })
    const orphan = join(f.root, 'profile', 'worktrees', 'deadbeef-0001')
    mkdirSync(orphan, { recursive: true })

    const recovered = new Orchestrator(f.stateFile, f.store, f.hub, () => {}, { machineWorkerLimit: 100, ...f.repo!.options() })
    try {
      await recovered.idle()
      const [first, second, third] = recovered.get(f.owner)!.tasks
      assert.equal(first!.status, 'interrupted')
      assert.match(first!.result, /keeps its edits/)
      assert.equal(readFileSync(join(first!.worktree!.folder, 'a.ts'), 'utf8'), 'half done\n', 'the interrupted worker\'s edits are kept')
      assert.equal(second!.merge?.status, 'merged')
      assert.equal(readFileSync(join(f.cwd, 'b.ts'), 'utf8'), 'accepted b\n')
      assert.equal(third!.merge?.status, 'refused')
      assert.equal(third!.merge?.reason, 'missing')
      assert.match(third!.merge!.message!, /is gone/)
      assert.ok(!existsSync(orphan), 'an orphan folder is removed')
      // The interrupted worker can be continued in its worktree.
      recovered.resume(f.owner)
      await recovered.reply(f.owner, first!.id, 'Carry on')
      assert.equal(f.chats.get(first!.chatId)!.cwd, first!.worktree!.folder)
    } finally { recovered.shutdown() }
  } finally { f.close() }
})

test('Antigravity never gets a worktree', async () => {
  const f = fixture({ git: true })
  try {
    f.start()
    await assert.rejects(() => f.runner.dispatch(f.owner, 'antigravity', 'Edit', null, { worktree: true }), /Antigravity can only write inside its own folder/)
    const worker = await startedWorker(f, 'antigravity', 'Edit in the main folder')
    assert.equal(worker.wantsWorktree, false)
    assert.equal(worker.worktree, null)
    assert.equal(f.chats.get(worker.chatId)!.cwd, f.cwd)
    assert.doesNotMatch(f.sent.at(-1)!.text, /own git worktree/)
    assert.match(readFileSync(f.runner.get(f.owner)!.progressFile, 'utf8'), /\| 0001 \| antigravity \| default \| running \|  \| main \|/)
  } finally { f.close() }
})

test('research dispatched with worktree false runs in the main folder and its verdict is only a review', async () => {
  const f = fixture({ git: true })
  try {
    f.start()
    const worker = await startedWorker(f, 'claude', 'Read the code and report', { worktree: false })
    assert.equal(worker.wantsWorktree, false)
    assert.equal(worker.worktree, null)
    assert.equal(f.chats.get(worker.chatId)!.cwd, f.cwd)
    finish(f, worker)
    f.runner.checkpoint(f.owner, 'Read', 'Next', worker.id, 'Accepted the findings.', undefined, undefined, { verdict: 'accept' })
    await f.runner.idle()
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.merge, null)
    assert.ok(subjects(f.cwd).includes('Task 0001 report: Read the code and report'))
  } finally { f.close() }
})

test('the dispatch and checkpoint tool pass worktree, fixes and verdict through', async () => {
  const f = fixture({ git: true })
  try {
    f.start()
    const [tool] = orchestratorTools(() => f.runner)
    const context = { chatId: f.owner, provider: 'codex' as const }
    const dispatched = await tool!.run({ action: 'dispatch', provider: 'claude', task: 'Research only', worktree: false }, context)
    assert.equal(dispatched.isError, undefined)
    assert.match(JSON.stringify(dispatched), /\\"worktree\\":false/)
    await f.runner.idle()
    const worker = f.runner.get(f.owner)!.tasks[0]!
    assert.equal(worker.wantsWorktree, false)
    finish(f, worker)
    const bad = await tool!.run({ action: 'checkpoint', summary: 'S', next: 'N', taskId: '0001', review: 'R', verdict: 'merge' }, context)
    assert.equal(bad.isError, true)
    assert.match(JSON.stringify(bad), /accept or reject/)
    const good = await tool!.run({ action: 'checkpoint', summary: 'S', next: 'N', taskId: '0001', review: 'R', verdict: 'accept' }, context)
    assert.equal(good.isError, undefined)
    await f.runner.idle()
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.merge, null)
  } finally { f.close() }
})

test('stopping while a worktree is being made cancels the task and discards its worktree; finished work keeps its own', async () => {
  const f = fixture({ git: true })
  try {
    f.start()
    const kept = await startedWorker(f, 'claude', 'Finished change')
    finish(f, kept, { 'a.ts': 'kept\n' })
    f.runner.checkpoint(f.owner, 'Reviewed', 'Next', kept.id, 'Looks right; verdict later.')
    await f.runner.dispatch(f.owner, 'codex', 'Never ran')
    await assert.rejects(() => f.runner.reply(f.owner, '0002', 'Hello'), /still being made/)
    f.runner.stop(f.owner, false)
    await f.runner.idle()
    const [first, second] = f.runner.get(f.owner)!.tasks
    assert.equal(second!.status, 'cancelled')
    assert.equal(second!.worktree, null)
    assert.ok(!existsSync(join(f.root, 'profile', 'worktrees', `${f.runner.get(f.owner)!.id.slice(0, 8)}-0002`)))
    assert.equal(git(f.cwd, 'branch', '--list', 'rocket/*/0002'), '')
    assert.equal(f.sent.filter(each => each.turn.chatId === second!.chatId).length, 0, 'it never ran')
    assert.ok(existsSync(first!.worktree!.folder), 'finished work waits for a verdict')
    f.runner.discardRun(f.owner)
    await f.runner.idle()
    assert.equal(f.runner.get(f.owner)!.tasks[0]!.merge?.status, 'discarded', 'deleting the run discards it')
    assert.ok(!existsSync(first!.worktree!.folder))
  } finally { f.close() }
})

test('shell run controls use exact run IDs, refuse without saving, and preserve MCP resume', async () => {
  const f = fixture({ machineWorkerLimit: 1 })
  try {
    const run = f.start()
    const first = (await f.runner.dispatch(f.owner, 'claude', 'Running worker')).tasks[0]
    await f.runner.dispatch(f.owner, 'cursor', 'Queued worker')
    const refuses = (action: () => unknown, message: string) => {
      const saved = readFileSync(f.stateFile, 'utf8')
      const emits = f.events.length
      assert.throws(action, { message })
      assert.equal(readFileSync(f.stateFile, 'utf8'), saved)
      assert.equal(f.events.length, emits)
    }
    for (const id of ['', ' ', 4 as unknown as string]) refuses(() => f.runner.wrapUp(id), 'Give the run ID shown on the worker board.')
    for (const id of [f.owner, 'unknown']) refuses(() => f.runner.wrapUp(id), 'This orchestration does not exist.')
    refuses(() => f.runner.resumeRun(run.id), 'Resume is available only while this orchestration is paused.')
    const draining = f.runner.wrapUp(run.id)
    assert.equal(draining.status, 'draining')
    assert.deepEqual(draining.tasks.map(task => task.status), ['running', 'cancelled'])
    assert.deepEqual(f.stopped, [])
    assert.equal(f.sent.length, 1)
    refuses(() => f.runner.wrapUp(run.id), 'Wrap up is available only while this orchestration is running or paused.')
    refuses(() => f.runner.resumeRun(run.id), 'Resume is available only while this orchestration is paused.')
    writeFileSync(first.report, 'Worker evidence')
    f.end(first.turnId!)
    f.runner.tick()
    const leader = f.sent.at(-1)!.turn.id
    f.runner.tick()
    assert.equal(f.sent.length, 2)
    f.runner.checkpoint(f.owner, 'Final review complete', 'Finished', first.id, 'Accepted evidence')
    f.end(leader)
    assert.equal(f.runner.get(f.owner)!.status, 'stopped')
    refuses(() => f.runner.wrapUp(run.id), 'Wrap up is available only while this orchestration is running or paused.')
    refuses(() => f.runner.resumeRun(run.id), 'Resume is available only while this orchestration is paused.')
    assert.equal(f.runner.resume(f.owner).status, 'running', 'MCP still resumes stopped runs')
    assert.equal(f.runner.get(f.owner)!.tasks[1].status, 'cancelled')
    f.runner.stateError = `Cannot read saved orchestration state at ${f.stateFile}: bad. The file was preserved.`
    refuses(() => f.runner.wrapUp(''), f.runner.stateError)
    refuses(() => f.runner.resumeRun(run.id), f.runner.stateError)
  } finally { f.close() }
})

test('paused run can resume with a cleared reason or wrap up with zero workers', () => {
  const f = fixture()
  try {
    const run = f.start()
    f.runner.tick()
    f.end(f.sent.at(-1)!.turn.id)
    assert.equal(f.runner.get(f.owner)!.status, 'paused')
    const resumed = f.runner.resumeRun(run.id)
    assert.equal(resumed.status, 'running')
    assert.equal(resumed.reason, null)
    resumed.status = 'stopped'
    assert.equal(f.runner.get(f.owner)!.status, 'running', 'returned runs are clones')
    f.runner.tick()
    f.end(f.sent.at(-1)!.turn.id)
    assert.equal(f.runner.wrapUp(run.id).status, 'draining')
    f.runner.tick()
    f.runner.checkpoint(f.owner, 'Finished', 'No further work')
    f.end(f.sent.at(-1)!.turn.id)
    assert.equal(f.runner.get(f.owner)!.status, 'stopped')
  } finally { f.close() }
})

test('resumeRun starts eligible queued work after a missing-checkpoint pause', async () => {
  const f = fixture({ machineWorkerLimit: 1 })
  try {
    const run = f.start()
    f.runner.tick()
    const leader = f.sent[0].turn.id
    const active = (await f.runner.dispatch(f.owner, 'claude', 'Held worker')).tasks[0]
    await f.runner.dispatch(f.owner, 'cursor', 'Queued follow-up')
    f.end(leader)
    assert.equal(f.runner.get(f.owner)!.status, 'paused')
    writeFileSync(active.report, 'Evidence')
    f.end(active.turnId!)
    assert.equal(f.runner.get(f.owner)!.tasks[1].status, 'queued')
    const resumed = f.runner.resumeRun(run.id)
    assert.equal(resumed.reason, null)
    assert.equal(resumed.tasks[1].status, 'running')
    assert.equal(f.sent.length, 3)
  } finally { f.close() }
})

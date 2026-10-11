import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addWorktree, applyMerged, baseCommit, changedBetween, checkedOutBranches, commitBlocker, commitSquashed, commitTree, deleteBranch,
  listBranches, mergeTrees, pruneWorktrees, removeWorktree, repoRoot, subjectsBetween, worktreeState
} from './git.ts'
import { messageOf } from './json.ts'

// Private checkouts for code workers. Each task gets a git worktree under `<dataDir>/worktrees/`
// on a branch `rocket/<run>/<task>`, made from the main folder as it stands. Accepted work is
// merged back one task at a time: merged in git's object store, checked (typecheck and unit
// tests) on the merged result in a scratch worktree, and only then are the worker's files written
// into the main folder as one squashed commit. A refusal writes nothing. The queue is teamwork's,
// so a merge never interleaves with a turn's commit in the main folder.

/** Where a task's worktree is, from the run and task ids alone, so a restart can find it. */
export interface WorktreeTask { run: string; task: string }
export interface MergeTask extends WorktreeTask {
  /** The base commit `create` returned. */
  base: string
  /** The subject of the squashed commit. */
  title: string
}
export interface Created { folder: string; branch: string; base: string }

export type Refusal = 'conflict' | 'dirty' | 'moved' | 'check failed' | 'in progress'
export type MergeOutcome =
  | { status: 'merged'; files: string[]; commit: string | null }
  | { status: 'refused'; reason: Refusal; files: string[]; message: string; output?: string }

export interface WorktreeOptions {
  /** The main folder (any folder inside the repository). */
  folder: string
  dataDir: string
  /** The folder's serial queue; teamwork's `serial`. */
  serial: <T>(top: string, work: () => Promise<T>) => Promise<T>
  /** Whether the squashed commit is made. Without it the files are left uncommitted. */
  commit?: boolean
  /** Run in the merged tree before anything is written; a shell command. Null skips the check. */
  checkCommand?: string | null
  checkTimeoutMs?: number
}

export const DEFAULT_CHECK = 'env -u NODE_ENV npm run typecheck && env -u NODE_ENV npm test'
const CHECK_TIMEOUT_MS = 600_000
const TAIL_CHARS = 2_000

const short = (run: string): string => run.slice(0, 8)

export class Worktrees {
  constructor(private readonly options: WorktreeOptions) {}

  /** Folder and branch for a task; the same every time. */
  where(task: WorktreeTask): { folder: string; branch: string } {
    return { folder: join(this.options.dataDir, 'worktrees', `${short(task.run)}-${task.task}`), branch: `rocket/${short(task.run)}/${task.task}` }
  }

  /** A worktree from the main folder as it stands now, uncommitted work included. */
  async create(run: string, task: string): Promise<Created> {
    const top = await this.top()
    const { folder, branch } = this.where({ run, task })
    return this.options.serial(top, async () => {
      if (existsSync(folder)) throw new Error(`Task ${task} already has a worktree at ${folder}. Discard it before making another.`)
      const base = await baseCommit(top, `Craft Studio base for task ${task}`)
      if (!base) throw new Error('The main folder could not be read, so no worktree was made. Try dispatching the task again.')
      try {
        await addWorktree(top, folder, branch, base)
      } catch (error) {
        throw new Error(`The worktree for task ${task} could not be made: ${messageOf(error)} Try dispatching it again.`)
      }
      await this.linkModules(top, folder)
      return { folder, branch, base }
    })
  }

  /** Remove a task's worktree and delete its branch at once. Missing pieces are not an error. */
  async discard(task: WorktreeTask): Promise<void> {
    const top = await this.top()
    const { folder, branch } = this.where(task)
    await this.options.serial(top, async () => {
      await removeWorktree(top, folder)
      await deleteBranch(top, branch)
    })
  }

  /** Merge a finished (or stopped) worker's files into the main folder, or say why not. */
  async merge(task: MergeTask): Promise<MergeOutcome> {
    const top = await this.top()
    const outcome = await this.options.serial(top, () => this.mergeNow(top, task))
    // The work is in the main folder now (or was never going to be), so the private copy goes.
    if (outcome.status === 'merged') await this.discard(task).catch(() => {})
    return outcome
  }

  /**
   * Startup: forget worktrees whose folders are gone, remove worktree folders and `rocket/`
   * branches no task names, and report the tasks whose folder is missing.
   */
  async reconcile(known: WorktreeTask[]): Promise<{ missing: WorktreeTask[]; removed: string[]; warnings: string[] }> {
    const top = await this.top()
    return this.options.serial(top, async () => {
      await pruneWorktrees(top)
      const keepFolders = new Set(known.map((task) => this.where(task).folder))
      const keepBranches = new Set(known.map((task) => this.where(task).branch))
      const removed: string[] = []
      const warnings: string[] = []
      const root = join(this.options.dataDir, 'worktrees')
      for (const entry of await readdir(root).catch(() => [] as string[])) {
        const folder = join(root, entry)
        if (keepFolders.has(folder)) continue
        try {
          await removeWorktree(top, folder)
          removed.push(folder)
        } catch (error) {
          warnings.push(`Could not remove worktree ${folder}: ${messageOf(error)}`)
        }
      }
      const checkedOutAfterFolders = await checkedOutBranches(top)
      for (const branch of [...await listBranches(top, 'rocket/'), ...await listBranches(top, 'rocket-check/')]) {
        if (keepBranches.has(branch)) continue
        if (checkedOutAfterFolders.has(branch)) continue
        try {
          await deleteBranch(top, branch)
          removed.push(branch)
        } catch (error) {
          warnings.push(`Could not delete branch ${branch}: ${messageOf(error)}`)
        }
      }
      return { missing: known.filter((task) => !existsSync(this.where(task).folder)), removed, warnings }
    })
  }

  private async top(): Promise<string> {
    const top = await repoRoot(this.options.folder)
    if (!top) throw new Error(`${this.options.folder} is not inside a git repository, so worktrees cannot be used. Dispatch the task without a worktree.`)
    return top
  }

  /** Workers share the main folder's dependencies instead of installing their own. */
  private async linkModules(top: string, folder: string): Promise<void> {
    const modules = join(top, 'node_modules')
    if (existsSync(modules) && !existsSync(join(folder, 'node_modules'))) await symlink(modules, join(folder, 'node_modules')).catch(() => {})
  }

  private refuse(task: MergeTask, reason: Refusal, files: string[], message: string, output?: string): MergeOutcome {
    return { status: 'refused', reason, files, message: `Task ${task.task} was not merged: ${message}`, ...(output ? { output } : {}) }
  }

  private async mergeNow(top: string, task: MergeTask): Promise<MergeOutcome> {
    const { folder, branch } = this.where(task)
    if (!existsSync(folder)) throw new Error(`Task ${task.task} has no worktree at ${folder}, so there is nothing to merge. Dispatch the work again.`)
    const blocker = await commitBlocker(top)
    if (blocker) return this.refuse(task, 'in progress', [], `${blocker} in the main folder. Merge it again once that is finished.`)

    // 1. The worker as it stands, uncommitted edits included.
    const worker = await worktreeState(folder, `Craft Studio worker state for task ${task.task}`)
    if (!worker) throw new Error(`The worktree of task ${task.task} could not be read, so nothing was merged. Try the merge again.`)
    const theirs = await changedBetween(top, task.base, worker.tree)
    if (!theirs.length) return { status: 'merged', files: [], commit: null }
    const ours = await baseCommit(top, `Craft Studio main folder for task ${task.task}`)
    if (!ours) throw new Error('The main folder could not be read, so nothing was merged. Try the merge again.')

    // Cheap refusal first: a file the user has edited and not committed is not ours to take.
    const dirty = await changedBetween(top, 'HEAD', ours).then((files) => files.filter((file) => theirs.includes(file)), () => [])
    if (dirty.length) return this.dirty(task, dirty)

    // 2. Merge in the object store.
    const merged = await mergeTrees(top, task.base, ours, worker.commit)
    if (merged.conflicts) {
      const files = merged.conflicts
      return this.refuse(task, 'conflict', files, `${files.join(', ')} changed in both the main folder and the worker. Dispatch a fix-up worker that starts from the main folder as it is, or discard the task.`)
    }

    // 3. Typecheck and unit tests on the merged result.
    const failed = await this.check(top, task, merged.tree)
    if (failed !== null) return this.refuse(task, 'check failed', theirs, 'typecheck or the unit tests fail on the merged result. Dispatch a fix-up worker with the output below.', failed)

    // 4. Write only the worker's files.
    const applied = await applyMerged(top, task.base, worker.tree, ours, merged.tree)
    if (applied.refused === 'dirty') return this.dirty(task, applied.files)
    if (applied.refused === 'moved') return this.refuse(task, 'moved', applied.files, `${applied.files.join(', ')} changed in the main folder while it was being checked. Merge it again.`)
    const files = applied.written ?? []

    // 5. One squashed commit.
    let commit: string | null = null
    if (this.options.commit !== false && files.length) {
      commit = await commitSquashed(top, files, `Task ${task.task}: ${task.title}`, await subjectsBetween(top, task.base, branch).catch(() => []))
    }
    return { status: 'merged', files, commit }
  }

  private dirty(task: MergeTask, files: string[]): MergeOutcome {
    return this.refuse(task, 'dirty', files, `${files.join(', ')} has uncommitted changes in the main folder. Merge it again once the turn or person changing it is done.`)
  }

  /** Null when the check passed, otherwise the tail of its output. Runs in a scratch worktree of the merged tree. */
  private async check(top: string, task: MergeTask, tree: string): Promise<string | null> {
    const command = this.options.checkCommand === undefined ? DEFAULT_CHECK : this.options.checkCommand
    if (!command) return null
    const scratch = join(this.options.dataDir, 'worktrees', `check-${short(task.run)}-${task.task}`)
    const branch = `rocket-check/${short(task.run)}/${task.task}`
    try {
      await addWorktree(top, scratch, branch, await commitTree(top, tree, null, `Craft Studio merged result of task ${task.task}`))
      await this.linkModules(top, scratch)
      return await runCheck(scratch, command, this.options.checkTimeoutMs ?? CHECK_TIMEOUT_MS)
    } finally {
      await removeWorktree(top, scratch).catch(() => {})
      await deleteBranch(top, branch).catch(() => {})
    }
  }
}

function runCheck(cwd: string, command: string, timeout: number): Promise<string | null> {
  return new Promise((done) => {
    execFile('sh', ['-c', command], { cwd, timeout, maxBuffer: 32_000_000 }, (error, stdout, stderr) => {
      if (!error) return done(null)
      const tail = `${stdout}${stderr}`.trim().slice(-TAIL_CHARS)
      const timedOut = 'killed' in error && error.killed
      done(`${timedOut ? `The check timed out after ${Math.round(timeout / 1000)} seconds.\n` : ''}${tail || 'The check failed without any output.'}`)
    })
  })
}

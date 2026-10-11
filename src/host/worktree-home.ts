import { isAbsolute, relative } from 'node:path'
import type { Orchestration } from '../shared/orchestrator.ts'

// A chat running in a Craft Studio worktree (docs/worktree-plan.md) works in a private copy that is
// deleted when its task ends. What belongs to the project, not the copy (its notes, its library
// shelf), must be filed under the main folder. The orchestrator's task list says which folder
// is whose, so no git call is needed per message.

export type WorktreeHome = {
  /** The run's folder: the main folder this worktree was copied from. */
  main: string
  /** When the worker started, and so when the copy was made. */
  since: number
}

const inside = (folder: string, cwd: string): boolean => {
  const path = relative(folder, cwd)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** The main folder and start time for a folder inside a task's worktree; null for any other folder. */
export function worktreeHome(runs: Iterable<Pick<Orchestration, 'cwd' | 'tasks'>>, cwd: string): WorktreeHome | null {
  for (const run of runs) {
    for (const task of run.tasks) {
      if (task.worktree && inside(task.worktree.folder, cwd)) return { main: run.cwd, since: task.startedAt ?? task.createdAt }
    }
  }
  return null
}

/** The folder a chat's project belongs to: the main folder for a worktree, the folder itself otherwise. */
export function homeOf(runs: Iterable<Pick<Orchestration, 'cwd' | 'tasks'>>, cwd: string): string {
  return worktreeHome(runs, cwd)?.main ?? cwd
}

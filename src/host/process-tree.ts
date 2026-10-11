import type { ChildProcess, SpawnOptions } from 'node:child_process'

// Provider CLIs are launchers around a worker: `cursor-agent` is a shell script that execs node,
// which forks another node; `codex` is a node wrapper around the Rust binary. A plain SIGTERM to
// the pid we spawned reaches the wrapper only and leaves the worker running. Each child is
// therefore started in a process group of its own and stopped as a group, with SIGKILL for
// whatever has not exited after a grace period.

/** How long a stopped process group has to exit before it is killed outright. */
export const PROCESS_STOP_GRACE_MS = 3_000

const groups = new Set<number>()

/** Spawn options that give the child its own process group (a no-op on Windows). */
export function ownProcessGroup(): Pick<SpawnOptions, 'detached'> {
  return process.platform === 'win32' ? {} : { detached: true }
}

/** Remember a spawned child so `stopAllProcessGroups` can reach it at quit. */
export function trackProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  groups.add(child.pid)
  child.once('exit', () => groups.delete(child.pid!))
}

/**
 * Terminate the child and every process in its group, escalating to SIGKILL after the grace
 * period. Safe to call for a child that has already exited.
 */
export function stopProcessGroup(child: ChildProcess, graceMs = PROCESS_STOP_GRACE_MS): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  signalGroup(pid, child, 'SIGTERM')
  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup(pid, child, 'SIGKILL')
  }, graceMs)
  escalate.unref?.()
  child.once('exit', () => clearTimeout(escalate))
}

/** Kill every tracked group at once; for the host's own exit, when nothing waits for a grace period. */
export function stopAllProcessGroups(): void {
  for (const pid of groups) {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  groups.clear()
}

function signalGroup(pid: number, child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-pid, signal)
  } catch {
    // The group is gone or never became one (the exec failed early); fall back to the pid itself.
    try { child.kill(signal) } catch { /* already exited */ }
  }
}

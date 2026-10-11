import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('../node_modules/electron/dist/chrome-sandbox', import.meta.url))

// Electron updates replace this file with a user-owned, non-SUID copy. Repair it
// before launching, without prompting for a password or disabling the sandbox.
export function ensureElectronSandbox(env = process.env) {
  if (process.platform !== 'linux' || env.CRAFT_NO_SANDBOX === '1' || env.ELECTRON_DISABLE_SANDBOX === '1') return
  const configured = () => {
    let stat
    try {
      stat = statSync(helper)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      throw new Error('Electron is not fully installed. Run npm install --include=dev first. ' +
        'If the Electron package is present but its binary is missing, run node node_modules/electron/install.js.', { cause: error })
    }
    return stat.isFile() && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o7777) === 0o4755
  }
  if (configured()) return
  console.log('Repairing Electron sandbox permissions…')
  try {
    // chown can clear the SUID bit, so chmod must come last.
    execFileSync('sudo', ['-n', 'chown', 'root:root', '--', helper], { stdio: 'pipe', timeout: 10_000 })
    execFileSync('sudo', ['-n', 'chmod', '4755', '--', helper], { stdio: 'pipe', timeout: 10_000 })
    if (!configured()) throw new Error('Sandbox permissions did not persist.')
  } catch (error) {
    throw new Error(`Could not repair Electron sandbox permissions automatically. Run these commands once, then launch again:\n` +
      `sudo chown root:root '${helper}'\nsudo chmod 4755 '${helper}'`, { cause: error })
  }
}

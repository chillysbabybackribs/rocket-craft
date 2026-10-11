// The environment Electron can start cleanly in, shared by the scripts that launch it.
//
// - A parent Electron app (an editor or agent terminal) exports its own binary and identity to
//   children; electron-vite honours ELECTRON_EXEC_PATH, so without the scrub the app would run
//   on the parent's Electron, or as plain Node (ELECTRON_RUN_AS_NODE).
// - On hybrid-GPU Linux sessions the NVIDIA PRIME offload variables break ANGLE and push the
//   whole app onto CPU rendering. Chromium snapshots the environment before app code runs, so
//   they have to be gone before the binary is exec'd.
// - Craft Studio is often started from a shell inside a Rocket chat, which carries Rocket's own
//   ROCKET_* variables (ROCKET_DATA_DIR names Rocket's profile). Craft Studio reads only CRAFT_*,
//   but its providers and their shells inherit this environment, so Rocket's are dropped here.
// - CRAFT_NO_SANDBOX=1 is the opt-out for kernels that forbid unprivileged user namespaces
//   while the npm-installed chrome-sandbox helper is not SUID root.
export function electronEnv(base = process.env) {
  const env = { ...base }
  for (const name of [
    'ELECTRON_EXEC_PATH', 'ELECTRON_CLI_ARGS', 'ELECTRON_MAJOR_VER', 'ELECTRON_PA_APP_NAME', 'ELECTRON_RUN_AS_NODE',
    '__NV_PRIME_RENDER_OFFLOAD', '__GLX_VENDOR_LIBRARY_NAME', '__VK_LAYER_NV_optimus'
  ]) delete env[name]
  for (const name of Object.keys(env)) if (name.startsWith('ROCKET_')) delete env[name]
  if (env.CRAFT_NO_SANDBOX === '1') env.ELECTRON_DISABLE_SANDBOX = '1'
  return env
}

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  // Two entries in the main build: the Electron main process, and the agent host that main
  // forks as a utility process (providers, transcript store, usage probes).
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { watch: {}, rollupOptions: { input: {
      index: resolve('src/main/index.ts'),
      host: resolve('src/host/index.ts'),
      // One browser_run script runs in a worker thread of the host, loaded from this file.
      'script-worker': resolve('src/host/tools/script-worker.ts')
    } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { watch: {}, rollupOptions: { input: { index: resolve('src/preload/index.ts') } } }
  },
  // Two pages: the app's UI and the address field's dropdown, which main shows in a view of its own
  // because nothing in the UI's page can be drawn over the browser.
  renderer: {
    plugins: [react()],
    build: { rollupOptions: { input: {
      index: resolve('src/renderer/index.html'),
      suggest: resolve('src/renderer/suggest.html')
    } } }
  }
})

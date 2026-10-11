import '@fontsource-variable/inter'
import '@fontsource-variable/geist-mono'
import './styles.css'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { rocketMap } from './app-map.ts'
import { call } from './host.ts'
import { start } from './store.ts'

// Main runs the app map's dispatcher here for the host's studio_ui_where / go / act tools.
window.rocketMap = rocketMap

// A page error that nobody sees is lost; the host's journal keeps it for studio_diagnostics.
// The same message is sent once, so a render loop cannot flood the journal.
const reported = new Set<string>()
function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (reported.has(message) || reported.size >= 20) return
  reported.add(message)
  void call('journal.report', { message, stack: error instanceof Error ? error.stack : undefined }).catch(() => {})
}
window.addEventListener('error', (event) => report(event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => report(event.reason))

start()
createRoot(document.getElementById('root')!).render(<App />)

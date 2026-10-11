import { session } from 'electron'
import { BROWSER_PARTITION, NEW_TAB_URL } from './browser-url.ts'

// Install before any window or restored tab can navigate. Both the app's net.fetch calls
// and embedded pages must obey the same policy, including after a full app restart.
export function isolateUiTestNetwork(value: string | undefined): void {
  const origin = new URL(value ?? '')
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.href !== `${origin.origin}/`) {
    throw new Error('The UI test requires a loopback fixture origin.')
  }
  for (const target of [session.defaultSession, session.fromPartition(BROWSER_PARTITION)]) {
    target.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
      if (new URL(details.url).origin === origin.origin) done({})
      else if (details.url === NEW_TAB_URL) done({ redirectURL: `${origin.origin}/one` })
      else done({ cancel: true })
    })
  }
}

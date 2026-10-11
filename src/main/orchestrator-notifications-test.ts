import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrchestratorNotification } from '../shared/types.ts'

/** Installed only after uiTestProfile validates the isolated profile marker. */
export function notificationTestTransport(profile: string) {
  const attempts: OrchestratorNotification[] = []
  const notices: EventEmitter[] = []
  const create = (notice: OrchestratorNotification) => {
    const native = Object.assign(new EventEmitter(), {
      show: () => {
        attempts.push(notice)
        writeFileSync(join(profile, 'ui-notifications.json'), JSON.stringify(attempts))
      },
      close: () => { native.emit('close') }
    })
    notices.push(native)
    return native
  }
  const seam = { attempts, click: (index: number) => { notices[index]?.emit('click') } }
  return { create, seam }
}

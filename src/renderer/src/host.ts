import {
  HOST_PORT_MESSAGE, type HostApi, type HostEvent, type HostMethod, type HostRequestMessage, type HostToRenderer
} from '../../shared/types.ts'

// The renderer's line to the agent host: a MessagePort that main brokers once and then stays out
// of. Requests are answered by id; events arrive in per-frame batches.

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

let port: MessagePort | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const waiting: Array<() => void> = []
let onEvents: (events: HostEvent[]) => void = () => {}
let onReconnect: () => void = () => {}

export function connectHost(handlers: { events: (events: HostEvent[]) => void; reconnect: () => void }): void {
  onEvents = handlers.events
  onReconnect = handlers.reconnect
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== HOST_PORT_MESSAGE || !event.ports[0]) return
    const replaced = port !== null
    port?.close()
    // Whatever was in flight on the old port will never be answered.
    for (const request of pending.values()) request.reject(new Error('The agent host restarted'))
    pending.clear()
    port = event.ports[0]
    port.onmessage = (message: MessageEvent<HostToRenderer>) => receive(message.data)
    for (const resume of waiting.splice(0)) resume()
    if (replaced) onReconnect()
  })
  window.rocket.requestHostPort()
}

function receive(message: HostToRenderer): void {
  if (message.kind === 'events') {
    onEvents(message.events)
    return
  }
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.ok) request.resolve(message.result)
  else request.reject(new Error(message.error))
}

export async function call<M extends HostMethod>(method: M, params: HostApi[M][0]): Promise<HostApi[M][1]> {
  if (!port) await new Promise<void>((resolve) => waiting.push(resolve))
  const id = nextId++
  return new Promise<HostApi[M][1]>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    port!.postMessage({ kind: 'request', id, method, params } satisfies HostRequestMessage)
  })
}

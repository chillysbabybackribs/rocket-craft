import { ACTIONS, PLACES, describeMap, isAction, isPlace } from '../../shared/app-map.ts'
import type { MainAgentOp, UiMapResult, UiSnapshot, UiWhere } from '../../shared/types.ts'
import { recordOf, stringOf } from '../json.ts'
import { failureResult, type Tool, type ToolContent, type ToolResult } from './registry.ts'

// The app map's tools. The host knows the map's names and the chat asking; the renderer's
// dispatcher does the navigating, and main captures the window afterwards so the model sees
// where it ended up as well as reading it.

type Main = (op: MainAgentOp) => Promise<unknown>

/** Where the shell is, plus which pane the asking chat is in. */
export type UiWhereForChat = UiWhere & { yourPane: number | null }

export function whereForChat(where: UiWhere, chatId: string | null): UiWhereForChat {
  const pane = chatId ? where.panes.find((entry) => entry.chatId === chatId) : undefined
  return { ...where, yourPane: pane?.index ?? null }
}

/** One line a model reads first: the column, whether it is this chat, the side panel and what that panel shows. */
export function describeWhere(where: UiWhereForChat): string {
  const own = where.yourPane === null ? 'this chat is not on screen' : `this chat is pane ${where.yourPane} (ui.pane(${where.yourPane}))`
  const others = where.panes.filter((pane) => pane.index !== where.yourPane).map((pane) => `pane ${pane.index}: ${pane.title}${pane.running ? ', running' : ''}`)
  let side: string
  const shownApp = where.craft?.apps.find((app) => app.id === where.craft?.shown)
  if (where.side === 'app') side = shownApp ? `${shownApp.name} is shown on the right side (${shownApp.run})` : 'an app is shown on the right side'
  else if (where.side === 'shelf') side = 'the app shelf is shown on the right side'
  else if (where.side === 'browser') side = 'the browser is shown on the right side'
  else if (where.side === 'artifact') side = `an artifact panel is open on the right side${where.artifact?.path ? ` (${where.artifact.path})` : ''}`
  else {
    const library = where.library
    const filters = library ? Object.entries(library.filters).map(([name, value]) => `${name} ${value}`).join(', ') : ''
    side = library ? `the library is shown on the right side (${library.view}, ${library.shown} of ${library.total} files${filters ? `, filtered by ${filters}` : ''})` : 'the library is shown on the right side'
  }
  const installed = where.craft?.apps.filter((app) => app.installState === 'installed').map((app) => app.name) ?? []
  if (where.craft) side += installed.length ? `; installed apps: ${installed.join(', ')}` : '; no apps are installed yet'
  const board = where.board
  const workers = board
    ? `; the worker board beside it has ${board.workers.length} worker${board.workers.length === 1 ? '' : 's'} (${board.workers.filter((worker) => worker.status === 'running').length} running) for a ${board.run.status} run${board.run.reason ? `: ${board.run.reason}` : ''}${board.run.actionPending ? ', run action pending' : ''}${board.expanded ? `, worker ${board.expanded} expanded` : ''}`
    : ''
  return `Where you are: one chat pane, ${own}${others.length ? ` (${others.join('; ')})` : ''}; ${side}${workers}.`
}

export async function askWhere(main: Main, chatId: string | null): Promise<UiWhereForChat> {
  return whereForChat(await main({ op: 'uiMap', call: 'where' }) as UiWhere, chatId)
}

function paramsOf(args: Record<string, unknown>): Record<string, unknown> {
  return recordOf(args.params)
}

async function capture(main: Main): Promise<{ metadata: Record<string, unknown>; content: ToolContent[] }> {
  const { images, ...details } = await main({ op: 'uiSnapshot' }) as UiSnapshot
  return {
    metadata: { ...details, images: images.map(({ base64: _base64, ...image }) => image) },
    content: images.flatMap((image) => [{ type: 'text' as const, text: image.label }, { type: 'image' as const, data: image.base64, mimeType: image.mimeType }])
  }
}

async function finish(main: Main, result: UiMapResult, chatId: string | null, withCapture: boolean): Promise<ToolResult> {
  const where = whereForChat(result.where, chatId)
  const text = { ...(result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }), where, summary: describeWhere(where) }
  const content: ToolContent[] = []
  if (withCapture) {
    try {
      const shot = await capture(main)
      content.push({ type: 'text', text: JSON.stringify({ ...text, capture: shot.metadata }, null, 2) }, ...shot.content)
    } catch (error) {
      content.push({ type: 'text', text: JSON.stringify({ ...text, captureFailed: error instanceof Error ? error.message : String(error) }, null, 2) })
    }
  } else content.push({ type: 'text', text: JSON.stringify(text, null, 2) })
  if (result.ok) return { content }
  return { content, isError: true, structuredContent: { error: { code: 'UI_MAP_REFUSED', origin: 'operation', message: result.error } } }
}

export function uiMapTools(main: Main): Tool[] {
  const unavailable = (error: unknown): ToolResult => failureResult('UI_UNAVAILABLE', `Craft Studio’s window did not answer: ${error instanceof Error ? error.message : String(error)} Open the app and try again.`, 'runner')
  return [
    {
      name: 'studio_ui_where',
      description: 'Where Craft Studio’s app shell is, in the app map’s names: the orchestrator chat (pane 0) and whether it is yours, the side panel (chat, browser, library, tools, artifact) and what it shows, and the orchestrator’s worker board. No image. Call it before deciding how to reach something.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async (_args, context) => {
        try {
          const where = await askWhere(main, context.chatId)
          return { content: [{ type: 'text', text: JSON.stringify({ where, summary: describeWhere(where) }, null, 2) }] }
        } catch (error) { return unavailable(error) }
      }
    },
    {
      name: 'studio_ui_go',
      description: `Show a place in Craft Studio’s app shell by name, the same way a click would, and return where the shell ended up with an image. A wrong parameter is refused with the valid choices. Prefer this to clicking through studio_ui_run.\n${describeMap().split('\nActions')[0]}`,
      inputSchema: {
        type: 'object',
        properties: {
          place: { type: 'string', enum: Object.keys(PLACES), description: 'The place to show.' },
          params: { type: 'object', description: 'The place’s parameters, as listed in the description.', additionalProperties: true },
          capture: { type: 'boolean', description: 'Include an image of the window afterwards. Default true.' }
        },
        required: ['place'], additionalProperties: false
      },
      run: async (args, context) => {
        const place = stringOf(args.place)
        if (!isPlace(place)) return failureResult('INVALID_ARGUMENT', `There is no place "${place}". The places are ${Object.keys(PLACES).join(', ')}.`)
        try {
          const result = await main({ op: 'uiMap', call: 'go', place, params: paramsOf(args) }) as UiMapResult
          return finish(main, result, context.chatId, args.capture !== false)
        } catch (error) { return unavailable(error) }
      }
    },
    {
      name: 'studio_ui_act',
      description: `Do an action in Craft Studio’s app shell by name, through the same code its buttons use, and return its result and where the shell ended up with an image. An action goes to its place first when that is not on screen. A wrong parameter is refused with the valid choices.\nActions${describeMap().split('\nActions')[1]}`,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: Object.keys(ACTIONS), description: 'The action to do.' },
          params: { type: 'object', description: 'The action’s parameters, as listed in the description.', additionalProperties: true },
          capture: { type: 'boolean', description: 'Include an image of the window afterwards. Default true.' }
        },
        required: ['action'], additionalProperties: false
      },
      run: async (args, context) => {
        const action = stringOf(args.action)
        if (!isAction(action)) return failureResult('INVALID_ARGUMENT', `There is no action "${action}". The actions are ${Object.keys(ACTIONS).join(', ')}.`)
        try {
          const result = await main({ op: 'uiMap', call: 'act', action, params: paramsOf(args) }) as UiMapResult
          return finish(main, result, context.chatId, args.capture !== false)
        } catch (error) { return unavailable(error) }
      }
    }
  ]
}

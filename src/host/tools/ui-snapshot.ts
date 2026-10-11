import type { UiSnapshot } from '../../shared/types.ts'
import { SHELL_UI_TOOL_NOTE } from '../agent-situation.ts'
import type { Tool } from './registry.ts'

// Main owns the window; the host only translates its capture into the shared MCP image format.
export function uiSnapshotTools(snapshot: () => Promise<UiSnapshot>): Tool[] {
  return [{
    name: 'studio_ui_snapshot',
    description: `${SHELL_UI_TOOL_NOTE}\n\nSee Craft Studio’s currently running app shell. Read-only: no clicks or focus changes. Returns images, saved capture paths, visible shell controls and panels, native view bounds, and running-instance information. Source edits may need rebuild/restart before they appear. When whole-window capture is unavailable, separate surface images are returned with a warning.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const { images, ...metadata } = await snapshot()
      return { content: [
        { type: 'text', text: JSON.stringify({ ...metadata, images: images.map(({ base64: _base64, ...image }) => image) }, null, 2) },
        ...images.flatMap(image => [
          { type: 'text' as const, text: image.label },
          { type: 'image' as const, data: image.base64, mimeType: image.mimeType }
        ])
      ] }
    }
  }]
}

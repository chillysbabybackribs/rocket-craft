import type { RocketBridge, UiMapResult, UiWhere } from '../../shared/types.ts'

declare global {
  interface Window {
    rocket: RocketBridge
    /** The app map's dispatcher, run by main for the host's UI tools; see `app-map.ts`. */
    rocketMap: {
      where: () => UiWhere
      go: (place: string, params?: Record<string, unknown>) => Promise<UiMapResult>
      act: (action: string, params?: Record<string, unknown>) => Promise<UiMapResult>
    }
  }
}

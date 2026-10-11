// The app is finite. This map names every place the shell can show and every action a model can
// take there, so a model navigates by name instead of searching a screenshot for a button. The
// renderer's dispatcher (`src/renderer/src/app-map.ts`) implements every entry and the app's own
// buttons go through the same dispatcher, so what a model does and what a click does is one path.
// The host prints this map into every turn and into the studio_ui_go / studio_ui_act schemas.
// Typing the dispatcher's tables with these names makes the typecheck fail on a missing entry.

/** A parameter's name and what it takes. */
export type ParamSpec = Record<string, string>

export type PlaceSpec = {
  description: string
  /** The component that renders it, for a model that has to change how it looks. */
  file: string
  params?: ParamSpec
}

export type ActionSpec = {
  description: string
  params?: ParamSpec
  /** The place the action belongs to; the dispatcher goes there first when it is not shown. */
  place?: PlaceName
}

export const PLACES = {
  app: {
    description: 'An installed Craft app on the right side, its own window docked there; showing one starts it if it is not running. Only installed apps can be shown (studio_ui_where lists them under craft.apps); a model cannot install one, only suggest it to the user.',
    file: 'src/renderer/src/components/CraftAppPanel.tsx',
    params: { id: 'app id, an installed one from craft.apps (required)' }
  },
  shelf: { description: 'The app shelf on the right side: every Craft app with its install state. The user installs and removes apps here; a model can show it when suggesting an install. Showing any place on the right side closes a file or progress view shown over it.', file: 'src/renderer/src/components/Shelf.tsx' },
  browser: { description: 'The built-in browser on the right side.', file: 'src/renderer/src/components/BrowserPanel.tsx' },
  library: {
    description: 'The library on the right side: every file the chats attached, downloaded, wrote as plans or opened, as a grid or list. Filters given here replace the shown ones; library_list lists the same files.',
    file: 'src/renderer/src/components/LibraryPanel.tsx',
    params: {
      source: 'attachment, download, plan or opened',
      kind: 'pdf, markdown, text, image, office or other',
      chat: 'chat id',
      added: 'today, yesterday, week or older',
      q: 'words to search for',
      view: '"grid" or "list"'
    }
  },
  progress: {
    description: 'The orchestrator\'s progress view on the right side, for the run the orchestrator column\'s chat owns: Now, Needs you, Plan, Workers and Activity. Any link to a run\'s progress.md shows it too.',
    file: 'src/renderer/src/components/ProgressView.tsx',
    params: { section: 'now, needs, plan, workers or activity' }
  }
} satisfies Record<string, PlaceSpec>

export type PlaceName = keyof typeof PLACES

export const ACTIONS = {
  'chat.open': { description: 'Show a chat in the orchestrator column.', params: { chatId: 'chat id (required)', pane: 'only 0, the default: the column is the one pane' } },
  'chat.new': { description: 'Show the new-chat screen in the orchestrator column.', params: { pane: 'only 0, the default' } },
  'app.show': { description: 'Show an installed Craft app on the right side, as its dock icon does; it starts on its first show.', params: { id: 'app id, an installed one from craft.apps (required)' } },
  'shelf.open': { description: 'Show the app shelf on the right side, as the Apps control does. Nothing is installed by showing it.' },
  'library.clear': { description: 'Clear the library\'s filters and search.', place: 'library' },
  'library.open': { description: 'Open a library file in the side panel (text, Markdown, PDF pages or a picture); closing it returns to the library.', params: { id: 'file id from library_list (required)' }, place: 'library' },
  'plan.edit': {
    description: 'Change the run\'s plan as the user would from the progress view. The change locks the step and the orchestrator must acknowledge it before dispatching more work.',
    params: {
      change: 'done, reopen, keep (do not do or remove it), drop, restore, up, down, reword, add or undo (required)',
      item: 'plan step id (required except for add and undo); studio_ui_where lists them under progress.plan',
      text: 'the wording, for reword and add (at most 140 characters)',
      changeId: 'for undo: a change id from progress.pending'
    },
    place: 'progress'
  },
  'need.answer': { description: 'Answer one of the run\'s open questions in Needs you.', params: { need: 'question id (required)', answer: 'one of its answers, or your own words (required)' }, place: 'progress' },
  'run.wrapUp': { description: 'Finish running workers, cancel queued workers, and request the final review of the shown run.', params: {} },
  'run.resume': { description: 'Continue the shown orchestration; available only while paused.', params: {} },
  'worker.expand': { description: 'Show one worker of the orchestrator\'s board large over the board, with its whole transcript and a reply box.', params: { chatId: 'worker chat id (required); studio_ui_where lists them under board.workers' } },
  'worker.collapse': { description: 'Put the expanded worker back in its window on the board.' },
  'worker.next': { description: 'Expand the next worker in the board\'s order (running, queued, then finished), wrapping round; the first one when none is expanded.' },
  'worker.previous': { description: 'Expand the previous worker in the board\'s order, wrapping round; the last one when none is expanded.' }
} satisfies Record<string, ActionSpec>

export type ActionName = keyof typeof ACTIONS

function paramsText(params: ParamSpec | undefined): string {
  if (!params) return ''
  return ` {${Object.entries(params).map(([name, what]) => `${name}: ${what}`).join('; ')}}`
}

/** The map as a model reads it: one line per place and per action. */
export function describeMap(): string {
  const places = Object.entries(PLACES as Record<string, PlaceSpec>).map(([name, spec]) => `- ${name}${paramsText(spec.params)} — ${spec.description} [${spec.file}]`)
  const actions = Object.entries(ACTIONS as Record<string, ActionSpec>).map(([name, spec]) => `- ${name}${paramsText(spec.params)} — ${spec.description}`)
  return `Places (studio_ui_go):\n${places.join('\n')}\nActions (studio_ui_act):\n${actions.join('\n')}`
}

export function isPlace(name: unknown): name is PlaceName {
  return typeof name === 'string' && Object.hasOwn(PLACES, name)
}

export function isAction(name: unknown): name is ActionName {
  return typeof name === 'string' && Object.hasOwn(ACTIONS, name)
}

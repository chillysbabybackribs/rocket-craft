import '@fontsource-variable/inter'
import './suggest.css'
import { SUGGEST_PADDING, SUGGEST_ROW_HEIGHT, type Suggestion, type SuggestionList } from '../../shared/types.ts'

// The address field's dropdown. Main shows this page in a view of its own, sized to its rows and
// stacked above the browser's page. It only draws: the list and the selection come from main,
// and a click on a row is reported back. Keyboard focus never comes here.

const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
const ICONS: Record<Suggestion['kind'], string> = {
  search: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  url: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  history: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`
}

const root = document.getElementById('root')!
root.style.setProperty('--row', `${SUGGEST_ROW_HEIGHT}px`)
root.style.setProperty('--pad', `${SUGGEST_PADDING}px`)

function span(className: string, text?: string): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function render(list: SuggestionList): void {
  root.replaceChildren(...list.items.map((item, index) => {
    const row = document.createElement('div')
    row.className = `row${index === list.selected ? ' is-selected' : ''}`
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(index === list.selected))
    const icon = span('icon')
    icon.innerHTML = ICONS[item.kind]
    row.append(icon, span('title', item.title), span('detail', item.detail))
    // On press rather than on click: the press takes focus from the address field, which closes
    // the dropdown before a click would land.
    row.addEventListener('mousedown', (event) => {
      event.preventDefault()
      if (event.button === 0) window.rocket.browser.send({ type: 'suggestPick', value: item.value })
    })
    return row
  }))
}

window.rocket.browser.onSuggestions(render)

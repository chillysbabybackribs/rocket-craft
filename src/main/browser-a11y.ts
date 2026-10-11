/** Compact accessibility snapshot from CDP (Accessibility.getFullAXTree). */

export type AxProperty = { name: string; value: { type: string; value?: unknown } }
export type AxNode = {
  nodeId: string
  role?: { type: string; value: string }
  name?: { type: string; value: string }
  properties?: AxProperty[]
  childIds?: string[]
  backendDOMNodeId?: number
}

const ACTION_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'tab', 'switch',
  'slider', 'listbox', 'option', 'menuitemcheckbox', 'menuitemradio', 'spinbutton', 'search', 'textarea'
])

const STATE_KEYS = new Set(['disabled', 'checked', 'expanded', 'selected', 'pressed', 'required', 'invalid'])

export type A11yPin = { ref: string; backendDOMNodeId: number }

export type A11ySnapshot = { text: string; pins: A11yPin[] }

function roleOf(node: AxNode): string {
  return node.role?.value?.toLowerCase() ?? 'generic'
}

function nameOf(node: AxNode): string {
  const value = node.name?.value
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function statesOf(node: AxNode): string {
  const bits: string[] = []
  for (const prop of node.properties ?? []) {
    if (!STATE_KEYS.has(prop.name)) continue
    const value = prop.value.value
    if (prop.name === 'level' && typeof value === 'number') bits.push(`level=${value}`)
    else if (value === true || value === 'true') bits.push(prop.name)
    else if (typeof value === 'string' && value) bits.push(`${prop.name}=${value}`)
  }
  return bits.length ? `[${bits.join(', ')}]` : ''
}

function matchesQuery(line: string, query: string, regex: RegExp | null): boolean {
  return regex ? regex.test(line) : line.toLowerCase().includes(query.toLowerCase())
}

export function parseReadQuery(raw: string | null): { text: string; regex: RegExp | null } | null {
  if (!raw?.trim()) return null
  const trimmed = raw.trim()
  const slash = /^\/(.+)\/([dgimsuy]*)$/.exec(trimmed)
  if (slash) {
    try {
      return { text: trimmed, regex: new RegExp(slash[1]!, slash[2]) }
    } catch {
      return { text: trimmed, regex: null }
    }
  }
  return { text: trimmed, regex: null }
}

export function filterReadByQuery(body: string, rawQuery: string | null, maxLines: number | null): string {
  const parsed = parseReadQuery(rawQuery)
  if (!parsed) return body
  const lines = body.split('\n')
  const kept = lines.filter((line) => matchesQuery(line, parsed.text, parsed.regex))
  const cap = maxLines ?? 80
  if (kept.length > cap) {
    return kept.slice(0, cap).join('\n') + `\n[… ${kept.length - cap} more matching lines; narrow the query]`
  }
  if (!kept.length) return `(No lines matched ${parsed.regex ? parsed.text : `"${parsed.text}"`}.)`
  return kept.join('\n')
}

/** Walk the AX tree; assign refs to actionable nodes with a DOM backend id. */
export function buildA11ySnapshot(nodes: AxNode[], maxRefs: number, rawQuery: string | null): A11ySnapshot {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const root = nodes[0]
  if (!root) return { text: '(No accessibility tree.)', pins: [] }

  const pins: A11yPin[] = []
  let refSeq = 0
  const parsed = parseReadQuery(rawQuery)
  const lines: string[] = ['## Accessibility snapshot']

  const walk = (nodeId: string, depth: number): void => {
    const node = byId.get(nodeId)
    if (!node) return
    const role = roleOf(node)
    const name = nameOf(node)
    const states = statesOf(node)
    const actionable = ACTION_ROLES.has(role)
    const show = actionable || name.length > 0
    if (!show && !(node.childIds?.length)) return

    let ref = ''
    if (actionable && node.backendDOMNodeId !== undefined && refSeq < maxRefs) {
      refSeq += 1
      ref = `e${refSeq}`
      pins.push({ ref, backendDOMNodeId: node.backendDOMNodeId })
    }

    const indent = '  '.repeat(depth)
    const label = name ? `"${name.length > 100 ? `${name.slice(0, 99)}…` : name}"` : ''
    const line = `${indent}- ${role}${label ? ` ${label}` : ''}${states ? ` ${states}` : ''}${ref ? ` [ref=${ref}]` : ''}`

    if (!parsed || matchesQuery(line, parsed.text, parsed.regex)) lines.push(line)

    for (const childId of node.childIds ?? []) walk(childId, depth + 1)
  }

  walk(root.nodeId, 0)
  if (lines.length === 1) {
    lines.push(parsed ? `(No accessibility nodes matched ${parsed.text}.)` : '(Tree is empty.)')
  }
  return { text: lines.join('\n'), pins }
}

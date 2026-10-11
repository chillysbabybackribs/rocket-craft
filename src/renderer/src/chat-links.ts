// Only recognizable paths are automatically linked; ordinary prose remains plain text.
export function isFilePath(text: string): boolean {
  return /^(?:file:\/\/\/|\/|~\/|\.\.?\/)[^\n]+$/.test(text)
    || /^(?:[\w@.-]+\/)+[^\s]+(?:\.[\w]+)(?::\d+(?::\d+)?)?(?:#L\d+)?$/.test(text)
    || /^[\w.-]+\.(?:md|txt|tsx?|jsx?|json|html?|css|py|rs|go|sh|ya?ml|toml|pdf|png|jpe?g|svg|csv)(?::\d+(?::\d+)?)?(?:#L\d+)?$/i.test(text)
}

export function chatUrlTransform(url: string): string {
  if (/^https?:\/\//i.test(url) || /^file:\/\//i.test(url)) return url
  if (url.startsWith('#') || url.startsWith('//')) return ''
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !isFilePath(url)) return ''
  return url
}

type Node = { type: string; value?: string; url?: string; children?: Node[] }

/** Link bare paths and paths in inline code without touching fenced code or existing links. */
export function remarkFileLinks() {
  return (tree: Node): void => {
    const visit = (node: Node): void => {
      if (!node.children || ['link', 'linkReference', 'code', 'html'].includes(node.type)) return
      node.children = node.children.flatMap((child): Node[] => {
        if (child.type === 'inlineCode' && isFilePath(child.value ?? '')) {
          return [{ type: 'link', url: child.value, children: [child] }]
        }
        if (child.type !== 'text') { visit(child); return [child] }
        const text = child.value ?? ''
        const result: Node[] = []
        let end = 0
        for (const match of text.matchAll(/(?:file:\/\/\/|~\/|\.{0,2}\/)?[\w@./%+-]+(?::\d+(?::\d+)?)?(?:#L\d+)?/g)) {
          const value = match[0].replace(/[.,]+$/, '')
          if (!isFilePath(value)) continue
          if (match.index > end) result.push({ type: 'text', value: text.slice(end, match.index) })
          result.push({ type: 'link', url: value, children: [{ type: 'text', value }] })
          end = match.index + value.length
        }
        if (!end) return [child]
        if (end < text.length) result.push({ type: 'text', value: text.slice(end) })
        return result
      })
    }
    visit(tree)
  }
}

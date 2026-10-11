// What the browser tools run inside a page. `pageLib` is never called here: its source is sent
// to the page and run in an isolated world (the page's DOM, but none of its JavaScript), where
// it installs `__rocket`. So it must stand alone: no imports, nothing from outside its body.
//
// It turns a page into what a model reads (text with links, the controls with short refs) and
// finds the element a model names: a ref from that reading (`e12`), `text=Sign in`, or a CSS
// selector.

export type DigestOptions = { focus: 'all' | 'text' | 'elements' | 'network'; selector: string | null; max: number | null }

export function pageLib(): void {
  const scope = globalThis as unknown as { __rocket?: unknown }
  if (scope.__rocket) return

  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],'
    + '[role=menuitem],[role=checkbox],[role=radio],[role=combobox],[role=option],[role=switch],[contenteditable=""],[contenteditable=true]'
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'HEAD', 'INPUT', 'SELECT', 'TEXTAREA'])
  const BLOCK = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'BLOCKQUOTE', 'PRE',
    'FORM', 'FIELDSET', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'
  ])

  // A ref remembers what its element was as well as which, so that when a page swaps the element
  // for a new copy (frameworks re-render), the ref can follow it.
  const refs = new Map<string, { el: WeakRef<Element>; tag: string; name: string }>()
  const ids = new WeakMap<Element, string>()
  let seq = 0
  const refOf = (el: Element): string => {
    let id = ids.get(el)
    if (!id) {
      id = `e${++seq}`
      ids.set(el, id)
      refs.set(id, { el: new WeakRef(el), tag: el.tagName, name: '' })
    }
    return id
  }

  const clean = (value: string | null | undefined, max = 80): string => {
    const text = (value ?? '').replace(/\s+/g, ' ').trim()
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  }
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect()
    return box.width >= 1 && box.height >= 1 && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true }))
  }
  const scrollIfNeeded = (el: Element): void => {
    const box = el.getBoundingClientRect()
    const margin = 2
    const inView = box.bottom > margin && box.top < window.innerHeight - margin
      && box.right > margin && box.left < window.innerWidth - margin
    if (!inView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  }
  const nameOf = (el: Element): string => {
    const field = el as HTMLInputElement
    const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    const label = field.labels?.[0]?.innerText ?? el.closest('label')?.innerText
    const button = el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(field.type) ? field.value : ''
    return clean(el.getAttribute('aria-label') || labelled || button || label || field.placeholder || (el as HTMLElement).innerText
      || el.getAttribute('title') || el.querySelector('img[alt]')?.getAttribute('alt') || el.getAttribute('name'))
  }
  /** A link's address as short as it can be said; a very long one is given as the link's ref instead. */
  const link = (el: HTMLAnchorElement): string => {
    let href = el.href
    try {
      const url = new URL(href)
      if (url.origin === location.origin) href = url.pathname + url.search + url.hash
    } catch {
      // Left as written.
    }
    return href.length > 110 ? refOf(el) : href
  }

  const readText = (root: Element, max: number): string => {
    const out: string[] = []
    let kept = 0
    let total = 0
    const push = (text: string): void => {
      total += text.length
      if (kept < max) {
        out.push(text)
        kept += text.length
      }
    }
    const walk = (node: Node): void => {
      if (node.nodeType === 3) return push((node.nodeValue ?? '').replace(/\s+/g, ' '))
      if (node.nodeType !== 1) return
      const el = node as HTMLElement
      const tag = el.tagName.toUpperCase()
      if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true') return
      if (el.checkVisibility && !el.checkVisibility()) return
      if (tag === 'BR') return push('\n')
      if (tag === 'IMG') {
        const alt = clean(el.getAttribute('alt'))
        return alt ? push(`![${alt}]`) : undefined
      }
      if (tag === 'A' && el.hasAttribute('href')) {
        const label = clean(el.innerText || el.querySelector('img[alt]')?.getAttribute('alt'), 160)
        return label ? push(`[${label}](${link(el as HTMLAnchorElement)}) `) : undefined
      }
      const heading = /^H([1-6])$/.exec(tag)
      const block = BLOCK.has(tag)
      if (block) push('\n')
      if (heading) push(`${'#'.repeat(Number(heading[1]))} `)
      if (tag === 'LI') push('- ')
      const before = total
      for (const child of el.childNodes) walk(child)
      if (el.shadowRoot) for (const child of el.shadowRoot.childNodes) walk(child)
      // Layout tables are full of empty cells; only one that said something gets a divider.
      if ((tag === 'TD' || tag === 'TH') && total > before && el.nextElementSibling) push(' | ')
      if (block) push('\n')
    }
    walk(root)
    const text = out.join('').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    return total > kept ? `${text}\n[… ${total - kept} more characters: pass a selector to narrow, or a larger max]` : text
  }

  const describe = (el: Element): string => {
    const field = el as HTMLInputElement
    const tag = el.tagName.toLowerCase()
    const kind = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? `input[${field.type}]` : tag)
    const name = nameOf(el)
    refs.get(refOf(el))!.name = name
    let line = `${refOf(el)} ${kind} "${name}"`
    if (tag === 'a') {
      const href = link(el as HTMLAnchorElement)
      if (href !== refOf(el)) line += ` → ${href}`
    } else if (tag === 'select') {
      const select = el as HTMLSelectElement
      line += ` = "${clean(select.selectedOptions[0]?.label, 40)}" of: ${[...select.options].slice(0, 15).map((option) => clean(option.label, 30)).join(', ')}`
    } else if (tag === 'input' || tag === 'textarea') {
      if (field.type === 'checkbox' || field.type === 'radio') line += field.checked ? ' [checked]' : ''
      else if (field.type === 'password') line += field.value ? ' = (filled)' : ''
      else if (field.value && !/^(submit|button|reset)$/.test(field.type)) line += ` = "${clean(field.value, 60)}"`
    }
    if (field.disabled || el.getAttribute('aria-disabled') === 'true') line += ' [disabled]'
    return line
  }

  const readElements = (root: ParentNode, max: number, links: boolean): string => {
    const all = [...root.querySelectorAll(INTERACTIVE)].filter((el) => (links || el.tagName !== 'A') && visible(el))
    // When there is not room for everything, a form's controls matter more than one more link.
    const controls = all.filter((el) => el.tagName !== 'A')
    const keep = new Set(controls.slice(0, max))
    for (const el of all) if (keep.size < max) keep.add(el)
    const lines = all.filter((el) => keep.has(el)).map(describe)
    if (all.length > keep.size) lines.push(`[… ${all.length - keep.size} more: pass a selector to narrow]`)
    return lines.join('\n')
  }

  const find = (target: string): Element => {
    if (/^e\d+$/.test(target)) {
      const known = refs.get(target)
      const el = known?.el.deref()
      if (el?.isConnected) return el
      // Gone, but if exactly one element is now what that one was, it is the same control re-rendered.
      const heirs = known?.name
        ? [...document.querySelectorAll(INTERACTIVE)].filter((entry) => entry.tagName === known.tag && visible(entry) && nameOf(entry) === known.name)
        : []
      if (known && heirs.length === 1) {
        known.el = new WeakRef(heirs[0]!)
        ids.set(heirs[0]!, target)
        return heirs[0]!
      }
      throw new Error(`${target} is no longer on the page. Read the page again for current refs.`)
    }
    if (target.startsWith('text=')) {
      const want = target.slice(5).trim().toLowerCase()
      const pool = [...document.querySelectorAll(INTERACTIVE)].filter(visible)
      const named = pool.find((el) => nameOf(el).toLowerCase() === want) ?? pool.find((el) => nameOf(el).toLowerCase().includes(want))
      if (named) return named
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        if (parent && (node.nodeValue ?? '').toLowerCase().includes(want) && visible(parent)) return parent
      }
      throw new Error(`Nothing on the page says "${target.slice(5).trim()}".`)
    }
    let matches: Element[]
    try {
      matches = [...document.querySelectorAll(target)]
    } catch {
      throw new Error(`"${target}" is not a ref (e12), a text= target, or a valid CSS selector.`)
    }
    const el = matches.find(visible) ?? matches[0]
    if (!el) throw new Error(`No element matches ${target}.`)
    return el
  }

  scope.__rocket = {
    /** Pin a ref from an accessibility snapshot onto a live element (main process resolves the node). */
    pinRef(id: string, el: Element): boolean {
      if (!/^e\d+$/.test(id) || !el?.isConnected) return false
      const name = nameOf(el)
      ids.set(el, id)
      refs.set(id, { el: new WeakRef(el), tag: el.tagName, name })
      const n = Number(id.slice(1))
      if (n > seq) seq = n
      return true
    },
    digest(options: DigestOptions): string {
      const chosen = options.selector ? find(options.selector) : null
      // A page's main region, when it has a real one, is what is worth reading first.
      const main = document.querySelector('main,[role=main]') as HTMLElement | null
      const narrowed = !chosen && main && main.innerText.length > 600
      const root = chosen ?? (narrowed ? main : document.body)
      if (!root) return '(The page has no content yet.)'
      const parts: string[] = []
      if (options.focus !== 'elements') {
        parts.push(readText(root, options.max ?? (options.focus === 'text' ? 20_000 : 6_000)) || '(No readable text.)')
        if (narrowed) parts.push('(Text is the page\'s main region; selector "body" reads all of it.)')
      }
      if (options.focus !== 'text') {
        const everything = options.focus === 'elements'
        const elements = readElements(chosen ?? document, everything ? options.max ?? 150 : 40, everything)
        if (elements) parts.push(`${everything ? '## Elements' : '## Controls'}\n${elements}`)
      }
      return parts.join('\n\n')
    },
    /** Bring the element into view and say where its middle is, in viewport pixels. */
    locate(target: string): { x: number; y: number } {
      const el = find(target)
      scrollIfNeeded(el)
      const box = el.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) throw new Error(`${target} is on the page but not visible.`)
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    },
    has(target: string): boolean {
      try {
        return visible(find(target))
      } catch {
        return false
      }
    },
    /** Get a field ready for typing over what it holds. A select is set outright, and says so. */
    focus(target: string, value: string): 'typed' | 'set' {
      const el = find(target) as HTMLElement
      scrollIfNeeded(el)
      if (el instanceof HTMLSelectElement) {
        const want = value.trim().toLowerCase()
        const option = [...el.options].find((entry) => entry.value === value || entry.label.trim().toLowerCase() === want)
        if (!option) throw new Error(`${target} has no option "${value}". Options: ${[...el.options].map((entry) => entry.label.trim()).join(', ')}`)
        el.value = option.value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return 'set'
      }
      if (el instanceof HTMLInputElement && /^(checkbox|radio|file|submit|button)$/.test(el.type)) {
        throw new Error(`${target} is a ${el.type} input; click it instead of filling it.`)
      }
      el.focus()
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select()
      else if (el.isContentEditable) getSelection()?.selectAllChildren(el)
      else throw new Error(`${target} is not something that can be typed into.`)
      return 'typed'
    },
    /** Set-of-Marks: ref badge positions for compositing onto a screenshot (no live-page DOM). */
    somMarkers(max = 40): { markers: { ref: string; left: number; top: number }[]; viewportWidth: number } {
      const markers = [...document.querySelectorAll(INTERACTIVE)].filter(visible).slice(0, max).map((el) => {
        const box = el.getBoundingClientRect()
        return { ref: refOf(el), left: Math.max(0, box.left), top: Math.max(0, box.top) }
      })
      return { markers, viewportWidth: window.innerWidth }
    }
  }
}

/** The library as an expression a page can be asked to evaluate. */
export const PAGE_LIB = `(${pageLib.toString()})()`

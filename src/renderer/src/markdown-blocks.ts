// A reply that is still arriving is rendered as markdown again on every batch of text, and parsing
// costs time in proportion to its length: a long answer would spend more than a frame on each
// batch. This cuts the text into top-level blocks that can be parsed apart, so the blocks already
// complete are parsed once and only the last one is parsed again as it grows.
//
// The cut is conservative. It is made only at a blank line outside a code fence, and only where
// the next line starts a block of its own at the left margin: never before a list item or an
// indented line, which may continue the list or code above. Text with link or footnote
// definitions is left whole, because a definition changes how other blocks read. A settled reply
// is parsed whole, so whatever this gets wrong lasts only while the text streams.

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m

export function splitBlocks(text: string): string[] {
  if (DEFINITION.test(text)) return [text]
  const lines = text.split('\n')
  const blocks: string[] = []
  let start = 0
  /** The marker that opened the code fence we are inside, if any. */
  let fence: string | null = null
  let afterBlank = false
  for (const [index, line] of lines.entries()) {
    if (!fence && afterBlank && /^\S/.test(line) && !LIST_ITEM.test(line)) {
      const block = lines.slice(start, index).join('\n')
      if (block.trim()) blocks.push(block)
      start = index
    }
    const marker = FENCE.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]!
      // A fence closes on a bare run of the same character, at least as long as the opening one.
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null
    }
    afterBlank = line.trim() === ''
  }
  blocks.push(lines.slice(start).join('\n'))
  return blocks
}

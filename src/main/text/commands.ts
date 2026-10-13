const PRESS_ENTER = /([.!?;,])?\s*\bpress enter\b\s*[.!?,;:-]*\s*$/i

export interface TrailingCommand {
  text: string
  pressEnter: boolean
}

/** "…send it over press enter" inserts the text and then presses Enter. */
export function extractTrailingCommand(text: string): TrailingCommand {
  const match = PRESS_ENTER.exec(text)
  if (!match) return { text, pressEnter: false }
  const kept = text.slice(0, match.index) + (match[1] && match[1] !== ',' && match[1] !== ';' ? match[1] : '')
  return { text: kept.trim(), pressEnter: true }
}

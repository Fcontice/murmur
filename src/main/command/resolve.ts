import { DEFAULT_SETTINGS, validateSearchUrl } from '@shared/settings'
import type { InstalledApp, Site } from '@shared/types'

export type OpenTarget =
  | { kind: 'url'; url: string; label: string }
  | { kind: 'app'; app: InstalledApp }
  | { kind: 'search'; query: string }

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})(?:\/\S*)?$/i
/** File names look like domains ("next.js", "notes.py"), so only well-known endings count as sites. */
const TLDS = new Set(
  ('com net org io dev app ai co me edu gov info biz tv xyz gg so to us uk ca de fr es it nl se no fi dk pl ch at be ie au nz ' +
    'in jp kr cn br mx eu ly sh fm tech site online store blog news').split(' '),
)
/** "website" is not here: the doc rule decides whether it names a "… website" entry. */
const NOISE_WORDS = new Set(['my', 'the', 'app', 'application', 'program', 'site'])
/** Small words that appear inside many names; alone they name nothing. */
const STOPWORDS = new Set(['on', 'to', 'for', 'of', 'in', 'at', 'by', 'with', 'and', 'or', 'a', 'an', 'is', 'it'])
const UNINSTALLER = /\buninstall(?:er)?\b/i
/** Shortcuts that run a setup script, not the app. */
const INSTALLER = /^install\b/i
/** Help and doc entries sit next to the real app; pick one only when it was asked for by name. */
const DOC_ENTRY = /\b(documentation|docs?|manuals?|faqs?|readme|release notes|revision history|website|on the web|example scripts|help)\b/i
/** Spoken shorthand that shares no letters in order with the app's name, or names a different app first. */
const ALIASES: Record<string, string> = { cmd: 'Command Prompt', 'to do': 'Microsoft To Do' }
/** A wrong app match launches the wrong program, so a lone short word must name a whole word. */
const MIN_LONE_PREFIX = 3
/** "vs" or "vsc" read as initials; longer runs of letters are real words. */
const MAX_ACRONYM = 4

/** Unicode-aware, so "Café" keeps its "é" and typed and spoken forms of it compare equal. */
const words = (text: string) => text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const meaningful = (text: string) => words(text).filter((word) => !NOISE_WORDS.has(word))
const containsRun = (haystack: string[], needle: string[]) => ` ${haystack.join(' ')} `.includes(` ${needle.join(' ')} `)
/** "faq" asks for "FAQs" and "doc" for "Docs"; only the doc-entry check uses this. */
const singular = (list: string[]) => list.map((word) => word.replace(/s$/, ''))

/** "github dot com" becomes an https URL; a spoken http(s) URL keeps its scheme; anything else is null. */
export function asDomainUrl(spoken: string): string | null {
  const text = spoken
    .trim()
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s+slash(?:\s+|$)/gi, '/')
    .replace(/\s+/g, '')
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      // The prefix test already implies this; keep it explicit since the result gets launched.
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
      // "user@host" hides the real host from a quick read.
      if (url.username || url.password) return null
      return url.toString().replace(/\/$/, '')
    } catch {
      return null
    }
  }
  const match = DOMAIN.exec(text)
  if (!match || !TLDS.has(match[1]!.toLowerCase())) return null
  const slash = text.indexOf('/')
  const host = slash === -1 ? text : text.slice(0, slash)
  if (host.length < 4) return null
  // Hosts are case-insensitive; paths are not.
  return `https://${host.toLowerCase()}${slash === -1 ? '' : text.slice(slash)}`
}

type Quality = 'full' | 'prefix'

/**
 * How the spoken words match the app's words in order: every word whole ('full'), some only as a
 * prefix or as initials ('prefix'), or not at all. `lone` marks a one-word target, which needs a
 * longer prefix or longer initials to count.
 */
function matchWords(spoken: string[], name: string[], allowSkips: boolean, lone: boolean): Quality | null {
  if (spoken.length === 0) return 'full'
  if (name.length === 0) return null
  const [first, ...rest] = spoken as [string, ...string[]]
  const head = name[0]!
  const found: Array<Quality | null> = []
  if (head === first) found.push(matchWords(rest, name.slice(1), allowSkips, false))
  else if (head.startsWith(first) && (!lone || first.length >= MIN_LONE_PREFIX)) {
    found.push(matchWords(rest, name.slice(1), allowSkips, false) && 'prefix')
  }
  // "vs" for "visual studio"; alone, two letters are too likely to be an unrelated word.
  const acronymOk = first.length >= (lone ? 3 : 2) && first.length <= Math.min(MAX_ACRONYM, name.length)
  if (acronymOk && [...first].every((letter, index) => name[index]![0] === letter)) {
    found.push(matchWords(rest, name.slice(first.length), allowSkips, false) && 'prefix')
  }
  if (allowSkips) found.push(matchWords(spoken, name.slice(1), true, lone))
  return found.includes('full') ? 'full' : found.includes('prefix') ? 'prefix' : null
}

/** Higher is better; 0 means the app is not a candidate. */
function score(target: string[], name: string[]): number {
  if (name.join(' ') === target.join(' ')) return 100
  const lone = target.length === 1
  const inOrder = matchWords(target, name, false, lone)
  if (inOrder) return inOrder === 'full' ? 90 : 80
  if (lone) {
    // Alone, a word may skip ahead only to the name's last word, whole: "teams", not "for" or "start".
    return target[0]!.length >= MIN_LONE_PREFIX && name.length > 1 && name.at(-1) === target[0] ? 60 : 0
  }
  const skipping = matchWords(target, name, true, false)
  return skipping === 'full' ? 60 : skipping === 'prefix' ? 50 : 0
}

/** Best installed app for what was said, or null. Uninstallers are never candidates. */
export function findApp(spoken: string, apps: InstalledApp[]): InstalledApp | null {
  const target = meaningful(spoken)
  if (target.length === 0 || target.some((word) => UNINSTALLER.test(word))) return null
  if (target.length === 1 && (STOPWORDS.has(target[0]!) || /^\d+$/.test(target[0]!))) return null
  const alias = ALIASES[target.join(' ')]
  const aliased = alias && apps.find((app) => app.name === alias)
  if (aliased) return aliased

  let best: { app: InstalledApp; score: number } | null = null
  for (const app of apps) {
    if (UNINSTALLER.test(app.name) || INSTALLER.test(app.name)) continue
    const name = words(app.name)
    const doc = DOC_ENTRY.exec(app.name)
    // "python docs" may open the docs; "docs" alone names no particular app.
    if (doc) {
      const docWords = words(doc[1]!)
      if (!containsRun(singular(target), singular(docWords)) || target.length <= docWords.length) continue
    }
    const points = score(target, name)
    if (points === 0) continue
    // Among equal matches, the shorter name is the more specific one; then alphabetical, so the
    // order the helper lists apps in never decides.
    const better =
      !best ||
      points > best.score ||
      (points === best.score &&
        (app.name.length < best.app.name.length || (app.name.length === best.app.name.length && app.name < best.app.name)))
    if (better) best = { app, score: points }
  }
  return best?.app ?? null
}

/** Two site names with the same key would shadow each other in `resolveOpenTarget`; '' names nothing. */
export function siteKey(name: string): string {
  return meaningful(name).join(' ')
}

/** Sites the user named win, then installed apps, then anything shaped like a domain; otherwise search. */
export function resolveOpenTarget(spoken: string, sites: Site[], apps: InstalledApp[]): OpenTarget {
  const target = siteKey(spoken)
  // A site named only with filler ("My") must not match a spoken filler word.
  const site = target ? sites.find((entry) => siteKey(entry.name) === target) : undefined
  if (site) return { kind: 'url', url: site.url, label: site.name }
  const app = findApp(spoken, apps)
  if (app) return { kind: 'app', app }
  const url = asDomainUrl(spoken)
  if (url) return { kind: 'url', url, label: url.replace(/^https?:\/\//, '') }
  return { kind: 'search', query: spoken.trim() }
}

/** Fills the user's search template, falling back to the default when it cannot be used. */
export function buildSearchUrl(template: string, query: string): string {
  const usable = validateSearchUrl(template) === null ? template : DEFAULT_SETTINGS.searchUrl
  return usable.replaceAll('{query}', encodeURIComponent(query.trim()))
}

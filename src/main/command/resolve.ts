import { DEFAULT_SETTINGS, validateSearchUrl } from '@shared/settings'
import type { InstalledApp, Site } from '@shared/types'

export type OpenTarget =
  | { kind: 'url'; url: string; label: string }
  | { kind: 'app'; app: InstalledApp }
  | { kind: 'search'; query: string }

const DOMAIN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/\S*)?$/i
/** File names look like domains; these are never sites people mean to open. */
const FILE_SUFFIX = /\.(txt|docx?|xlsx?|pptx?|pdf|png|jpe?g|gif|exe|zip|md|json|csv)$/i
const NOISE_WORDS = new Set(['my', 'the', 'app', 'application', 'program', 'website', 'site'])
const UNINSTALLER = /^uninstall\b/i
/** A wrong app match launches the wrong program, so a lone short word must name a whole word. */
const MIN_LONE_PREFIX = 3
/** "vs" or "vsc" read as initials; longer runs of letters are real words. */
const MAX_ACRONYM = 4

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
const meaningful = (text: string) => words(text).filter((word) => !NOISE_WORDS.has(word))

/** "github dot com" and "https://github.com" both become an https URL; anything else is null. */
export function asDomainUrl(spoken: string): string | null {
  const text = spoken.trim().replace(/\s+dot\s+/gi, '.').replace(/\s+/g, '')
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      // The prefix test already implies this; keep it explicit since the result gets launched.
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
      return url.toString().replace(/\/$/, '')
    } catch {
      return null
    }
  }
  if (!DOMAIN.test(text) || FILE_SUFFIX.test(text)) return null
  const slash = text.indexOf('/')
  const host = slash === -1 ? text : text.slice(0, slash)
  if (host.length < 4) return null
  // Hosts are case-insensitive; paths are not.
  return `https://${host.toLowerCase()}${slash === -1 ? '' : text.slice(slash)}`
}

/**
 * True when every spoken word matches the app's words in order, as a prefix or as initials.
 * `lone` marks a one-word target, which needs a longer prefix or longer initials to count.
 */
function matches(spoken: string[], name: string[], allowSkips: boolean, lone: boolean): boolean {
  if (spoken.length === 0) return true
  if (name.length === 0) return false
  const [first, ...rest] = spoken as [string, ...string[]]
  const head = name[0]!
  const prefixOk = head === first || (head.startsWith(first) && (!lone || first.length >= MIN_LONE_PREFIX))
  if (prefixOk && matches(rest, name.slice(1), false, false)) return true
  // "vs" for "visual studio"; alone, two letters are too likely to be an unrelated word.
  const acronymOk = first.length >= (lone ? 3 : 2) && first.length <= Math.min(MAX_ACRONYM, name.length)
  if (acronymOk && [...first].every((letter, index) => name[index]![0] === letter) && matches(rest, name.slice(first.length), false, false)) return true
  return allowSkips && matches(spoken, name.slice(1), true, lone)
}

/** Best installed app for what was said, or null. Uninstallers are never candidates. */
export function findApp(spoken: string, apps: InstalledApp[]): InstalledApp | null {
  const target = meaningful(spoken)
  if (target.length === 0 || target[0] === 'uninstall') return null
  const lone = target.length === 1
  let best: { app: InstalledApp; score: number } | null = null
  for (const app of apps) {
    if (UNINSTALLER.test(app.name)) continue
    const name = words(app.name)
    let score = 0
    if (name.join(' ') === target.join(' ')) score = 100
    else if (matches(target, name, false, lone)) score = 80
    else if (matches(target, name, true, lone)) score = 60
    if (score === 0) continue
    // Among equal matches, the shorter name is the more specific one.
    if (!best || score > best.score || (score === best.score && app.name.length < best.app.name.length)) best = { app, score }
  }
  return best?.app ?? null
}

/** Sites the user named win, then installed apps, then anything shaped like a domain; otherwise search. */
export function resolveOpenTarget(spoken: string, sites: Site[], apps: InstalledApp[]): OpenTarget {
  const target = meaningful(spoken).join(' ')
  // A site named only with filler ("My") must not match a spoken filler word.
  const site = target ? sites.find((entry) => meaningful(entry.name).join(' ') === target) : undefined
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

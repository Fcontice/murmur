import { describe, expect, it } from 'vitest'
import type { InstalledApp, SavedCommand, Site } from '@shared/types'
import { asDomainUrl, buildSearchUrl, findApp, resolveOpenTarget } from '../src/main/command/resolve'
import { reservedNameProblem, routeCommand } from '../src/main/command/router'

const saved = (name: string, prompt = `Do ${name}.`): SavedCommand => ({ id: name, name, prompt, createdAt: 0, uses: 0 })
const commands = [saved('Spanish', 'Translate this into Spanish.'), saved('Bulletize'), saved('Make it formal')]

describe('routeCommand', () => {
  it.each([
    ['open spotify', 'spotify'],
    ['Open Spotify.', 'Spotify'],
    ['um, open spotify', 'spotify'],
    ['Okay, launch Visual Studio Code.', 'Visual Studio Code'],
    ['go to github.com', 'github.com'],
    ['Go to GitHub dot com.', 'GitHub dot com'],
    ['pull up my gmail', 'my gmail'],
    ['can you open the calculator please', 'calculator'],
    ['open up teams', 'teams'],
    ['Open. Spotify.', 'Spotify'],
    ['open “Spotify”', 'Spotify'],
    ['go to make.com', 'make.com'],
    ['go to about.me', 'about.me'],
    ['pull up Barnes and Noble', 'Barnes and Noble'],
    ['open command and conquer', 'command and conquer'],
  ])('%s opens %s', (spoken, target) => {
    expect(routeCommand(spoken, commands)).toEqual({ kind: 'open', target })
  })

  it.each([
    ['search for standing desks', 'standing desks'],
    ['Search the web for best standing desks.', 'best standing desks'],
    ['look up electron 44 release notes', 'electron 44 release notes'],
    ['Google how tall is the Eiffel Tower?', 'how tall is the Eiffel Tower'],
    ['search google for cheap flights', 'cheap flights'],
    ['search for "standing desks"', 'standing desks'],
    ['google docs', 'google docs'],
    ['Google, docs.', 'Google docs'],
    ["look up the Beatles'", "the Beatles'"],
  ])('%s searches for %s', (spoken, query) => {
    expect(routeCommand(spoken, commands)).toEqual({ kind: 'search', query })
  })

  it('runs a saved command and keeps extra words', () => {
    expect(routeCommand('Spanish', commands)).toEqual({ kind: 'saved', command: commands[0], extra: '' })
    expect(routeCommand('spanish this please.', commands)).toEqual({ kind: 'saved', command: commands[0], extra: '' })
    expect(routeCommand('Bulletize, keep it to three points', commands)).toEqual({ kind: 'saved', command: commands[1], extra: 'keep it to three points' })
    expect(routeCommand("Bulletize, call it 'Q3'", commands)).toEqual({ kind: 'saved', command: commands[1], extra: "call it 'Q3'" })
    expect(routeCommand('make it formal', commands)).toEqual({ kind: 'saved', command: commands[2], extra: '' })
  })

  it('drops politeness after a saved name', () => {
    const summarize = [saved('Summarize')]
    expect(routeCommand('Summarize this, please.', summarize)).toMatchObject({ kind: 'saved', extra: '' })
    expect(routeCommand('Summarize, thanks', summarize)).toMatchObject({ kind: 'saved', extra: '' })
  })

  it('normalizes saved names like the transcript', () => {
    expect(routeCommand('So formal', [saved('So formal')])).toMatchObject({ kind: 'saved', command: { name: 'So formal' } })
    expect(routeCommand('Shorter', [saved('Shorter.')])).toMatchObject({ kind: 'saved', command: { name: 'Shorter.' } })
  })

  it('matches saved names across Unicode normalization forms', () => {
    const cafe = [saved('Café')]
    expect(routeCommand('Café this', cafe)).toEqual({ kind: 'saved', command: cafe[0], extra: '' })
  })

  it('runs a saved command named like an app, but "open" still opens', () => {
    const spotify = [saved('Spotify')]
    expect(routeCommand('spotify', spotify)).toMatchObject({ kind: 'saved', command: { name: 'Spotify' } })
    expect(routeCommand('open spotify', spotify)).toEqual({ kind: 'open', target: 'spotify' })
  })

  it.each(['', 'ok', 'um', '.'])('%j is empty', (spoken) => {
    expect(routeCommand(spoken, commands)).toEqual({ kind: 'empty' })
  })

  it('prefers the longest saved name', () => {
    const overlapping = [saved('Make it'), saved('Make it formal')]
    expect(routeCommand('make it formal', overlapping)).toMatchObject({ kind: 'saved', command: { name: 'Make it formal' } })
  })

  it.each([
    'make this more professional',
    'Open-minded people make better teammates, write that as a tweet',
    'open with a joke about Mondays',
    'open the email by thanking them for their time and then ask about the budget',
    'search engines are changing, write a paragraph about it',
    'start with a greeting',
    'write a note to Sam',
    'Spanishy words are fun',
    'open',
    'search for',
    'open the',
    'go to the',
    'Open the.',
    'open a',
    'open my',
    'Open it.',
    'open this',
    'Go to the next paragraph and make it formal',
    'open up a new paragraph about dogs',
    'Open the door and walk in, write that',
    'open spotify and then search for cats',
    'open Microsoft Teams, now',
    'Open that up.',
    'Look up this',
    'Search for that.',
    'google this please',
    'Google it.',
  ])('%s is a writing command', (spoken) => {
    expect(routeCommand(spoken, commands).kind).toBe('write')
  })

  it('keeps a long instruction intact', () => {
    const long = `rewrite this so that ${'every word counts '.repeat(170)}in the end`
    expect(long.length).toBeGreaterThan(3000)
    expect(routeCommand(long, commands)).toEqual({ kind: 'write', instruction: long })
  })

  it('passes the cleaned instruction through for writing', () => {
    expect(routeCommand('  make this shorter  ', commands)).toEqual({ kind: 'write', instruction: 'make this shorter' })
  })
})

describe('reservedNameProblem', () => {
  it('rejects names that start like an action', () => {
    expect(reservedNameProblem('Open sesame')).toMatch(/open/i)
    expect(reservedNameProblem('look up thing')).toMatch(/look up/i)
    expect(reservedNameProblem('Google')).toMatch(/google/i)
    expect(reservedNameProblem('Spanish')).toBeNull()
    expect(reservedNameProblem('Opener')).toBeNull()
    expect(reservedNameProblem('open,x')).toMatch(/open/i)
    expect(reservedNameProblem('open. x')).toMatch(/open/i)
    expect(reservedNameProblem('Open.ai summary')).toBeNull()
  })

  it('rejects names with no real word in them', () => {
    for (const name of ['ok', 'please', '   ']) expect(reservedNameProblem(name)).toMatch(/real word/)
  })
})

const app = (name: string, id = `${name}.id`): InstalledApp => ({ name, id })
const APPS = [
  app('Spotify'), app('Microsoft Teams'), app('Visual Studio Code'), app('Character Map'), app('Calculator'),
  app('Notepad'), app('Opera GX Browser'), app('Uninstall Node.js'), app('Node.js'), app('Warp'),
]
const site = (name: string, url: string): Site => ({ id: name, name, url, createdAt: 0 })

describe('asDomainUrl', () => {
  it.each([
    ['github.com', 'https://github.com'],
    ['GitHub dot com', 'https://github.com'],
    ['news.ycombinator.com', 'https://news.ycombinator.com'],
    ['https://example.com/a', 'https://example.com/a'],
    ['example dot co dot uk', 'https://example.co.uk'],
    ['open.ai', 'https://open.ai'],
    ['HTTPS://GitHub.com', 'https://github.com'],
    ['GitHub.com/Anthropics', 'https://github.com/Anthropics'],
  ])('%s → %s', (spoken, url) => expect(asDomainUrl(spoken)).toBe(url))

  it.each([
    'spotify', 'my gmail', 'file.txt', 'javascript:alert(1)', 'a.b', 'localhost', '192.168.1.1',
    'JAVASCRIPT:alert(1)', 'JavaScript:alert(document.domain)', 'file:///c:/windows', 'FILE:///C:/x', 'https://',
  ])('%s is not a domain', (spoken) => {
    expect(asDomainUrl(spoken)).toBeNull()
  })

  it('only ever returns http(s) URLs', () => {
    expect(asDomainUrl('https://evil.com@good.com')).toMatch(/^https:\/\//)
    expect(asDomainUrl('https://javascript:alert(1)')).toBeNull()
  })
})

describe('findApp', () => {
  it.each([
    ['spotify', 'Spotify'],
    ['Spotify app', 'Spotify'],
    ['Spotify.', 'Spotify'],
    ['teams', 'Microsoft Teams'],
    ['VS Code', 'Visual Studio Code'],
    ['visual studio code', 'Visual Studio Code'],
    ['character map', 'Character Map'],
    ['calc', 'Calculator'],
    ['opera', 'Opera GX Browser'],
    ['node', 'Node.js'],
    ['warp', 'Warp'],
    ['vsc', 'Visual Studio Code'],
  ])('%s finds %s', (spoken, name) => expect(findApp(spoken, APPS)?.name).toBe(name))

  it('never picks an uninstaller', () => {
    expect(findApp('uninstall node', APPS)).toBeNull()
    expect(findApp('uninstall', APPS)).toBeNull()
  })

  it.each(['photoshop', 'my gmail', '', 'no', 'ma', 'vs', 'the app'])('%s finds nothing', (spoken) => expect(findApp(spoken, APPS)).toBeNull())

  it('does not read a random two-letter word as an acronym', () => {
    const apps = [...APPS, app('Microsoft Access')]
    expect(findApp('ma', apps)).toBeNull()
    expect(findApp('microsoft access', apps)?.name).toBe('Microsoft Access')
  })

  it('does not stretch acronyms past four letters', () => {
    const apps = [app('Alpha Beta Gamma Delta Epsilon')]
    expect(findApp('abcd', [app('Alpha Bravo Charlie Delta')])?.name).toBe('Alpha Bravo Charlie Delta')
    expect(findApp('abgde', apps)).toBeNull()
  })
})

describe('resolveOpenTarget', () => {
  const sites = [site('Gmail', 'https://mail.google.com'), site('Spotify', 'https://open.spotify.com')]

  it('checks sites first, then apps, then domains, then searches', () => {
    expect(resolveOpenTarget('my gmail', sites, APPS)).toEqual({ kind: 'url', url: 'https://mail.google.com', label: 'Gmail' })
    expect(resolveOpenTarget('Spotify', sites, APPS)).toEqual({ kind: 'url', url: 'https://open.spotify.com', label: 'Spotify' })
    expect(resolveOpenTarget('teams', sites, APPS)).toEqual({ kind: 'app', app: APPS[1] })
    expect(resolveOpenTarget('github dot com', sites, APPS)).toEqual({ kind: 'url', url: 'https://github.com', label: 'github.com' })
    expect(resolveOpenTarget('photoshop', sites, APPS)).toEqual({ kind: 'search', query: 'photoshop' })
  })

  it('never matches a site whose name is only filler', () => {
    expect(resolveOpenTarget('the', [site('My', 'https://example.com')], APPS)).toEqual({ kind: 'search', query: 'the' })
  })
})

describe('buildSearchUrl', () => {
  it('encodes the query into the template', () => {
    expect(buildSearchUrl('https://www.google.com/search?q={query}', 'C# & .NET 10?')).toBe('https://www.google.com/search?q=C%23%20%26%20.NET%2010%3F')
  })
  it('fills every {query} in the template', () => {
    expect(buildSearchUrl('https://example.com/?q={query}&again={query}', 'a b')).toBe('https://example.com/?q=a%20b&again=a%20b')
  })
  it('falls back to Google for an unusable template', () => {
    expect(buildSearchUrl('file:///c:/{query}', 'x')).toBe('https://www.google.com/search?q=x')
  })
})

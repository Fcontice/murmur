import { describe, expect, it } from 'vitest'
import type { SavedCommand } from '@shared/types'
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
  ])('%s opens %s', (spoken, target) => {
    expect(routeCommand(spoken, commands)).toEqual({ kind: 'open', target })
  })

  it.each([
    ['search for standing desks', 'standing desks'],
    ['Search the web for best standing desks.', 'best standing desks'],
    ['look up electron 44 release notes', 'electron 44 release notes'],
    ['Google how tall is the Eiffel Tower?', 'how tall is the Eiffel Tower'],
    ['search google for cheap flights', 'cheap flights'],
  ])('%s searches for %s', (spoken, query) => {
    expect(routeCommand(spoken, commands)).toEqual({ kind: 'search', query })
  })

  it('runs a saved command and keeps extra words', () => {
    expect(routeCommand('Spanish', commands)).toEqual({ kind: 'saved', command: commands[0], extra: '' })
    expect(routeCommand('spanish this please.', commands)).toEqual({ kind: 'saved', command: commands[0], extra: '' })
    expect(routeCommand('Bulletize, keep it to three points', commands)).toEqual({ kind: 'saved', command: commands[1], extra: 'keep it to three points' })
    expect(routeCommand('make it formal', commands)).toEqual({ kind: 'saved', command: commands[2], extra: '' })
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
  ])('%s is a writing command', (spoken) => {
    expect(routeCommand(spoken, commands).kind).toBe('write')
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
  })
})

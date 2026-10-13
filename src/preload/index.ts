import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HubApi, PillApi, Unsubscribe } from '@shared/api'

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>

const hub: HubApi = {
  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),
  onSettings: (listener) => subscribe('settings:changed', listener),

  getStatus: () => invoke('status:get'),
  onStatus: (listener) => subscribe('status:changed', listener),

  listModels: () => invoke('models:list'),
  downloadModel: (id) => invoke('models:download', id),
  cancelModel: (id) => invoke('models:cancel', id),
  removeModel: (id) => invoke('models:remove', id),
  onModels: (listener) => subscribe('models:changed', listener),
  testLlm: () => invoke('llm:test'),

  listHistory: (query, limit, offset) => invoke('history:list', query, limit, offset),
  deleteHistory: (id) => invoke('history:delete', id),
  clearHistory: () => invoke('history:clear'),
  onHistory: (listener) => subscribe('history:added', listener),
  getStats: () => invoke('stats:get'),

  listDictionary: () => invoke('dictionary:list'),
  saveDictionaryEntry: (entry) => invoke('dictionary:save', entry),
  deleteDictionaryEntry: (id) => invoke('dictionary:delete', id),

  listSnippets: () => invoke('snippets:list'),
  saveSnippet: (snippet) => invoke('snippets:save', snippet),
  deleteSnippet: (id) => invoke('snippets:delete', id),

  recordShortcut: () => invoke('shortcut:record'),
  stopRecordingShortcut: () => invoke('shortcut:stop'),
  resetShortcut: (action) => invoke('shortcut:reset', action),

  copyText: (text) => invoke('app:copy', text),
  openDataFolder: () => invoke('app:openData'),
  getAppInfo: () => invoke('app:info'),
}

const pill: PillApi = {
  onState: (listener) => subscribe('pill:state', listener),
  onConfig: (listener) => subscribe('pill:config', listener),
  onCaptureStart: (listener) => subscribe('capture:start', listener),
  onCaptureStop: (listener) => subscribe('capture:stop', listener),
  onSound: (listener) => subscribe('pill:sound', listener),
  ready: () => ipcRenderer.send('pill:ready'),
  captureStarted: (sessionId) => ipcRenderer.send('capture:started', sessionId),
  captureChunk: (sessionId, pcm) => ipcRenderer.send('capture:chunk', sessionId, pcm),
  captureStopped: (sessionId) => ipcRenderer.send('capture:stopped', sessionId),
  captureFailed: (sessionId, message) => ipcRenderer.send('capture:failed', sessionId, message),
  action: (action) => ipcRenderer.send('pill:action', action),
  setInteractive: (interactive) => ipcRenderer.send('pill:interactive', interactive),
}

// Each window only receives the surface it needs.
const page = (globalThis as unknown as { location: { pathname: string } }).location.pathname
if (page.endsWith('pill.html')) contextBridge.exposeInMainWorld('murmurPill', pill)
else contextBridge.exposeInMainWorld('murmur', hub)

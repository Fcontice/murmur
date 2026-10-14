import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { InstalledApp, ShortcutAction } from '@shared/types'
import { logger } from './log'
import { resourcePath } from './paths'

const log = logger('helper')
const REQUEST_TIMEOUT_MS = 3000
const RESTART_BACKOFF_MS = [0, 1000, 2000, 4000, 8000, 16000]

export interface HelperContext {
  app: { name?: string; process?: string; title?: string; path?: string }
  text: { available: boolean; before?: string; after?: string; selected?: string; contents?: string; isPassword?: boolean; editable?: boolean }
}

export interface PasteResult {
  ok: boolean
  error?: string
  elapsedMs?: number
}

export interface PasteOptions {
  method: 'clipboard' | 'type'
  restoreClipboard: boolean
  restoreDelayMs: number
  pressEnter: boolean
  /** Refuse to paste unless the foreground process name contains this. */
  expectProcess?: string
}

interface HelperEvents {
  shortcut: [ShortcutAction, 'down' | 'up']
  otherKey: []
  recorded: [number[]]
  status: ['starting' | 'ready' | 'failed']
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Owns the native helper process: restarts it when it dies and re-applies shortcut state afterwards. */
export class Helper extends EventEmitter<HelperEvents> {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private restarts = 0
  private stopping = false
  private bindings: Array<{ id: ShortcutAction; keys: number[]; whileCapturing: boolean }> = []
  status: 'starting' | 'ready' | 'failed' = 'starting'

  start(): void {
    const exe = resourcePath('helper', 'murmur-helper.exe')
    if (!existsSync(exe)) {
      log.error(`Helper not found at ${exe}. Run "npm run helper:build".`)
      this.setStatus('failed')
      return
    }

    this.setStatus('starting')
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child

    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
    child.stderr.on('data', (chunk: Buffer) => log.warn(`stderr: ${chunk.toString().trim()}`))
    child.on('error', (error) => log.error('Helper failed to start', error))
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      for (const [, request] of this.pending) {
        clearTimeout(request.timer)
        request.reject(new Error('Helper exited'))
      }
      this.pending.clear()
      if (this.stopping) return
      const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]!
      this.restarts++
      log.warn(`Helper exited with code ${code}; restarting in ${delay} ms`)
      this.setStatus(this.restarts >= RESTART_BACKOFF_MS.length ? 'failed' : 'starting')
      setTimeout(() => !this.stopping && this.start(), delay)
    })
  }

  stop(): void {
    this.stopping = true
    this.child?.stdin.write('{"type":"quit"}\n')
    const child = this.child
    setTimeout(() => child?.kill(), 500).unref()
  }

  private setStatus(status: 'starting' | 'ready' | 'failed'): void {
    this.status = status
    this.emit('status', status)
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      request.resolve(message)
      return
    }

    switch (message.event) {
      case 'ready':
        this.restarts = 0
        this.setStatus('ready')
        void this.pushBindings()
        break
      case 'shortcut':
        this.emit('shortcut', message.id as unknown as ShortcutAction, message.phase as 'down' | 'up')
        break
      case 'otherKey':
        this.emit('otherKey')
        break
      case 'recorded':
        this.emit('recorded', (message.keys as number[]) ?? [])
        break
      case 'log':
        log.info(`[${String(message.level)}] ${String(message.message)}`)
        break
    }
  }

  private request(type: string, fields: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const child = this.child
    if (!child || this.status !== 'ready') return Promise.reject(new Error('Helper is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Helper request "${type}" timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`)
    })
  }

  private async pushBindings(): Promise<void> {
    await this.request('setShortcuts', { bindings: this.bindings }).catch((error) => log.warn('setShortcuts failed', error))
  }

  setShortcuts(shortcuts: Record<ShortcutAction, number[]>): void {
    this.bindings = (Object.entries(shortcuts) as Array<[ShortcutAction, number[]]>)
      .filter(([, keys]) => keys.length > 0)
      .map(([id, keys]) => ({ id, keys, whileCapturing: id === 'cancel' }))
    if (this.status === 'ready') void this.pushBindings()
  }

  setCapturing(active: boolean): void {
    void this.request('setCapturing', { active }).catch(() => undefined)
  }

  recordShortcut(active: boolean): void {
    void this.request('recordShortcut', { active }).catch(() => undefined)
  }

  async getContext(maxChars: number): Promise<HelperContext | null> {
    try {
      const reply = await this.request('getContext', { maxChars }, 1200)
      return reply.ok ? (reply as unknown as HelperContext) : null
    } catch {
      return null
    }
  }

  async copySelection(): Promise<string> {
    try {
      const reply = await this.request('copySelection', {}, 3000)
      return typeof reply.text === 'string' ? reply.text : ''
    } catch {
      return ''
    }
  }

  /** Installed apps from the Start menu, or null when the helper cannot list them. */
  async listApps(): Promise<InstalledApp[] | null> {
    try {
      const reply = await this.request('listApps', {}, 9000)
      if (!reply.ok || !Array.isArray(reply.apps)) return null
      return (reply.apps as unknown[]).flatMap((entry) => {
        const { name, id } = (entry ?? {}) as Record<string, unknown>
        return typeof name === 'string' && name && typeof id === 'string' && id ? [{ name, id }] : []
      })
    } catch {
      return null
    }
  }

  async launchApp(id: string): Promise<boolean> {
    try {
      // The field is appId because id is the request id on the wire.
      return (await this.request('launchApp', { appId: id }, 9000)).ok === true
    } catch {
      return false
    }
  }

  /** Visible text of the foreground window. Empty when it cannot be read in time; source then names the error. */
  async getWindowText(maxChars: number): Promise<{ text: string; elapsedMs: number; source: string }> {
    try {
      const reply = await this.request('getWindowText', { maxChars }, 2500)
      return {
        text: reply.ok && typeof reply.text === 'string' ? reply.text : '',
        elapsedMs: Number(reply.elapsedMs ?? 0),
        source: String(reply.source ?? reply.error ?? ''),
      }
    } catch {
      return { text: '', elapsedMs: 0, source: 'unavailable' }
    }
  }

  async paste(text: string, options: PasteOptions): Promise<PasteResult> {
    try {
      // Typing long text and waiting out held modifiers both take a while.
      const timeout = 6000 + options.restoreDelayMs + (options.method === 'type' ? text.length * 2 : 0)
      return (await this.request('paste', { text, ...options }, timeout)) as unknown as PasteResult
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'helper_unavailable' }
    }
  }
}

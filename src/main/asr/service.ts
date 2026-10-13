import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { EngineStatus, Settings } from '@shared/types'
import { logger } from '../log'
import type { ModelManager } from '../models'
import { encodeWav } from './audio'
import type { WorkerRequest, WorkerResponse } from './worker'

const log = logger('asr')
const TRANSCRIBE_TIMEOUT_MS = 120_000

type AsrState = EngineStatus['asr']

interface Pending {
  resolve: (text: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class AsrService extends EventEmitter<{ status: [AsrState, string] }> {
  state: AsrState = 'unavailable'
  detail = ''
  private worker: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private loadedKey = ''
  private settings: Settings | null = null

  constructor(private readonly models: ModelManager) {
    super()
  }

  private setState(state: AsrState, detail = ''): void {
    this.state = state
    this.detail = detail
    this.emit('status', state, detail)
  }

  /** Brings the engine in line with the settings. Safe to call whenever settings or installed models change. */
  configure(settings: Settings): void {
    this.settings = settings
    if (settings.asrProvider === 'remote') {
      this.stopWorker()
      this.loadedKey = ''
      const ready = Boolean(settings.asrRemote.baseUrl && settings.asrRemote.model)
      this.setState(ready ? 'ready' : 'unavailable', ready ? `Remote: ${settings.asrRemote.model}` : 'Set the transcription endpoint and model.')
      return
    }

    const model = this.models.definition(settings.asrModel)
    if (!model || model.kind !== 'asr' || !model.asrType) {
      this.stopWorker()
      this.setState('unavailable', 'Choose a speech model.')
      return
    }
    if (!this.models.isInstalled(model.id)) {
      this.stopWorker()
      this.loadedKey = ''
      this.setState('unavailable', `${model.name} is not downloaded yet.`)
      return
    }

    const key = `${model.id}|${model.asrType === 'whisper' ? settings.language : ''}`
    if (key === this.loadedKey && this.worker) return
    this.loadedKey = key
    this.stopWorker()
    this.startWorker({
      type: 'load',
      modelType: model.asrType,
      language: settings.language,
      files: Object.fromEntries(model.files.map((file) => [file.name.split('.')[0]!, this.models.file(model.id, file.name)])),
    }, model.name)
  }

  private startWorker(load: Extract<WorkerRequest, { type: 'load' }>, name: string): void {
    this.setState('loading', `Loading ${name}…`)
    const worker = utilityProcess.fork(join(__dirname, 'asrWorker.js'), [], { serviceName: 'Murmur speech recognition', stdio: 'pipe' })
    this.worker = worker
    worker.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text && !text.includes('Creating a resampler')) log.warn(text)
    })

    worker.on('message', (message: WorkerResponse) => {
      if (this.worker !== worker) return
      switch (message.type) {
        case 'loaded':
          log.info(`${name} loaded in ${message.ms} ms`)
          this.setState('ready', name)
          break
        case 'loadFailed':
          log.error(`Loading ${name} failed: ${message.error}`)
          this.setState('failed', `Could not load ${name}: ${message.error}`)
          break
        case 'result':
          this.settle(message.id, (request) => request.resolve(message.text))
          break
        case 'error':
          this.settle(message.id, (request) => request.reject(new Error(message.error)))
          break
      }
    })

    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      this.worker = null
      this.loadedKey = ''
      this.failAll(new Error('The speech engine stopped unexpectedly'))
      log.error(`Speech worker exited with code ${code}`)
      this.setState('failed', 'The speech engine stopped. It restarts on the next dictation.')
    })

    worker.once('spawn', () => worker.postMessage(load))
  }

  private stopWorker(): void {
    const worker = this.worker
    this.worker = null
    this.failAll(new Error('The speech engine was restarted'))
    worker?.kill()
  }

  private settle(id: number, action: (request: Pending) => void): void {
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    clearTimeout(request.timer)
    action(request)
  }

  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, (request) => request.reject(error))
  }

  dispose(): void {
    this.stopWorker()
  }

  async transcribe(samples: Float32Array): Promise<string> {
    const settings = this.settings
    if (!settings) throw new Error('Speech recognition is not configured')
    if (settings.asrProvider === 'remote') return this.transcribeRemote(samples, settings)

    if (!this.worker && this.state === 'failed') {
      this.configure(settings)
      await this.waitUntilLoaded()
    }
    if (this.state === 'loading') await this.waitUntilLoaded()
    const worker = this.worker
    if (!worker || this.state !== 'ready') throw new Error(this.detail || 'The speech model is not ready')

    const id = this.nextId++
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, (request) => request.reject(new Error('Transcription timed out'))), TRANSCRIBE_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ type: 'transcribe', id, samples } satisfies WorkerRequest)
    })
  }

  private waitUntilLoaded(): Promise<void> {
    if (this.state !== 'loading') return Promise.resolve()
    return new Promise((resolve) => {
      const onStatus = (state: AsrState) => {
        if (state === 'loading') return
        this.off('status', onStatus)
        resolve()
      }
      this.on('status', onStatus)
    })
  }

  /** Any server that implements the OpenAI transcription endpoint. */
  private async transcribeRemote(samples: Float32Array, settings: Settings): Promise<string> {
    const { baseUrl, apiKey, model } = settings.asrRemote
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(encodeWav(samples))], { type: 'audio/wav' }), 'dictation.wav')
    form.append('model', model)
    form.append('response_format', 'json')
    if (settings.language !== 'auto') form.append('language', settings.language)

    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`Transcription service returned ${response.status}`)
    const body = (await response.json()) as { text?: string }
    return (body.text ?? '').trim()
  }
}

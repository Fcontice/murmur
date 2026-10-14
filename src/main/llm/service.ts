import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { EngineStatus, Settings } from '@shared/types'
import { logger } from '../log'
import type { ModelManager } from '../models'
import { resourcePath, userFile } from '../paths'
import { TruncatedError } from './errors'
import { buildFormatRequest, type ChatRequest } from './prompts'

const log = logger('llm')
const REQUEST_TIMEOUT_MS = 25_000
const STARTUP_TIMEOUT_MS = 180_000
const CONTEXT_TOKENS = 8192

type LlmState = EngineStatus['llm']

interface Endpoint {
  baseUrl: string
  apiKey: string
  model: string
}

interface LocalServer {
  child: ChildProcess
  endpoint: Endpoint
  modelId: string
}

interface Backend {
  label: string
  exe: string
  args: string[]
  /** Skip this backend when the Vulkan build can see no graphics device. */
  needsVulkanDevice?: boolean
}

function hasVulkanDevice(exe: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(exe, ['--list-devices'], { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve(!error && /Vulkan\d+:/.test(`${stdout}${stderr}`))
    })
  })
}

const PID_FILE = () => userFile('llama-server.pid')

/**
 * If the app was killed, its model server keeps running and holds gigabytes of memory. The process
 * id it was started with is on disk; end it if that id still belongs to a model server.
 */
export async function reapStaleServer(): Promise<void> {
  const pid = Number(await readFile(PID_FILE(), 'utf8').catch(() => ''))
  await rm(PID_FILE(), { force: true }).catch(() => undefined)
  if (!Number.isInteger(pid) || pid <= 0) return
  const image = await new Promise<string>((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (_error, stdout) => resolve(stdout ?? ''))
  })
  if (!/^"llama-server\.exe"/im.test(image)) return
  try {
    process.kill(pid)
    log.warn(`Stopped a model server left over from a previous run (pid ${pid})`)
  } catch {
    // already gone
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No free port'))))
    })
  })
}

/**
 * Text clean-up and command mode. The local model is served by a bundled llama.cpp server that only
 * listens on this machine; a custom server is any OpenAI-compatible endpoint. Both speak the same API.
 */
export class LlmService extends EventEmitter<{ status: [LlmState, string] }> {
  state: LlmState = 'off'
  detail = ''
  private settings: Settings | null = null
  private server: LocalServer | null = null
  /** Bumped whenever the wanted configuration changes, so stale start-ups are abandoned. */
  private generation = 0
  private wantedModel = ''

  constructor(private readonly models: ModelManager) {
    super()
  }

  get available(): boolean {
    return this.state === 'ready'
  }

  private setState(state: LlmState, detail = ''): void {
    this.state = state
    this.detail = detail
    this.emit('status', state, detail)
  }

  /** Brings the engine in line with the settings. Safe to call whenever settings or installed models change. */
  configure(settings: Settings): void {
    this.settings = settings
    if (settings.llmProvider === 'off') {
      this.stopServer()
      this.setState('off', 'AI clean-up is turned off.')
      return
    }
    if (settings.llmProvider === 'remote') {
      this.stopServer()
      const ready = Boolean(settings.llmRemote.baseUrl && settings.llmRemote.model)
      this.setState(ready ? 'ready' : 'unavailable', ready ? `Custom server: ${settings.llmRemote.model}` : 'Set the endpoint and model name.')
      return
    }

    const model = this.models.definition(settings.llmModel)
    if (!model || model.kind !== 'llm') {
      this.stopServer()
      this.setState('unavailable', 'Choose a language model.')
      return
    }
    if (!this.models.isInstalled(model.id)) {
      this.stopServer()
      this.setState('unavailable', `${model.name} is not downloaded yet.`)
      return
    }
    if (this.wantedModel === model.id && (this.state === 'ready' || this.state === 'loading')) return
    this.stopServer()
    this.wantedModel = model.id
    void this.startServer(model.id, model.name, this.models.file(model.id, 'model.gguf'))
  }

  /** Ways to run the model, fastest first. A graphics driver can crash on load, so each is tried in turn. */
  private backends(): Backend[] {
    const bundled = resourcePath('llama', 'llama-server.exe')
    const list: Backend[] = []
    if (this.models.isInstalled('llama-cuda')) list.push({ label: 'NVIDIA GPU', exe: this.models.file('llama-cuda', 'llama-server.exe'), args: ['--n-gpu-layers', '999'] })
    if (existsSync(bundled)) {
      list.push({ label: 'GPU', exe: bundled, args: ['--n-gpu-layers', '999'], needsVulkanDevice: true })
      list.push({ label: 'CPU', exe: bundled, args: ['--device', 'none'] })
    }
    return list
  }

  private async startServer(modelId: string, name: string, modelPath: string): Promise<void> {
    const generation = this.generation
    const backends = this.backends()
    if (backends.length === 0) {
      log.error('No llama-server found. Run "node scripts/fetch-llama.cjs".')
      this.setState('failed', 'The language model runtime is missing from this installation.')
      return
    }

    this.setState('loading', `Loading ${name}…`)
    let lastError: unknown = null
    for (const backend of backends) {
      if (backend.needsVulkanDevice && !(await hasVulkanDevice(backend.exe))) continue
      if (generation !== this.generation) return
      const started = Date.now()
      try {
        await this.launch(backend, modelId, name, modelPath, generation)
        if (generation !== this.generation) return
        log.info(`${name} ready in ${Date.now() - started} ms on ${backend.label}`)
        const slow = backend.label === 'CPU' && modelId !== 'gemma-3-1b-it'
        this.setState('ready', `${name} · ${backend.label}${slow ? ' (slower: a GPU or the smaller model would speed up clean-up)' : ''}`)
        return
      } catch (error) {
        if (generation !== this.generation) return
        lastError = error
        log.warn(`${name} did not start on ${backend.label}`, error)
        this.killServer()
      }
    }
    this.wantedModel = ''
    this.setState('failed', `Could not load ${name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  private async launch(backend: Backend, modelId: string, name: string, modelPath: string, generation: number): Promise<void> {
    const port = await freePort()
    // A per-run key keeps other programs and web pages on this machine from using the endpoint.
    const apiKey = randomBytes(24).toString('hex')

    const child = spawn(
      backend.exe,
      ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey, '--ctx-size', String(CONTEXT_TOKENS),
        '--parallel', '1', '--no-webui', ...backend.args],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    )
    const server: LocalServer = { child, endpoint: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey, model: modelId }, modelId }
    this.server = server
    if (child.pid) await writeFile(PID_FILE(), String(child.pid)).catch(() => undefined)

    // Kept only to explain a failed start; the server's output is never written to the log.
    let tail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-600)
    })
    const exited = new Promise<never>((_, reject) => {
      child.once('error', (error) => reject(error))
      child.once('exit', (code) => {
        if (this.server === server) {
          this.server = null
          if (this.state === 'ready') {
            this.wantedModel = ''
            log.error(`llama-server exited with code ${code}`)
            this.setState('failed', `${name} stopped unexpectedly. Dictation continues with basic clean-up; reselect the model in Settings to restart it.`)
          }
        }
        reject(new Error(`The model runtime exited (code ${code}). ${tail.split('\n').filter(Boolean).at(-1) ?? ''}`.trim()))
      })
    })
    exited.catch(() => undefined)

    await Promise.race([this.waitUntilHealthy(port, generation), exited])
    if (generation !== this.generation) return

    // The first evaluation compiles GPU pipelines and takes seconds. Spend that now, with the real
    // instructions, so the first dictation is as fast as the rest.
    await Promise.race([
      this.request(server.endpoint, buildFormatRequest({
        transcript: 'testing one two three', style: 'formal', strength: 'light', category: 'other', appName: '', vocabulary: [],
      }), 120_000).catch((error: unknown) => {
        // A cut-off warm-up reply still warmed the model; only real failures count.
        if (!(error instanceof TruncatedError)) throw error
      }),
      exited,
    ])
  }

  private async waitUntilHealthy(port: number, generation: number): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (generation !== this.generation) return
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
        if (response.ok) return
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('The model took too long to load')
  }

  private killServer(): void {
    const server = this.server
    this.server = null
    if (!server) return
    server.child.kill()
    void rm(PID_FILE(), { force: true }).catch(() => undefined)
  }

  private stopServer(): void {
    this.generation++
    this.wantedModel = ''
    this.killServer()
  }

  dispose(): void {
    this.stopServer()
  }

  /** Reloads the model, picking up a newly installed or removed GPU runtime. */
  restart(): void {
    if (!this.settings) return
    this.stopServer()
    this.configure(this.settings)
  }

  complete = (request: ChatRequest): Promise<string> => {
    const settings = this.settings
    if (!settings || settings.llmProvider === 'off') return Promise.reject(new Error('AI clean-up is turned off'))
    if (settings.llmProvider === 'remote') return this.request(settings.llmRemote, request, REQUEST_TIMEOUT_MS)
    if (!this.server || this.state !== 'ready') return Promise.reject(new Error(this.detail || 'The language model is not loaded'))
    return this.request(this.server.endpoint, request, REQUEST_TIMEOUT_MS)
  }

  /** OpenAI-style chat completion: llama.cpp, Ollama, LM Studio and hosted APIs all accept this. */
  private async request(endpoint: Endpoint, request: ChatRequest, timeoutMs: number): Promise<string> {
    const local = endpoint === this.server?.endpoint
    const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}) },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0,
        max_tokens: request.maxTokens,
        stream: false,
        // The instructions and examples repeat on every call; llama.cpp reuses their evaluation.
        ...(local ? { cache_prompt: true } : {}),
        messages: [
          { role: 'system', content: request.system },
          ...request.shots.flatMap(([user, reply]) => [
            { role: 'user', content: user },
            { role: 'assistant', content: reply },
          ]),
          { role: 'user', content: request.user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`The language model returned an error (${response.status})`)
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }> }
    const choice = body.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string') throw new Error('The language model returned no text')
    if (choice?.finish_reason === 'length') {
      log.warn(`Reply cut off at max_tokens ${request.maxTokens} (${content.length} chars)`)
      throw new TruncatedError(content)
    }
    return content
  }

  /** Checks the configured model from the settings page. */
  async test(): Promise<{ ok: boolean; message: string }> {
    const started = Date.now()
    try {
      // A reply cut off by the tiny token limit still proves the model answers.
      const reply = await this.complete({ system: 'Reply with the single word: ready', shots: [], user: 'Are you there?', maxTokens: 8 }).catch(
        (error: unknown) => {
          if (error instanceof TruncatedError) return error.partial
          throw error
        },
      )
      return { ok: true, message: `Replied "${reply.trim().slice(0, 40)}" in ${Date.now() - started} ms.` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}

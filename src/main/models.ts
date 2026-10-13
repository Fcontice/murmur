import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { ModelInfo, ModelStatus } from '@shared/types'
import { logger } from './log'
import { modelsDir } from './paths'

const log = logger('models')

interface ModelFile {
  name: string
  url: string
  bytes: number
}

export type AsrModelType = 'nemo_transducer' | 'whisper'

export interface ModelDefinition extends ModelInfo {
  files: ModelFile[]
  asrType?: AsrModelType
  /** The files are zip archives to unpack; the value identifies the unpacked contents. */
  extract?: string
}

/** Must match the build fetched by scripts/fetch-llama.cjs so both runtimes behave the same. */
const LLAMA_TAG = 'b11588'
const llamaRelease = (file: string) => `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${file}`
const hf =(repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

function define(model: Omit<ModelDefinition, 'sizeBytes'>): ModelDefinition {
  return { ...model, sizeBytes: model.files.reduce((sum, file) => sum + file.bytes, 0) }
}

const PARAKEET = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const WHISPER_BASE = 'csukuangfj/sherpa-onnx-whisper-base'
const WHISPER_SMALL = 'csukuangfj/sherpa-onnx-whisper-small'

export const MODELS: ModelDefinition[] = [
  define({
    id: 'parakeet-tdt-0.6b-v3',
    kind: 'asr',
    name: 'Parakeet TDT 0.6B v3',
    description: 'Fast and accurate, with punctuation. Transcribes about 20× faster than real time on a modern CPU.',
    languages: '25 European languages, detected automatically',
    recommended: true,
    asrType: 'nemo_transducer',
    files: [
      { name: 'encoder.int8.onnx', url: hf(PARAKEET, 'encoder.int8.onnx'), bytes: 652_184_281 },
      { name: 'decoder.int8.onnx', url: hf(PARAKEET, 'decoder.int8.onnx'), bytes: 11_845_275 },
      { name: 'joiner.int8.onnx', url: hf(PARAKEET, 'joiner.int8.onnx'), bytes: 6_355_277 },
      { name: 'tokens.txt', url: hf(PARAKEET, 'tokens.txt'), bytes: 93_939 },
    ],
  }),
  define({
    id: 'whisper-small',
    kind: 'asr',
    name: 'Whisper Small',
    description: 'Wider language coverage, slower than Parakeet.',
    languages: '99 languages',
    asrType: 'whisper',
    files: [
      { name: 'encoder.int8.onnx', url: hf(WHISPER_SMALL, 'small-encoder.int8.onnx'), bytes: 112_442_483 },
      { name: 'decoder.int8.onnx', url: hf(WHISPER_SMALL, 'small-decoder.int8.onnx'), bytes: 262_226_114 },
      { name: 'tokens.txt', url: hf(WHISPER_SMALL, 'small-tokens.txt'), bytes: 816_730 },
    ],
  }),
  define({
    id: 'whisper-base',
    kind: 'asr',
    name: 'Whisper Base',
    description: 'Smallest download. Lower accuracy; fine for short notes.',
    languages: '99 languages',
    asrType: 'whisper',
    files: [
      { name: 'encoder.int8.onnx', url: hf(WHISPER_BASE, 'base-encoder.int8.onnx'), bytes: 29_120_534 },
      { name: 'decoder.int8.onnx', url: hf(WHISPER_BASE, 'base-decoder.int8.onnx'), bytes: 130_672_026 },
      { name: 'tokens.txt', url: hf(WHISPER_BASE, 'base-tokens.txt'), bytes: 816_730 },
    ],
  }),
  define({
    id: 'gemma-3-4b-it',
    kind: 'llm',
    name: 'Gemma 3 4B',
    description: 'Best clean-up quality. Needs a GPU with 4 GB of memory, or a fast CPU.',
    languages: 'Multilingual',
    recommended: true,
    files: [{ name: 'model.gguf', url: hf('unsloth/gemma-3-4b-it-GGUF', 'gemma-3-4b-it-Q4_K_M.gguf'), bytes: 2_489_894_016 }],
  }),
  define({
    id: 'gemma-3-1b-it',
    kind: 'llm',
    name: 'Gemma 3 1B',
    description: 'Small and quick on any machine. Handles fillers and punctuation; weaker at rewriting.',
    languages: 'Multilingual',
    files: [{ name: 'model.gguf', url: hf('unsloth/gemma-3-1b-it-GGUF', 'gemma-3-1b-it-Q4_K_M.gguf'), bytes: 806_058_272 }],
  }),
  define({
    id: 'llama-cuda',
    kind: 'runtime',
    name: 'NVIDIA GPU acceleration',
    description: 'Runs the language model on an NVIDIA graphics card, several times faster than on the processor.',
    languages: 'Needs an NVIDIA GPU with a current driver',
    extract: LLAMA_TAG,
    files: [
      { name: 'llama-cuda.zip', url: llamaRelease(`llama-${LLAMA_TAG}-bin-win-cuda-12.4-x64.zip`), bytes: 265_217_350 },
      { name: 'cudart.zip', url: llamaRelease('cudart-llama-bin-win-cuda-12.4-x64.zip'), bytes: 391_443_627 },
    ],
  }),
]

interface Download {
  controller: AbortController
  received: number
  error: string | null
}

export class ModelManager extends EventEmitter<{ change: [ModelStatus[]]; installed: [string] }> {
  private downloads = new Map<string, Download>()
  private lastErrors = new Map<string, string>()
  private lastEmit = 0

  constructor(private readonly definitions: ModelDefinition[] = MODELS) {
    super()
  }

  definition(id: string): ModelDefinition | undefined {
    return this.definitions.find((model) => model.id === id)
  }

  dir(id: string): string {
    return join(modelsDir(), id)
  }

  file(id: string, name: string): string {
    return join(this.dir(id), name)
  }

  isInstalled(id: string): boolean {
    const model = this.definition(id)
    if (!model) return false
    if (model.extract) {
      const marker = this.file(id, '.installed')
      return existsSync(marker) && readFileSync(marker, 'utf8') === model.extract
    }
    return model.files.every((file) => {
      const path = this.file(id, file.name)
      return existsSync(path) && statSync(path).size === file.bytes
    })
  }

  list(): ModelStatus[] {
    return this.definitions.map(({ files: _files, asrType: _asrType, extract: _extract, ...info }) => {
      const download = this.downloads.get(info.id)
      return {
        ...info,
        installed: this.isInstalled(info.id),
        downloading: download !== undefined,
        progress: download ? Math.min(1, download.received / info.sizeBytes) : 0,
        error: this.lastErrors.get(info.id) ?? null,
      }
    })
  }

  private notify(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 200) return
    this.lastEmit = now
    this.emit('change', this.list())
  }

  async download(id: string): Promise<void> {
    const model = this.definition(id)
    if (!model || this.downloads.has(id) || this.isInstalled(id)) return

    const download: Download = { controller: new AbortController(), received: 0, error: null }
    this.downloads.set(id, download)
    this.lastErrors.delete(id)
    this.notify(true)

    try {
      await mkdir(this.dir(id), { recursive: true })
      for (const file of model.files) {
        await this.downloadFile(id, file, download)
      }
      if (model.extract) {
        // bsdtar ships with Windows 10 and later and reads zip archives.
        for (const file of model.files) await promisify(execFile)('tar', ['-xf', this.file(id, file.name), '-C', this.dir(id)], { windowsHide: true })
        for (const file of model.files) await rm(this.file(id, file.name), { force: true })
        await writeFile(this.file(id, '.installed'), model.extract)
      }
      log.info(`Installed ${id}`)
      this.downloads.delete(id)
      this.notify(true)
      this.emit('installed', id)
    } catch (error) {
      this.downloads.delete(id)
      if (!download.controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(`Download of ${id} failed`, error)
        this.lastErrors.set(id, `Download failed: ${message}`)
      }
      this.notify(true)
    }
  }

  /** Resumes from a partial file when the server supports ranges. */
  private async downloadFile(id: string, file: ModelFile, download: Download): Promise<void> {
    const target = this.file(id, file.name)
    const done = await stat(target).then((s) => s.size, () => -1)
    if (done === file.bytes) {
      download.received += file.bytes
      return
    }

    const partial = `${target}.part`
    let offset = await stat(partial).then((s) => s.size, () => 0)
    if (offset > file.bytes) {
      await rm(partial, { force: true })
      offset = 0
    }

    const response = await fetch(file.url, {
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
      signal: download.controller.signal,
      redirect: 'follow',
    })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${file.name}`)
    const resumed = response.status === 206
    if (!resumed) offset = 0
    download.received += offset

    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        download.received += chunk.byteLength
        this.notify()
        controller.enqueue(chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body.pipeThrough(counter) as import('node:stream/web').ReadableStream<Uint8Array>),
      createWriteStream(partial, { flags: resumed ? 'a' : 'w' }),
      { signal: download.controller.signal },
    )

    const size = (await stat(partial)).size
    if (size !== file.bytes) {
      await rm(partial, { force: true })
      throw new Error(`${file.name} is ${size} bytes, expected ${file.bytes}`)
    }
    await rename(partial, target)
  }

  cancel(id: string): void {
    this.downloads.get(id)?.controller.abort()
  }

  async remove(id: string): Promise<void> {
    this.cancel(id)
    await rm(this.dir(id), { recursive: true, force: true })
    this.notify(true)
  }
}

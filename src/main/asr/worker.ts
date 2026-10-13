/**
 * Speech recognition runs in its own process. Decoding is a blocking native call, and keeping it out
 * of the main process means a recogniser crash cannot take the app down.
 */
import { createRequire } from 'node:module'
import { cpus } from 'node:os'
import { splitAtPauses, SAMPLE_RATE } from './audio'

export type WorkerRequest =
  | { type: 'load'; modelType: 'nemo_transducer' | 'whisper'; files: Record<string, string>; language: string }
  | { type: 'transcribe'; id: number; samples: Float32Array }

export type WorkerResponse =
  | { type: 'loaded'; ms: number }
  | { type: 'loadFailed'; error: string }
  | { type: 'result'; id: number; text: string; ms: number }
  | { type: 'error'; id: number; error: string }

interface Recognizer {
  createStream(): { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void }
  decode(stream: unknown): void
  getResult(stream: unknown): { text: string }
}

const nodeRequire = createRequire(__filename)
let recognizer: Recognizer | null = null

function load(request: Extract<WorkerRequest, { type: 'load' }>): void {
  const sherpa = nodeRequire('sherpa-onnx-node') as { OfflineRecognizer: new (config: unknown) => Recognizer }
  const numThreads = Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))
  const modelConfig =
    request.modelType === 'whisper'
      ? {
          whisper: {
            encoder: request.files.encoder,
            decoder: request.files.decoder,
            language: request.language === 'auto' ? '' : request.language,
            task: 'transcribe',
          },
          tokens: request.files.tokens,
          numThreads,
          provider: 'cpu',
          debug: 0,
        }
      : {
          transducer: { encoder: request.files.encoder, decoder: request.files.decoder, joiner: request.files.joiner },
          tokens: request.files.tokens,
          numThreads,
          provider: 'cpu',
          modelType: 'nemo_transducer',
          debug: 0,
        }
  recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, modelConfig })
}

function transcribe(samples: Float32Array): string {
  if (!recognizer) throw new Error('No speech model is loaded')
  const parts: string[] = []
  for (const segment of splitAtPauses(samples)) {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: segment })
    recognizer.decode(stream)
    const text = recognizer.getResult(stream).text.trim()
    if (text) parts.push(text)
  }
  return parts.join(' ')
}

const port = process.parentPort
const reply = (message: WorkerResponse) => port.postMessage(message)

port.on('message', (event) => {
  const request = event.data as WorkerRequest
  if (request.type === 'load') {
    const started = Date.now()
    try {
      load(request)
      // The first decode pays one-off initialisation costs; spend them now rather than on a dictation.
      transcribe(new Float32Array(SAMPLE_RATE))
      reply({ type: 'loaded', ms: Date.now() - started })
    } catch (error) {
      recognizer = null
      reply({ type: 'loadFailed', error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  const started = Date.now()
  try {
    // Structured clone can deliver the samples as a view over a transferred buffer.
    const samples = request.samples instanceof Float32Array ? request.samples : new Float32Array(request.samples)
    reply({ type: 'result', id: request.id, text: transcribe(samples), ms: Date.now() - started })
  } catch (error) {
    reply({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
})

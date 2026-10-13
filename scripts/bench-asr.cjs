// Quick sanity/latency check for the local speech model: node scripts/bench-asr.cjs [wav]
const path = require('node:path')
const sherpa = require('sherpa-onnx-node')

const dir = path.join(process.env.LOCALAPPDATA, 'Murmur', 'models', 'parakeet-tdt-0.6b-v3')
const wavPath = process.argv[2] || path.join(__dirname, '..', 'tests', 'fixtures', 'dictation.wav')

const t0 = Date.now()
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(dir, 'encoder.int8.onnx'),
      decoder: path.join(dir, 'decoder.int8.onnx'),
      joiner: path.join(dir, 'joiner.int8.onnx'),
    },
    tokens: path.join(dir, 'tokens.txt'),
    numThreads: 4,
    provider: 'cpu',
    modelType: 'nemo_transducer',
    debug: 0,
  },
})
console.log(`load: ${Date.now() - t0} ms`)

const wave = sherpa.readWave(wavPath)
const seconds = wave.samples.length / wave.sampleRate
for (let i = 0; i < 3; i++) {
  const t1 = Date.now()
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
  recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  const ms = Date.now() - t1
  console.log(`run ${i}: ${ms} ms for ${seconds.toFixed(1)} s audio (rtf ${(ms / 1000 / seconds).toFixed(3)})`)
  if (i === 0) console.log(JSON.stringify({ text: result.text, lang: result.lang, keys: Object.keys(result) }))
}

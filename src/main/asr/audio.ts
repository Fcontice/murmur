export const SAMPLE_RATE = 16_000

export function pcm16ToFloat32(chunks: Int16Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) out[offset + i] = chunk[i]! / 32768
    offset += chunk.length
  }
  return out
}

/** Level in dBFS; silence is clamped to -100. */
export function rmsDb(samples: ArrayLike<number>, scale = 1): number {
  if (samples.length === 0) return -100
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]! / scale
    sum += value * value
  }
  return Math.max(-100, 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-10))
}

/** Maps a dBFS level onto 0..1 for the meter, over the range speech actually occupies. */
export function levelFromDb(db: number, floorDb = -55, rangeDb = 40): number {
  return Math.min(1, Math.max(0, (db - floorDb) / rangeDb))
}

export function peak(samples: Float32Array): number {
  let max = 0
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]!)
    if (value > max) max = value
  }
  return max
}

/**
 * Recognisers work on bounded windows, so long recordings are cut into pieces. Each cut lands on the
 * quietest stretch near the limit so words are not split.
 */
export function splitAtPauses(samples: Float32Array, sampleRate = SAMPLE_RATE, maxSeconds = 28, searchSeconds = 8): Float32Array[] {
  const maxLength = Math.floor(maxSeconds * sampleRate)
  if (samples.length <= maxLength) return [samples]

  const frame = Math.floor(sampleRate * 0.1)
  const search = Math.floor(searchSeconds * sampleRate)
  const segments: Float32Array[] = []
  let start = 0

  while (samples.length - start > maxLength) {
    const limit = start + maxLength
    let bestAt = limit
    let bestEnergy = Infinity
    for (let at = limit - search; at + frame <= limit; at += frame) {
      let energy = 0
      for (let i = at; i < at + frame; i++) energy += samples[i]! * samples[i]!
      if (energy < bestEnergy) {
        bestEnergy = energy
        bestAt = at + Math.floor(frame / 2)
      }
    }
    segments.push(samples.subarray(start, bestAt))
    start = bestAt
  }
  segments.push(samples.subarray(start))
  return segments
}

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples.length * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }
  return buffer
}

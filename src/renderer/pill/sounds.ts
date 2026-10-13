type SoundName = 'start' | 'stop' | 'lock' | 'error'

// Each cue is a short run of sine notes: [frequency in Hz, start offset in seconds, length in seconds].
const CUES: Record<SoundName, Array<[number, number, number]>> = {
  start: [[660, 0, 0.07], [880, 0.06, 0.1]],
  stop: [[880, 0, 0.07], [587, 0.06, 0.11]],
  lock: [[784, 0, 0.05], [784, 0.09, 0.05], [1047, 0.18, 0.09]],
  error: [[330, 0, 0.12], [262, 0.11, 0.16]],
}

let context: AudioContext | null = null

export function playSound(name: SoundName, volume = 0.11): void {
  context ??= new AudioContext()
  const output = context
  if (output.state === 'suspended') void output.resume()
  const now = output.currentTime + 0.01

  for (const [frequency, offset, length] of CUES[name]) {
    const oscillator = output.createOscillator()
    const gain = output.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    // A fast attack and exponential decay keep the cue soft and click-free.
    gain.gain.setValueAtTime(0.0001, now + offset)
    gain.gain.exponentialRampToValueAtTime(volume, now + offset + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + length)
    oscillator.connect(gain).connect(output.destination)
    oscillator.start(now + offset)
    oscillator.stop(now + offset + length + 0.02)
  }
}

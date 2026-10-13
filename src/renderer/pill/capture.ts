const SAMPLE_RATE = 16_000

export interface CaptureCallbacks {
  onStarted(sessionId: string): void
  onChunk(sessionId: string, pcm: ArrayBuffer): void
  onStopped(sessionId: string): void
  onFailed(sessionId: string, message: string): void
  onLevel(level: number): void
}

interface Graph {
  stream: MediaStream
  context: AudioContext
  node: AudioWorkletNode
  deviceId: string | null
}

function describeError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow it under Windows Settings › Privacy & security › Microphone.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Plug one in or pick another in Settings.'
  if (name === 'NotReadableError') return 'The microphone is in use by another app or was disconnected.'
  return 'Could not start the microphone.'
}

/** Level in 0..1 from one block, mapped over the dB range speech occupies. */
function blockLevel(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  const db = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-10)
  return Math.min(1, Math.max(0, (db + 55) / 40))
}

function toPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!))
    pcm[i] = value < 0 ? value * 32768 : value * 32767
  }
  return pcm.buffer
}

export class Recorder {
  private graph: Graph | null = null
  private opening: Promise<Graph> | null = null
  private activeSession: string | null = null
  private microphoneId: string | null = null
  private keepWarm = false

  constructor(private readonly callbacks: CaptureCallbacks) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      // A device that went away leaves a dead stream behind; reopen on next use.
      if (!this.activeSession) void this.close()
    })
  }

  configure(microphoneId: string | null, keepWarm: boolean): void {
    const deviceChanged = microphoneId !== this.microphoneId
    this.microphoneId = microphoneId
    this.keepWarm = keepWarm
    if (this.activeSession) return
    if (deviceChanged || !keepWarm) void this.close()
    if (keepWarm) void this.open().catch(() => undefined)
  }

  private async open(): Promise<Graph> {
    if (this.graph && this.graph.deviceId === this.microphoneId && this.graph.stream.getAudioTracks().every((track) => track.readyState === 'live')) {
      return this.graph
    }
    if (this.opening) return this.opening
    await this.close()

    this.opening = (async () => {
      const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: SAMPLE_RATE }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: this.microphoneId ? { ...base, deviceId: { exact: this.microphoneId } } : base })
      } catch (error) {
        // The chosen microphone may be unplugged; the system default is better than failing.
        if (!this.microphoneId) throw error
        stream = await navigator.mediaDevices.getUserMedia({ audio: base })
      }
      const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
      await context.audioWorklet.addModule('./recorder-worklet.js')
      const node = new AudioWorkletNode(context, 'recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
      context.createMediaStreamSource(stream).connect(node)
      node.port.onmessage = (event: MessageEvent<{ samples?: Float32Array; done?: boolean }>) => this.onWorkletMessage(event.data)
      const graph: Graph = { stream, context, node, deviceId: this.microphoneId }
      this.graph = graph
      return graph
    })()
    try {
      return await this.opening
    } finally {
      this.opening = null
    }
  }

  private async close(): Promise<void> {
    const graph = this.graph
    this.graph = null
    if (!graph) return
    graph.node.port.onmessage = null
    graph.stream.getTracks().forEach((track) => track.stop())
    await graph.context.close().catch(() => undefined)
  }

  private onWorkletMessage(data: { samples?: Float32Array; done?: boolean }): void {
    const sessionId = this.activeSession
    if (data.samples && sessionId) {
      this.callbacks.onLevel(blockLevel(data.samples))
      this.callbacks.onChunk(sessionId, toPcm16(data.samples))
    }
    if (data.done && sessionId) {
      this.activeSession = null
      this.callbacks.onLevel(0)
      this.callbacks.onStopped(sessionId)
      if (!this.keepWarm) void this.close()
    }
  }

  async start(sessionId: string): Promise<void> {
    this.activeSession = sessionId
    try {
      const graph = await this.open()
      if (graph.context.state === 'suspended') await graph.context.resume()
      // Stopped or superseded while the microphone was opening.
      if (this.activeSession !== sessionId) {
        if (!this.activeSession && !this.keepWarm) void this.close()
        return
      }
      this.callbacks.onStarted(sessionId)
    } catch (error) {
      if (this.activeSession === sessionId) this.activeSession = null
      this.callbacks.onFailed(sessionId, describeError(error))
    }
  }

  stop(sessionId: string): void {
    if (this.activeSession !== sessionId) {
      this.callbacks.onStopped(sessionId)
      return
    }
    if (this.graph) {
      this.graph.node.port.postMessage('flush')
    } else {
      // Still opening: nothing was recorded.
      this.activeSession = null
      this.callbacks.onStopped(sessionId)
    }
  }
}

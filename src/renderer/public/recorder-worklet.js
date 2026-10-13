// Collects microphone samples into fixed 40 ms blocks (640 samples at 16 kHz) and hands them to the page.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(640)
    this.filled = 0
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return
      if (this.filled > 0) this.port.postMessage({ samples: this.block.slice(0, this.filled) })
      this.filled = 0
      this.port.postMessage({ done: true })
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let offset = 0
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.block.length - this.filled)
      this.block.set(channel.subarray(offset, offset + count), this.filled)
      this.filled += count
      offset += count
      if (this.filled === this.block.length) {
        this.port.postMessage({ samples: this.block.slice() })
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('recorder', RecorderProcessor)

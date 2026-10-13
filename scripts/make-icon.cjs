// Draws the app icon (four sound bars on a dark rounded square) and writes it as PNG.
// node scripts/make-icon.cjs
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 3x3 supersampling for smooth edges.
      const sum = [0, 0, 0, 0]
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const [r, g, b, a] = pixel((x + (sx + 0.5) / 3) / size, (y + (sy + 0.5) / 3) / size)
          sum[0] += r * a
          sum[1] += g * a
          sum[2] += b * a
          sum[3] += a
        }
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4
      const alpha = sum[3] / 9
      raw[offset] = alpha ? Math.round(sum[0] / sum[3]) : 0
      raw[offset + 1] = alpha ? Math.round(sum[1] / sum[3]) : 0
      raw[offset + 2] = alpha ? Math.round(sum[2] / sum[3]) : 0
      raw[offset + 3] = Math.round(alpha * 255)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

const BARS = [0.3, 0.62, 0.44, 0.22]
const BAR_WIDTH = 0.085
const GAP = 0.065
const START = 0.5 - (BARS.length * BAR_WIDTH + (BARS.length - 1) * GAP) / 2

function pixel(x, y) {
  for (let index = 0; index < BARS.length; index++) {
    const left = START + index * (BAR_WIDTH + GAP)
    const half = BARS[index] / 2
    if (insideRoundedRect(x, y, left, 0.5 - half, left + BAR_WIDTH, 0.5 + half, BAR_WIDTH / 2)) return [124, 140, 255, 1]
  }
  if (insideRoundedRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22)) return [16, 16, 19, 1]
  return [0, 0, 0, 0]
}

const root = path.join(__dirname, '..')
mkdirSync(path.join(root, 'build'), { recursive: true })
mkdirSync(path.join(root, 'resources'), { recursive: true })
writeFileSync(path.join(root, 'build', 'icon.png'), png(512, pixel))
writeFileSync(path.join(root, 'resources', 'icon.png'), png(256, pixel))
console.log('Wrote build/icon.png and resources/icon.png')

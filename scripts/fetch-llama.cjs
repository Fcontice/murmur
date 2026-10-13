// Downloads the pinned llama.cpp build that runs the local language model, into resources/llama.
// node scripts/fetch-llama.cjs
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TAG = 'b11588'
const ASSET = `llama-${TAG}-bin-win-vulkan-x64.zip`
const SHA256 = '696f75ee2aa8047cd6a7c67e37f4c251d609ef3450a9cdab298e7429adf19944'
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${ASSET}`

// Only the server and the libraries it loads are shipped.
const KEEP = /^(llama-server\.exe|llama-server-impl\.dll|llama-common\.dll|llama\.dll|mtmd\.dll|libomp\.dll|ggml.*\.dll|LICENSE.*)$/i

async function main() {
  const target = path.join(__dirname, '..', 'resources', 'llama')
  const marker = path.join(target, '.version')
  if (existsSync(path.join(target, 'llama-server.exe')) && existsSync(marker) && readFileSync(marker, 'utf8') === TAG) {
    console.log(`llama.cpp ${TAG} already present`)
    return
  }

  console.log(`Downloading ${ASSET}…`)
  const response = await fetch(URL)
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== SHA256) throw new Error(`Checksum mismatch for ${ASSET}: got ${digest}`)

  const zip = path.join(os.tmpdir(), ASSET)
  writeFileSync(zip, archive)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  execFileSync('tar', ['-xf', zip, '-C', target])
  rmSync(zip, { force: true })

  for (const name of readdirSync(target)) {
    if (!KEEP.test(name)) rmSync(path.join(target, name), { recursive: true, force: true })
  }
  writeFileSync(marker, TAG)
  console.log(`llama.cpp ${TAG} ready in resources/llama`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})

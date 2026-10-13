import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Runs the prompt evaluations against the installed local model. See tests/eval.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: { include: ['tests/eval/**/*.eval.ts'], environment: 'node', fileParallelism: false },
})

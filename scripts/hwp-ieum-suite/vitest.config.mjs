// Ieum's whole vendored HWP test suite (vendor/ieumoffice/apps/hwp/tests, unedited) run against an
// engine of ours instead of Ieum's own build: `@rhwp/core` and `require.resolve('@rhwp/core')` are
// pointed at HWP_ENGINE_DIR (an absolute folder with rhwp.js + rhwp_bg.wasm). Used by
// scripts/hwp-ieum-suite.ts; the vendored tree is not touched.
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const engine = process.env.HWP_ENGINE_DIR
if (!engine) throw new Error('HWP_ENGINE_DIR is not set')
const entry = join(engine, 'rhwp.js')

export default defineConfig({
  plugins: [{
    name: 'workbench-engine-for-ieum-tests',
    enforce: 'pre',
    transform(code) {
      return code.includes("require.resolve('@rhwp/core')") ? code.replaceAll("require.resolve('@rhwp/core')", JSON.stringify(entry)) : null
    },
  }],
  resolve: { alias: [{ find: /^@rhwp\/core$/, replacement: entry }] },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 20000, maxWorkers: 1 },
})

import { defineConfig } from 'tsdown'

/** Points `createVectorTileWorker` at the bundled worker instead of its TypeScript source. */
const workerUrl = {
  name: 'react-three-earth:vector-worker-url',
  transform(code: string, id: string) {
    if (!id.endsWith('MapStyleBackend.ts')) return null
    return code.replace("new URL('./worker/vectorTileWorker.ts', import.meta.url)", "new URL('./vector-worker.js', import.meta.url)")
  },
}

export default defineConfig({
  entry: { index: 'src/index.ts', react: 'src/react/index.tsx', 'vector-worker': 'src/vector/worker/vectorTileWorker.ts', 'plugin-worker': 'src/plugins/pluginWorker.ts' },
  format: 'esm',
  platform: 'browser',
  dts: true,
  clean: true,
  plugins: [workerUrl],
  // Not minified, so the published code reads as it is (agents and humans read node_modules)
  sourcemap: false,
})

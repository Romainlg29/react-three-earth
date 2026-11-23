import { defineConfig } from 'tsdown'

/** Points `createVectorTileWorker` and `createRasterDemWorker` at the bundled workers instead of their TypeScript sources. */
const workerUrl = {
  name: 'react-three-earth:vector-worker-url',
  transform(code: string, id: string) {
    if (id.endsWith('MapStyleBackend.ts')) return code.replace("new URL('./worker/vectorTileWorker.ts', import.meta.url)", "new URL('./vector-worker.js', import.meta.url)")
    if (id.endsWith('DemMeshBuilder.ts')) return code.replace("new URL('./rasterDemWorker.ts', import.meta.url)", "new URL('./terrain-worker.js', import.meta.url)")
    return null
  },
}

export default defineConfig({
  entry: { index: 'src/index.ts', react: 'src/react/index.tsx', 'vector-worker': 'src/vector/worker/vectorTileWorker.ts', 'plugin-worker': 'src/plugins/pluginWorker.ts', 'terrain-worker': 'src/tiles/dem/rasterDemWorker.ts' },
  format: 'esm',
  platform: 'browser',
  dts: true,
  clean: true,
  plugins: [workerUrl],
  // Not minified, so the published code reads as it is (agents and humans read node_modules)
  sourcemap: false,
})

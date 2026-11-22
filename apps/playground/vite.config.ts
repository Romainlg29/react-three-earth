import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { fixtureTiles } from './fixtures/vitePlugin.ts'

const library = (path: string) => fileURLToPath(new URL(`../../packages/react-three-earth/src/${path}`, import.meta.url))

export default defineConfig({
  plugins: [react(), fixtureTiles()],
  resolve: {
    // Work on the library source directly, no rebuild needed
    alias: [
      { find: /^react-three-earth\/react$/, replacement: library('react/index.tsx') },
      { find: /^react-three-earth$/, replacement: library('index.ts') },
    ],
  },
  // The library is aliased to its source, so Vite would only discover these on first load, re-bundle and
  // reload the page ("new dependencies optimized"). Listing them makes startup one pass.
  optimizeDeps: {
    include: [
      'three',
      'three/tsl',
      'three/webgpu',
      'react-three-earth > 3d-tiles-renderer',
      'react-three-earth > 3d-tiles-renderer/three/plugins',
      '@react-three/fiber',
      '@react-three/fiber/extension',
      '@react-three/tsl',
      'react',
      'react-dom/client',
    ],
  },
  server: { port: 5173 },
})

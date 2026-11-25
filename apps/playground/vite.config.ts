import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { fixtureTiles } from './fixtures/vitePlugin.ts'

const library = (path: string) => fileURLToPath(new URL(`../../packages/react-three-earth/src/${path}`, import.meta.url))
const drawLibrary = (path: string) => fileURLToPath(new URL(`../../packages/draw/src/${path}`, import.meta.url))

export default defineConfig({
  // GitHub Pages serves the playground under /<repository>/ (see .github/workflows/playground-pages.yml).
  base: process.env.PLAYGROUND_BASE ?? '/',
  plugins: [react(), fixtureTiles()],
  build: {
    rollupOptions: { input: { main: fileURLToPath(new URL('index.html', import.meta.url)), examples: fileURLToPath(new URL('examples.html', import.meta.url)) } },
  },
  resolve: {
    // Work on the library source directly, no rebuild needed
    alias: [
      { find: /^@earthkit\/globe\/react$/, replacement: library('react/index.tsx') },
      { find: /^@earthkit\/globe$/, replacement: library('index.ts') },
      { find: /^@earthkit\/draw\/react$/, replacement: drawLibrary('react/index.ts') },
      { find: /^@earthkit\/draw$/, replacement: drawLibrary('index.ts') },
    ],
  },
  // The library is aliased to its source, so Vite would only discover these on first load, re-bundle and
  // reload the page ("new dependencies optimized"). Listing them makes startup one pass.
  optimizeDeps: {
    include: [
      'three',
      'three/tsl',
      'three/webgpu',
      '@earthkit/globe > 3d-tiles-renderer',
      '@earthkit/draw > earcut',
      '@earthkit/globe > 3d-tiles-renderer/three/plugins',
      '@react-three/fiber',
      '@react-three/fiber/extension',
      '@react-three/tsl',
      'react',
      'react-dom/client',
      '@aeronautic/core',
      '@aeronautic/core/react',
      '@aeronautic/afterburner',
      '@aeronautic/afterburner/react',
    ],
  },
  server: { port: 5173 },
})

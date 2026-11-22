import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { fixtureTiles } from './fixtures/vitePlugin'

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
  server: { port: 5173 },
})

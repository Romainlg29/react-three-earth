import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const library = (path: string) => fileURLToPath(new URL(`../react-three-earth/src/${path}`, import.meta.url))

export default defineConfig({
  resolve: { alias: [{ find: /^@earthkit\/globe$/, replacement: library('index.ts') }] },
  test: { environment: 'happy-dom' },
})

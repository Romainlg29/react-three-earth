import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const source = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@earthkit\/globe$/, replacement: source('react-three-earth/src/index.ts') },
      { find: /^@earthkit\/draw$/, replacement: source('draw/src/index.ts') },
    ],
  },
  test: { environment: 'node' },
})

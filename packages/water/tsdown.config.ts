import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', react: 'src/react/index.tsx' },
  format: 'esm',
  platform: 'browser',
  dts: true,
  clean: true,
  external: [/^@earthkit\/globe(\/.*)?$/, /^three(\/.*)?$/, 'react'],
  // Not minified, so the published code reads as it is
  sourcemap: false,
})

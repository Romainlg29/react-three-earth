import { it } from 'vitest'
import { buildSolidGeometry, LocalFrame } from '../src/render/SolidFeatures.js'
import { createCircle } from '../src/shapes.js'
it('debug', () => {
  const d = { ...createCircle([6.6, 46.45], 40_000, { baseHeightMeters: 0, heightMeters: 500 }), id: 'd' } as any
  const frame = new LocalFrame(6.6, 46.45, 0)
  for (let i = 0; i < 5; i++) buildSolidGeometry(d, frame)
  ;(globalThis as any).T = {earcut:0,flip:0,refine:0}
  const t = performance.now()
  for (let i = 0; i < 10; i++) buildSolidGeometry(d, frame)
  console.log((performance.now() - t) / 10, JSON.stringify((globalThis as any).T))
})

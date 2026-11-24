import { it } from 'vitest'
import { buildSolidGeometry, LocalFrame } from '../src/render/SolidFeatures.js'
import { indexMesh, isClosedMesh, meshVolume, meshSharpEdges } from '../src/mesh.js'
import { createCircle, createSphere } from '../src/shapes.js'
const time = (name: string, f: () => void) => { for (let i = 0; i < 20; i++) f(); const t = performance.now(); for (let i = 0; i < 50; i++) f(); console.log(name, ((performance.now() - t) / 50).toFixed(3), 'ms') }
it('debug', () => {
  const s = { ...createSphere([6.6, 46.45], 1200), id: 'a' } as any
  const c = { ...createCircle([6.6, 46.45], 10_000, { baseHeightMeters: 0, heightMeters: 500 }), id: 'c' } as any
  const d = { ...createCircle([6.6, 46.45], 40_000, { baseHeightMeters: 0, heightMeters: 500 }), id: 'd' } as any
  const frame = new LocalFrame(6.6, 46.45, 0)
  for (const [n, f] of [['sphere', s], ['cyl10', c], ['cyl40', d]] as const) {
    time(n + ' build', () => buildSolidGeometry(f, frame))
    time(n + ' build x4', () => buildSolidGeometry(f, frame, 0, { coarseness: 4 }))
    time(n + ' index', () => indexMesh(f.geometry))
    const m = indexMesh(f.geometry)
    time(n + ' closed+volume', () => { isClosedMesh(m); meshVolume(m) })
    time(n + ' sharp', () => meshSharpEdges(m))
  }
})

import { Object3D } from 'three'
import { it } from 'vitest'
const SRC = process.env.OLD ? '../zz-old/src' : '../src'
const { SolidFeatures } = await import(SRC + '/render/SolidFeatures.js')
const { createCircle, createSphere } = await import(SRC + '/shapes.js')
import { DEFAULT_DRAW_STYLE } from '../src/style.js'
import type { DrawFeature } from '../src/types.js'

const earth = { view: { morph: 0, flatMapLuminance: 1 }, createGeographicAnchor: () => Object.assign(new Object3D(), { dispose() { (this as unknown as Object3D).removeFromParent() } }) }
const cases: Array<[string, DrawFeature]> = [
  ['default sphere r=1200 m', { ...createSphere([6.6, 46.45], 1200), id: 'a' } as DrawFeature],
  ['flat disk r=10 km at 500 m', { ...createCircle([6.6, 46.45], 10_000, { baseHeightMeters: 500 }), id: 'b' } as DrawFeature],
  ['cylinder r=10 km, 500 m', { ...createCircle([6.6, 46.45], 10_000, { baseHeightMeters: 0, heightMeters: 500 }), id: 'c' } as DrawFeature],
  ['cylinder r=40 km, 500 m', { ...createCircle([6.6, 46.45], 40_000, { baseHeightMeters: 0, heightMeters: 500 }), id: 'd' } as DrawFeature],
  ['box 2x3.5 km', { ...createCircle([6.6, 46.45], 2000, { steps: 4, baseHeightMeters: 0, heightMeters: 900 }), id: 'e' } as DrawFeature],
]
it('bench', () => {
  const solids = new SolidFeatures(earth as never)
  for (const pass of [0, 1]) for (const [name, feature] of cases) {
    for (const kind of ['preview', 'full'] as const) {
      const times: number[] = []
      let triangles = 0
      for (let run = 0; run < 9; run++) {
        const copy = { ...feature }
        const start = performance.now()
        if (kind === 'preview') solids.setPreviews([{ feature: copy, style: DEFAULT_DRAW_STYLE }])
        else solids.setFeatures([{ feature: copy, style: DEFAULT_DRAW_STYLE }])
        times.push(performance.now() - start)
        const anchor = solids.object.children.at(-1) as Object3D
        triangles = ((anchor.children[0] as any)?.geometry.getAttribute('position').count ?? 0) / 3
      }
      solids.setPreviews([])
      solids.setFeatures([])
      times.sort((a, b) => a - b)
      if (pass === 1) process.stderr.write(`BENCH ${name} ${kind}: median ${times[4]!.toFixed(2)} ms, ${triangles} triangles\n`)
    }
  }
})

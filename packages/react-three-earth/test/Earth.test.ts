import { describe, expect, it } from 'vitest'

import { Earth } from '../src/core/Earth.js'
import { Terrain } from '../src/core/Terrain.js'
import { QuantizedMeshSource } from '../src/core/sources.js'

describe('Earth.inspect', () => {
  it('reports an empty earth as plain JSON', () => {
    const earth = new Earth({ date: new Date('2026-11-22T07:00:00Z') })
    const inspection = earth.inspect()
    expect(inspection).toEqual({ date: '2026-11-22T07:00:00.000Z', updateMilliseconds: 0, terrain: null, imageryLayers: 0,
      view: { mode: '3d', morph: 0, anchorLongitudeDegrees: 0, anchorLatitudeDegrees: 0 },
      atmosphere: null,
    })
    expect(JSON.parse(JSON.stringify(inspection))).toEqual(inspection)
  })

  it('reports the terrain url and memory budget before any tile loads', () => {
    const earth = new Earth()
    earth.setTerrain(new Terrain({ sources: [new QuantizedMeshSource({ url: 'https://example.com/terrain' })], memoryBudgetBytes: 100e6 }))
    expect(earth.inspect().terrain).toMatchObject({ tilesLoaded: 0, tilesDownloading: 0, memoryBudgetBytes: 100e6 })
  })
})

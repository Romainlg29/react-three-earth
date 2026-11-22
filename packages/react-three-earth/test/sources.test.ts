import { describe, expect, it } from 'vitest'

import { Imagery } from '../src/core/Imagery.js'
import { QuantizedMeshSource, RasterTileSource, type ImagerySource } from '../src/core/sources.js'

describe('QuantizedMeshSource', () => {
  it('points at the tileset folder whether or not the url ends with a slash', () => {
    expect(new QuantizedMeshSource({ url: 'https://example.com/terrain' }).url).toBe('https://example.com/terrain/')
    expect(new QuantizedMeshSource({ url: 'https://example.com/terrain/' }).url).toBe('https://example.com/terrain/')
  })

  it('creates a fresh plugin for each terrain that uses it', () => {
    const source = new QuantizedMeshSource({ url: 'https://example.com/terrain/' })
    expect(source.createPlugins()[0]).not.toBe(source.createPlugins()[0])
  })
})

describe('RasterTileSource', () => {
  it('explains what is missing when the url has no tile placeholders', () => {
    expect(() => new RasterTileSource({ url: 'https://example.com/wmts?request=GetCapabilities' })).toThrow(
      /needs \{z\}, \{x\} and \{y\}/,
    )
  })

  it('defaults to Web Mercator 256 px tiles', () => {
    const source = new RasterTileSource({ url: 'https://example.com/{z}/{x}/{y}.png' })
    expect(source).toMatchObject({ projection: 'EPSG:3857', tileDimensionPixels: 256, levels: 20 })
  })
})

describe('Imagery', () => {
  const fakeSource = (): ImagerySource => ({ kind: 'imagery', createOverlay: ({ opacity }) => ({ opacity }) })

  it('creates one overlay per source, in order, with the layer opacity', () => {
    const imagery = new Imagery({ sources: [fakeSource(), fakeSource()], opacity: 0.5 })
    expect(imagery.overlays.map(overlay => overlay.opacity)).toEqual([0.5, 0.5])
  })

  it('updates every overlay when the opacity changes', () => {
    const imagery = new Imagery({ sources: [fakeSource(), fakeSource()] })
    imagery.opacity = 0.25
    expect(imagery.opacity).toBe(0.25)
    expect(imagery.overlays.map(overlay => overlay.opacity)).toEqual([0.25, 0.25])
  })
})

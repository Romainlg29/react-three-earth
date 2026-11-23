import { describe, expect, it, vi } from 'vitest'

import { IMAGE_ATLAS_PADDING, ImageAtlas, padAndPremultiply } from '../src/vector/worker/imageAtlas.js'
import { MapStyleProcessor, planePatternMapping } from '../src/vector/worker/MapStyleProcessor.js'
import { ShapeBuilder } from '../src/vector/worker/ShapeBuilder.js'
import { normalizeSprites, parseSpriteIndex, spriteUrls, type DecodedImage } from '../src/vector/worker/sprites.js'
import type { StyleImage } from '../src/vector/worker/types.js'
import { createFakeFetch } from './helpers/encodeArchives.js'
import { encodeVectorTile } from './helpers/encodeVectorTile.js'

/** A solid RGBA image. */
function solid(width: number, height: number, [r, g, b, a]: [number, number, number, number], pixelRatio = 1): StyleImage {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < data.length; index += 4) data.set([r, g, b, a], index)
  return { width, height, data, pixelRatio, sdf: false }
}

/** RGBA of one pixel of a padded atlas entry. */
function pixel(data: Uint8Array, width: number, x: number, y: number): number[] {
  return [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
}

describe('sprite URLs and index', () => {
  it('puts @2x before the extension and any query string, and names array sprites', () => {
    expect(spriteUrls('https://host/sprites/basic', 2, 'https://host/style.json')).toEqual({ json: 'https://host/sprites/basic@2x.json', image: 'https://host/sprites/basic@2x.png' })
    expect(spriteUrls('../sprite?key=1', 1, 'https://host/styles/style.json')).toEqual({ json: 'https://host/sprite.json?key=1', image: 'https://host/sprite.png?key=1' })
    expect(normalizeSprites('https://host/sprite')).toEqual([{ id: 'default', url: 'https://host/sprite' }])
    expect(normalizeSprites([{ id: 'roads', url: 'a' }, { id: 3 }])).toEqual([{ id: 'roads', url: 'a' }])
    expect(normalizeSprites(undefined)).toEqual([])
  })

  it('reads sprite JSON metadata and skips entries without a valid box', () => {
    const index = parseSpriteIndex({
      dots: { x: 0, y: 0, width: 8, height: 8, pixelRatio: 2 },
      sign: { x: 8, y: 0, width: 20, height: 10, sdf: true, stretchX: [[2, 18]], content: [2, 2, 18, 8] },
      broken: { x: 0, y: 0, width: 0, height: 8 },
      fractional: { x: 0.5, y: 0, width: 8, height: 8 },
    })
    expect([...index.keys()]).toEqual(['dots', 'sign'])
    expect(index.get('dots')).toEqual({ x: 0, y: 0, width: 8, height: 8, pixelRatio: 2, sdf: false })
    expect(index.get('sign')).toMatchObject({ pixelRatio: 1, sdf: true, stretchX: [[2, 18]], content: [2, 2, 18, 8] })
  })
})

describe('ImageAtlas', () => {
  it('pads images with their wrapped edges, premultiplied', () => {
    // 2 × 1: a red pixel, then a half-transparent white one.
    const image: StyleImage = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 255, 255, 255, 128]), pixelRatio: 1, sdf: false }
    const padded = padAndPremultiply(image)
    const width = 2 + IMAGE_ATLAS_PADDING * 2
    expect(pixel(padded, width, 1, 1)).toEqual([255, 0, 0, 255])
    expect(pixel(padded, width, 2, 1)).toEqual([128, 128, 128, 128])
    // Left padding repeats the right edge, right padding the left edge, rows wrap the same way.
    expect(pixel(padded, width, 0, 1)).toEqual([128, 128, 128, 128])
    expect(pixel(padded, width, 3, 1)).toEqual([255, 0, 0, 255])
    expect(pixel(padded, width, 1, 0)).toEqual([255, 0, 0, 255])
  })

  it('pads icons with transparent pixels instead, so their edges fade out', () => {
    const image: StyleImage = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 255, 255, 255, 128]), pixelRatio: 1, sdf: false }
    const padded = padAndPremultiply(image, false)
    const width = 2 + IMAGE_ATLAS_PADDING * 2
    expect(pixel(padded, width, 1, 1)).toEqual([255, 0, 0, 255])
    expect(pixel(padded, width, 0, 1)).toEqual([0, 0, 0, 0])
    expect(pixel(padded, width, 3, 1)).toEqual([0, 0, 0, 0])
    expect(pixel(padded, width, 1, 0)).toEqual([0, 0, 0, 0])
  })

  it('packs images, rewrites one of the same size in place, reuses freed slots and grows', () => {
    const atlas = new ImageAtlas()
    const first = atlas.add('a', solid(8, 8, [255, 0, 0, 255]))!
    expect(first).toEqual({ x: IMAGE_ATLAS_PADDING, y: IMAGE_ATLAS_PADDING, width: 8, height: 8 })
    const update = atlas.takeUpdate()!
    expect(update.images).toHaveLength(1)
    expect(atlas.takeUpdate()).toBeNull()

    expect(atlas.add('a', solid(8, 8, [0, 255, 0, 255]))).toEqual(first) // same size: same place
    expect(atlas.takeUpdate()!.images[0]!.x).toBe(0)

    const second = atlas.add('b', solid(8, 8, [0, 0, 255, 255]))!
    expect(second.x).toBeGreaterThan(first.x)
    atlas.remove('a')
    expect(atlas.get('a')).toBeNull()
    expect(atlas.add('c', solid(6, 6, [0, 0, 0, 255]))!.x).toBe(first.x) // fits in a's freed slot

    const tall = atlas.add('tall', solid(4, 200, [0, 0, 0, 255]))!
    expect(tall.height).toBe(200)
    expect(atlas.height).toBeGreaterThanOrEqual(202 + 10)
    expect(atlas.takeUpdate()!.height).toBe(atlas.height)
  })
})

describe('ShapeBuilder patterns', () => {
  it('maps fills onto the plane and lines along their length, leaving earlier vertices coloured', () => {
    const builder = new ShapeBuilder()
    builder.setColor([255, 0, 0, 255])
    builder.addCircle({ x: 0, y: 0 }, 1) // before any pattern: 17 vertices
    const rectangle = { x: 10, y: 20, width: 16, height: 8, pixelRatio: 1 }
    builder.setPattern(rectangle, { kind: 'plane', imagePixelsPerUnit: 0.5, originX: 3, originY: 1 })
    builder.addPolygons([[[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]]])
    builder.setPattern(rectangle)
    builder.addLine([{ x: 0, y: 0 }, { x: 100, y: 0 }], { width: 4 })
    builder.setPattern(null)
    builder.addCircle({ x: 0, y: 0 }, 1)
    const mesh = builder.build()!
    const vertices = mesh.positions.length / 2
    expect(mesh.patterns!.length).toBe(vertices * 4)
    expect(mesh.patternCoordinates!.length).toBe(vertices * 2)
    expect([...mesh.patterns!.subarray(0, 4)]).toEqual([0, 0, 0, 0])
    // Fill vertex 17 is (0, 0), vertex 18 is (10, 0): origin plus position × 0.5.
    expect([...mesh.patterns!.subarray(17 * 4, 18 * 4)]).toEqual([10, 20, 16, 8])
    expect([...mesh.patternCoordinates!.subarray(17 * 2, 19 * 2)]).toEqual([3, 1, 8, 1])
    // Line: 4 units wide, image 8 px high, so 2 image px per unit. The end vertices are 100 units along.
    const line = mesh.patternCoordinates!.subarray(21 * 2, 25 * 2)
    expect([...line]).toEqual([0, 0, 0, 8, 200, 0, 200, 8])
    expect([...mesh.patterns!.subarray(-4)]).toEqual([0, 0, 0, 0])
  })

  it('keeps the across coordinate within the line at mitred corners', () => {
    const builder = new ShapeBuilder()
    builder.setPattern({ x: 0, y: 0, width: 4, height: 4, pixelRatio: 1 })
    builder.addLine([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], { width: 2, join: 'miter' })
    const across = [...builder.build()!.patternCoordinates!].filter((_, index) => index % 2 === 1)
    for (const value of across) expect(Math.min(Math.abs(value), Math.abs(value - 4))).toBeLessThan(1e-4)
  })
})

describe('fill pattern mapping', () => {
  it('continues the pattern across tiles, with small coordinates at any zoom', () => {
    const rectangle = { x: 0, y: 0, width: 16, height: 16, pixelRatio: 2 }
    const unitsPerPixel = 8 // 4096 units over 512 px
    const left = planePatternMapping(rectangle, { x: 1000003, y: 5, tileSizePixels: 512 }, unitsPerPixel)
    const right = planePatternMapping(rectangle, { x: 1000004, y: 5, tileSizePixels: 512 }, unitsPerPixel)
    expect(left.originX).toBeLessThan(16)
    // The left tile's right edge (4096 units) lands where the right tile starts, modulo the image.
    expect((left.originX + 4096 * left.imagePixelsPerUnit) % 16).toBeCloseTo(right.originX)
    expect(left.imagePixelsPerUnit).toBe(2 / 8)
  })
})

describe('MapStyleProcessor sprites and patterns', () => {
  const baseUrl = 'https://maps.test/style.json'
  const tiles = ['https://maps.test/tiles/{z}/{x}/{y}.pbf']
  // A 16 × 8 sheet: "dots" on the left half, "stripes" on the right half (pixel ratio 2).
  const sheet: DecodedImage = { width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(255) }
  const spriteIndex = { dots: { x: 0, y: 0, width: 8, height: 8, pixelRatio: 2 }, stripes: { x: 8, y: 0, width: 8, height: 4, pixelRatio: 2 } }
  const tile = encodeVectorTile([
    { name: 'land', features: [{ type: 'Polygon', geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], properties: { pattern: 'dots' } }] },
    { name: 'roads', features: [{ type: 'LineString', geometry: [[[0, 2000], [4096, 2000]]], properties: {} }] },
  ])
  function style(sprite: unknown, fillPattern: unknown = ['get', 'pattern']) {
    return {
      version: 8,
      sprite,
      sources: { base: { type: 'vector', tiles, maxzoom: 14 } },
      layers: [
        { id: 'paper', type: 'background', paint: { 'background-pattern': 'stripes', 'background-opacity': 0.5 } },
        { id: 'land', type: 'fill', source: 'base', 'source-layer': 'land', paint: { 'fill-pattern': fillPattern, 'fill-opacity': 0.8 } },
        { id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-pattern': 'arrows', 'line-width': 4 } },
      ],
    }
  }
  const decodeImage = vi.fn(async () => sheet)

  it('loads the @2x sprite, draws fill patterns and the background pattern, and reports missing images', async () => {
    const { fetch, requests } = createFakeFetch({
      'https://maps.test/sprite@2x.json': spriteIndex,
      'https://maps.test/sprite@2x.png': new Uint8Array([1, 2, 3]),
      'https://maps.test/tiles/10/1/2.pbf': tile,
    })
    const processor = await MapStyleProcessor.create({ style: style('/sprite'), baseUrl, requestHeaders: {}, localFontFamily: 'x', spritePixelRatio: 2 }, { fetch, decodeImage })
    expect(requests.map(request => request.url)).toContain('https://maps.test/sprite@2x.json')
    expect(processor.summary.spriteImageIds).toEqual(['dots', 'stripes'])
    const background = processor.summary.backgroundPatternByZoom[10]!
    expect(background).toMatchObject({ imageId: 'stripes', opacity: 0.5, rectangle: { width: 8, height: 4, pixelRatio: 2 } })
    expect(processor.summary.backgroundByZoom[10]).toBeNull() // the pattern replaces the colour

    const bucket = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10 })
    expect(bucket.images.sort()).toEqual(['arrows', 'dots'])
    expect(bucket.missingImages).toEqual(['arrows']) // the line draws nothing
    const shapes = bucket.shapes!
    expect(shapes.patterns).not.toBeNull()
    expect(processor.takeImageAtlasUpdate()!.images).toHaveLength(2) // stripes (background), dots
    expect(shapes.patterns![2]).toBe(8) // dots: 8 px wide
    expect(shapes.colors[3]).toBe(Math.round(0.8 * 255)) // the opacity rides in the vertex alpha
    // 2 image px per map pixel, 8 units per map pixel: the 4096-unit tile spans 1024 image px.
    const xs = [...shapes.patternCoordinates!].filter((_, index) => index % 2 === 0)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1024)
  })

  it('names array sprites, falls back to the 1x sheet, and applies runtime images', async () => {
    const { fetch } = createFakeFetch({
      'https://maps.test/roads.json': spriteIndex,
      'https://maps.test/roads.png': new Uint8Array([1]),
      'https://maps.test/tiles/10/1/2.pbf': tile,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const processor = await MapStyleProcessor.create(
      { style: style([{ id: 'roads', url: '/roads' }], 'roads:dots'), baseUrl, requestHeaders: {}, localFontFamily: 'x', spritePixelRatio: 2, images: [['arrows', solid(4, 4, [0, 0, 0, 255])]] },
      { fetch, decodeImage },
    )
    warn.mockRestore()
    expect(processor.summary.spriteImageIds).toEqual(['roads:dots', 'roads:stripes'])
    expect(processor.summary.backgroundPatternByZoom[10]).toBeNull() // "stripes" is "roads:stripes" here
    let bucket = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10 })
    expect(bucket.missingImages).toEqual([])
    const vertices = bucket.shapes!.positions.length / 2
    const patterned = [...Array(vertices).keys()].filter(index => bucket.shapes!.patterns![index * 4 + 2]! > 0)
    expect(patterned.length).toBe(vertices) // fill and line both patterned

    // Same size: rewritten in place. Another size: meshes must be rebuilt. Removed: rebuilt, then missing.
    expect(processor.setImage('arrows', solid(4, 4, [255, 0, 0, 255])).rebuild).toBe(false)
    expect(processor.setImage('arrows', solid(8, 4, [255, 0, 0, 255])).rebuild).toBe(true)
    expect(processor.setImage('arrows', null).rebuild).toBe(true)
    bucket = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10 })
    expect(bucket.missingImages).toEqual(['arrows'])
    // A runtime image hides a sprite image of the same id, and removing it uncovers the sprite one.
    expect(processor.setImage('roads:dots', solid(2, 2, [0, 0, 0, 255])).rebuild).toBe(true)
    expect(processor.setImage('roads:dots', null).rebuild).toBe(true)
  })

  it('draws a background pattern over the colour below it, and lists a missing background image', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/sprite.json': spriteIndex, 'https://maps.test/sprite.png': new Uint8Array([1]) })
    const layers = (pattern: string) => [
      { id: 'ground', type: 'background', paint: { 'background-color': '#336699' } },
      { id: 'paper', type: 'background', paint: { 'background-pattern': pattern } },
      { id: 'hidden', type: 'background', paint: { 'background-pattern': 'stripes', 'background-opacity': 0 } },
    ]
    const create = (pattern: string) => MapStyleProcessor.create({ style: { version: 8, sprite: '/sprite', sources: {}, layers: layers(pattern) }, baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, decodeImage })
    const found = await create('dots')
    expect(found.summary.backgroundByZoom[3]).toEqual([51, 102, 153, 255])
    expect(found.summary.backgroundPatternByZoom[3]!.imageId).toBe('dots') // the transparent layer above is skipped
    const missing = await create('paper-texture')
    expect(missing.summary.backgroundPatternByZoom[3]).toBeNull()
    expect(missing.summary.missingBackgroundImages).toEqual(['paper-texture'])
    expect(missing.setImage('paper-texture', solid(2, 2, [0, 0, 0, 255])).missingBackgroundImages).toEqual([])
  })

  it('skips a sprite that fails to load, with a warning', async () => {
    const { fetch } = createFakeFetch({ 'https://maps.test/tiles/10/1/2.pbf': tile })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const processor = await MapStyleProcessor.create({ style: style('/nothing'), baseUrl, requestHeaders: {}, localFontFamily: 'x' }, { fetch, decodeImage })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sprite "default" .* could not load/))
    warn.mockRestore()
    expect(processor.summary.spriteImageIds).toEqual([])
    const bucket = await processor.processTile({ sourceId: 'base', x: 1, y: 2, z: 10, zoom: 10 })
    expect(bucket.shapes).toBeNull()
    expect(bucket.missingImages.sort()).toEqual(['arrows', 'dots'])
  })
})

import { classifyRings, Formatted, type Color } from '@maplibre/maplibre-gl-style-spec'
import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile'
import Pbf from 'pbf'

import { GlyphProvider, type Glyph } from './glyphs.js'
import {
  CollisionGrid,
  layoutLineLabels,
  layoutPointLabel,
  shapeText,
  TextBuilder,
  type Box,
  type TextAnchor,
  type TextJustify,
  type TextSection,
} from './labels.js'
import { tileOverlaps, type MercatorRectangle } from './rectangles.js'
import { ShapeBuilder, type LineCap, type LineJoin, type Point } from './ShapeBuilder.js'
import { StyleImages, type ImageDecoder } from './sprites.js'
import { compileStyleLayers, toRgba, type CompiledStyleLayer, type StyleFeature, type StyleLayerSpecification } from './styleLayers.js'
import { createVectorTileFetcher, resolveTemplate, type VectorSourceSpecification, type VectorTileFetcher } from './tileSources.js'
import {
  TILE_EXTENT,
  TILE_SIZE_PIXELS,
  type AtlasUpdate,
  type BackgroundPattern,
  type ImageAtlasUpdate,
  type ImageChange,
  type MapStyleProcessorOptions,
  type MapStyleSummary,
  type PatternRectangle,
  type StyleImage,
  type TileBucket,
  type TileRequest,
} from './types.js'

/** Hooks for tests: Node has neither the network fixtures nor OffscreenCanvas. */
export interface MapStyleProcessorHooks {
  fetch?: typeof fetch
  drawLocalGlyph?: (fontStack: string, codePoint: number) => Glyph | null
  /** Decodes sprite sheets (Node has no `createImageBitmap`). */
  decodeImage?: ImageDecoder
}

interface StyleDocument {
  version?: number
  sources?: Record<string, VectorSourceSpecification>
  layers?: StyleLayerSpecification[]
  glyphs?: string
  sprite?: unknown
}

/** Pattern lookups of one tile: the images it asked for, and those that do not exist. */
interface TileImages {
  used: Set<string>
  missing: Set<string>
}

/** Where a tile sits in the world, for patterns that continue seamlessly across tiles. */
export interface TilePlacement {
  x: number
  y: number
  /** Map pixels per tile at the evaluated zoom. */
  tileSizePixels: number
}

/** Raw tiles kept for reuse (overzoomed levels and neighbouring regions read the same tile). */
const RAW_TILE_CACHE_SIZE = 128
const MAXIMUM_ZOOM = 24

interface SymbolCandidate {
  layer: CompiledStyleLayer
  feature: StyleFeature
  type: VectorTileFeature['type']
  geometry: Point[][]
  sections: TextSection[]
  sortKey: number
  order: number
}

interface RawTileEntry {
  x: number
  y: number
  z: number
  promise: Promise<VectorTile | null>
  waiters: number
  controller: AbortController
}

/**
 * Turns vector tiles into triangles for one MapLibre style: fetches tiles (XYZ, TileJSON or PMTiles),
 * evaluates the style's filters and properties per feature, tessellates fills, lines and circles, and lays
 * out text labels with SDF glyphs. Runs in a worker; pure enough to run on the main thread or in Node.
 */
export class MapStyleProcessor {
  readonly summary: MapStyleSummary
  protected readonly layers: CompiledStyleLayer[]
  protected readonly fetchers: Map<string, VectorTileFetcher>
  protected readonly glyphs: GlyphProvider
  protected readonly images: StyleImages
  protected readonly rawTiles = new Map<string, RawTileEntry>()
  /** Tiles fetched this session, oldest first (at most 4096), so `invalidate` knows which the browser may cache. */
  protected readonly fetchedTiles = new Map<string, { x: number; y: number; z: number }>()
  /**
   * Fetched tiles in invalidated areas: their next fetch uses `cache: 'no-cache'`, once, so the browser's HTTP
   * cache cannot hand back the tile from before the change.
   */
  protected readonly revalidatedTiles = new Set<string>()

  protected constructor(
    layers: CompiledStyleLayer[],
    fetchers: Map<string, VectorTileFetcher>,
    glyphs: GlyphProvider,
    images: StyleImages,
    skipped: string[],
    attributions: string[],
  ) {
    this.layers = layers
    this.fetchers = fetchers
    this.glyphs = glyphs
    this.images = images
    this.summary = {
      sources: [...fetchers].map(([id, fetcher]) => ({ id, minimumZoom: fetcher.minimumZoom, maximumZoom: fetcher.maximumZoom })),
      backgroundByZoom: Array.from({ length: MAXIMUM_ZOOM + 1 }, (_, zoom) => this.backgroundAt(zoom)),
      skippedLayers: skipped,
      attributions,
      ...this.backgroundPatterns(),
      spriteImageIds: images.spriteImageIds(),
    }
  }

  static async create(options: MapStyleProcessorOptions, hooks: MapStyleProcessorHooks = {}): Promise<MapStyleProcessor> {
    const style = options.style as StyleDocument
    if (typeof style !== 'object' || style === null || !Array.isArray(style.layers)) {
      throw new Error('MapStyleSource: the style must be a MapLibre style document (version 8) with a `layers` array.')
    }
    const fetch = hooks.fetch ?? globalThis.fetch.bind(globalThis)
    const { layers, skipped } = compileStyleLayers(style.layers)

    const usedSources = new Set(layers.filter(layer => layer.type !== 'background').map(layer => layer.source))
    const fetchers = new Map<string, VectorTileFetcher>()
    await Promise.all(
      Object.entries(style.sources ?? {}).map(async ([id, source]) => {
        if (!usedSources.has(id)) return
        if (source.type !== 'vector') {
          skipped.push(...layers.filter(layer => layer.source === id).map(layer => layer.id))
          return
        }
        try {
          fetchers.set(id, await createVectorTileFetcher(source, { baseUrl: options.baseUrl, requestHeaders: options.requestHeaders, fetch }))
        } catch (error) {
          console.warn(`MapStyleSource: source "${id}" is unavailable, its layers are skipped. ${(error as Error).message}`)
        }
      }),
    )
    const imagesPromise = StyleImages.load({
      sprite: style.sprite,
      baseUrl: options.baseUrl,
      pixelRatio: options.spritePixelRatio ?? 1,
      requestHeaders: options.requestHeaders,
      fetch,
      images: options.images ?? [],
      ...(hooks.decodeImage !== undefined ? { decodeImage: hooks.decodeImage } : {}),
    })
    const drawable = layers.filter(layer => layer.type === 'background' || (layer.source !== undefined && fetchers.has(layer.source)))
    const glyphs = new GlyphProvider({
      glyphsUrl: style.glyphs === undefined ? null : resolveTemplate(style.glyphs, options.baseUrl),
      requestHeaders: options.requestHeaders,
      localFontFamily: options.localFontFamily,
      fetch,
      ...(hooks.drawLocalGlyph !== undefined ? { drawLocalGlyph: hooks.drawLocalGlyph } : {}),
    })
    // In the style's source order, not in the order the requests finished
    // and only for sources a drawn layer uses
    const attributions = Object.entries(style.sources ?? {}).flatMap(([id, source]) => {
      const fetcher = fetchers.get(id)
      if (fetcher === undefined || !usedSources.has(id)) return []
      const attribution = source.attribution ?? fetcher.attribution
      return typeof attribution === 'string' ? [attribution] : []
    })
    return new MapStyleProcessor(drawable, fetchers, glyphs, await imagesPromise, skipped, attributions)
  }

  /** Glyph atlas changes since the last call. Send them with (and before) the next bucket. */
  takeAtlasUpdate(): AtlasUpdate | null {
    return this.glyphs.atlas.takeUpdate()
  }

  /** Image atlas changes since the last call. Send them with (and before) the next result. */
  takeImageAtlasUpdate(): ImageAtlasUpdate | null {
    return this.images.atlas.takeUpdate()
  }

  /**
   * Adds or replaces (`image`) or removes (`null`) a runtime image. Tiles processed from now on use it; the
   * answer says whether tiles processed before must be rebuilt or only redrawn.
   */
  setImage(id: string, image: StyleImage | null): ImageChange {
    const rebuild = this.images.set(id, image)
    Object.assign(this.summary, this.backgroundPatterns())
    return { rebuild, backgroundPatternByZoom: this.summary.backgroundPatternByZoom, missingBackgroundImages: this.summary.missingBackgroundImages }
  }

  /** Tessellates one tile. The bucket's `atlas` is left null: the caller attaches `takeAtlasUpdate()`. */
  async processTile(request: TileRequest, signal?: AbortSignal): Promise<TileBucket> {
    const { sourceId, x, y, z, zoom } = request
    signal?.throwIfAborted()
    const tile = await this.getRawTile(sourceId, x, y, z, signal)
    signal?.throwIfAborted()
    if (tile === null) return { shapes: null, text: null, atlas: null, images: [], missingImages: [], byteLength: 0 }

    const unitsPerPixel = TILE_EXTENT / (TILE_SIZE_PIXELS * 2 ** (zoom - z))
    const placement: TilePlacement = { x, y, tileSizePixels: TILE_SIZE_PIXELS * 2 ** (zoom - z) }
    const images: TileImages = { used: new Set(), missing: new Set() }
    const shapes = new ShapeBuilder()
    const symbols: SymbolCandidate[] = []
    for (const layer of this.layers) {
      if (layer.source !== sourceId || layer.type === 'background' || !layer.isVisibleAtZoom(zoom)) continue
      const sourceLayer = layer.sourceLayer === undefined ? undefined : tile.layers[layer.sourceLayer]
      if (sourceLayer === undefined) continue
      const factor = TILE_EXTENT / sourceLayer.extent
      for (let index = 0; index < sourceLayer.length; index++) {
        const vectorFeature = sourceLayer.feature(index)
        const feature: StyleFeature = { type: vectorFeature.type, properties: vectorFeature.properties, id: vectorFeature.id }
        if (!layer.accepts(zoom, feature)) continue
        const geometry = scaleGeometry(vectorFeature.loadGeometry(), factor)
        if (layer.type === 'symbol') {
          const candidate = this.createSymbolCandidate(layer, feature, vectorFeature.type, geometry, zoom, symbols.length)
          if (candidate !== null) symbols.push(candidate)
        } else this.addShape(shapes, layer, feature, vectorFeature.type, geometry, zoom, unitsPerPixel, placement, images)
      }
    }
    const text = await this.layoutLabels(symbols, zoom, unitsPerPixel, signal)
    const shapeMesh = shapes.build()
    const byteLength =
      (shapeMesh === null ? 0 : shapeMesh.positions.byteLength + shapeMesh.colors.byteLength + shapeMesh.indices.byteLength) +
      (shapeMesh?.patterns == null ? 0 : shapeMesh.patterns.byteLength + (shapeMesh.patternCoordinates?.byteLength ?? 0)) +
      (text === null ? 0 : text.positions.byteLength * 2 + text.colors.byteLength * 2 + text.haloEdges.byteLength + text.indices.byteLength)
    return { shapes: shapeMesh, text, atlas: null, images: [...images.used], missingImages: [...images.missing], byteLength }
  }

  /**
   * The colour of the top-most background layer that draws at this zoom with a colour. Patterned layers draw
   * over it (`backgroundPatterns`).
   */
  protected backgroundAt(zoom: number): [number, number, number, number] | null {
    let color: [number, number, number, number] | null = null
    for (const layer of this.layers) {
      if (layer.type !== 'background' || !layer.isVisibleAtZoom(zoom)) continue
      if (patternName(layer, 'background-pattern', zoom) !== null) continue
      const opacity = layer.evaluate<number>('paint', 'background-opacity', zoom)
      const next = layer.evaluateColor('background-color', zoom, undefined, opacity)
      if (next[3] > 0) color = next
    }
    return color
  }

  /**
   * `background-pattern` per zoom: the top-most patterned background layer that draws, unless an opaque
   * colour layer above it covers it. Transparent layers and missing images are skipped (a missing image draws
   * nothing, as in MapLibre, and is listed). A translucent colour layer above a pattern draws under it: one
   * colour and one pattern per zoom is the limit.
   */
  protected backgroundPatterns(): Pick<MapStyleSummary, 'backgroundPatternByZoom' | 'missingBackgroundImages'> {
    const missing = new Set<string>()
    const backgroundPatternByZoom = Array.from({ length: MAXIMUM_ZOOM + 1 }, (_, zoom) => {
      let pattern: BackgroundPattern | null = null
      for (const layer of this.layers) {
        if (layer.type !== 'background' || !layer.isVisibleAtZoom(zoom)) continue
        const opacity = layer.evaluate<number>('paint', 'background-opacity', zoom)
        const name = patternName(layer, 'background-pattern', zoom)
        if (name === null) {
          if (layer.evaluateColor('background-color', zoom, undefined, opacity)[3] === 255) pattern = null
          continue
        }
        if (opacity <= 0) continue
        const rectangle = this.images.getPattern(name)
        if (rectangle === null) {
          if (this.images.isMissing(name)) missing.add(name)
          continue
        }
        pattern = { imageId: name, rectangle, opacity }
      }
      return pattern
    })
    return { backgroundPatternByZoom, missingBackgroundImages: [...missing] }
  }

  /** The pattern's place in the atlas, recording the lookup for the tile's image lists. */
  protected lookUpPattern(name: string, images: TileImages): PatternRectangle | null {
    images.used.add(name)
    const rectangle = this.images.getPattern(name)
    if (rectangle === null && this.images.isMissing(name)) images.missing.add(name)
    return rectangle
  }

  protected addShape(
    shapes: ShapeBuilder,
    layer: CompiledStyleLayer,
    feature: StyleFeature,
    type: VectorTileFeature['type'],
    geometry: Point[][],
    zoom: number,
    unitsPerPixel: number,
    placement: TilePlacement,
    images: TileImages,
  ): void {
    shapes.setGroup(layer.group)
    if (layer.type === 'fill' || layer.type === 'fill-extrusion') {
      if (type !== 3) return
      const prefix = layer.type
      const opacity = layer.evaluate<number>('paint', `${prefix}-opacity`, zoom, feature)
      const polygons = classifyRings(geometry as never, 500) as unknown as Point[][][]
      const pattern = patternName(layer, `${prefix}-pattern`, zoom, feature)
      if (pattern !== null) {
        // A patterned fill has no outline and no colour (MapLibre); a missing image draws nothing.
        const rectangle = this.lookUpPattern(pattern, images)
        if (rectangle === null || opacity <= 0) return
        shapes.setColor([255, 255, 255, Math.round(opacity * 255)])
        shapes.setPattern(rectangle, planePatternMapping(rectangle, placement, unitsPerPixel))
        shapes.addPolygons(polygons)
        shapes.setPattern(null)
        return
      }
      const color = layer.evaluateColor(`${prefix}-color`, zoom, feature, opacity)
      if (color[3] > 0) {
        shapes.setColor(color)
        shapes.addPolygons(polygons)
      }
      if (layer.type === 'fill' && layer.has('paint', 'fill-outline-color') && layer.evaluate<boolean>('paint', 'fill-antialias', zoom, feature)) {
        const outline = layer.evaluateColor('fill-outline-color', zoom, feature, opacity)
        if (outline[3] > 0) {
          shapes.setColor(outline)
          for (const ring of geometry) shapes.addLine(ring, { width: unitsPerPixel, join: 'miter' })
        }
      }
      return
    }
    if (layer.type === 'line') {
      if (type !== 2 && type !== 3) return
      const opacity = layer.evaluate<number>('paint', 'line-opacity', zoom, feature)
      let widthPixels = layer.evaluate<number>('paint', 'line-width', zoom, feature)
      const gapPixels = layer.evaluate<number>('paint', 'line-gap-width', zoom, feature)
      // Hairlines: draw one pixel wide and fade, as MapLibre's antialiasing does.
      const fade = widthPixels > 0 && widthPixels < 1 ? widthPixels : 1
      widthPixels = Math.max(widthPixels, widthPixels > 0 ? 1 : 0)
      const pattern = patternName(layer, 'line-pattern', zoom, feature)
      const rectangle = pattern === null ? null : this.lookUpPattern(pattern, images)
      if (pattern !== null && rectangle === null) return // missing image: nothing, as in MapLibre
      const color: [number, number, number, number] = rectangle !== null ? [255, 255, 255, Math.round(opacity * fade * 255)] : layer.evaluateColor('line-color', zoom, feature, opacity * fade)
      if (color[3] === 0 || widthPixels <= 0) return
      const width = widthPixels * unitsPerPixel
      // Dashes do not combine with a pattern (MapLibre).
      const dashes = rectangle === null && layer.has('paint', 'line-dasharray') ? layer.evaluate<number[] | { values: number[] }>('paint', 'line-dasharray', zoom, feature) : undefined
      const dashLengths = dashes === undefined ? undefined : (Array.isArray(dashes) ? dashes : dashes.values).map(length => length * width)
      shapes.setColor(color)
      shapes.setPattern(rectangle)
      for (const line of geometry) {
        shapes.addLine(line, {
          width,
          gapWidth: gapPixels * unitsPerPixel,
          offset: layer.evaluate<number>('paint', 'line-offset', zoom, feature) * unitsPerPixel,
          cap: layer.evaluate<LineCap>('layout', 'line-cap', zoom, feature),
          join: layer.evaluate<LineJoin>('layout', 'line-join', zoom, feature),
          miterLimit: layer.evaluate<number>('layout', 'line-miter-limit', zoom, feature),
          ...(dashLengths !== undefined ? { dashes: dashLengths } : {}),
        })
      }
      shapes.setPattern(null)
      return
    }
    if (layer.type === 'circle') {
      if (type !== 1) return
      const opacity = layer.evaluate<number>('paint', 'circle-opacity', zoom, feature)
      const radius = layer.evaluate<number>('paint', 'circle-radius', zoom, feature) * unitsPerPixel
      const strokeWidth = layer.evaluate<number>('paint', 'circle-stroke-width', zoom, feature) * unitsPerPixel
      const strokeOpacity = layer.evaluate<number>('paint', 'circle-stroke-opacity', zoom, feature)
      const color = layer.evaluateColor('circle-color', zoom, feature, opacity)
      const strokeColor = layer.evaluateColor('circle-stroke-color', zoom, feature, strokeOpacity)
      for (const ring of geometry) {
        for (const point of ring) {
          if (strokeWidth > 0 && strokeColor[3] > 0) {
            shapes.setColor(strokeColor)
            shapes.addCircle(point, radius + strokeWidth)
          }
          if (color[3] > 0) {
            shapes.setColor(color)
            shapes.addCircle(point, radius)
          }
        }
      }
    }
  }

  protected createSymbolCandidate(
    layer: CompiledStyleLayer,
    feature: StyleFeature,
    type: VectorTileFeature['type'],
    geometry: Point[][],
    zoom: number,
    order: number,
  ): SymbolCandidate | null {
    const field = layer.evaluate<Formatted | string | undefined>('layout', 'text-field', zoom, feature)
    if (field === undefined || field === null) return null
    // Legacy `{token}` strings (not expressions) substitute feature properties, as in MapLibre.
    const tokens = typeof layer.raw('layout', 'text-field') === 'string'
    const formatted = field instanceof Formatted ? field : Formatted.fromString(String(field))
    if (tokens) for (const section of formatted.sections) section.text = resolveTokens(section.text, feature.properties)
    if (formatted.isEmpty()) return null
    const fonts = layer.evaluate<string[]>('layout', 'text-font', zoom, feature)
    const fontStack = fonts.join(',')
    const transform = layer.evaluate<'none' | 'uppercase' | 'lowercase'>('layout', 'text-transform', zoom, feature)
    const sections = formatted.sections
      .filter(section => section.text.length > 0)
      .map(section => ({
        text: transform === 'uppercase' ? section.text.toLocaleUpperCase() : transform === 'lowercase' ? section.text.toLocaleLowerCase() : section.text,
        fontStack: section.fontStack ?? fontStack,
        scale: section.scale ?? 1,
      }))
    if (sections.length === 0) return null
    const sortKey = layer.has('layout', 'symbol-sort-key') ? (layer.evaluate<number | undefined>('layout', 'symbol-sort-key', zoom, feature) ?? 0) : 0
    return { layer, feature, type, geometry, sections, sortKey, order }
  }

  /**
   * Places labels, top-most style layer first (as MapLibre does), then by `symbol-sort-key`, skipping those
   * that collide with labels already placed in this tile.
   */
  protected async layoutLabels(symbols: SymbolCandidate[], zoom: number, unitsPerPixel: number, signal?: AbortSignal) {
    if (symbols.length === 0) return null
    const codePoints = new Map<string, Set<number>>()
    for (const { sections } of symbols) {
      for (const section of sections) {
        let set = codePoints.get(section.fontStack)
        if (set === undefined) codePoints.set(section.fontStack, (set = new Set()))
        for (const character of section.text) set.add(character.codePointAt(0)!)
      }
    }
    await Promise.all([...codePoints].map(([fontStack, set]) => this.glyphs.load(fontStack, set)))
    signal?.throwIfAborted()

    symbols.sort((a, b) => b.layer.index - a.layer.index || a.sortKey - b.sortKey || a.order - b.order)
    const collisions = new CollisionGrid()
    const text = new TextBuilder()
    const getGlyph = (fontStack: string, codePoint: number) => this.glyphs.get(fontStack, codePoint)
    for (const symbol of symbols) {
      const { layer, feature } = symbol
      const placement = layer.evaluate<'point' | 'line' | 'line-center'>('layout', 'symbol-placement', zoom, feature)
      const size = layer.evaluate<number>('layout', 'text-size', zoom, feature)
      const textScale = size / 24
      const pixelsToUnits = unitsPerPixel * textScale
      const paddingUnits = layer.evaluate<number>('layout', 'text-padding', zoom, feature) * unitsPerPixel
      const allowOverlap = layer.evaluate<boolean>('layout', 'text-allow-overlap', zoom, feature)
      const ignorePlacement = layer.evaluate<boolean>('layout', 'text-ignore-placement', zoom, feature)
      const opacity = layer.evaluate<number>('paint', 'text-opacity', zoom, feature)
      const paint = {
        color: layer.evaluateColor('text-color', zoom, feature, opacity),
        haloColor: toRgba(layer.evaluate<Color>('paint', 'text-halo-color', zoom, feature), opacity),
        haloWidthPixels: layer.evaluate<number>('paint', 'text-halo-width', zoom, feature),
      }
      if (paint.color[3] === 0 && paint.haloColor[3] === 0) continue
      const lineHeightEms = layer.evaluate<number>('layout', 'text-line-height', zoom, feature)
      const letterSpacingEms = layer.evaluate<number>('layout', 'text-letter-spacing', zoom, feature)
      const tryPlace = (quads: Parameters<TextBuilder['addLabel']>[0], boxes: Box[]): void => {
        if (!allowOverlap && collisions.overlaps(boxes)) return
        if (!ignorePlacement) collisions.insert(boxes)
        text.addLabel(quads, paint, textScale)
      }

      if (placement === 'point') {
        const anchor = representativePoint(symbol.type, symbol.geometry)
        if (anchor === null || anchor.x < 0 || anchor.y < 0 || anchor.x >= TILE_EXTENT || anchor.y >= TILE_EXTENT) continue
        const shaped = shapeText(
          symbol.sections,
          {
            maximumWidthEms: layer.evaluate<number>('layout', 'text-max-width', zoom, feature),
            lineHeightEms,
            letterSpacingEms,
            anchor: firstAnchor(layer, zoom, feature),
            justify: layer.evaluate<TextJustify>('layout', 'text-justify', zoom, feature),
          },
          getGlyph,
        )
        if (shaped === null) continue
        const [offsetX = 0, offsetY = 0] = layer.evaluate<number[]>('layout', 'text-offset', zoom, feature)
        const rotation = (layer.evaluate<number>('layout', 'text-rotate', zoom, feature) * Math.PI) / 180
        const { quads, boxes } = layoutPointLabel(shaped, anchor, pixelsToUnits, { x: offsetX * 24, y: offsetY * 24 }, rotation, paddingUnits)
        tryPlace(quads, boxes)
        continue
      }

      if (symbol.type === 1) continue
      const shaped = shapeText(symbol.sections, { maximumWidthEms: 0, lineHeightEms, letterSpacingEms, anchor: 'center', justify: 'center' }, getGlyph)
      if (shaped === null) continue
      const options = {
        pixelsToUnits,
        spacingUnits: layer.evaluate<number>('layout', 'symbol-spacing', zoom, feature) * unitsPerPixel,
        maximumAngleRadians: (layer.evaluate<number>('layout', 'text-max-angle', zoom, feature) * Math.PI) / 180,
        keepUpright: layer.evaluate<boolean>('layout', 'text-keep-upright', zoom, feature),
        paddingUnits,
        center: placement === 'line-center',
        extent: TILE_EXTENT,
      }
      for (const line of symbol.geometry) {
        for (const { quads, boxes } of layoutLineLabels(shaped, line, options)) tryPlace(quads, boxes)
      }
    }
    return text.build()
  }

  /**
   * Forgets raw tiles overlapping the rectangles (`null`: every tile), so the next request fetches them again.
   * Requests already waiting on a forgotten tile still get it.
   */
  invalidate(rectangles: readonly MercatorRectangle[] | null): void {
    for (const [key, tile] of this.fetchedTiles) if (tileOverlaps(tile.x, tile.y, tile.z, rectangles)) this.revalidatedTiles.add(key)
    for (const fetcher of this.fetchers.values()) fetcher.invalidate?.()
    for (const [key, entry] of this.rawTiles) {
      if (tileOverlaps(entry.x, entry.y, entry.z, rectangles)) this.rawTiles.delete(key)
    }
  }

  /** Fetches and decodes a tile once, shared by concurrent requests; aborted only when every waiter is. */
  protected getRawTile(sourceId: string, x: number, y: number, z: number, signal?: AbortSignal): Promise<VectorTile | null> {
    const fetcher = this.fetchers.get(sourceId)
    if (fetcher === undefined) return Promise.resolve(null)
    const key = `${sourceId}/${z}/${x}/${y}`
    let entry = this.rawTiles.get(key)
    if (entry === undefined) {
      const controller = new AbortController()
      const revalidate = this.revalidatedTiles.delete(key)
      const created: RawTileEntry = {
        x,
        y,
        z,
        controller,
        waiters: 0,
        promise: fetcher.fetchTile(x, y, z, controller.signal, revalidate).then(bytes => (bytes === null ? null : new VectorTile(new Pbf(bytes)))),
      }
      created.promise.catch(() => {
        if (revalidate) this.revalidatedTiles.add(key) // an aborted or failed refetch must not use up the revalidation
        if (this.rawTiles.get(key) === created) this.rawTiles.delete(key) // retry next time
      })
      this.rawTiles.set(key, created)
      this.fetchedTiles.delete(key)
      this.fetchedTiles.set(key, { x, y, z })
      if (this.fetchedTiles.size > 4096) this.fetchedTiles.delete(this.fetchedTiles.keys().next().value!)
      entry = created
      if (this.rawTiles.size > RAW_TILE_CACHE_SIZE) {
        for (const [oldKey, old] of this.rawTiles) {
          if (this.rawTiles.size <= RAW_TILE_CACHE_SIZE) break
          if (old.waiters === 0) this.rawTiles.delete(oldKey)
        }
      }
    } else {
      // Most recently used last.
      this.rawTiles.delete(key)
      this.rawTiles.set(key, entry)
    }
    const shared = entry
    shared.waiters++
    const onAbort = () => {
      shared.waiters--
      if (shared.waiters === 0) {
        shared.controller.abort(signal?.reason)
        if (this.rawTiles.get(key) === shared) this.rawTiles.delete(key)
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    return shared.promise.finally(() => {
      if (signal?.aborted !== true) {
        signal?.removeEventListener('abort', onAbort)
        shared.waiters--
      }
    })
  }
}

/** The image a `*-pattern` property names, or null when it is not set or empty. */
function patternName(layer: CompiledStyleLayer, property: string, zoom: number, feature?: StyleFeature): string | null {
  if (!layer.has('paint', property)) return null
  const value = layer.evaluate<{ name: string } | string | undefined | null>('paint', property, zoom, feature)
  const name = typeof value === 'string' ? value : value?.name
  return name === undefined || name === '' ? null : name
}

/**
 * A fill pattern's mapping for one tile: `pixelRatio` image pixels per map pixel, anchored to the world's
 * top-left corner so patterns continue across tiles. The tile's offset into the repeating image is reduced
 * here, in 64-bit, so 32-bit vertex coordinates stay small at any zoom.
 */
export function planePatternMapping(rectangle: PatternRectangle, placement: TilePlacement, unitsPerPixel: number) {
  const imagePixelsPerMapPixel = rectangle.pixelRatio
  const originX = positiveModulo(placement.x * placement.tileSizePixels * imagePixelsPerMapPixel, rectangle.width)
  const originY = positiveModulo(placement.y * placement.tileSizePixels * imagePixelsPerMapPixel, rectangle.height)
  return { kind: 'plane' as const, imagePixelsPerUnit: imagePixelsPerMapPixel / unitsPerPixel, originX, originY }
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus
}

function scaleGeometry(geometry: Point[][], factor: number): Point[][] {
  if (factor === 1) return geometry
  return geometry.map(ring => ring.map(point => ({ x: point.x * factor, y: point.y * factor })))
}

/** Where a point-placed label goes: the point itself, the middle of a line, the centre of a polygon's box. */
function representativePoint(type: VectorTileFeature['type'], geometry: Point[][]): Point | null {
  const first = geometry[0]
  if (first === undefined || first.length === 0) return null
  if (type === 1) return first[0]!
  if (type === 2) {
    let total = 0
    for (let index = 1; index < first.length; index++) total += Math.hypot(first[index]!.x - first[index - 1]!.x, first[index]!.y - first[index - 1]!.y)
    let remaining = total / 2
    for (let index = 1; index < first.length; index++) {
      const a = first[index - 1]!
      const b = first[index]!
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      if (remaining <= length && length > 0) return { x: a.x + ((b.x - a.x) * remaining) / length, y: a.y + ((b.y - a.y) * remaining) / length }
      remaining -= length
    }
    return first.at(-1)!
  }
  let minimumX = Infinity
  let minimumY = Infinity
  let maximumX = -Infinity
  let maximumY = -Infinity
  for (const { x, y } of first) {
    minimumX = Math.min(minimumX, x)
    minimumY = Math.min(minimumY, y)
    maximumX = Math.max(maximumX, x)
    maximumY = Math.max(maximumY, y)
  }
  return { x: (minimumX + maximumX) / 2, y: (minimumY + maximumY) / 2 }
}

function firstAnchor(layer: CompiledStyleLayer, zoom: number, feature: StyleFeature): TextAnchor {
  if (layer.has('layout', 'text-variable-anchor')) {
    const anchors = layer.evaluate<TextAnchor[] | undefined>('layout', 'text-variable-anchor', zoom, feature)
    if (anchors !== undefined && anchors.length > 0) return anchors[0]!
  }
  return layer.evaluate<TextAnchor>('layout', 'text-anchor', zoom, feature)
}

/** Replaces `{name}` with the feature's `name` property (empty when missing). */
export function resolveTokens(text: string, properties: Record<string, unknown>): string {
  return text.replace(/{([^{}]+)}/g, (_, key: string) => {
    const value = properties[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

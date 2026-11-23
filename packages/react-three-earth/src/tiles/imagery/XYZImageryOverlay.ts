import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import type { Texture } from 'three'

import { composeRegionsOnGpu, type GpuRegionComposition, type NormalizedRange, type TiledRegionImageSourceLike } from './composeRegionsOnGpu.js'
import type { ImageryCompositor } from './ImageryCompositor.js'

/** An overlay that composes on the GPU when the plugin it is added to gives it a compositor. */
export interface GpuComposedOverlay {
  compositor: ImageryCompositor | null
}

/** Whether an overlay takes a compositor. */
export function isGpuComposedOverlay(overlay: unknown): overlay is GpuComposedOverlay {
  return typeof overlay === 'object' && overlay !== null && 'compositor' in overlay
}

/** What a TileJSON document gives an XYZ overlay. */
export interface TileJsonInfo {
  /** The first tile URL template, absolute, with a TMS `scheme` turned into `{-y}`. */
  url: string
  /** `maxzoom + 1`, when the TileJSON has a `maxzoom`. */
  levels: number | undefined
  attribution: string | undefined
}

/** Options of 3DTilesRenderer's `XYZTilesOverlay`, plus a TileJSON document to read the tiles from. */
export type XYZImageryOverlayOptions = ConstructorParameters<typeof XYZTilesOverlay>[0] & {
  /** A TileJSON URL: its `tiles`, `maxzoom` and `scheme` replace `url` and `levels` when the overlay starts. */
  tileJsonUrl?: string
  /** Called once the TileJSON is read, before tiles load (for its attribution). */
  onTileJson?: (info: TileJsonInfo) => void
}

/** Reads a TileJSON document's tile template, zoom levels and attribution. Throws an error that states the fix. */
export function readTileJson(tileJson: unknown, tileJsonUrl: string): TileJsonInfo {
  const { tiles, maxzoom, scheme, attribution } = (tileJson ?? {}) as { tiles?: unknown; maxzoom?: unknown; scheme?: unknown; attribution?: unknown }
  const template = Array.isArray(tiles) ? tiles.find((entry): entry is string => typeof entry === 'string') : undefined
  if (template === undefined) throw new Error(`RasterTileSource: the TileJSON at ${tileJsonUrl} has no \`tiles\`; pass a TileJSON with a tile URL template, or the template itself as \`url\`.`)
  // `new URL` percent-encodes braces: protect the placeholders through the resolution.
  const absolute = new URL(template.replace(/{/g, '__open__').replace(/}/g, '__close__'), tileJsonUrl).href.replace(/__open__/g, '{').replace(/__close__/g, '}')
  return {
    url: scheme === 'tms' ? absolute.replace(/{y}/g, '{-y}') : absolute,
    levels: typeof maxzoom === 'number' ? maxzoom + 1 : undefined,
    attribution: typeof attribution === 'string' ? attribution : undefined,
  }
}

/**
 * 3DTilesRenderer's `XYZTilesOverlay`, composing each terrain tile's texture on the GPU instead of on a
 * main-thread canvas. Source tiles are still fetched and decoded upstream (`createImageBitmap`, which decodes
 * off the main thread).
 */
export class XYZImageryOverlay extends XYZTilesOverlay implements GpuComposedOverlay {
  /** Set by `ImageOverlayPlugin` when the overlay is added to it. Null composes on a canvas, as upstream. */
  compositor: ImageryCompositor | null = null

  declare regionImageSource: TiledRegionImageSourceLike | null
  declare imageSource: { url: string; levels: number | unknown[] }
  /** Upstream `ImageOverlay.fetch`: goes through 3DTilesRenderer's download queue and `preprocessURL`. */
  declare fetch: (url: string, options?: RequestInit) => Promise<Response>
  protected regionComposition: GpuRegionComposition | null = null
  protected readonly tileJsonUrl: string | undefined
  protected readonly onTileJson: ((info: TileJsonInfo) => void) | undefined
  /** Whether the app gave `levels`: then the TileJSON's `maxzoom` does not replace them. */
  protected readonly levelsGiven: boolean

  constructor({ tileJsonUrl, onTileJson, ...options }: XYZImageryOverlayOptions) {
    super(options)
    this.tileJsonUrl = tileJsonUrl
    this.onTileJson = onTileJson
    this.levelsGiven = options.levels !== undefined
  }

  // Upstream `TiledImageOverlay._init` creates the region source; it is private API (pinned to 0.5.x).
  async _init(): Promise<void> {
    if (this.tileJsonUrl !== undefined) await this.loadTileJson(this.tileJsonUrl)
    await upstream._init.call(this)
    if (this.regionImageSource !== null) this.regionComposition = composeRegionsOnGpu(this.regionImageSource, () => this.compositor)
  }

  /**
   * Points the image source at the TileJSON's tiles before upstream initialises it. Its `minzoom` and `bounds` are
   * not read: tiles outside them are requested and answer 404 (drawn as nothing).
   */
  protected async loadTileJson(tileJsonUrl: string): Promise<void> {
    const response = await this.fetch(tileJsonUrl, this.fetchOptions ?? {})
    if (!response.ok) throw new Error(`RasterTileSource: the TileJSON at ${tileJsonUrl} answered ${response.status}; check the URL.`)
    const info = readTileJson(await response.json(), tileJsonUrl)
    this.imageSource.url = info.url
    if (!this.levelsGiven && info.levels !== undefined) this.imageSource.levels = info.levels
    this.onTileJson?.(info)
  }

  // 3DTilesRenderer calls this when it starts waiting for a terrain tile's texture (in its priority order,
  // visible tiles first), well after locking it at download start. Pinned to 0.5.x like `_init`.
  getTexture(range: NormalizedRange, level = upstream.calculateLevel.call(this, range)): Promise<Texture | null> | Texture | null {
    this.regionComposition?.prioritize([...range, level])
    return upstream.getTexture.call(this, range, level)
  }
}

/** Upstream `TiledImageOverlay` methods this class wraps. */
interface UpstreamInternals {
  _init(this: XYZImageryOverlay): Promise<void>
  calculateLevel(this: XYZImageryOverlay, range: NormalizedRange): number
  getTexture(this: XYZImageryOverlay, range: NormalizedRange, level: number): Promise<Texture | null> | Texture | null
}

const upstream = XYZTilesOverlay.prototype as unknown as UpstreamInternals

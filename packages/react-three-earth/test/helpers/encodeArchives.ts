import { zxyToTileId } from 'pmtiles'

function varint(out: number[], value: number): void {
  let remaining = value
  while (remaining > 0x7f) {
    out.push((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  out.push(remaining)
}

function field(out: number[], tag: number, bytes: number[]): void {
  varint(out, (tag << 3) | 2)
  varint(out, bytes.length)
  out.push(...bytes)
}

function varintField(out: number[], tag: number, value: number): void {
  varint(out, tag << 3)
  varint(out, value)
}

export interface TestGlyph {
  id: number
  width: number
  height: number
  left: number
  top: number
  advance: number
}

/** A glyph range PBF with solid bitmaps (every byte 255), as a glyph server would send. */
export function encodeGlyphRange(fontStack: string, range: string, glyphs: TestGlyph[]): Uint8Array {
  const stack: number[] = []
  field(stack, 1, [...new TextEncoder().encode(fontStack)])
  field(stack, 2, [...new TextEncoder().encode(range)])
  for (const glyph of glyphs) {
    const bytes: number[] = []
    varintField(bytes, 1, glyph.id)
    if (glyph.width > 0) field(bytes, 2, new Array((glyph.width + 6) * (glyph.height + 6)).fill(255))
    varintField(bytes, 3, glyph.width)
    varintField(bytes, 4, glyph.height)
    varintField(bytes, 5, (glyph.left << 1) ^ (glyph.left >> 31))
    varintField(bytes, 6, (glyph.top << 1) ^ (glyph.top >> 31))
    varintField(bytes, 7, glyph.advance)
    field(stack, 3, bytes)
  }
  const out: number[] = []
  field(out, 1, stack)
  return new Uint8Array(out)
}

/** An uncompressed PMTiles v3 archive (one root directory, no leaves) of MVT tiles, or of images with `tileType` 2 (PNG). */
export function encodePMTiles(tiles: Array<{ z: number; x: number; y: number; data: Uint8Array }>, minimumZoom: number, maximumZoom: number, metadataJson = '{}', tileType = 1): Uint8Array {
  const entries = tiles.map(tile => ({ id: zxyToTileId(tile.z, tile.x, tile.y), data: tile.data })).sort((a, b) => a.id - b.id)
  const directory: number[] = []
  varint(directory, entries.length)
  let previousId = 0
  for (const entry of entries) {
    varint(directory, entry.id - previousId)
    previousId = entry.id
  }
  for (let index = 0; index < entries.length; index++) varint(directory, 1) // run lengths
  for (const entry of entries) varint(directory, entry.data.length)
  entries.forEach((entry, index) => varint(directory, index === 0 ? 1 : 0)) // offset + 1, then contiguous
  const metadata = [...new TextEncoder().encode(metadataJson)]
  const headerLength = 127
  const rootOffset = headerLength
  const metadataOffset = rootOffset + directory.length
  const dataOffset = metadataOffset + metadata.length
  const dataLength = entries.reduce((sum, entry) => sum + entry.data.length, 0)
  const archive = new Uint8Array(dataOffset + dataLength)
  const view = new DataView(archive.buffer)
  archive.set(new TextEncoder().encode('PMTiles'), 0)
  archive[7] = 3
  const u64 = (offset: number, value: number) => view.setBigUint64(offset, BigInt(value), true)
  u64(8, rootOffset)
  u64(16, directory.length)
  u64(24, metadataOffset)
  u64(32, metadata.length)
  u64(40, 0)
  u64(48, 0)
  u64(56, dataOffset)
  u64(64, dataLength)
  u64(72, entries.length)
  u64(80, entries.length)
  u64(88, entries.length)
  archive[96] = 1 // clustered
  archive[97] = 1 // internal compression: none
  archive[98] = 1 // tile compression: none
  archive[99] = tileType // 1: MVT, 2: PNG
  archive[100] = minimumZoom
  archive[101] = maximumZoom
  view.setInt32(102, -180e7, true)
  view.setInt32(106, -85e7, true)
  view.setInt32(110, 180e7, true)
  view.setInt32(114, 85e7, true)
  archive[118] = minimumZoom
  archive.set(directory, rootOffset)
  archive.set(metadata, metadataOffset)
  let offset = dataOffset
  for (const entry of entries) {
    archive.set(entry.data, offset)
    offset += entry.data.length
  }
  return archive
}

/** A fetch that serves a map of URL → bytes or JSON, with HTTP range support, and records requests. */
export function createFakeFetch(files: Record<string, Uint8Array | object>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({ url, headers })
    init?.signal?.throwIfAborted()
    const file = files[url]
    if (file === undefined) return new Response(null, { status: 404 })
    if (!(file instanceof Uint8Array)) return new Response(JSON.stringify(file), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const range = /bytes=(\d+)-(\d+)/.exec(headers.range ?? '')
    if (range === null) return new Response(file as BodyInit, { status: 200 })
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), file.length - 1)
    return new Response(file.slice(start, end + 1) as BodyInit, { status: 206 })
  }) as typeof fetch
  return { fetch: fakeFetch, requests }
}

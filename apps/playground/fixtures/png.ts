import { deflateSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Encodes an RGBA image (straight alpha) as PNG. */
export function encodePngRgba(width: number, height: number, rgba: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x++) raw.set(rgba(x, y), y * (width * 4 + 1) + 1 + x * 4)
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8) // 8 bits, RGBA
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Encodes an RGB image as PNG. */
export function encodePng(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y)
      const o = y * (width * 3 + 1) + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const header = new Uint8Array(13)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, width)
  hv.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let p = 0
  for (const part of parts) { out.set(part, p); p += part.length }
  return out
}

/** A Web Mercator XYZ tile: colour bands by latitude, a grid at tile edges, so seams and offsets are visible. */
export function imageryTile(z: number, x: number, y: number): Uint8Array {
  const size = 256
  return encodePng(size, size, (px, py) => {
    const edge = px < 2 || py < 2
    if (edge) return [255, 255, 255]
    const n = Math.PI - (2 * Math.PI * (y + py / size)) / 2 ** z
    const latitude = (180 / Math.PI) * Math.atan(Math.sinh(n))
    const longitude = ((x + px / size) / 2 ** z) * 360 - 180
    const band = Math.floor((latitude + 90) / 10) % 2
    const checker = (Math.floor((longitude + 180) / 10) + band) % 2
    return checker ? [46, 125, 50] : [139, 195, 74]
  })
}

/**
 * A minimal Mapbox Vector Tile (MVT 2.1) encoder for tests and playground fixtures.
 * https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 */

export interface EncodedFeature {
  type: 'Point' | 'LineString' | 'Polygon'
  /** Point: one ring of points. LineString: lines. Polygon: rings (outer clockwise in tile space, y down). */
  geometry: Array<Array<[number, number]>>
  properties?: Record<string, string | number | boolean>
  id?: number
}

export interface EncodedLayer {
  name: string
  features: EncodedFeature[]
  extent?: number
}

class Writer {
  bytes: number[] = []
  varint(value: number): void {
    let remaining = value
    while (remaining > 0x7f) {
      this.bytes.push((remaining & 0x7f) | 0x80)
      remaining = Math.floor(remaining / 128)
    }
    this.bytes.push(remaining)
  }
  tag(field: number, wireType: number): void {
    this.varint((field << 3) | wireType)
  }
  bytesField(field: number, bytes: number[]): void {
    this.tag(field, 2)
    this.varint(bytes.length)
    this.bytes.push(...bytes)
  }
  stringField(field: number, value: string): void {
    this.bytesField(field, [...new TextEncoder().encode(value)])
  }
  varintField(field: number, value: number): void {
    this.tag(field, 0)
    this.varint(value)
  }
  packedField(field: number, values: number[]): void {
    const inner = new Writer()
    for (const value of values) inner.varint(value)
    this.bytesField(field, inner.bytes)
  }
}

const zigzag = (value: number) => (value << 1) ^ (value >> 31)
const command = (id: number, count: number) => (id & 7) | (count << 3)

function encodeGeometry(feature: EncodedFeature): number[] {
  const out: number[] = []
  let cursorX = 0
  let cursorY = 0
  const move = (x: number, y: number) => {
    out.push(zigzag(Math.round(x) - cursorX), zigzag(Math.round(y) - cursorY))
    cursorX = Math.round(x)
    cursorY = Math.round(y)
  }
  if (feature.type === 'Point') {
    const points = feature.geometry[0] ?? []
    out.push(command(1, points.length))
    for (const [x, y] of points) move(x, y)
    return out
  }
  for (const ring of feature.geometry) {
    const points = feature.type === 'Polygon' && ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring
    out.push(command(1, 1))
    move(points[0]![0], points[0]![1])
    out.push(command(2, points.length - 1))
    for (const [x, y] of points.slice(1)) move(x, y)
    if (feature.type === 'Polygon') out.push(command(7, 1))
  }
  return out
}

/** Encodes layers into one tile. */
export function encodeVectorTile(layers: EncodedLayer[]): Uint8Array {
  const tile = new Writer()
  for (const layer of layers) {
    const keys: string[] = []
    const values: Array<string | number | boolean> = []
    const index = <T>(list: T[], value: T) => {
      let found = list.indexOf(value)
      if (found === -1) found = list.push(value) - 1
      return found
    }
    const writer = new Writer()
    writer.varintField(15, 2)
    writer.stringField(1, layer.name)
    for (const feature of layer.features) {
      const featureWriter = new Writer()
      if (feature.id !== undefined) featureWriter.varintField(1, feature.id)
      const tags: number[] = []
      for (const [key, value] of Object.entries(feature.properties ?? {})) tags.push(index(keys, key), index(values, value))
      if (tags.length > 0) featureWriter.packedField(2, tags)
      featureWriter.varintField(3, feature.type === 'Point' ? 1 : feature.type === 'LineString' ? 2 : 3)
      featureWriter.packedField(4, encodeGeometry(feature))
      writer.bytesField(2, featureWriter.bytes)
    }
    for (const key of keys) writer.stringField(3, key)
    for (const value of values) {
      const valueWriter = new Writer()
      if (typeof value === 'string') valueWriter.stringField(1, value)
      else if (typeof value === 'boolean') valueWriter.varintField(7, value ? 1 : 0)
      else if (Number.isInteger(value) && value >= 0) valueWriter.varintField(5, value)
      else {
        valueWriter.tag(3, 1)
        const buffer = new DataView(new ArrayBuffer(8))
        buffer.setFloat64(0, value, true)
        valueWriter.bytes.push(...new Uint8Array(buffer.buffer))
      }
      writer.bytesField(4, valueWriter.bytes)
    }
    writer.varintField(5, layer.extent ?? 4096)
    tile.bytesField(3, writer.bytes)
  }
  return new Uint8Array(tile.bytes)
}

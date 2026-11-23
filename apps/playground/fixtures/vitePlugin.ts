
import type { Plugin } from 'vite'

import { imageryTile } from './png.ts'
import { encodeQuantizedMeshTile, layerJson } from './quantizedMesh.ts'
import { terrariumTile } from './dem.ts'
import { fixtureLabelStyle, fixturePatternStyle, fixtureReliefStyle, fixtureSprite, fixtureStyle, vectorTile } from './vectorTiles.ts'

/**
 * Serves synthetic terrain at /fixtures/terrain/, imagery at /fixtures/imagery/{z}/{x}/{y}.png, and a vector
 * map style at /fixtures/style.json (tiles at /fixtures/vector/{z}/{x}/{y}.pbf), so the playground runs with
 * no network.
 *
 * `/fixtures/style-labels.json` adds a dense grid of town labels (layer `towns`), for collision and fades.
 *
 * `/fixtures/style-patterns.json` is the same style with patterns, from the sprite at /fixtures/sprite.json
 * (and `@2x`).
 *
 * `/fixtures/style-relief.json` adds a raster layer of the imagery, colour relief and hillshade from Terrarium
 * elevation tiles at /fixtures/dem/{z}/{x}/{y}.png (`?only=hillshade`: the hillshade alone, on mid-grey). The DEM tiles
 * with `?plain` hold the quantized-mesh terrain's heights alone, for terrain from raster-dem.
 *
 * `/fixtures/style.json?live` reads /fixtures/vector-live/ instead, whose lakes take the colour set with
 * `/fixtures/vector-live/water-color?value=%23e0457b` (empty: the style's blue), for the invalidate check.
 */
export function fixtureTiles(): Plugin {
  let liveWaterColor: string | undefined
  return {
    name: 'react-three-earth-fixture-tiles',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        if (url === '/fixtures/terrain/layer.json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(layerJson()))
          return
        }
        const terrain = /^\/fixtures\/terrain\/(\d+)\/(\d+)\/(\d+)\.terrain$/.exec(url)
        if (terrain) {
          const [, z, x, y] = terrain.map(Number)
          res.setHeader('Content-Type', 'application/vnd.quantized-mesh')
          res.end(Buffer.from(encodeQuantizedMeshTile(z ?? 0, x ?? 0, y ?? 0)))
          return
        }
        const imagery = /^\/fixtures\/imagery\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url)
        if (imagery) {
          const [, z, x, y] = imagery.map(Number)
          res.setHeader('Content-Type', 'image/png')
          res.end(Buffer.from(imageryTile(z ?? 0, x ?? 0, y ?? 0)))
          return
        }
        if (url === '/fixtures/style.json') {
          const live = new URLSearchParams(req.url?.split('?')[1] ?? '').has('live')
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(fixtureStyle({ live })))
          return
        }
        if (url === '/fixtures/style-labels.json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(fixtureLabelStyle()))
          return
        }
        if (url === '/fixtures/style-relief.json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(fixtureReliefStyle({ only: new URLSearchParams(req.url?.split('?')[1] ?? '').get('only') })))
          return
        }
        const dem = /^\/fixtures\/dem\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url)
        if (dem) {
          const [, z, x, y] = dem.map(Number)
          res.setHeader('Content-Type', 'image/png')
          const plain = new URLSearchParams(req.url?.split('?')[1] ?? '').has('plain')
          res.end(Buffer.from(terrariumTile(z ?? 0, x ?? 0, y ?? 0, { hills: !plain })))
          return
        }
        if (url === '/fixtures/style-patterns.json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(fixturePatternStyle()))
          return
        }
        const sprite = /^\/fixtures\/sprite(@2x)?\.(json|png)$/.exec(url)
        if (sprite) {
          const { json, png } = fixtureSprite(sprite[1] === undefined ? 1 : 2)
          res.setHeader('Content-Type', sprite[2] === 'json' ? 'application/json' : 'image/png')
          res.end(sprite[2] === 'json' ? JSON.stringify(json) : Buffer.from(png))
          return
        }
        if (url === '/fixtures/vector-live/water-color') {
          liveWaterColor = new URLSearchParams(req.url?.split('?')[1] ?? '').get('value') || undefined
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ waterColor: liveWaterColor ?? null }))
          return
        }
        const live = /^\/fixtures\/vector-live\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url)
        if (live) {
          const [, z, x, y] = live.map(Number)
          res.setHeader('Content-Type', 'application/x-protobuf')
          res.setHeader('Cache-Control', 'no-store')
          res.end(Buffer.from(vectorTile(z ?? 0, x ?? 0, y ?? 0, liveWaterColor)))
          return
        }
        const vector = /^\/fixtures\/vector\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url)
        if (vector) {
          const [, z, x, y] = vector.map(Number)
          res.setHeader('Content-Type', 'application/x-protobuf')
          res.end(Buffer.from(vectorTile(z ?? 0, x ?? 0, y ?? 0)))
          return
        }
        next()
      })
    },
  }
}

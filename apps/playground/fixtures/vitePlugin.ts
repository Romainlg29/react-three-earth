import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import type { Plugin } from 'vite'

import { imageryTile } from './png'
import { encodeQuantizedMeshTile, layerJson } from './quantizedMesh'

/**
 * Serves synthetic terrain at /fixtures/terrain/, imagery at /fixtures/imagery/{z}/{x}/{y}.png, and the
 * atmosphere's star catalogue and blue noise, so the playground runs with no network.
 */
export function fixtureTiles(): Plugin {
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
        if (url === '/fixtures/stars.bin') {
          // Shipped inside the npm package, so no network is needed
          const require = createRequire(join(process.cwd(), '../../packages/react-three-earth/package.json'))
          const root = join(dirname(require.resolve('@takram/three-atmosphere')), '..')
          res.end(readFileSync(join(root, 'assets/stars.bin')))
          return
        }
        if (url === '/fixtures/blue-noise.bin') {
          // Stand-in for takram's stbn.bin (not in its npm package): deterministic white noise, same size
          const bytes = new Uint8Array(128 * 128 * 64)
          let seed = 1
          for (let i = 0; i < bytes.length; i++) bytes[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24
          res.end(Buffer.from(bytes))
          return
        }
        next()
      })
    },
  }
}

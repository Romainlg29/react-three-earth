// An example plugin for draped layers: a glow around a selected place, draped on the terrain above every
// imagery layer. It is static: `select` redraws only the regions around the old and the new place.
import { PLUGIN_API_VERSION, type DrapedLayerHandle, type EarthPlugin, type GeographicBounds, type GeographicPosition } from 'react-three-earth'
import { Color, Mesh, NoBlending, PlaneGeometry, Scene } from 'three'
import { smoothstep, uniform, uv, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

export interface SelectionGlowOptions {
  /** Default: '#ff2bd6'. */
  color?: string
  /** Default: 3000. */
  radiusMeters?: number
}

export interface SelectionGlowPlugin extends EarthPlugin {
  /** Glows around `position`, or nowhere with null. */
  select(position: GeographicPosition | null): void
  readonly selected: GeographicPosition | null
}

const METERS_PER_DEGREE_OF_LATITUDE = 111_320

export function selectionGlow({ color = '#ff2bd6', radiusMeters = 3000 }: SelectionGlowOptions = {}): SelectionGlowPlugin {
  let selected: GeographicPosition | null = null
  let handle: DrapedLayerHandle | null = null
  const boundsAround = ({ longitudeDegrees, latitudeDegrees }: GeographicPosition): GeographicBounds => {
    const latitudeSpan = radiusMeters / METERS_PER_DEGREE_OF_LATITUDE
    const longitudeSpan = latitudeSpan / Math.max(Math.cos((latitudeDegrees * Math.PI) / 180), 0.01)
    return { westDegrees: longitudeDegrees - longitudeSpan, southDegrees: latitudeDegrees - latitudeSpan, eastDegrees: longitudeDegrees + longitudeSpan, northDegrees: latitudeDegrees + latitudeSpan }
  }

  // One quad, drawn with no blending into the cleared region: its colour and straight alpha land as they are.
  const colorUniform = uniform(new Color(color))
  const material = new MeshBasicNodeMaterial({ blending: NoBlending, depthTest: false, depthWrite: false })
  const distance = uv().sub(0.5).length().mul(2) // 0 at the centre, 1 on the circle
  material.colorNode = vec4(colorUniform, smoothstep(1, 0, distance).pow(1.5))
  const quad = new Mesh(new PlaneGeometry(1, 1), material)
  quad.frustumCulled = false
  const scene = new Scene()
  scene.add(quad)

  return {
    name: 'selection-glow',
    apiVersion: PLUGIN_API_VERSION,
    get selected() {
      return selected
    },
    select(position) {
      const before = selected
      selected = position
      // Redraw where it was and where it is now.
      if (before !== null) handle?.invalidate(boundsAround(before))
      if (position !== null) handle?.invalidate(boundsAround(position))
    },
    install(context) {
      handle = context.registerDrapedLayer({
        id: 'selection-glow',
        bounds: () => (selected === null ? null : boundsAround(selected)),
        draw: ({ renderer, region }) => {
          if (selected === null) return
          const centre = region.project(selected)
          const north = region.project({ ...selected, latitudeDegrees: selected.latitudeDegrees + radiusMeters / METERS_PER_DEGREE_OF_LATITUDE })
          // Web Mercator is conformal: the circle has the same size in x and y in Mercator units.
          const radiusY = north.y - centre.y
          const [west, south, east, northEdge] = region.mercatorRange
          const radiusX = (radiusY * (northEdge - south)) / (east - west)
          quad.position.set(centre.x, centre.y, 0)
          quad.scale.set(radiusX * 2, radiusY * 2, 1)
          quad.updateMatrixWorld()
          renderer.render(scene, region.camera)
        },
      })
      context.onDispose(() => {
        handle = null
      })
    },
    uninstall() {
      quad.geometry.dispose()
      material.dispose()
    },
    inspect() {
      return { selected }
    },
  }
}

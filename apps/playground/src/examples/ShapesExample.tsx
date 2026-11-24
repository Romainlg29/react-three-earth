import type { Earth as EarthImpl } from 'react-three-earth'
import { Imagery, MapStyleSource } from 'react-three-earth/react'
import {
  CircleMode,
  createCircle,
  createRectangle,
  createRegularPolygon,
  createSphere,
  destination,
  Draw,
  LineStringMode,
  PolygonMode,
  RectangleMode,
  SelectMode,
  SphereMode,
  StaticMode,
  wallMesh,
  type GroundHeight,
} from 'react-three-earth-draw'
import { useDrawState } from 'react-three-earth-draw/react'
import { useEffect, useMemo, useState } from 'react'

import { rasterBasemapStyle } from './data'
import { DrawGizmoToolbar, GIZMO_HELP } from './DrawGizmoToolbar'
import { ExampleShell } from './ExampleShell'

const CENTER: [number, number] = [6.6, 46.45]

const TOOLS = [
  { mode: 'static', label: 'Pan' },
  { mode: 'select', label: 'Select' },
  { mode: 'circle', label: 'Circle' },
  { mode: 'rectangle', label: 'Rectangle' },
  { mode: 'sphere', label: 'Sphere' },
  { mode: 'polygon', label: 'Polygon' },
  { mode: 'linestring', label: 'Wall' },
] as const

const HEIGHTS = [
  { meters: 0, label: 'Flat' },
  { meters: 600, label: '600 m' },
  { meters: 2000, label: '2 km' },
] as const

/**
 * Solids to start with, as meshes standing on the terrain under each vertex (`ground`): a cylinder, a turned box, a
 * hexagonal tower, a slab floating at 2.5 km, a sphere and a wall.
 */
function startingShapes(ground: GroundHeight) {
  const at = (distanceMeters: number, bearingDegrees: number) => destination(CENTER, distanceMeters, bearingDegrees)
  const wall = wallMesh([at(8000, 220), at(8000, 180), at(8000, 140)], position => ground(position[0]!, position[1]!), 400)
  return [
    createCircle(at(5000, 270), 1500, { id: 'cylinder', baseHeightMeters: ground, heightMeters: 1500 }),
    createRectangle(at(5000, 90), 2000, 3500, { id: 'box', rotationDegrees: 30, baseHeightMeters: ground, heightMeters: 900 }),
    createRegularPolygon(at(4000, 180), 1200, 6, { id: 'tower', baseHeightMeters: ground, heightMeters: 2500 }),
    createRegularPolygon(at(5000, 330), 1800, 5, { id: 'slab', baseHeightMeters: 2500, heightMeters: 200 }),
    createSphere(at(5000, 30), 1200, { id: 'sphere', baseHeightMeters: ground, properties: { kind: 'sphere' } }),
    { type: 'Feature' as const, id: 'wall', properties: {}, geometry: wall },
  ]
}

/** Adds the starting shapes once the first view has loaded, so the terrain under them is known. */
function useStartingShapes(earth: EarthImpl | null, draw: Draw): void {
  useEffect(() => {
    if (earth === null) return
    const add = () => {
      if (draw.getFeatures().features.length > 0) return
      const fallback = earth.queryTerrainElevation({ longitudeDegrees: CENTER[0], latitudeDegrees: CENTER[1] }) ?? 0
      draw.addFeatures(startingShapes((longitudeDegrees, latitudeDegrees) => earth.queryTerrainElevation({ longitudeDegrees, latitudeDegrees }) ?? fallback))
    }
    if (earth.inspect().loaded) {
      add()
      return
    }
    earth.addEventListener('load', add)
    return () => earth.removeEventListener('load', add)
  }, [earth, draw])
}

function ShapesToolbar({ draw, setSolidHeight }: { draw: Draw; setSolidHeight: (meters: number) => void }) {
  const state = useDrawState(draw)
  const [height, setHeight] = useState(600)
  const pick = (meters: number) => {
    setHeight(meters)
    setSolidHeight(meters)
  }
  return (
    <>
      <div className="example-buttons" role="toolbar" aria-label="Shape tools">
        {TOOLS.map(tool => (
          <button key={tool.mode} type="button" aria-pressed={state.mode === tool.mode} onClick={() => draw.setMode(tool.mode)}>
            {tool.label}
          </button>
        ))}
      </div>
      <div className="example-buttons" role="group" aria-label="Solid height">
        {HEIGHTS.map(option => (
          <button key={option.meters} type="button" aria-pressed={height === option.meters} onClick={() => pick(option.meters)}>
            {option.label}
          </button>
        ))}
      </div>
      {state.mode === 'select' && <DrawGizmoToolbar draw={draw} />}
      <div className="example-buttons">
        <button type="button" disabled={!state.canFinish} onClick={() => draw.finish()}>
          Finish
        </button>
        <button type="button" disabled={!state.drawing} onClick={() => draw.cancel()}>
          Cancel
        </button>
        <button type="button" disabled={state.selectedIds.length === 0} onClick={() => draw.deleteSelected()}>
          Delete
        </button>
        <button type="button" disabled={!state.canUndo} onClick={() => draw.undo()}>
          Undo
        </button>
        <button type="button" disabled={state.features.features.length === 0} onClick={() => draw.clear()}>
          Clear
        </button>
      </div>
      <p className="example-status" data-testid="shapes-status">
        {state.drawing
          ? 'Tap again to set the size.'
          : state.mode === 'select'
            ? state.selectedIds.length === 0
              ? 'Tap a shape to select it.'
              : state.editingVertices
                ? 'Drag a vertex or a midpoint; tap the shape again for the gizmo.'
                : `${GIZMO_HELP} Drag the shape itself to move it. Tap a flat shape again to edit its vertices.`
            : `${state.features.features.length} shapes.`}
      </p>
    </>
  )
}

/**
 * `?example=shapes`: circles, rectangles, spheres, polygons and walls with `react-three-earth-draw`. A tap places the
 * center or a corner, a second tap sets the size. With a height, shapes become meshes (cylinders, boxes, prisms, walls)
 * standing on the terrain: GeoJSON multipolygons of faces whose positions carry their altitude.
 */
export function ShapesExample() {
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const { draw, setSolidHeight } = useMemo(() => {
    const solidModes = [new CircleMode(), new RectangleMode(), new PolygonMode(), new LineStringMode()]
    const setSolidHeight = (meters: number) => {
      for (const mode of solidModes) mode.heightMeters = meters > 0 ? meters : undefined
    }
    setSolidHeight(600)
    const created = new Draw({
      modes: [new StaticMode(), new SelectMode({ snapping: true }), ...solidModes, new SphereMode({ properties: { kind: 'sphere' } })],
      // Opt-in: Escape, Enter, Delete, and G, R, S with X, Y, Z for the gizmo.
      keyboard: true,
      style: feature => ({
        fillColor: feature.properties?.kind === 'sphere' ? '#d946ef' : '#f97316',
        lineColor: '#7c2d12',
        lineWidthPixels: 2,
      }),
    })
    // `window.draw` lets the browser checks drive it (`draw.getMode().gizmoHandles()` says where the gizmo's handles are).
    Object.assign(window, { draw: created })
    return { draw: created, setSolidHeight }
  }, [])
  useStartingShapes(earth, draw)
  const plugins = useMemo(() => [draw], [draw])
  const style = useMemo(() => rasterBasemapStyle({ 'raster-saturation': -0.6 }), [])
  return (
    <ExampleShell
      title="Shapes and solids"
      description="Circles, rectangles and spheres in two taps; polygons and walls vertex by vertex. Pick a height to make them cylinders, boxes and prisms standing on the terrain. Everything stays GeoJSON: solids are multipolygons of faces, the third coordinate an altitude."
      camera={{ longitudeDegrees: CENTER[0], latitudeDegrees: CENTER[1], heightMeters: 0, distanceMeters: 30_000, headingDegrees: 0, pitchDegrees: -45 }}
      onEarth={setEarth}
      plugins={plugins}
      panel={<ShapesToolbar draw={draw} setSolidHeight={setSolidHeight} />}
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
    </ExampleShell>
  )
}

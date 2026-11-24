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
  transformFrame,
} from 'react-three-earth-draw'
import { useDrawState } from 'react-three-earth-draw/react'
import { useMemo, useState } from 'react'

import { rasterBasemapStyle } from './data'
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

/** Solids to start with: a cylinder, a turned box, a hexagonal tower, a slab floating at 2.5 km, a sphere and a wall. */
function startingShapes() {
  const at = (distanceMeters: number, bearingDegrees: number) => destination(CENTER, distanceMeters, bearingDegrees)
  const slab = createRegularPolygon(at(5000, 330), 1800, 5, { baseHeightMeters: 2500, extrusionHeightMeters: 200 })
  return [
    createCircle(at(5000, 270), 1500, { extrusionHeightMeters: 1500 }),
    createRectangle(at(5000, 90), 2000, 3500, { rotationDegrees: 30, extrusionHeightMeters: 900 }),
    createRegularPolygon(at(4000, 180), 1200, 6, { extrusionHeightMeters: 2500 }),
    slab,
    createSphere(at(5000, 30), 1200),
    { type: 'Feature' as const, properties: { extrusionHeightMeters: 400 }, geometry: { type: 'LineString' as const, coordinates: [at(8000, 220), at(8000, 180), at(8000, 140)] } },
  ]
}

function ShapesToolbar({ draw, setExtrusion }: { draw: Draw; setExtrusion: (meters: number) => void }) {
  const state = useDrawState(draw)
  const [height, setHeight] = useState(600)
  const pick = (meters: number) => {
    setHeight(meters)
    setExtrusion(meters)
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
      <div className="example-buttons" role="group" aria-label="Extrusion height">
        {HEIGHTS.map(option => (
          <button key={option.meters} type="button" aria-pressed={height === option.meters} onClick={() => pick(option.meters)}>
            {option.label}
          </button>
        ))}
      </div>
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
                : 'Drag the shape to move it, a corner to scale it, an edge to stretch it, the outer knob to turn it, the top knob to change its height, the knob below to lift it. Tap it again to edit its vertices.'
            : `${state.features.features.length} shapes.`}
      </p>
    </>
  )
}

/**
 * `?example=shapes`: circles, rectangles, spheres, polygons and walls with `react-three-earth-draw`. A tap places the
 * center or a corner, a second tap sets the size. With an extrusion height, shapes become solids (cylinders, boxes,
 * prisms, walls) standing on the terrain; a third coordinate lifts them to an altitude, as GeoJSON allows.
 */
export function ShapesExample() {
  const [, setEarth] = useState<EarthImpl | null>(null)
  const { draw, setExtrusion } = useMemo(() => {
    const extruded = [new CircleMode(), new RectangleMode(), new PolygonMode(), new LineStringMode()]
    const setExtrusion = (meters: number) => {
      for (const mode of extruded) mode.extrusionHeightMeters = meters > 0 ? meters : undefined
    }
    setExtrusion(600)
    const created = new Draw({
      modes: [new StaticMode(), new SelectMode(), ...extruded, new SphereMode()],
      features: startingShapes(),
      style: feature => ({
        fillColor: feature.geometry.type === 'Point' ? '#d946ef' : '#f97316',
        lineColor: '#7c2d12',
        lineWidthPixels: 2,
      }),
    })
    // `window.draw` lets the browser checks drive it; `transformFrame` tells them where the gizmo's handles are.
    Object.assign(window, { draw: created, drawTransformFrame: transformFrame })
    return { draw: created, setExtrusion }
  }, [])
  const plugins = useMemo(() => [draw], [draw])
  const style = useMemo(() => rasterBasemapStyle({ 'raster-saturation': -0.6 }), [])
  return (
    <ExampleShell
      title="Shapes and solids"
      description="Circles, rectangles and spheres in two taps; polygons and walls vertex by vertex. Pick a height to extrude them into cylinders, boxes and prisms standing on the terrain. Everything stays GeoJSON: the third coordinate is an altitude."
      camera={{ longitudeDegrees: CENTER[0], latitudeDegrees: CENTER[1], heightMeters: 0, distanceMeters: 30_000, headingDegrees: 0, pitchDegrees: -45 }}
      onEarth={setEarth}
      plugins={plugins}
      panel={<ShapesToolbar draw={draw} setExtrusion={setExtrusion} />}
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
    </ExampleShell>
  )
}

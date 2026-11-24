import type { Earth as EarthImpl } from 'react-three-earth'
import { Imagery, MapStyleSource } from 'react-three-earth/react'
import { Draw } from 'react-three-earth-draw'
import { useDrawState } from 'react-three-earth-draw/react'
import { useMemo, useState } from 'react'

import { rasterBasemapStyle } from './data'
import { ExampleShell } from './ExampleShell'

const TOOLS = [
  { mode: 'static', label: 'Pan' },
  { mode: 'select', label: 'Select' },
  { mode: 'point', label: 'Point' },
  { mode: 'linestring', label: 'Line' },
  { mode: 'polygon', label: 'Polygon' },
] as const

/** The toolbar: plain buttons on the draw's state. The library ships none of this, nor any CSS. */
function DrawToolbar({ draw }: { draw: Draw }) {
  const state = useDrawState(draw)
  return (
    <>
      <div className="example-buttons" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map(tool => (
          <button key={tool.mode} type="button" aria-pressed={state.mode === tool.mode} onClick={() => draw.setMode(tool.mode)}>
            {tool.label}
          </button>
        ))}
      </div>
      <div className="example-buttons">
        <button type="button" disabled={!state.canFinish} onClick={() => draw.finish()}>
          Finish
        </button>
        <button type="button" disabled={!state.canUndo} onClick={() => draw.undo()}>
          Undo
        </button>
        <button type="button" disabled={!state.drawing} onClick={() => draw.cancel()}>
          Cancel
        </button>
        <button type="button" disabled={state.selectedIds.length === 0} onClick={() => draw.deleteSelected()}>
          Delete
        </button>
        <button type="button" disabled={state.features.features.length === 0} onClick={() => draw.clear()}>
          Clear
        </button>
      </div>
      <p className="example-status" data-testid="draw-status">
        {state.drawing
          ? `${state.vertexCount} vertices placed. Tap the last one to finish.`
          : state.mode === 'select'
            ? state.selectedIds.length === 0
              ? 'Tap a feature to select it.'
              : state.editingVertices
                ? 'Drag a vertex or the feature; tap a midpoint to add a vertex, a vertex then Delete to remove it. Tap the feature again for the gizmo.'
                : 'Drag the feature to move it, or the gizmo to scale, stretch, turn, extrude or lift it. Tap it again to edit its vertices.'
            : `${state.features.features.length} features drawn.`}
      </p>
    </>
  )
}

/**
 * `?example=draw`: drawing points, lines and polygons with `react-three-earth-draw`, a headless plugin. Taps place
 * vertices while one finger still pans and two fingers pinch; finished features are draped on the terrain, as GeoJSON.
 */
export function DrawExample() {
  const [, setEarth] = useState<EarthImpl | null>(null)
  const draw = useMemo(() => {
    const created = new Draw({
      style: (feature, { drawing }) => ({
        fillColor: drawing ? '#f59e0b' : '#22c55e',
        lineColor: drawing ? '#f59e0b' : feature.geometry.type === 'LineString' ? '#e11d48' : '#16a34a',
        lineWidthPixels: feature.geometry.type === 'LineString' ? 4 : 2.5,
        pointColor: '#e11d48',
      }),
    })
    // `window.draw` lets the browser checks drive it.
    ;(window as unknown as { draw: Draw }).draw = created
    return created
  }, [])
  const plugins = useMemo(() => [draw], [draw])
  const style = useMemo(() => rasterBasemapStyle({ 'raster-saturation': -0.3 }), [])
  return (
    <ExampleShell
      title="Draw and edit points, lines and polygons"
      description="Pick a tool and tap the map to place vertices; tap the last vertex to finish. Select a feature to move, scale, stretch, turn, extrude or lift it with its gizmo; tap it again to drag its vertices and add new ones at the midpoints. One finger still pans between taps and two fingers pinch, on the globe and the flat map. Features are kept as GeoJSON."
      camera={{ longitudeDegrees: 6.6, latitudeDegrees: 46.45, heightMeters: 0, distanceMeters: 70_000, headingDegrees: 0, pitchDegrees: -60 }}
      onEarth={setEarth}
      plugins={plugins}
      panel={<DrawToolbar draw={draw} />}
    >
      <Imagery>
        <MapStyleSource style={style} />
      </Imagery>
    </ExampleShell>
  )
}

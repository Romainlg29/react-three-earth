import type { Draw, ElementMode, GizmoSpace, GizmoTool } from '@earthkit/draw'
import { useDrawState } from '@earthkit/draw/react'

const TOOLS: ReadonlyArray<{ tool: GizmoTool; label: string }> = [
  { tool: 'all', label: 'All' },
  { tool: 'move', label: 'Move' },
  { tool: 'rotate', label: 'Rotate' },
  { tool: 'scale', label: 'Scale' },
]

const SPACES: ReadonlyArray<{ space: GizmoSpace; label: string }> = [
  { space: 'world', label: 'World axes' },
  { space: 'local', label: 'Local axes' },
]

const ELEMENTS: ReadonlyArray<{ element: ElementMode; label: string }> = [
  { element: 'vertex', label: 'Vertex' },
  { element: 'edge', label: 'Edge' },
  { element: 'face', label: 'Face' },
]

/**
 * The gizmo's tool and axes, as plain buttons on the draw's state: the library is headless. In edit mode, the elements
 * to pick and Extrude instead.
 */
export function DrawGizmoToolbar({ draw }: { draw: Draw }) {
  const gizmoTool = useDrawState(draw, state => state.gizmoTool)
  const gizmoSpace = useDrawState(draw, state => state.gizmoSpace)
  const editing = useDrawState(draw, state => state.editingVertices)
  const elementMode = useDrawState(draw, state => state.elementMode)
  const canExtrude = useDrawState(draw, state => state.canExtrude)
  if (editing) {
    return (
      <div className="example-buttons" role="group" aria-label="Edit mode">
        {ELEMENTS.map(({ element, label }) => (
          <button key={element} type="button" aria-pressed={elementMode === element} onClick={() => draw.setElementMode(element)}>
            {label}
          </button>
        ))}
        <button type="button" disabled={!canExtrude} onClick={() => draw.extrude()}>
          Extrude
        </button>
      </div>
    )
  }
  return (
    <>
      <div className="example-buttons" role="group" aria-label="Gizmo tool">
        {TOOLS.map(({ tool, label }) => (
          <button key={tool} type="button" aria-pressed={gizmoTool === tool} onClick={() => draw.setGizmoTool(tool)}>
            {label}
          </button>
        ))}
      </div>
      <div className="example-buttons" role="group" aria-label="Gizmo axes">
        {SPACES.map(({ space, label }) => (
          <button key={space} type="button" aria-pressed={gizmoSpace === space} onClick={() => draw.setGizmoSpace(space)}>
            {label}
          </button>
        ))}
      </div>
    </>
  )
}

/** What the select mode's gizmo does, for the status line. */
export const GIZMO_HELP =
  'Arrows move along an axis, squares in a plane, the white ring on the ground; arcs turn, cubes and the outer ring scale. Keys: G, R, S, then X, Y, Z.'

/** What edit mode does, for the status line. */
export const EDIT_HELP =
  'Tap a vertex, edge or face to pick it, drag it to move it; drag a picked face\'s arrow to push or pull it. Tap the empty map for the gizmo. Keys: Tab, 1, 2, 3, E.'

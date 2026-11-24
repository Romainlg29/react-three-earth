import type { Draw, GizmoSpace, GizmoTool } from 'react-three-earth-draw'
import { useDrawState } from 'react-three-earth-draw/react'

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

/** The gizmo's tool and axes, as plain buttons on the draw's state: the library is headless. */
export function DrawGizmoToolbar({ draw }: { draw: Draw }) {
  const gizmoTool = useDrawState(draw, state => state.gizmoTool)
  const gizmoSpace = useDrawState(draw, state => state.gizmoSpace)
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

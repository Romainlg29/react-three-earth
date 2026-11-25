import type { GeoJsonSource as GeoJsonSourceImpl } from '@earthkit/globe'
import { GeoJsonSource, StyleLayer } from '@earthkit/globe/react'
import { useEffect, useRef, useState, type ChangeEvent, type Ref } from 'react'

import { readGeoJsonFiles, type LoadedGeoJsonFile } from './geojsonFiles'

const HOVER = ['boolean', ['feature-state', 'hover'], false]
const IS_POLYGON = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]
const IS_LINE_OR_POLYGON = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']]]
const IS_POINT = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]]

/**
 * Whether files are being dragged over the page, and the files dropped anywhere on it. The canvas fills the
 * window, so the window takes the drop; the browser's default (opening the file) is prevented.
 */
export function useFileDrop(onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const latest = useRef(onFiles)
  latest.current = onFiles
  useEffect(() => {
    // dragenter and dragleave fire for every child crossed: count them to know when the drag leaves the window.
    let depth = 0
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') === true
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth++
      setDragging(true)
    }
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.dataTransfer!.dropEffect = 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      latest.current([...(event.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return dragging
}

/** The loaded files, the errors of the last load, and the actions on them. */
export function useGeoJsonFiles(onLoaded: (file: LoadedGeoJsonFile) => void) {
  const [files, setFiles] = useState<LoadedGeoJsonFile[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const add = async (input: Iterable<File>) => {
    const { loaded, errors } = await readGeoJsonFiles(input)
    setErrors(errors)
    if (loaded.length === 0) return
    setFiles(current => [...current, ...loaded])
    // Fit the last one: the one the user is most likely looking for.
    onLoaded(loaded.at(-1)!)
  }
  const toggle = (id: string) => setFiles(current => current.map(file => (file.id === id ? { ...file, visible: !file.visible } : file)))
  // Two steps: marked removed (the interactions drop its layers and clear their hover state), then gone.
  const remove = (id: string) => setFiles(current => current.map(file => (file.id === id ? { ...file, removed: true } : file)))
  useEffect(() => {
    if (files.some(file => file.removed)) setFiles(current => current.filter(file => !file.removed))
  }, [files])
  const shown = files.filter(file => !file.removed)
  return { files, shown, errors, add, toggle, remove }
}

/**
 * One file's layers, styled for what it holds: translucent fills with an outline for polygons, lines, circles for
 * points, and labels when the features have a name. Hovered features (`generateId` gives them ids) stand out. While
 * the file is edited, every kind of layer is there, for the shapes the user adds. Inside `<MapStyleSource>`.
 */
export function GeoJsonFileLayers({ file, editing = false, sourceRef }: { file: LoadedGeoJsonFile; editing?: boolean; sourceRef?: Ref<GeoJsonSourceImpl> }) {
  const visibility = file.visible ? 'visible' : 'none'
  const { color, labelProperty } = file
  const counts = editing ? { points: 1, lines: 1, polygons: 1 } : file.counts
  return (
    <GeoJsonSource ref={sourceRef} id={file.id} data={file.data} generateId>
      {counts.polygons > 0 ? (
        <StyleLayer id={`${file.id}-fill`} type="fill" filter={IS_POLYGON} layout={{ visibility }} paint={{ 'fill-color': color, 'fill-opacity': ['case', HOVER, 0.55, 0.3] }} />
      ) : null}
      {counts.lines + counts.polygons > 0 ? (
        <StyleLayer
          id={`${file.id}-line`}
          type="line"
          filter={IS_LINE_OR_POLYGON}
          layout={{ visibility, 'line-join': 'round', 'line-cap': 'round' }}
          paint={{ 'line-color': color, 'line-width': ['case', HOVER, 4.5, 2.5] }}
        />
      ) : null}
      {counts.points > 0 ? (
        <StyleLayer
          id={`${file.id}-circle`}
          type="circle"
          filter={IS_POINT}
          layout={{ visibility }}
          paint={{ 'circle-color': color, 'circle-radius': ['case', HOVER, 9, 6], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }}
        />
      ) : null}
      {labelProperty !== null ? (
        <StyleLayer
          id={`${file.id}-label`}
          type="symbol"
          layout={{ visibility, 'text-field': ['to-string', ['get', labelProperty]], 'text-size': 13, 'text-anchor': 'top', 'text-offset': [0, 0.8] }}
          paint={{ 'text-color': '#1d2333', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }}
        />
      ) : null}
    </GeoJsonSource>
  )
}

function describeCounts({ points, lines, polygons }: LoadedGeoJsonFile['counts']): string {
  const parts = [
    [points, 'point'],
    [lines, 'line'],
    [polygons, 'polygon'],
  ] as const
  const described = parts.filter(([count]) => count > 0).map(([count, noun]) => `${count.toLocaleString('en')} ${noun}${count === 1 ? '' : 's'}`)
  return described.length === 0 ? 'no geometry' : described.join(', ')
}

export interface GeoJsonFilesPanelProps {
  files: LoadedGeoJsonFile[]
  errors: string[]
  onAdd: (files: File[]) => void
  onSample: () => void
  onToggle: (id: string) => void
  onRemove: (id: string) => void
  onZoom: (file: LoadedGeoJsonFile) => void
  /** Edits the file in place with the draw plugin; absent, files cannot be edited. */
  onEdit?: (file: LoadedGeoJsonFile) => void
  /** The file being edited, if any. */
  editingId?: string | null
}

/** The file list: a picker for phones (no drag and drop there), a sample, and a row per file. */
export function GeoJsonFilesPanel({ files, errors, onAdd, onSample, onToggle, onRemove, onZoom, onEdit, editingId = null }: GeoJsonFilesPanelProps) {
  const input = useRef<HTMLInputElement>(null)
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    onAdd([...(event.target.files ?? [])])
    event.target.value = '' // the same file can be picked again
  }
  return (
    <>
      <p className="example-status">Drop .geojson or .json files anywhere on the map, or open them here.</p>
      <div className="example-buttons">
        <button type="button" onClick={() => input.current?.click()}>
          Open files…
        </button>
        <button type="button" onClick={onSample}>
          Add a sample
        </button>
        <input ref={input} type="file" accept=".geojson,.json,application/geo+json,application/json" multiple hidden onChange={pick} data-testid="showcase-file-input" />
      </div>
      {errors.length > 0 ? (
        <ul className="showcase-errors" role="alert">
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul className="showcase-files" aria-label="Loaded files">
          {files.map(file => (
            <li key={file.id}>
              <span className="showcase-swatch" style={{ background: file.color }} aria-hidden="true" />
              <span className="showcase-file-name">
                <strong title={file.name}>{file.name}</strong>
                <small>{describeCounts(file.counts)}</small>
              </span>
              <button type="button" aria-pressed={file.visible} aria-label={`Show ${file.name}`} title="Show" onClick={() => onToggle(file.id)}>
                {file.visible ? '◉' : '○'}
              </button>
              <button type="button" aria-label={`Zoom to ${file.name}`} title="Zoom to" disabled={file.bounds === null} onClick={() => onZoom(file)}>
                ⤢
              </button>
              {onEdit !== undefined ? (
                <button type="button" aria-pressed={editingId === file.id} aria-label={`Edit ${file.name}`} title="Edit in place" onClick={() => onEdit(file)}>
                  ✎
                </button>
              ) : null}
              <button type="button" aria-label={`Remove ${file.name}`} title="Remove" onClick={() => onRemove(file.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

/** The hint over the map while files are dragged over it. */
export function DropOverlay() {
  return (
    <div className="showcase-drop" aria-hidden="true">
      <span>Drop GeoJSON files to add them to the map</span>
    </div>
  )
}

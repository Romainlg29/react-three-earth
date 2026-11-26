import { Compare } from '@earthkit/compare'
import { useCompareHandle, useCompareImagery } from '@earthkit/compare/react'
import { Draw } from '@earthkit/draw'
import { Geocoder } from '@earthkit/geocoder'
import type { CameraView, Earth as EarthImpl, GeoJsonSource as GeoJsonSourceImpl } from '@earthkit/globe'
import { GeoJsonSource, Imagery, MapStyleSource, Marker, Popup, StyleLayer, useEarthEvent, useHoverFeatureState, useLayerCursor } from '@earthkit/globe/react'
import { Measure, type UnitSystem } from '@earthkit/measure'
import { TERRAIN_STYLE_PRESETS, type TerrainStylePreset } from '@earthkit/terrain-style'
import { useTerrainStyle } from '@earthkit/terrain-style/react'
import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

import { cities } from './cities'
import { useFixtures } from './data'
import { DrawToolbar } from './DrawExample'
import { ExampleShell } from './ExampleShell'
import { createProviders, SearchBox } from './GeocoderExample'
import { MeasurementLabels, MeasurePanel } from './MeasureExample'
import { peaks } from './peaks'
import { flyToPlace, placesFor, type Place } from './places'
import { DropOverlay, GeoJsonFileLayers, GeoJsonFilesPanel, useFileDrop, useGeoJsonFiles } from './showcase/GeoJsonFiles'
import { fileLayerIds, loadGeoJsonText, sampleGeoJsonText, type LoadedGeoJsonFile } from './showcase/geojsonFiles'
import { basemapStyle, comparedStyle, type Basemap } from './showcase/styles'

const PLACES = placesFor<Place>(
  [
    { name: 'Alps', view: { longitudeDegrees: 6.95, latitudeDegrees: 45.75, heightMeters: 2500, distanceMeters: 45_000, headingDegrees: 30, pitchDegrees: -22 } },
    { name: 'Manhattan', view: { longitudeDegrees: -74.0115, latitudeDegrees: 40.7075, heightMeters: 10, distanceMeters: 2400, headingDegrees: 25, pitchDegrees: -28 } },
    { name: 'Everest', view: { longitudeDegrees: 86.925, latitudeDegrees: 27.9881, heightMeters: 7000, distanceMeters: 32_000, headingDegrees: 200, pitchDegrees: -16 } },
    { name: 'Whole world', view: { longitudeDegrees: 10, latitudeDegrees: 30, heightMeters: 0, distanceMeters: 16_000_000, headingDegrees: 0, pitchDegrees: -90 } },
  ],
  [
    { name: 'Fixture peak', view: { longitudeDegrees: -90, latitudeDegrees: 0, heightMeters: 3900, distanceMeters: 2500, headingDegrees: 30, pitchDegrees: -35 } },
    { name: 'Whole world', view: { longitudeDegrees: -90, latitudeDegrees: 0, heightMeters: 0, distanceMeters: 16_000_000, headingDegrees: 0, pitchDegrees: -90 } },
  ],
)

const START: CameraView = useFixtures
  ? { longitudeDegrees: -90, latitudeDegrees: 0, heightMeters: 0, distanceMeters: 400_000, headingDegrees: 0, pitchDegrees: -60 }
  : { longitudeDegrees: 9, latitudeDegrees: 42, heightMeters: 0, distanceMeters: 5_500_000, headingDegrees: 0, pitchDegrees: -75 }

/** Pins with a popup each: `<Popup>` inside `<Marker>` opens on a click on the pin. */
const LANDMARKS = useFixtures
  ? [{ name: 'Fixture peak', detail: 'The synthetic terrain’s top, 3900 m', longitudeDegrees: -90, latitudeDegrees: 0 }]
  : [
      { name: 'Eiffel Tower', detail: 'Paris, 330 m tall, 1889', longitudeDegrees: 2.2945, latitudeDegrees: 48.8584 },
      { name: 'Matterhorn', detail: 'Pennine Alps, 4478 m', longitudeDegrees: 7.6586, latitudeDegrees: 45.9763 },
      { name: 'Statue of Liberty', detail: 'New York Harbor, 1886', longitudeDegrees: -74.0445, latitudeDegrees: 40.6892 },
      { name: 'Mount Fuji', detail: 'Honshu, 3776 m', longitudeDegrees: 138.7274, latitudeDegrees: 35.3606 },
      { name: 'Sydney Opera House', detail: 'Bennelong Point, 1973', longitudeDegrees: 151.2153, latitudeDegrees: -33.8568 },
      { name: 'Machu Picchu', detail: 'Cusco Region, 2430 m', longitudeDegrees: -72.545, latitudeDegrees: -13.1631 },
    ]

type Tool = 'explore' | 'draw' | 'measure' | 'compare'

const TOOLS: Array<{ tool: Tool; label: string }> = [
  { tool: 'explore', label: 'Explore' },
  { tool: 'draw', label: 'Draw' },
  { tool: 'measure', label: 'Measure' },
  { tool: 'compare', label: 'Compare' },
]

interface DataLayers {
  peaks: boolean
  cities: boolean
  landmarks: boolean
  buildings: boolean
  labels: boolean
}

const DATA_LAYERS: Array<{ key: keyof DataLayers; label: string }> = [
  { key: 'peaks', label: 'Summits (clusters)' },
  { key: 'cities', label: 'Cities (heatmap)' },
  { key: 'landmarks', label: 'Landmarks (markers)' },
  { key: 'buildings', label: '3D buildings' },
  { key: 'labels', label: 'Place names' },
]

const PEAK_LAYERS = ['peak-clusters', 'peak-points']

/** What a click on a feature shows: its name and a few of its properties. */
interface Selection {
  key: string
  longitudeDegrees: number
  latitudeDegrees: number
  title: string
  rows: Array<[string, string]>
}

function propertyRows(properties: Record<string, unknown>, skip: string | null): Array<[string, string]> {
  return Object.entries(properties)
    .filter(([key, value]) => key !== skip && value !== null && typeof value !== 'object')
    .slice(0, 8)
    .map(([key, value]) => [key, typeof value === 'number' ? value.toLocaleString('en') : String(value)])
}

/**
 * The feature interactions, inside `<Earth>`: hover highlights through feature-state, a pointer cursor, and clicks
 * (a cluster zooms in to where it splits, a peak or a file's feature opens a popup). Only while exploring: the
 * drawing and measuring tools own the taps otherwise.
 */
function FeatureInteractions({ enabled, files, peakSource, onSelect }: { enabled: boolean; files: LoadedGeoJsonFile[]; peakSource: RefObject<GeoJsonSourceImpl | null>; onSelect: (selection: Selection) => void }) {
  // Removed files leave the list a commit before their source goes, so the hover state is cleared on a live source.
  const fileLayers = files.filter(file => !file.removed).flatMap(fileLayerIds)
  const interactive = [...PEAK_LAYERS, ...fileLayers]
  useEarthEvent(
    'click',
    event => {
      const feature = event.features[0]
      if (!enabled || feature === undefined) return
      const properties = (feature.properties ?? {}) as Record<string, unknown>
      if (feature.layer.id === 'peak-clusters' && feature.geometry.type === 'Point') {
        const [longitudeDegrees, latitudeDegrees] = feature.geometry.coordinates as [number, number]
        void peakSource.current?.getClusterExpansionZoom(properties.cluster_id as number).then(zoom => event.target.camera.flyTo({ longitudeDegrees, latitudeDegrees, zoom: zoom + 0.5 }))
        return
      }
      // Points open at the point, lines and polygons where they were clicked.
      const at = feature.geometry.type === 'Point' ? (feature.geometry.coordinates as [number, number]) : event.geographic === null ? null : ([event.geographic.longitudeDegrees, event.geographic.latitudeDegrees] as [number, number])
      if (at === null) return
      const file = files.find(entry => feature.layer.id.startsWith(`${entry.id}-`))
      const labelProperty = file === undefined ? 'name' : file.labelProperty
      const name = labelProperty === null ? undefined : properties[labelProperty]
      onSelect({
        key: `${feature.layer.id}:${String(feature.id)}:${at.join(',')}`,
        longitudeDegrees: at[0],
        latitudeDegrees: at[1],
        title: typeof name === 'string' ? name : (file?.name ?? 'Feature'),
        rows: propertyRows(properties, labelProperty),
      })
    },
    { layers: interactive, tolerancePixels: 10 },
  )
  // Layer events need at least one layer: hover and cursor are registered only while exploring.
  return enabled ? <HoverAndCursor layers={interactive} /> : null
}

function HoverAndCursor({ layers }: { layers: string[] }) {
  useHoverFeatureState(layers, { tolerancePixels: 6 })
  useLayerCursor(layers, 'pointer', { tolerancePixels: 6 })
  return null
}

/** The summits, clustered, with hover highlights; the same layers as `?example=geojson`. */
function PeakLayers({ source, visible }: { source: RefObject<GeoJsonSourceImpl | null>; visible: boolean }) {
  // Hidden rather than unmounted: the hover state may still point at its features.
  const visibility = visible ? 'visible' : 'none'
  return (
    <GeoJsonSource id="peaks" data={peaks} cluster clusterRadiusPixels={50} clusterProperties={{ highestMeters: ['max', ['get', 'elevationMeters']] }} ref={source}>
      <StyleLayer
        id="peak-clusters"
        type="circle"
        filter={['has', 'point_count']}
        layout={{ visibility }}
        paint={{
          'circle-color': ['interpolate', ['linear'], ['get', 'highestMeters'], 3000, '#3aa267', 6000, '#e0603a', 8000, '#8f5cf6'],
          'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 14, 20, 26],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        }}
      />
      <StyleLayer id="peak-counts" type="symbol" filter={['has', 'point_count']} layout={{ visibility, 'text-field': '{point_count_abbreviated}', 'text-size': 14 }} paint={{ 'text-color': '#ffffff' }} />
      <StyleLayer
        id="peak-points"
        type="circle"
        filter={['!', ['has', 'point_count']]}
        layout={{ visibility }}
        paint={{
          'circle-color': ['interpolate', ['linear'], ['get', 'elevationMeters'], 1000, '#3aa267', 3500, '#e6b33c', 6000, '#e0603a', 8000, '#f4f1ff'],
          'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 11, 7],
          'circle-stroke-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ffd43b', '#1d2333'],
          'circle-stroke-width': 2,
        }}
      />
      <StyleLayer
        id="peak-names"
        type="symbol"
        filter={['!', ['has', 'point_count']]}
        layout={{ visibility, 'text-field': '{name}', 'text-size': 13, 'text-anchor': 'top', 'text-offset': [0, 0.9] }}
        paint={{ 'text-color': '#1d2333', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }}
      />
    </GeoJsonSource>
  )
}

/** The cities as a heatmap weighted by population, turning into circles as you zoom in. */
function CityLayers() {
  return (
    <GeoJsonSource id="cities" data={cities}>
      <StyleLayer
        id="city-heat"
        type="heatmap"
        maximumZoom={7}
        paint={{
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'populationMillions'], 1, 0.1, 37, 1],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 12, 4, 40, 7, 70],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 7, 2.5],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0, 0, 0, 0)', 0.2, '#5b2a86', 0.45, '#c2255c', 0.7, '#f76707', 1, '#ffe066'],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.85, 7, 0],
        }}
      />
      <StyleLayer
        id="city-circles"
        type="circle"
        minimumZoom={5}
        paint={{
          'circle-radius': ['interpolate', ['linear'], ['get', 'populationMillions'], 1, 6, 37, 26],
          'circle-color': '#f76707',
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 7, 0.75],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        }}
      />
    </GeoJsonSource>
  )
}

/** The compare slider: a line across the map with a grip, placed by `--compare-position`. */
function CompareHandle({ compare }: { compare: Compare }) {
  const handleRef = useCompareHandle(compare, { label: 'Compare basemaps' })
  return (
    <div ref={handleRef} className="compare-handle">
      <span className="compare-grip" aria-hidden="true" />
    </div>
  )
}

/** A collapsible panel section. */
function Section({ title, open = false, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="showcase-section" open={open}>
      <summary>{title}</summary>
      {children}
    </details>
  )
}

/**
 * `?example=showcase`: most of earthkit on one page. The globe and the flat map, terrain with presets from
 * `@earthkit/terrain-style`, the atmosphere and the sun's time, map styles with 3D buildings, GeoJSON layers
 * (clusters, a heatmap, hover feature-state, click popups), markers with popups, the headless map controls, and the
 * draw, measure, geocoder and compare plugins. GeoJSON files dropped on the map (or opened) are added as sources,
 * styled for their geometry and fitted into view.
 */
export function ShowcaseExample() {
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const [basemap, setBasemap] = useState<Basemap>('streets')
  const [preset, setPreset] = useState<TerrainStylePreset>('alpine')
  const [exaggeration, setExaggeration] = useState(1)
  const [layers, setLayers] = useState<DataLayers>({ peaks: true, cities: false, landmarks: true, buildings: true, labels: true })
  const [tool, setTool] = useState<Tool>('explore')
  const [unitSystem, setUnitSystem] = useState<UnitSystem>('metric')
  const [selection, setSelection] = useState<Selection | null>(null)
  const peakSource = useRef<GeoJsonSourceImpl | null>(null)

  // The plugins, created once. Draw, measure and the geocoder stay installed (idle in their `static` mode); the
  // comparison is installed only while its tool is on, which clips the layers it lists.
  const draw = useMemo(() => new Draw(), [])
  // A second draw edits a dropped file in place (`setSource`), leaving the user's own drawings in the first one.
  const fileDraw = useMemo(() => new Draw({ name: 'file-edit' }), [])
  const measure = useMemo(() => new Measure(), [])
  const geocoder = useMemo(() => new Geocoder({ provider: createProviders(), marker: true }), [])
  const compare = useMemo(() => new Compare(), [])
  const plugins = useMemo(() => (tool === 'compare' ? [draw, fileDraw, measure, geocoder, compare] : [draw, fileDraw, measure, geocoder]), [tool, draw, fileDraw, measure, geocoder, compare])
  // The files' sources, by file id, for `fileDraw.setSource`; and the file being edited.
  const fileSources = useRef(new Map<string, GeoJsonSourceImpl>())
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const beforeRef = useCompareImagery(compare, 'before')
  const afterRef = useCompareImagery(compare, 'after')

  const fitFile = (file: LoadedGeoJsonFile) => {
    // Clear of the card on wide screens (it collapses on phones).
    const leftPixels = matchMedia('(min-width: 700px)').matches ? 380 : 40
    if (file.bounds !== null) void earth?.camera.fitBounds(file.bounds, { paddingPixels: { topPixels: 60, rightPixels: 70, bottomPixels: 60, leftPixels }, maximumZoom: 15 })
  }
  const geoJsonFiles = useGeoJsonFiles(fitFile)
  const dragging = useFileDrop(files => void geoJsonFiles.add(files))
  const addSample = () => void geoJsonFiles.add([new File([sampleGeoJsonText()], 'haute-route.geojson', { type: 'application/geo+json' })])

  const style = useMemo(() => basemapStyle(basemap, layers), [basemap, layers.buildings, layers.labels])
  const otherStyle = useMemo(() => comparedStyle(basemap), [basemap])
  // A new preset is a new material factory: the terrain reloads its tiles with it.
  const terrainStyle = useTerrainStyle({ color: preset })

  const stopEditingFile = () => {
    fileDraw.setMode('static')
    fileDraw.setSource(null)
    setEditingFileId(null)
  }
  const editFile = (file: LoadedGeoJsonFile) => {
    const source = fileSources.current.get(file.id)
    if (source === undefined) return
    if (editingFileId === file.id) {
      stopEditingFile()
      return
    }
    draw.setMode('static')
    measure.setMode('static')
    setSelection(null)
    fileDraw.setSource(source)
    fileDraw.setMode('select')
    setEditingFileId(file.id)
    setTool('draw')
  }
  const chooseTool = (next: Tool) => {
    if (next !== 'draw') {
      draw.setMode('static')
      if (editingFileId !== null) stopEditingFile()
    }
    if (next !== 'measure') measure.setMode('static')
    if (next !== 'explore') setSelection(null)
    setTool(next)
  }
  const toggleLayer = (key: keyof DataLayers) => setLayers(current => ({ ...current, [key]: !current[key] }))
  const removeFile = (id: string) => {
    if (id === editingFileId) stopEditingFile()
    geoJsonFiles.remove(id)
    setSelection(null)
  }

  return (
    <ExampleShell
      title="Showcase"
      description="Most of earthkit on one map. Switch the basemap, light, layers and tools below, morph to the flat map with the 2D button, and drop GeoJSON files on the map to see them."
      camera={START}
      onEarth={setEarth}
      plugins={plugins}
      viewSwitch
      exaggeration={exaggeration}
      createTerrainMaterial={basemap === 'stylised' ? terrainStyle : undefined}
      overlay={
        <>
          {tool === 'compare' ? <CompareHandle compare={compare} /> : null}
          {dragging ? <DropOverlay /> : null}
        </>
      }
      panel={
        <div className="showcase-panel">
          <div className="example-buttons">
            {PLACES.map(place => (
              <button key={place.name} type="button" onClick={() => flyToPlace(earth, place)}>
                {place.name}
              </button>
            ))}
          </div>

          <Section title="Search">
            <SearchBox geocoder={geocoder} />
          </Section>

          <Section title="Basemap and terrain" open>
            <div className="example-buttons">
              <button type="button" aria-pressed={basemap === 'streets'} onClick={() => setBasemap('streets')}>
                Streets
              </button>
              <button type="button" aria-pressed={basemap === 'satellite'} onClick={() => setBasemap('satellite')}>
                Satellite
              </button>
              <button type="button" aria-pressed={basemap === 'stylised'} onClick={() => setBasemap('stylised')}>
                Stylised terrain
              </button>
            </div>
            {basemap === 'stylised' ? (
              <div className="example-buttons" aria-label="Terrain style presets">
                {(Object.keys(TERRAIN_STYLE_PRESETS) as TerrainStylePreset[]).map(name => (
                  <button key={name} type="button" aria-pressed={name === preset} onClick={() => setPreset(name)}>
                    {name}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="example-field">
              Exaggeration
              <input type="range" min={1} max={3} step={0.1} value={exaggeration} onChange={event => setExaggeration(Number(event.target.value))} />
              <output>{exaggeration.toFixed(1)}×</output>
            </label>
          </Section>

          <Section title="Layers">
            <div className="showcase-checks">
              {DATA_LAYERS.map(({ key, label }) => (
                <label key={key}>
                  <input type="checkbox" checked={layers[key]} disabled={basemap !== 'streets' && key === 'buildings'} onChange={() => toggleLayer(key)} />
                  {label}
                </label>
              ))}
            </div>
          </Section>

          <Section title="Tools" open>
            <div className="example-buttons" role="toolbar" aria-label="Tools">
              {TOOLS.map(entry => (
                <button key={entry.tool} type="button" aria-pressed={tool === entry.tool} onClick={() => chooseTool(entry.tool)}>
                  {entry.label}
                </button>
              ))}
            </div>
            {tool === 'explore' ? <p className="example-status">Tap a summit, a cluster, a pin or a file’s feature. Hover highlights with a mouse.</p> : null}
            {tool === 'draw' && editingFileId !== null ? (
              <>
                <p className="example-status" data-testid="showcase-editing">
                  Editing {geoJsonFiles.shown.find(file => file.id === editingFileId)?.name ?? 'a file'} in place: tap a feature to select it, drag to move it, tap it again for its vertices.
                </p>
                <div className="example-buttons">
                  <button type="button" onClick={stopEditingFile}>
                    Done editing
                  </button>
                </div>
                <DrawToolbar draw={fileDraw} />
              </>
            ) : null}
            {tool === 'draw' && editingFileId === null ? <DrawToolbar draw={draw} /> : null}
            {tool === 'measure' ? <MeasurePanel measure={measure} unitSystem={unitSystem} setUnitSystem={setUnitSystem} /> : null}
            {tool === 'compare' ? <p className="example-status">Drag the slider: {basemap === 'satellite' ? 'streets' : 'satellite'} on the right, your basemap and data on the left.</p> : null}
          </Section>

          <Section title={`Your GeoJSON${geoJsonFiles.shown.length > 0 ? ` (${geoJsonFiles.shown.length})` : ''}`} open>
            <GeoJsonFilesPanel files={geoJsonFiles.shown} errors={geoJsonFiles.errors} onAdd={files => void geoJsonFiles.add(files)} onSample={addSample} onToggle={geoJsonFiles.toggle} onRemove={removeFile} onZoom={fitFile} onEdit={editFile} editingId={editingFileId} />
          </Section>
        </div>
      }
    >
      <Imagery ref={beforeRef}>
        <MapStyleSource style={style}>
          {layers.cities ? <CityLayers /> : null}
          <PeakLayers source={peakSource} visible={layers.peaks} />
          {geoJsonFiles.files.map(file => (
            <GeoJsonFileLayers
              key={file.id}
              file={file}
              editing={file.id === editingFileId}
              sourceRef={source => {
                if (source === null) return
                fileSources.current.set(file.id, source)
                return () => void fileSources.current.delete(file.id)
              }}
            />
          ))}
        </MapStyleSource>
      </Imagery>
      {tool === 'compare' ? (
        <Imagery ref={afterRef}>
          <MapStyleSource style={otherStyle} />
        </Imagery>
      ) : null}
      <FeatureInteractions enabled={tool === 'explore'} files={geoJsonFiles.files} peakSource={peakSource} onSelect={setSelection} />
      {layers.landmarks
        ? LANDMARKS.map(landmark => (
            <Marker key={landmark.name} longitudeDegrees={landmark.longitudeDegrees} latitudeDegrees={landmark.latitudeDegrees} label={landmark.name}>
              <Popup label={landmark.name}>
                <div className="example-popup">
                  <strong>{landmark.name}</strong>
                  {landmark.detail}
                </div>
              </Popup>
            </Marker>
          ))
        : null}
      <MeasurementLabels measure={measure} unitSystem={unitSystem} />
      {selection !== null ? (
        <Popup key={selection.key} longitudeDegrees={selection.longitudeDegrees} latitudeDegrees={selection.latitudeDegrees} open onClose={() => setSelection(null)} label={selection.title} offsetPixels={10}>
          <div className="example-popup">
            <strong>{selection.title}</strong>
            {selection.rows.length > 0 ? (
              <table className="showcase-properties">
                <tbody>
                  {selection.rows.map(([key, value]) => (
                    <tr key={key}>
                      <th scope="row">{key}</th>
                      <td>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </Popup>
      ) : null}
    </ExampleShell>
  )
}

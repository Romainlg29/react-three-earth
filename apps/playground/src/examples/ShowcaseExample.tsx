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
  const fileLayers = files.filter(file => file.visible).flatMap(fileLayerIds)
  const interactive = enabled ? [...PEAK_LAYERS, ...fileLayers] : []
  useHoverFeatureState(interactive, { tolerancePixels: 6 })
  useLayerCursor(interactive, 'pointer', { tolerancePixels: 6 })
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
    { layers: [...PEAK_LAYERS, ...fileLayers], tolerancePixels: 10 },
  )
  return null
}

/** The summits, clustered, with hover highlights; the same layers as `?example=geojson`. */
function PeakLayers({ source }: { source: RefObject<GeoJsonSourceImpl | null> }) {
  return (
    <GeoJsonSource id="peaks" data={peaks} cluster clusterRadiusPixels={50} clusterProperties={{ highestMeters: ['max', ['get', 'elevationMeters']] }} ref={source}>
      <StyleLayer
        id="peak-clusters"
        type="circle"
        filter={['has', 'point_count']}
        paint={{
          'circle-color': ['interpolate', ['linear'], ['get', 'highestMeters'], 3000, '#3aa267', 6000, '#e0603a', 8000, '#8f5cf6'],
          'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 14, 20, 26],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        }}
      />
      <StyleLayer id="peak-counts" type="symbol" filter={['has', 'point_count']} layout={{ 'text-field': '{point_count_abbreviated}', 'text-size': 14 }} paint={{ 'text-color': '#ffffff' }} />
      <StyleLayer
        id="peak-points"
        type="circle"
        filter={['!', ['has', 'point_count']]}
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
        layout={{ 'text-field': '{name}', 'text-size': 13, 'text-anchor': 'top', 'text-offset': [0, 0.9] }}
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

/** The sun's time today, from an hour in UTC. */
function dateAtHour(hourUtc: number): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(hourUtc), Math.round((hourUtc % 1) * 60)))
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
  const [hourUtc, setHourUtc] = useState<number | null>(null)
  const [layers, setLayers] = useState<DataLayers>({ peaks: true, cities: false, landmarks: true, buildings: true, labels: true })
  const [tool, setTool] = useState<Tool>('explore')
  const [unitSystem, setUnitSystem] = useState<UnitSystem>('metric')
  const [selection, setSelection] = useState<Selection | null>(null)
  const peakSource = useRef<GeoJsonSourceImpl | null>(null)

  // The plugins, created once. Draw, measure and the geocoder stay installed (idle in their `static` mode); the
  // comparison is installed only while its tool is on, which clips the layers it lists.
  const draw = useMemo(() => new Draw(), [])
  const measure = useMemo(() => new Measure(), [])
  const geocoder = useMemo(() => new Geocoder({ provider: createProviders(), marker: true }), [])
  const compare = useMemo(() => new Compare(), [])
  const plugins = useMemo(() => (tool === 'compare' ? [draw, measure, geocoder, compare] : [draw, measure, geocoder]), [tool, draw, measure, geocoder, compare])
  const beforeRef = useCompareImagery(compare, 'before')
  const afterRef = useCompareImagery(compare, 'after')

  const fitFile = (file: LoadedGeoJsonFile) => {
    if (file.bounds !== null) void earth?.camera.fitBounds(file.bounds, { paddingPixels: { topPixels: 60, rightPixels: 70, bottomPixels: 60, leftPixels: 60 }, maximumZoom: 15 })
  }
  const geoJsonFiles = useGeoJsonFiles(fitFile)
  const dragging = useFileDrop(files => void geoJsonFiles.add(files))
  const addSample = () => void geoJsonFiles.add([new File([sampleGeoJsonText()], 'haute-route.geojson', { type: 'application/geo+json' })])

  const style = useMemo(() => basemapStyle(basemap, layers), [basemap, layers.buildings, layers.labels])
  const otherStyle = useMemo(() => comparedStyle(basemap), [basemap])
  // A new preset is a new material factory: the terrain reloads its tiles with it.
  const terrainStyle = useTerrainStyle({ color: preset })
  const date = useMemo(() => (hourUtc === null ? undefined : dateAtHour(hourUtc)), [hourUtc])

  const chooseTool = (next: Tool) => {
    if (next !== 'draw') draw.setMode('static')
    if (next !== 'measure') measure.setMode('static')
    if (next !== 'explore') setSelection(null)
    setTool(next)
  }
  const toggleLayer = (key: keyof DataLayers) => setLayers(current => ({ ...current, [key]: !current[key] }))
  const removeFile = (id: string) => {
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
      date={date}
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
            <label className="example-field">
              Sun (UTC)
              <input type="range" min={0} max={23.75} step={0.25} value={hourUtc ?? new Date().getUTCHours() + new Date().getUTCMinutes() / 60} onChange={event => setHourUtc(Number(event.target.value))} />
              <output>{hourUtc === null ? 'now' : `${String(Math.floor(hourUtc)).padStart(2, '0')}:${String(Math.round((hourUtc % 1) * 60)).padStart(2, '0')}`}</output>
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
            {tool === 'draw' ? <DrawToolbar draw={draw} /> : null}
            {tool === 'measure' ? <MeasurePanel measure={measure} unitSystem={unitSystem} setUnitSystem={setUnitSystem} /> : null}
            {tool === 'compare' ? <p className="example-status">Drag the slider: {basemap === 'satellite' ? 'streets' : 'satellite'} on the right, your basemap and data on the left.</p> : null}
          </Section>

          <Section title={`Your GeoJSON${geoJsonFiles.files.length > 0 ? ` (${geoJsonFiles.files.length})` : ''}`} open>
            <GeoJsonFilesPanel files={geoJsonFiles.files} errors={geoJsonFiles.errors} onAdd={files => void geoJsonFiles.add(files)} onSample={addSample} onToggle={geoJsonFiles.toggle} onRemove={removeFile} onZoom={fitFile} />
          </Section>
        </div>
      }
    >
      <Imagery ref={beforeRef}>
        <MapStyleSource style={style}>
          {layers.cities ? <CityLayers /> : null}
          {layers.peaks ? <PeakLayers source={peakSource} /> : null}
          {geoJsonFiles.files.map(file => (
            <GeoJsonFileLayers key={file.id} file={file} />
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
      {tool === 'measure' ? <MeasurementLabels measure={measure} unitSystem={unitSystem} /> : null}
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

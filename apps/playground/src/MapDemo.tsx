import { Canvas } from '@react-three/fiber'
import {
  prefersWebGLBackend,
  setCameraView,
  type CameraView,
  type Earth as EarthImpl,
  type GeographicPosition,
  type MapStyleSource as MapStyleSourceImpl,
  type Marker as MarkerImpl,
  type ViewMode,
} from 'react-three-earth'
import {
  Atmosphere,
  AttributionControl,
  Earth,
  EarthControls,
  Imagery,
  MapStyleSource,
  Marker,
  PerformanceStats,
  Popup,
  QuantizedMeshSource,
  RasterTileSource,
  StyleLayer,
  Terrain,
  useEarth,
  useEarthFrame,
} from 'react-three-earth/react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'

import { capsule, smoothUnion, sphere, torus, translate, union } from './sdf/distance'
import { SdfShape } from './sdf/SdfShape'
import { sdfShapes } from './sdf/sdfShapes'
import { sdfGlow } from './styleLayers/sdfGlow'
import { stripedFill } from './styleLayers/stripedFill'

const OPENSTREETMAP_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

const params = new URLSearchParams(location.search)
const useFixtures = params.has('fixtures')
const terrainUrl = useFixtures ? `${import.meta.env.BASE_URL}fixtures/terrain/` : (import.meta.env.VITE_TERRAIN_URL ?? 'https://terrain.reearth.land/cesium-mesh/ellipsoid/')
const imageryUrl = useFixtures ? `${import.meta.env.BASE_URL}fixtures/imagery/{z}/{x}/{y}.png` : (import.meta.env.VITE_IMAGERY_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
const withAtmosphere = params.get('atmosphere') !== '0'
const initialView: ViewMode = params.get('view') === '2d' ? '2d' : '3d'
// `?map=vector` drapes a MapLibre style (vector tiles) instead of raster imagery. `?test=invalidate` (with
// `?fixtures&map=vector`) reads tiles whose lake colour the browser check changes on the server, then redraws
// them through `window.mapStyleSource.invalidate(bounds)`.
// `?map=patterns` (with `?fixtures`) is the fixture style with sprite patterns; images it lacks are listed in
// `window.styleImagesMissing` for the browser check, which adds one with `window.mapStyleSource.addImage`.
const liveFixtures = useFixtures && params.get('test') === 'invalidate'
const fixtureStyleUrl = params.get('map') === 'patterns' ? '/fixtures/style-patterns.json' : `/fixtures/style.json${liveFixtures ? '?live' : ''}`
const mapStyleUrl = params.get('map') === 'vector' || (useFixtures && params.get('map') === 'patterns') ? (useFixtures ? fixtureStyleUrl : import.meta.env.VITE_MAP_STYLE_URL) : undefined
if (params.get('map') === 'vector' && mapStyleUrl === undefined) console.warn('Set VITE_MAP_STYLE_URL in apps/playground/.env for ?map=vector; showing raster imagery.')
// The atmosphere's lookup textures are cached between page loads, in dev too: the cache key holds
// ATMOSPHERE_PRECOMPUTE_VERSION, which a unit test makes you bump when the generating shaders change.
// `?nocache` always generates them, for timing generation on a device.
const atmosphereCache = !params.has('nocache')
// `?atmosphereBudget=<milliseconds>` (or Infinity) sets the GPU time per frame spent generating them.
const atmosphereBudget = params.has('atmosphereBudget') ? Number(params.get('atmosphereBudget')) : undefined
const showStatistics = params.get('stats') !== '0'
// `?markers` adds markers and popups (on the fixture terrain's highest hill with `?fixtures`).
const showMarkers = params.has('markers')
// `?sdf` installs the example plugin (src/sdf/) and puts a raymarched shape on the peak, half buried in it.
const showSdfShapes = params.has('sdf')
const sdfShapesPlugin = sdfShapes()
// `?glow` (with `?fixtures&map=vector`) installs the style layer type examples (src/styleLayers/): a glow around
// the primary roads (worker module, offscreen maximum blending) and striped lakes (built-in fill, own shader).
// `?glow=late` leaves them out: the browser check installs them after the style loaded (window.styleLayerTypePlugins).
const showStyleLayerTypes = params.has('glow')
const styleLayerTypePlugins = [sdfGlow(), stripedFill()]
const plugins = [...(showSdfShapes ? [sdfShapesPlugin] : []), ...(showStyleLayerTypes && params.get('glow') !== 'late' ? styleLayerTypePlugins : [])]
if (showStyleLayerTypes) Object.assign(window, { styleLayerTypePlugins })
// Module scope: each distinct distance function is its own pipeline.
const beacon = union(smoothUnion(sphere(260), translate(capsule(90, 450), [0, 0, -450]), 120), translate(torus(420, 50), [0, 0, 100]))
// WebGL 2 where WebGPU is slow (Safari); `?webgl` forces it anywhere, `?webgpu` forces WebGPU
// (`?webgl` wins if both are given).
const forceWebGL = params.has('webgl') || (!params.has('webgpu') && prefersWebGLBackend())
const defaultDate = new Date('2026-11-22T07:00:00Z')
const requestedDate = new Date(params.get('date') ?? Number.NaN)
const date = Number.isNaN(requestedDate.getTime()) ? defaultDate : requestedDate

/**
 * Mount Fuji from the south-east, late afternoon. Override with
 * `?camera=longitude,latitude,height,distance,heading,pitch` (degrees and meters), e.g. from space:
 * `?camera=138.7,35.4,0,8000000,0,-20`.
 */
function readCameraView(): CameraView {
  const defaults = [138.7274, 35.3606, 2000, 60_000, -40, -25] as const
  const given = params.get('camera')?.split(',') ?? []
  // Empty or non-numeric fields keep their default
  const [longitudeDegrees, latitudeDegrees, heightMeters, distanceMeters, headingDegrees, pitchDegrees] = defaults.map((fallback, index) => {
    const value = Number.parseFloat(given[index] ?? '')
    return Number.isFinite(value) ? value : fallback
  }) as [number, number, number, number, number, number]
  return { longitudeDegrees, latitudeDegrees, heightMeters, distanceMeters, headingDegrees, pitchDegrees }
}

declare global {
  interface Window {
    earth?: EarthImpl
    setView?: (view: ViewMode) => void
    camera?: import('three').Camera
    mapStyleSource?: MapStyleSourceImpl | null
    markers?: Record<string, MarkerImpl | null>
    dragEnds?: GeographicPosition[]
    selectedPlace?: string | null
    styleImagesMissing?: string[]
  }
}

function InitialView() {
  const camera = useThree(state => state.camera)
  const earth = useEarth()
  useLayoutEffect(() => {
    setCameraView(camera, readCameraView())
    window.earth = earth // agents and tests read earth.inspect()
    window.camera = camera
  }, [camera, earth])
  return null
}

/**
 * Markers for `?markers`. With fixtures: a pin with a popup on the highest hill (3900 m at -90°, 0°), a label
 * buried under it (height 0, so the hill hides it), and a draggable pin. Otherwise the same around Fuji.
 */
function Markers() {
  const peak = useFixtures ? { longitudeDegrees: -90, latitudeDegrees: 0, name: 'Fixture peak', heightMeters: 3900 } : { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, name: 'Mount Fuji', heightMeters: 3776 }
  const [dragged, setDragged] = useState<GeographicPosition>({ longitudeDegrees: peak.longitudeDegrees + 0.05, latitudeDegrees: peak.latitudeDegrees - 0.05 })
  const markers = (window.markers ??= {})
  // One popup open at a time, controlled: the "selected place" pattern.
  const [selected, setSelected] = useState<string | null>(null)
  window.selectedPlace = selected
  const places = [
    { id: 'east', longitudeDegrees: peak.longitudeDegrees + 0.08, latitudeDegrees: peak.latitudeDegrees + 0.02 },
    { id: 'west', longitudeDegrees: peak.longitudeDegrees - 0.06, latitudeDegrees: peak.latitudeDegrees - 0.04 },
  ]
  return (
    <>
      {places.map(place => (
        <Marker key={place.id} longitudeDegrees={place.longitudeDegrees} latitudeDegrees={place.latitudeDegrees} color="#7048e8" label={`Place ${place.id}`}>
          <Popup open={selected === place.id} onOpen={() => setSelected(place.id)} onClose={() => setSelected(null)}>
            Place {place.id}
          </Popup>
        </Marker>
      ))}
      <Marker longitudeDegrees={peak.longitudeDegrees} latitudeDegrees={peak.latitudeDegrees} label={peak.name} ref={marker => void (markers.peak = marker)}>
        <Popup>
          <strong>{peak.name}</strong>
          <div>{peak.heightMeters} m</div>
        </Popup>
      </Marker>
      <Marker longitudeDegrees={peak.longitudeDegrees - 0.1} latitudeDegrees={peak.latitudeDegrees + 0.1} heightMeters={0} label="Buried label" ref={marker => void (markers.buried = marker)}>
        <div style={{ padding: '2px 6px', background: '#fff', borderRadius: 4, font: '12px system-ui', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>sea level</div>
      </Marker>
      <Marker
        {...dragged}
        draggable
        color="#e8590c"
        label="Draggable marker"
        ref={marker => void (markers.draggable = marker)}
        onDragEnd={position => {
          // Without the height, the marker keeps following the terrain.
          setDragged({ longitudeDegrees: position.longitudeDegrees, latitudeDegrees: position.latitudeDegrees })
          ;(window.dragEnds ??= []).push(position)
        }}
      />
    </>
  )
}

/** The `?glow` layers: custom style layer types from the example plugins, at their place in the fixture style. */
function StyleLayerTypeExamples() {
  return (
    <>
      <StyleLayer id="lake-stripes" type="striped-fill" source="fixture" sourceLayer="water" paint={{ 'striped-fill-color': '#2f7fd8', 'striped-fill-stripe-color': '#9fd0ff', 'striped-fill-stripe-width-pixels': 5 }} beforeId="road-casing" />
      <StyleLayer
        id="road-glow"
        type="sdf-glow"
        source="fixture"
        sourceLayer="roads"
        filter={['==', ['get', 'class'], 'primary']}
        paint={{ 'sdf-glow-color': '#ff2bd6', 'sdf-glow-radius-pixels': 28 }}
        beforeId="road-casing"
      />
    </>
  )
}

/**
 * The `?sdf` scene: a beacon on the peak (3900 m at -90°, 0° with fixtures, Fuji otherwise), its lower half in
 * the mountain, and a ring above it.
 */
function SdfShapes() {
  const peak = useFixtures ? { longitudeDegrees: -90, latitudeDegrees: 0, heightMeters: 3900 } : { longitudeDegrees: 138.7274, latitudeDegrees: 35.3606, heightMeters: 3776 }
  return <SdfShape plugin={sdfShapesPlugin} position={peak} halfSizeMeters={[480, 480, 1000]} distanceFunction={beacon} color="#ff5a1f" />
}

/** Plain lights for the atmosphere-off check, faded out on the flat map like the atmosphere's sun. */
function PlainLights() {
  const [lights] = useState(() => ({ ambient: { current: null as { intensity: number } | null }, sun: { current: null as { intensity: number } | null } }))
  useEarthFrame(earth => {
    const lit = 1 - earth.view.morph
    if (lights.ambient.current) lights.ambient.current.intensity = 0.6 * lit
    if (lights.sun.current) lights.sun.current.intensity = 2 * lit
  })
  return (
    <>
      <ambientLight ref={lights.ambient as never} intensity={0.6} />
      <directionalLight ref={lights.sun as never} position={[1e7, 0, 1e7]} intensity={2} />
    </>
  )
}

/** How the atmosphere's lookup textures were made, for reading timings off a phone. */
function AtmosphereStatus() {
  const [text, setText] = useState('')
  useEffect(() => {
    const startMilliseconds = performance.now()
    const interval = setInterval(() => {
      const atmosphere = window.earth?.inspect().atmosphere
      if (atmosphere == null) return setText('')
      if (!atmosphere.ready) return setText(`Atmosphere: generating… ${((performance.now() - startMilliseconds) / 1000).toFixed(0)} s`)
      const seconds = ((atmosphere.generationTimeMilliseconds ?? 0) / 1000).toFixed(2)
      setText(`Atmosphere: ${atmosphere.loadedFromCache ? 'loaded from cache' : 'generated'} in ${seconds} s, ${atmosphere.generationFrames} frames`)
      clearInterval(interval)
    }, 250)
    return () => clearInterval(interval)
  }, [])
  return text === '' ? null : <div style={{ position: 'absolute', bottom: 8, left: 8, opacity: 0.8 }}>{text}</div>
}

export function MapDemo() {
  const [view, setView] = useState<ViewMode>(initialView)
  window.setView = setView // tests switch the view like the button does
  return (
    <>
      <Canvas renderer={{ antialias: true, reversedDepthBuffer: true, forceWebGL: forceWebGL, trackTimestamp: showStatistics }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={[1, 2]}>
        <Earth date={date} view={view} plugins={plugins}>
          <InitialView />
          {showStatistics ? <PerformanceStats /> : null}
          <Terrain>
            <QuantizedMeshSource url={terrainUrl} attribution={useFixtures ? 'Synthetic test terrain' : 'Terrain: Re:Earth Terrain, Mapterhorn'} />
          </Terrain>
          <Imagery>
            {mapStyleUrl !== undefined ? (
              <MapStyleSource url={mapStyleUrl} ref={source => void (window.mapStyleSource = source)} onStyleImageMissing={imageId => (window.styleImagesMissing ??= []).push(imageId)}>
                {showStyleLayerTypes ? <StyleLayerTypeExamples /> : null}
              </MapStyleSource>
            ) : <RasterTileSource url={imageryUrl} levels={useFixtures ? 18 : 19} attribution={OPENSTREETMAP_ATTRIBUTION} />}
          </Imagery>
          {withAtmosphere ? (
            <Atmosphere cache={atmosphereCache} generationBudgetMillisecondsPerFrame={atmosphereBudget} />
          ) : (
            <PlainLights />
          )}
          <EarthControls />
          <AttributionControl />
          {showMarkers ? <Markers /> : null}
          {showSdfShapes ? <SdfShapes /> : null}
        </Earth>
      </Canvas>
      <button
        type="button"
        onClick={() => setView(view === '3d' ? '2d' : '3d')}
        style={{ position: 'absolute', top: 8, right: 8, padding: '6px 12px', font: 'inherit', cursor: 'pointer' }}
      >
        {view === '3d' ? 'Flat map (2D)' : 'Globe (3D)'}
      </button>
      {withAtmosphere && <AtmosphereStatus />}
    </>
  )
}

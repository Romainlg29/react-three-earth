import { Canvas, useThree } from '@react-three/fiber'
import { setCameraView, type CameraView, type Earth as EarthImpl, type EarthPlugin } from '@earthkit/globe'
import {
  Atmosphere,
  Earth,
  EarthControls,
  QuantizedMeshSource,
  Terrain,
  useEarth,
} from '@earthkit/globe/react'
import { useEffect, useLayoutEffect, useState, type ComponentProps, type ReactNode } from 'react'

import { MapControls } from '../controls/MapControls'
import { cameraFromParams, forceWebGL, terrainAttribution, terrainUrl, withAtmosphere } from './data'
import { cameraLongitude, dateAtLocalSolarHours, parseTimeOfDay, TimeOfDay } from './TimeOfDay'
import './examples.css'

const searchParams = new URLSearchParams(location.search)
/** `?date=<ISO time>` fixes the sun, so browser checks see the same light at any hour. Default: now. */
const requestedDate = new Date(searchParams.get('date') ?? Number.NaN)
const date = Number.isNaN(requestedDate.getTime()) ? undefined : requestedDate
/** `?time=HH:MM`: local solar time at the example's starting view, on the UTC day of `?date`, or today. */
const requestedTimeOfDay = parseTimeOfDay(searchParams.get('time'))

function initialDate(view: CameraView): Date {
  const startView = cameraFromParams(view)
  return requestedTimeOfDay === null ? (date ?? new Date()) : dateAtLocalSolarHours(requestedTimeOfDay, startView.longitudeDegrees, date)
}

function InitialView({ view, onEarth }: { view: CameraView; onEarth?: (earth: EarthImpl) => void }) {
  const camera = useThree(state => state.camera)
  const earth = useEarth()
  useLayoutEffect(() => {
    setCameraView(camera, cameraFromParams(view))
    window.earth = earth // the browser checks read earth.inspect()
    window.camera = camera
    onEarth?.(earth)
    // Once: the camera is the user's after this
  }, [camera, earth])
  return null
}

export interface ExampleShellProps {
  title: string
  /** One or two sentences on what the example shows; plain text or inline elements. */
  description: ReactNode
  camera: CameraView
  /** Inside `<Earth>`: imagery, markers, hooks. */
  children?: ReactNode
  /** The terrain's source. Default: the quantized-mesh terrain. */
  terrain?: ReactNode
  /** `<Terrain exaggeration>`. */
  exaggeration?: number
  /** `<Terrain createMaterial>`: a stable function, defined outside render. */
  createTerrainMaterial?: ComponentProps<typeof Terrain>['createMaterial']
  /** Buttons and inputs under the description. */
  panel?: ReactNode
  /** `<Earth plugins>`: create them once, outside render. */
  plugins?: readonly EarthPlugin[]
  /** The physically based sky and sun; false lights the map evenly instead. Default: true unless `?atmosphere=0`. */
  atmosphere?: boolean
  /** `<Atmosphere exposure>`: lower for a dim, overcast day. Default: the atmosphere's. */
  atmosphereExposure?: number
  /** Props for `<EarthControls>`. */
  controls?: ComponentProps<typeof EarthControls>
  /** Receives the vanilla `Earth` once mounted: the panel's buttons drive `earth.camera`. */
  onEarth?: (earth: EarthImpl) => void
  /** Shows the card with the title and panel. Default: true. */
  showCard?: boolean
  /** DOM over the canvas, in its box (a slider's handle). */
  overlay?: ReactNode
  /** The DOM around the canvas, for an example that embeds the map in a page. Default: the whole window. */
  className?: string
  /** The sun's time, overriding `?date`, `?time` and the time-of-day slider (which it hides). Default: now. */
  date?: Date
  /** Show the globe / flat map button in the map controls. Default: false. */
  viewSwitch?: boolean
}

/**
 * The frame every gallery example shares: a full-window canvas with terrain, the atmosphere, the map controls,
 * and a card with the example's title, what it shows, its own controls and a link back to the gallery. The card
 * collapses to its title on narrow screens so the map stays usable on a phone.
 */
export function ExampleShell({ title, description, camera, children, terrain, exaggeration, createTerrainMaterial, panel, controls, onEarth, plugins, overlay, atmosphere = withAtmosphere, atmosphereExposure, showCard = true, className = 'example-canvas', date: dateOverride, viewSwitch = false }: ExampleShellProps) {
  const [collapsed, setCollapsed] = useState(() => matchMedia('(max-width: 600px)').matches)
  const [sunDate, setSunDate] = useState(() => initialDate(camera))
  const [earth, setEarth] = useState<EarthImpl | null>(null)
  const [longitudeDegrees, setLongitudeDegrees] = useState(() => cameraFromParams(camera).longitudeDegrees)
  const handleEarth = (mounted: EarthImpl) => {
    setEarth(mounted)
    onEarth?.(mounted)
  }
  // The slider reads local solar time where the camera came to rest: follow it after each move.
  useEffect(() => {
    if (!earth) return
    const follow = () => setLongitudeDegrees(current => cameraLongitude(earth, current))
    earth.addEventListener('moveend', follow)
    return () => earth.removeEventListener('moveend', follow)
  }, [earth])
  return (
    <div className={className}>
      <Canvas renderer={{ antialias: true, reversedDepthBuffer: true, forceWebGL }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={[1, 2]}>
        <Earth plugins={plugins} date={dateOverride ?? sunDate}>
          <InitialView view={camera} onEarth={handleEarth} />
          <Terrain exaggeration={exaggeration} createMaterial={createTerrainMaterial}>{terrain ?? <QuantizedMeshSource url={terrainUrl} attribution={terrainAttribution} />}</Terrain>
          {children}
          {atmosphere ? <Atmosphere exposure={atmosphereExposure} /> : <PlainLights />}
          <EarthControls {...controls} />
          <MapControls viewSwitch={viewSwitch} />
        </Earth>
      </Canvas>
      {overlay}
      {showCard ? (
        <section className="example-card" aria-label={title} data-collapsed={collapsed}>
          <header>
            <a className="example-back" href={`${import.meta.env.BASE_URL}examples.html`} aria-label="All examples">
              ‹
            </a>
            <h1>{title}</h1>
            <button type="button" className="example-toggle" aria-expanded={!collapsed} aria-label={collapsed ? 'Show details' : 'Hide details'} onClick={() => setCollapsed(value => !value)}>
              {collapsed ? '+' : '−'}
            </button>
          </header>
          {collapsed ? null : (
            <div className="example-body">
              <p>{description}</p>
              {panel}
              {dateOverride === undefined ? <TimeOfDay date={sunDate} onChange={setSunDate} longitudeDegrees={longitudeDegrees} /> : null}
            </div>
          )}
        </section>
      ) : null}
    </div>
  )
}

/** Plain lights for `?atmosphere=0`. */
function PlainLights() {
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[1e7, 0, 1e7]} intensity={2} />
    </>
  )
}

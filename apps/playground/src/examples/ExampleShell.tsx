import { Canvas, useThree } from '@react-three/fiber'
import { setCameraView, type CameraView, type Earth as EarthImpl, type EarthPlugin } from 'react-three-earth'
import {
  Atmosphere,
  Earth,
  EarthControls,
  QuantizedMeshSource,
  Terrain,
  useEarth,
} from 'react-three-earth/react'
import { useLayoutEffect, useState, type ComponentProps, type ReactNode } from 'react'

import { MapControls } from '../controls/MapControls'
import { cameraFromParams, forceWebGL, terrainAttribution, terrainUrl, withAtmosphere } from './data'
import './examples.css'

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
  /** Buttons and inputs under the description. */
  panel?: ReactNode
  /** `<Earth plugins>`: create them once, outside render. */
  plugins?: readonly EarthPlugin[]
  /** The physically based sky and sun; false lights the map evenly instead. Default: true unless `?atmosphere=0`. */
  atmosphere?: boolean
  /** Props for `<EarthControls>`. */
  controls?: ComponentProps<typeof EarthControls>
  /** Receives the vanilla `Earth` once mounted: the panel's buttons drive `earth.camera`. */
  onEarth?: (earth: EarthImpl) => void
  /** Shows the card with the title and panel. Default: true. */
  showCard?: boolean
  /** The DOM around the canvas, for an example that embeds the map in a page. Default: the whole window. */
  className?: string
}

/**
 * The frame every gallery example shares: a full-window canvas with terrain, the atmosphere, the map controls,
 * and a card with the example's title, what it shows, its own controls and a link back to the gallery. The card
 * collapses to its title on narrow screens so the map stays usable on a phone.
 */
export function ExampleShell({ title, description, camera, children, terrain, exaggeration, panel, controls, onEarth, plugins, atmosphere = withAtmosphere, showCard = true, className = 'example-canvas' }: ExampleShellProps) {
  const [collapsed, setCollapsed] = useState(() => matchMedia('(max-width: 600px)').matches)
  return (
    <div className={className}>
      <Canvas renderer={{ antialias: true, reversedDepthBuffer: true, forceWebGL }} camera={{ fov: 60, near: 1, far: 1e8 }} dpr={[1, 2]}>
        <Earth plugins={plugins}>
          <InitialView view={camera} onEarth={onEarth} />
          <Terrain exaggeration={exaggeration}>{terrain ?? <QuantizedMeshSource url={terrainUrl} attribution={terrainAttribution} />}</Terrain>
          {children}
          {atmosphere ? <Atmosphere /> : <PlainLights />}
          <EarthControls {...controls} />
          <MapControls />
        </Earth>
      </Canvas>
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

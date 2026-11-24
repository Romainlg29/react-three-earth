/**
 * The playground's styled map controls, built on the library's headless hooks: an example of what an app writes.
 * The library draws no buttons and ships no CSS; the look lives in `mapControls.css`.
 */
import type { ViewMode } from 'react-three-earth'
import { Controls, Marker, useFullscreenControl, useMarker, useGeolocateControl, useNavigationControl, useScaleControl, useViewControl } from 'react-three-earth/react'

import { useLayoutEffect } from 'react'

import './mapControls.css'

const PLUS = 'M9 3h2v6h6v2h-6v6H9v-6H3V9h6z'
const MINUS = 'M3 9h14v2H3z'
const NEEDLE_NORTH = 'M10 1.5 14 10H6z'
const NEEDLE_SOUTH = 'M10 18.5 6 10h8z'
const CROSSHAIR = 'M9 1h2v2.07A7 7 0 0 1 16.93 9H19v2h-2.07A7 7 0 0 1 11 16.93V19H9v-2.07A7 7 0 0 1 3.07 11H1V9h2.07A7 7 0 0 1 9 3.07zM10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'
const ENTER_FULLSCREEN = 'M3 3h5v2H5v3H3zM12 3h5v5h-2V5h-3zM3 12h2v3h3v2H3zM15 12h2v5h-5v-2h3z'
const EXIT_FULLSCREEN = 'M7 3h2v5H4V6h3zM11 3h2v3h3v2h-5zM4 12h5v5H7v-3H4zM11 12h5v2h-3v3h-2z'

function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" className={className}>
      <path d={path} />
    </svg>
  )
}

function Navigation() {
  const navigation = useNavigationControl({ visualizePitch: true })
  return (
    <div className="map-control-group" {...navigation.groupProps}>
      <button className="map-control-button" {...navigation.zoomInButtonProps}>
        <Icon path={PLUS} />
      </button>
      <button className="map-control-button" {...navigation.zoomOutButtonProps}>
        <Icon path={MINUS} />
      </button>
      <button className="map-control-button" data-north={navigation.north} {...navigation.compassButtonProps}>
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" className="map-compass-needle" style={{ transform: navigation.compassTransform }}>
          <path d={NEEDLE_NORTH} fill="#e2574c" />
          <path d={NEEDLE_SOUTH} fill="#8a8a8a" />
        </svg>
      </button>
    </div>
  )
}

function ViewSwitch({ onViewChange }: { onViewChange?: (mode: ViewMode) => void }) {
  const view = useViewControl({ onViewChange })
  return (
    <div className="map-control-group">
      <button className="map-control-button" {...view.buttonProps}>
        {view.label}
      </button>
    </div>
  )
}

/**
 * A `<Marker>` is a focusable button by default. The user's dot is a picture (`role="img"`) and the accuracy circle
 * decoration (`aria-hidden`): neither belongs in the tab order.
 */
function PassiveMarker({ decorative }: { decorative: boolean }) {
  const marker = useMarker()
  useLayoutEffect(() => {
    const element = marker?.element
    if (element === undefined) return
    element.removeAttribute('tabindex')
    if (decorative) {
      element.removeAttribute('role')
      element.setAttribute('aria-hidden', 'true')
    } else {
      element.setAttribute('role', 'img')
    }
  }, [marker, decorative])
  return null
}

/** The geolocate button, and the user's dot and accuracy circle drawn from its state with markers. */
function Geolocate() {
  const geolocate = useGeolocateControl({ trackUser: true })
  const location = geolocate.userLocation
  const diameter = geolocate.accuracyDiameterPixels
  return (
    <div className="map-control-group">
      <button className="map-control-button" data-status={geolocate.permissionDenied ? 'error' : geolocate.status} {...geolocate.buttonProps}>
        <Icon path={CROSSHAIR} />
      </button>
      {location === null ? null : (
        <>
          <Marker longitudeDegrees={location.longitudeDegrees} latitudeDegrees={location.latitudeDegrees} anchor="center" pitchAlignment="map" rotationAlignment="map" label={geolocate.userLocationAccuracyLabel}>
            <PassiveMarker decorative />
            <div className="map-accuracy-circle" style={{ width: diameter, height: diameter, visibility: diameter < 16 ? 'hidden' : 'visible' }} />
          </Marker>
          <Marker longitudeDegrees={location.longitudeDegrees} latitudeDegrees={location.latitudeDegrees} anchor="center" occludedOpacity={1} label={geolocate.userLocationLabel}>
            <PassiveMarker decorative={false} />
            <div className="map-user-dot" data-stale={geolocate.stale} />
          </Marker>
        </>
      )}
    </div>
  )
}

function Fullscreen() {
  const fullscreen = useFullscreenControl()
  return (
    <div className="map-control-group">
      <button className="map-control-button" {...fullscreen.buttonProps}>
        <Icon path={fullscreen.active ? EXIT_FULLSCREEN : ENTER_FULLSCREEN} />
      </button>
    </div>
  )
}

function Scale() {
  const scale = useScaleControl()
  return (
    <div className="map-scale" {...scale.scaleProps} style={{ width: scale.widthPixels }}>
      {scale.label}
    </div>
  )
}

export interface MapControlsProps {
  /** Show the 2D / 3D button, reporting presses here. */
  onViewChange?: (mode: ViewMode) => void
  /** Show the 2D / 3D button. Default: true when `onViewChange` is given. */
  viewSwitch?: boolean
  /** Show the geolocate button and the user's dot. Default: false. */
  geolocate?: boolean
}

/**
 * Zoom, compass, (2D / 3D), (geolocate), fullscreen in the top-right corner, and the scale in the bottom-left.
 * Place it inside `<Earth>`.
 */
export function MapControls({ onViewChange, viewSwitch = onViewChange !== undefined, geolocate = false }: MapControlsProps) {
  return (
    <>
      <Controls className="map-corner map-corner-top-right">
        <Navigation />
        {viewSwitch ? <ViewSwitch onViewChange={onViewChange} /> : null}
        {geolocate ? <Geolocate /> : null}
        <Fullscreen />
      </Controls>
      <Controls className="map-corner map-corner-bottom-left">
        <Scale />
      </Controls>
    </>
  )
}

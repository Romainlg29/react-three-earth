import { useThree } from '@react-three/fiber/extension'
import { use, useLayoutEffect, useState, type ReactNode } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import { Controls as ControlsImpl, type ControlPosition, type ControlsItem } from '../controls/Controls.js'
import { FullscreenControl as FullscreenControlImpl, type FullscreenControlOptions } from '../controls/FullscreenControl.js'
import { GeolocateControl as GeolocateControlImpl, type GeolocateControlOptions, type GeolocateEventMap } from '../controls/GeolocateControl.js'
import type { ControlsLocale } from '../controls/locale.js'
import { NavigationControl as NavigationControlImpl, type NavigationControlOptions } from '../controls/NavigationControl.js'
import { ScaleControl as ScaleControlImpl, type ScaleControlOptions } from '../controls/ScaleControl.js'
import { ViewControl as ViewControlImpl, type ViewControlOptions } from '../controls/ViewControl.js'
import type { ViewMode } from '../view/ViewMorph.js'
import { ControlsContext, useEarth } from './context.js'

export interface ControlsProps {
  /** The corner of the map. Default: 'top-right'. */
  position?: ControlPosition
  /** Where the controls go. Default: the element around the canvas. */
  container?: HTMLElement | null
  /** `<NavigationControl>`, `<ScaleControl>`, `<GeolocateControl>`, `<FullscreenControl>`, `<ViewControl>` or your own. */
  children?: ReactNode
}

/**
 * A corner of the map with controls in it. Place it inside `<Earth>`; two `<Controls>` in one corner stack.
 *
 * ```tsx
 * <Controls position="top-right">
 *   <NavigationControl />
 *   <ViewControl />
 * </Controls>
 * ```
 */
export function Controls({ position = 'top-right', container, children }: ControlsProps) {
  const earth = useEarth()
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const [controls, setControls] = useState<ControlsImpl | null>(null)
  const parent = container ?? renderer.domElement.parentElement

  useLayoutEffect(() => {
    if (parent === null) return
    const created = new ControlsImpl({ earth, container: parent, position })
    setControls(created)
    return () => {
      setControls(null)
      created.dispose()
    }
  }, [earth, parent, position])

  // The children add themselves once their corner exists
  return controls === null ? null : <ControlsContext value={controls}>{children}</ControlsContext>
}

/** The vanilla `Controls` of the nearest `<Controls>`, for a control of your own. */
export function useControls(): ControlsImpl {
  const controls = use(ControlsContext)
  if (controls === null) throw new Error('useControls: put this component inside <Controls>, for example <Controls><NavigationControl /></Controls>.')
  return controls
}

/** Adds a control to the nearest `<Controls>` for as long as the component is mounted, and rebuilds it when `dependencies` change. */
function useControl<T extends ControlsItem & { dispose?(): void }>(name: string, create: () => T, dependencies: readonly unknown[], onCreate?: (control: T) => (() => void) | void): T | null {
  const controls = use(ControlsContext)
  if (controls === null) throw new Error(`<${name}> must sit inside <Controls>, for example <Controls><${name} /></Controls>.`)
  const [control, setControl] = useState<T | null>(null)
  useLayoutEffect(() => {
    const created = create()
    ;(created as unknown as { addTo(controls: ControlsImpl): void }).addTo(controls)
    const release = onCreate?.(created)
    setControl(created)
    return () => {
      release?.()
      setControl(null)
      created.dispose?.()
    }
    // `create` and `onCreate` close over `dependencies`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, ...dependencies])
  return control
}

function localeKey(locale: Partial<ControlsLocale> | undefined): string | undefined {
  return locale === undefined ? undefined : JSON.stringify(locale)
}

export type NavigationControlProps = NavigationControlOptions

/** Zoom in, zoom out and compass buttons. See the vanilla `NavigationControl`. */
export function NavigationControl(props: NavigationControlProps) {
  useControl('NavigationControl', () => new NavigationControlImpl(props), [props.showZoom, props.showCompass, props.visualizePitch, props.zoomStep, props.durationSeconds, localeKey(props.locale)])
  return null
}

export type ScaleControlProps = ScaleControlOptions

/** A scale bar with a round length in metres, miles or nautical miles. See the vanilla `ScaleControl`. */
export function ScaleControl(props: ScaleControlProps) {
  useControl('ScaleControl', () => new ScaleControlImpl(props), [props.unit, props.maximumWidthPixels, localeKey(props.locale)])
  return null
}

export interface GeolocateControlProps extends GeolocateControlOptions {
  /** A position arrived. */
  onGeolocate?: (event: GeolocateEventMap['geolocate']) => void
  /** The browser could not tell the position. */
  onError?: (event: GeolocateEventMap['error']) => void
  /** The map started following the user. */
  onTrackUserLocationStart?: () => void
  /** The map stopped following the user. */
  onTrackUserLocationEnd?: () => void
}

/** Finds the user and flies there. See the vanilla `GeolocateControl`. */
export function GeolocateControl({ onGeolocate, onError, onTrackUserLocationStart, onTrackUserLocationEnd, ...options }: GeolocateControlProps) {
  const handlers = { onGeolocate, onError, onTrackUserLocationStart, onTrackUserLocationEnd }
  // The handlers are read when an event fires, so a new function each render never rebuilds the control
  const [latest] = useState(() => ({ current: handlers }))
  useLayoutEffect(() => {
    latest.current = handlers
  })
  useControl(
    'GeolocateControl',
    () => new GeolocateControlImpl(options),
    [options.trackUser, options.fitMaximumZoom, options.showUserLocation, options.showAccuracyCircle, JSON.stringify(options.positionOptions), localeKey(options.locale)],
    control => {
      const geolocate = (event: GeolocateEventMap['geolocate']) => latest.current.onGeolocate?.(event)
      const error = (event: GeolocateEventMap['error']) => latest.current.onError?.(event)
      const start = () => latest.current.onTrackUserLocationStart?.()
      const end = () => latest.current.onTrackUserLocationEnd?.()
      control.events.addEventListener('geolocate', geolocate)
      control.events.addEventListener('error', error)
      control.events.addEventListener('trackuserlocationstart', start)
      control.events.addEventListener('trackuserlocationend', end)
      return () => {
        control.events.removeEventListener('geolocate', geolocate)
        control.events.removeEventListener('error', error)
        control.events.removeEventListener('trackuserlocationstart', start)
        control.events.removeEventListener('trackuserlocationend', end)
      }
    },
  )
  return null
}

export type FullscreenControlProps = FullscreenControlOptions

/** A fullscreen button; covers the page where the browser cannot (iPhone). See the vanilla `FullscreenControl`. */
export function FullscreenControl(props: FullscreenControlProps) {
  useControl('FullscreenControl', () => new FullscreenControlImpl(props), [props.container, props.unsupported, localeKey(props.locale)])
  return null
}

export interface ViewControlProps extends ViewControlOptions {
  /**
   * The user pressed the button and asked for this view. If your own state holds `<Earth view>`, set it here so the prop
   * and the button agree.
   */
  onViewChange?: (mode: ViewMode) => void
}

/** A 2D / 3D button. See the vanilla `ViewControl`. */
export function ViewControl({ onViewChange, ...options }: ViewControlProps) {
  const [latest] = useState(() => ({ current: onViewChange }))
  useLayoutEffect(() => {
    latest.current = onViewChange
  })
  useControl('ViewControl', () => new ViewControlImpl(options), [options.transition?.durationSeconds, localeKey(options.locale)], control => {
    const listener = (event: { mode: ViewMode }) => latest.current?.(event.mode)
    control.events.addEventListener('viewchange', listener)
    return () => control.events.removeEventListener('viewchange', listener)
  })
  return null
}

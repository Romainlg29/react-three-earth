import { useThree } from '@react-three/fiber/extension'
import { FiberProvider } from 'its-fine'
import { use, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import { CONTROLS_CLASS_NAME, Controls as ControlsImpl, type MapControl } from '../controls/Controls.js'
import { FullscreenControl as FullscreenControlImpl, type FullscreenControlOptions, type FullscreenControlState } from '../controls/FullscreenControl.js'
import { GeolocateControl as GeolocateControlImpl, type GeolocateControlOptions, type GeolocateControlState, type GeolocateEventMap } from '../controls/GeolocateControl.js'
import type { ControlsLocale } from '../controls/locale.js'
import { NavigationControl as NavigationControlImpl, type NavigationControlOptions, type NavigationControlState } from '../controls/NavigationControl.js'
import { ScaleControl as ScaleControlImpl, type ScaleControlOptions, type ScaleControlState } from '../controls/ScaleControl.js'
import { ViewControl as ViewControlImpl, type ViewControlOptions, type ViewControlState } from '../controls/ViewControl.js'
import type { ViewMode } from '../view/ViewMorph.js'
import { ControlsContext, useEarth } from './context.js'
import { useDomRoot } from './domRoot.js'

export interface ControlsProps {
  /** Class names for the element, added to `react-three-earth-controls`. Place it over the map with them. */
  className?: string
  /** Inline style of the element. */
  style?: CSSProperties
  /** Where the element goes. Default: the element around the canvas. */
  container?: HTMLElement | null
  /** Your controls, as HTML: buttons built with `useNavigationControl`, `useScaleControl` and the other hooks. */
  children?: ReactNode
}

/**
 * An unstyled `<div>` over the map for your controls, from inside `<Earth>`: its children are rendered as HTML in the
 * element around the canvas, where hooks such as `useNavigationControl` and `useEarth` work. It has no CSS of its own:
 * place it with `className` or `style`. Presses, clicks and wheel turns inside it never reach the map.
 *
 * ```tsx
 * <Controls className="top-right">
 *   <MyZoomButtons />
 * </Controls>
 * ```
 */
export function Controls(props: ControlsProps) {
  return (
    <FiberProvider>
      <ControlsContent {...props} />
    </FiberProvider>
  )
}

function ControlsContent({ className, style, container, children }: ControlsProps) {
  const parent = useControlsContainer(container)
  const [controls, setControls] = useState<ControlsImpl | null>(null)

  useLayoutEffect(() => {
    if (parent === null) return
    const created = new ControlsImpl({ container: parent })
    setControls(created)
    return () => {
      setControls(null)
      created.dispose()
    }
  }, [parent])

  useLayoutEffect(() => {
    if (controls === null) return
    controls.element.className = className === undefined ? CONTROLS_CLASS_NAME : `${CONTROLS_CLASS_NAME} ${className}`
  }, [controls, className])

  const appliedStyle = useRef<string[]>([])
  useLayoutEffect(() => {
    if (controls === null) return
    const elementStyle = controls.element.style as unknown as Record<string, string>
    for (const key of appliedStyle.current) elementStyle[key] = ''
    appliedStyle.current = Object.keys(style ?? {})
    Object.assign(controls.element.style, style)
  })

  useDomRoot(controls?.element ?? null, <ControlsContext value={controls}>{children}</ControlsContext>)
  return null
}

/** The vanilla `Controls` of the nearest `<Controls>`, or null outside one. */
export function useControls(): ControlsImpl | null {
  return use(ControlsContext)
}

/** `container`, or the element around the canvas. */
function useControlsContainer(container: HTMLElement | null | undefined): HTMLElement | null {
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  return container ?? renderer.domElement.parentElement
}

/** What to spread on a `<button>`: its type, accessible name, tooltip, and press. */
export interface ControlButtonProps {
  type: 'button'
  'aria-label': string
  title: string
  onClick: () => void
  disabled?: boolean
  hidden?: boolean
  'aria-pressed'?: boolean
  'aria-busy'?: boolean
}

function buttonProps(label: string, onClick: () => void, extra?: Partial<ControlButtonProps>): ControlButtonProps {
  return { type: 'button', 'aria-label': label, title: label, onClick, ...extra }
}

/** Follows a headless control's state; the control listens to the earth while the component is mounted. */
function useControlState<State extends object>(control: MapControl<State>): State {
  return useSyncExternalStore(control.subscribe, control.getState, control.getState)
}

/** The latest value, for handlers read when an event fires: a new function each render never rebuilds the control. */
function useLatest<T>(value: T): { current: T } {
  const [latest] = useState(() => ({ current: value }))
  useLayoutEffect(() => {
    latest.current = value
  })
  return latest
}

function localeKey(locale: Partial<ControlsLocale> | undefined): string | undefined {
  return locale === undefined ? undefined : JSON.stringify(locale)
}

export type UseNavigationControlOptions = Omit<NavigationControlOptions, 'earth'>

export interface NavigationControlResult extends NavigationControlState {
  control: NavigationControlImpl
  zoomIn: () => void
  zoomOut: () => void
  zoomBy: (levels: number) => void
  resetNorth: () => void
  /** Spread on the element around the buttons: `role="group"` and its name. */
  groupProps: { role: 'group'; 'aria-label': string }
  zoomInButtonProps: ControlButtonProps
  zoomOutButtonProps: ControlButtonProps
  compassButtonProps: ControlButtonProps
}

/**
 * Zoom in, zoom out and compass, headless: the state and actions of the vanilla `NavigationControl`, and props to
 * spread on your own buttons. Use it inside `<Earth>` (HTML goes inside `<Controls>`).
 *
 * ```tsx
 * function Zoom() {
 *   const navigation = useNavigationControl({ visualizePitch: true })
 *   return (
 *     <div {...navigation.groupProps}>
 *       <button {...navigation.zoomInButtonProps}>+</button>
 *       <button {...navigation.zoomOutButtonProps}>−</button>
 *       <button {...navigation.compassButtonProps}><span style={{ transform: navigation.compassTransform }}>▲</span></button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useNavigationControl(options: UseNavigationControlOptions = {}): NavigationControlResult {
  const earth = useEarth()
  const { visualizePitch, zoomStep, durationSeconds, locale } = options
  // `locale` is compared by content, so an inline object never rebuilds the control
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const control = useMemo(() => new NavigationControlImpl({ earth, visualizePitch, zoomStep, durationSeconds, locale }), [earth, visualizePitch, zoomStep, durationSeconds, localeKey(locale)])
  const state = useControlState(control)
  return {
    ...state,
    control,
    zoomIn: control.zoomIn,
    zoomOut: control.zoomOut,
    zoomBy: control.zoomBy,
    resetNorth: control.resetNorth,
    groupProps: { role: 'group', 'aria-label': state.groupLabel },
    zoomInButtonProps: buttonProps(state.zoomInLabel, control.zoomIn),
    zoomOutButtonProps: buttonProps(state.zoomOutLabel, control.zoomOut),
    compassButtonProps: buttonProps(state.compassLabel, control.resetNorth),
  }
}

export type UseScaleControlOptions = Omit<ScaleControlOptions, 'earth'>

export interface ScaleControlResult extends ScaleControlState {
  control: ScaleControlImpl
  /** Spread on the bar: `role="img"`, its name, and `hidden` while there is no scale. Set its width to `widthPixels`. */
  scaleProps: { role: 'img'; 'aria-label': string; hidden: boolean }
}

/** A scale bar, headless: the width and label of the vanilla `ScaleControl`, following the camera. */
export function useScaleControl(options: UseScaleControlOptions = {}): ScaleControlResult {
  const earth = useEarth()
  const { unit, maximumWidthPixels, locale } = options
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const control = useMemo(() => new ScaleControlImpl({ earth, unit, maximumWidthPixels, locale }), [earth, unit, maximumWidthPixels, localeKey(locale)])
  const state = useControlState(control)
  return { ...state, control, scaleProps: { role: 'img', 'aria-label': state.accessibleLabel, hidden: !state.visible } }
}

export interface UseGeolocateControlOptions extends Omit<GeolocateControlOptions, 'earth' | 'container'> {
  /** The element whose presses pause following. Default: the element around the canvas. */
  container?: HTMLElement | null
  /** A position arrived. */
  onGeolocate?: (event: GeolocateEventMap['geolocate']) => void
  /** The browser could not tell the position. */
  onError?: (event: GeolocateEventMap['error']) => void
  /** The map started following the user. */
  onTrackUserLocationStart?: () => void
  /** The map stopped following the user. */
  onTrackUserLocationEnd?: () => void
}

export interface GeolocateControlResult extends GeolocateControlState {
  control: GeolocateControlImpl
  trigger: () => void
  stop: () => void
  /** Spread on the button: name (which explains the status), `disabled`, `hidden` where geolocation is missing, `aria-pressed` with `trackUser`, `aria-busy`. */
  buttonProps: ControlButtonProps
}

/**
 * Finds the user and flies there, headless: the vanilla `GeolocateControl`'s status and actions. Draw the user's dot
 * yourself from `userLocation`, for example with a `<Marker>`.
 */
export function useGeolocateControl(options: UseGeolocateControlOptions = {}): GeolocateControlResult {
  const earth = useEarth()
  const { container, trackUser, positionOptions, fitMaximumZoom, locale, onGeolocate, onError, onTrackUserLocationStart, onTrackUserLocationEnd } = options
  const parent = useControlsContainer(container) ?? undefined
  const positionKey = positionOptions === undefined ? undefined : JSON.stringify(positionOptions)
  const control = useMemo(
    () => new GeolocateControlImpl({ earth, container: parent, trackUser, positionOptions, fitMaximumZoom, locale }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [earth, parent, trackUser, positionKey, fitMaximumZoom, localeKey(locale)],
  )
  const handlers = useLatest({ onGeolocate, onError, onTrackUserLocationStart, onTrackUserLocationEnd })
  useLayoutEffect(() => {
    const geolocate = (event: GeolocateEventMap['geolocate']) => handlers.current.onGeolocate?.(event)
    const error = (event: GeolocateEventMap['error']) => handlers.current.onError?.(event)
    const start = () => handlers.current.onTrackUserLocationStart?.()
    const end = () => handlers.current.onTrackUserLocationEnd?.()
    control.events.addEventListener('geolocate', geolocate)
    control.events.addEventListener('error', error)
    control.events.addEventListener('trackuserlocationstart', start)
    control.events.addEventListener('trackuserlocationend', end)
    return () => {
      // Stopped first, so the end of following still reaches the handler
      control.stop()
      control.events.removeEventListener('geolocate', geolocate)
      control.events.removeEventListener('error', error)
      control.events.removeEventListener('trackuserlocationstart', start)
      control.events.removeEventListener('trackuserlocationend', end)
    }
  }, [control, handlers])
  const state = useControlState(control)
  return {
    ...state,
    control,
    trigger: control.trigger,
    stop: control.stop,
    buttonProps: buttonProps(state.label, control.trigger, { disabled: state.disabled, hidden: !state.available, 'aria-pressed': state.pressed, 'aria-busy': state.busy }),
  }
}

export interface UseFullscreenControlOptions extends Omit<FullscreenControlOptions, 'earth' | 'container'> {
  /** The element that goes fullscreen. Default: the element around the canvas. */
  container?: HTMLElement | null
}

export interface FullscreenControlResult extends FullscreenControlState {
  control: FullscreenControlImpl | null
  enter: () => void
  exit: () => void
  toggle: () => void
  /** Spread on the button: name, `aria-pressed`, `hidden` where it would do nothing. */
  buttonProps: ControlButtonProps
}

const NOTHING = (): void => {}
const NO_FULLSCREEN: FullscreenControlState = { active: false, available: false, label: '' }
const noSubscription = () => NOTHING

/** Fullscreen, headless: the vanilla `FullscreenControl`'s state and actions, for the element around the canvas. */
export function useFullscreenControl(options: UseFullscreenControlOptions = {}): FullscreenControlResult {
  const earth = useEarth()
  const { container, unsupported, locale } = options
  const parent = useControlsContainer(container)
  const control = useMemo(
    () => (parent === null ? null : new FullscreenControlImpl({ earth, container: parent, unsupported, locale })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [earth, parent, unsupported, localeKey(locale)],
  )
  const state = useSyncExternalStore(control?.subscribe ?? noSubscription, control?.getState ?? (() => NO_FULLSCREEN), control?.getState ?? (() => NO_FULLSCREEN))
  const enter = control === null ? NOTHING : () => void control.enter()
  const toggle = control?.toggle ?? NOTHING
  return {
    ...state,
    control,
    enter,
    exit: control?.exit ?? NOTHING,
    toggle,
    buttonProps: buttonProps(state.label, toggle, { 'aria-pressed': state.active, hidden: !state.available }),
  }
}

export interface UseViewControlOptions extends Omit<ViewControlOptions, 'earth'> {
  /**
   * `toggle` asked for this view. If your own state holds `<Earth view>`, set it here so the prop and the button
   * agree.
   */
  onViewChange?: (mode: ViewMode) => void
}

export interface ViewControlResult extends ViewControlState {
  control: ViewControlImpl
  toggle: () => void
  /** Spread on the button: its accessible name ("Switch to the flat map") and press. Its text is `label`. */
  buttonProps: ControlButtonProps
}

/** A 2D / 3D switch, headless: the vanilla `ViewControl`'s state and `toggle`. */
export function useViewControl(options: UseViewControlOptions = {}): ViewControlResult {
  const earth = useEarth()
  const { transition, locale, onViewChange } = options
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const control = useMemo(() => new ViewControlImpl({ earth, transition, locale }), [earth, transition?.durationSeconds, localeKey(locale)])
  const latest = useLatest(onViewChange)
  useLayoutEffect(() => {
    const listener = (event: { mode: ViewMode }) => latest.current?.(event.mode)
    control.events.addEventListener('viewchange', listener)
    return () => control.events.removeEventListener('viewchange', listener)
  }, [control, latest])
  const state = useControlState(control)
  return { ...state, control, toggle: control.toggle, buttonProps: buttonProps(state.accessibleLabel, control.toggle) }
}

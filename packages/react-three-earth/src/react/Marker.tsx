import { useThree } from '@react-three/fiber/extension'
import { FiberProvider } from 'its-fine'
import { use, useImperativeHandle, useLayoutEffect, useMemo, useRef, type ReactNode, type Ref } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import type { GeographicPosition } from '../core/camera.js'
import { Marker as MarkerImpl, PIN_SVG, type MarkerHeight } from '../core/Marker.js'
import type { MarkerAlignment, ScreenAnchor, ScreenOffset } from '../core/markerLayout.js'
import { MarkerContext, useEarth } from './context.js'
import { useDomRoot } from './domRoot.js'

/** The vanilla `Marker` of the nearest `<Marker>`, or null outside one. Works in a marker's content too. */
export function useMarker(): MarkerImpl | null {
  return use(MarkerContext)
}

export interface MarkerProps {
  longitudeDegrees: number
  latitudeDegrees: number
  /** Ellipsoidal height in metres, or 'terrain' to sit on the loaded terrain. Default: 'terrain'. */
  heightMeters?: MarkerHeight
  /** The point of the marker on its position. Default: 'bottom' for the default pin, 'center' for content of your own. */
  anchor?: ScreenAnchor
  /** Shift on the screen after anchoring, in CSS pixels. */
  offsetPixels?: ScreenOffset
  /** Clockwise turn, in degrees. Default: 0. */
  rotationDegrees?: number
  /** `'map'` turns the marker with the map's heading. Default: 'viewport'. */
  rotationAlignment?: MarkerAlignment
  /** `'map'` lays the marker on the ground as the camera tilts. Default: 'viewport'. */
  pitchAlignment?: MarkerAlignment
  /** Lets the user drag the marker; `onDragEnd` gives its new place. Default: false. */
  draggable?: boolean
  /** Opacity while terrain hides the marker; 0 hides it. Default: 0.2. */
  occludedOpacity?: number
  /** The accessible name screen readers announce, for example the place's name. Default: 'Map marker'. */
  label?: string
  /** Colour of the default pin. Default: '#3fb1ce'. */
  color?: string
  /** Extra class names for the marker's element. */
  className?: string
  /** Clicked, or activated with Enter or Space. */
  onClick?: () => void
  onDragStart?: (position: GeographicPosition & { heightMeters: number }) => void
  onDrag?: (position: GeographicPosition & { heightMeters: number }) => void
  /**
   * The user let go: the marker's new place. Store it in your state: the marker stays where it was dropped, but
   * jumps back to its props the next time they change.
   */
  onDragEnd?: (position: GeographicPosition & { heightMeters: number }) => void
  /** Where the marker's DOM goes. Default: the element around the canvas. */
  container?: HTMLElement | null
  /**
   * What the marker shows (HTML, rendered in the page's DOM), and `<Popup>`s it opens on click, anywhere inside.
   * Without an element of its own (text alone counts as none), it shows the default pin.
   */
  children?: ReactNode
  ref?: Ref<MarkerImpl>
}

/**
 * HTML pinned to a place on the earth, over the canvas. Follows the map in the frame that draws it, hides
 * behind the globe's horizon and fades behind terrain. Place it anywhere inside `<Earth>`.
 *
 * ```tsx
 * <Marker longitudeDegrees={138.73} latitudeDegrees={35.36} label="Mount Fuji">
 *   <Popup>Mount Fuji, 3776 m</Popup>
 * </Marker>
 * ```
 */
export function Marker(props: MarkerProps) {
  return (
    <FiberProvider>
      <MarkerContent {...props} />
    </FiberProvider>
  )
}

function MarkerContent({
  longitudeDegrees,
  latitudeDegrees,
  heightMeters = 'terrain',
  anchor,
  offsetPixels,
  rotationDegrees = 0,
  rotationAlignment = 'viewport',
  pitchAlignment = 'viewport',
  draggable = false,
  occludedOpacity = 0.2,
  label,
  color,
  className,
  onClick,
  onDragStart,
  onDrag,
  onDragEnd,
  container,
  children,
  ref,
}: MarkerProps) {
  const earth = useEarth()
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const parent = container ?? renderer.domElement.parentElement

  // One element for the marker's life: React renders its content (and `<Popup>`s, which render nothing there)
  // into it, with a fallback pin that shows while there is no content of its own.
  const marker = useMemo(
    () => new MarkerImpl({ longitudeDegrees, latitudeDegrees, heightMeters, element: document.createElement('div'), anchor: anchor ?? 'bottom' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  useImperativeHandle(ref, () => marker, [marker])

  useLayoutEffect(() => {
    if (parent === null) return
    marker.addTo(earth, parent)
    return () => void marker.remove()
  }, [marker, earth, parent])
  // Not `dispose`: under StrictMode React runs this cleanup and then the effects again on the same marker.

  useLayoutEffect(() => void marker.setPosition({ longitudeDegrees, latitudeDegrees, heightMeters }), [marker, longitudeDegrees, latitudeDegrees, heightMeters])
  useLayoutEffect(() => {
    if (anchor !== undefined) marker.setAnchor(anchor)
  }, [marker, anchor])
  const offsetX = offsetPixels?.xPixels ?? 0
  const offsetY = offsetPixels?.yPixels ?? 0
  useLayoutEffect(() => void marker.setOffset({ xPixels: offsetX, yPixels: offsetY }), [marker, offsetX, offsetY])
  useLayoutEffect(() => void marker.setRotation(rotationDegrees), [marker, rotationDegrees])
  useLayoutEffect(() => void marker.setRotationAlignment(rotationAlignment), [marker, rotationAlignment])
  useLayoutEffect(() => void marker.setPitchAlignment(pitchAlignment), [marker, pitchAlignment])
  useLayoutEffect(() => void marker.setDraggable(draggable), [marker, draggable])
  useLayoutEffect(() => void marker.setOccludedOpacity(occludedOpacity), [marker, occludedOpacity])
  useLayoutEffect(() => void marker.setLabel(label ?? 'Map marker'), [marker, label])
  useLayoutEffect(() => {
    if (color === undefined) marker.element.style.removeProperty('--earthkit-marker-color')
    else marker.element.style.setProperty('--earthkit-marker-color', color)
  }, [marker, color])
  useLayoutEffect(() => {
    const names = className?.split(/\s+/).filter(Boolean) ?? []
    marker.element.classList.add(...names)
    return () => marker.element.classList.remove(...names)
  }, [marker, className])

  const handlers = useRef({ onClick, onDragStart, onDrag, onDragEnd })
  useLayoutEffect(() => {
    handlers.current = { onClick, onDragStart, onDrag, onDragEnd }
  })
  useLayoutEffect(() => {
    const click = () => handlers.current.onClick?.()
    const dragStart = ({ position }: { position: GeographicPosition & { heightMeters: number } }) => handlers.current.onDragStart?.(position)
    const drag = ({ position }: { position: GeographicPosition & { heightMeters: number } }) => handlers.current.onDrag?.(position)
    const dragEnd = ({ position }: { position: GeographicPosition & { heightMeters: number } }) => handlers.current.onDragEnd?.(position)
    marker.addEventListener('click', click)
    marker.addEventListener('dragstart', dragStart)
    marker.addEventListener('drag', drag)
    marker.addEventListener('dragend', dragEnd)
    return () => {
      marker.removeEventListener('click', click)
      marker.removeEventListener('dragstart', dragStart)
      marker.removeEventListener('drag', drag)
      marker.removeEventListener('dragend', dragEnd)
    }
  }, [marker])

  useDomRoot(
    marker.element,
    <MarkerContext value={marker}>
      {children}
      <FallbackPin marker={marker} anchor={anchor} />
    </MarkerContext>,
  )
  return null
}

/**
 * The default pin, shown by CSS only while it is the marker's sole element. It watches the marker's children so
 * the default anchor follows: 'bottom' on the pin, 'center' on content of your own.
 */
function FallbackPin({ marker, anchor }: { marker: MarkerImpl; anchor: ScreenAnchor | undefined }) {
  const element = useRef<HTMLSpanElement>(null)
  const latestAnchor = useRef(anchor)
  latestAnchor.current = anchor
  useLayoutEffect(() => {
    const host = element.current?.parentElement
    if (host == null) return
    const check = () => {
      if (latestAnchor.current === undefined) marker.setAnchor(host.childElementCount === 1 ? 'bottom' : 'center')
    }
    check()
    // Content that comes and goes without the marker rendering (a child's own state, Suspense).
    const observer = new MutationObserver(check)
    observer.observe(host, { childList: true })
    return () => observer.disconnect()
  }, [marker])
  useLayoutEffect(() => {
    const host = element.current?.parentElement
    if (host != null && anchor === undefined) marker.setAnchor(host.childElementCount === 1 ? 'bottom' : 'center')
  }, [marker, anchor])
  return <span ref={element} className="earthkit-marker-fallback-pin" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PIN_SVG }} />
}

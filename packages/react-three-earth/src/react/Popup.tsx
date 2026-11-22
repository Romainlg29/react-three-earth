import { useThree } from '@react-three/fiber/extension'
import { FiberProvider } from 'its-fine'
import { use, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type ReactNode, type Ref } from 'react'
import type { WebGPURenderer } from 'three/webgpu'

import type { MarkerHeight } from '../core/Marker.js'
import type { ScreenAnchor, ScreenOffset } from '../core/markerLayout.js'
import { Popup as PopupImpl } from '../core/Popup.js'
import { MarkerContext, useEarth } from './context.js'
import { useDomRoot } from './domRoot.js'

export interface PopupProps {
  /** Where the popup points, outside a `<Marker>`. Leave out with `trackPointer`. */
  longitudeDegrees?: number
  latitudeDegrees?: number
  /** Ellipsoidal height in metres, or 'terrain'. Default: 'terrain'. */
  heightMeters?: MarkerHeight
  /**
   * Whether the popup is open. Leave it out and a popup inside a `<Marker>` opens on click, while one outside
   * opens when it mounts. Set it to control the popup yourself: on a marker, a click then calls `onOpen` instead
   * of opening it, and `onClose` follows the user closing it.
   */
  open?: boolean
  /** Follows the pointer over the canvas instead of a place, as a tooltip. Default: false. */
  trackPointer?: boolean
  /** The side of the popup on its point, or 'auto' (above, or wherever it fits). Default: 'auto'. */
  anchor?: ScreenAnchor | 'auto'
  /** Distance from the point in CSS pixels, or a shift of your own. Default: 0. */
  offsetPixels?: number | ScreenOffset
  /** Shows a × button. Default: true. */
  closeButton?: boolean
  /** Closes when the user clicks the map. Default: true. */
  closeOnClick?: boolean
  /** Closes when the camera starts moving. Default: false. */
  closeOnMove?: boolean
  /** Moves keyboard focus in on open and back on close. Default: true. */
  focusAfterOpen?: boolean
  /** The widest the popup gets, in CSS pixels; Infinity for no limit. Default: 240. */
  maximumWidthPixels?: number
  /** Extra class names for the popup's root element. */
  className?: string
  /** The accessible name of the dialog. Default: 'Map popup'. */
  label?: string
  /** The popup opened; controlled with `open`, the user asked to open it (clicked its marker). */
  onOpen?: () => void
  /** The user closed the popup: its close button, `Escape`, a click on the map or its marker, or a camera move. */
  onClose?: () => void
  /** Where the popup's DOM goes, outside a `<Marker>`. Default: the element around the canvas. */
  container?: HTMLElement | null
  /** The content, rendered as HTML in the page's DOM. */
  children?: ReactNode
  ref?: Ref<PopupImpl>
}

/**
 * A box of HTML pointing at a place. Inside a `<Marker>` it opens when the marker is clicked; elsewhere in
 * `<Earth>` it points at `longitudeDegrees` / `latitudeDegrees`, or follows the pointer with `trackPointer`.
 *
 * ```tsx
 * <Popup longitudeDegrees={2.35} latitudeDegrees={48.86} open={open} onClose={() => setOpen(false)}>
 *   Paris
 * </Popup>
 * ```
 */
export function Popup(props: PopupProps) {
  return (
    <FiberProvider>
      <PopupContent {...props} />
    </FiberProvider>
  )
}

function PopupContent({
  longitudeDegrees,
  latitudeDegrees,
  heightMeters = 'terrain',
  open,
  trackPointer = false,
  anchor = 'auto',
  offsetPixels = 0,
  closeButton = true,
  closeOnClick = true,
  closeOnMove = false,
  focusAfterOpen = true,
  maximumWidthPixels = 240,
  className,
  label,
  onOpen,
  onClose,
  container,
  children,
  ref,
}: PopupProps) {
  const earth = useEarth()
  const marker = use(MarkerContext)
  const renderer = useThree(state => state.renderer) as unknown as WebGPURenderer
  const parent = container ?? renderer.domElement.parentElement
  const popup = useMemo(() => new PopupImpl({ closeButton }), [closeButton])
  useImperativeHandle(ref, () => popup, [popup])

  useLayoutEffect(() => {
    if (marker === null) return
    marker.setPopup(popup)
    return () => {
      if (marker.getPopup() === popup) marker.setPopup(null)
    }
  }, [marker, popup])

  useLayoutEffect(() => {
    if (marker !== null) return
    if (trackPointer) popup.trackPointer()
    else if (longitudeDegrees !== undefined && latitudeDegrees !== undefined) popup.setPosition({ longitudeDegrees, latitudeDegrees, heightMeters })
  }, [popup, marker, trackPointer, longitudeDegrees, latitudeDegrees, heightMeters])

  const offsetKey = typeof offsetPixels === 'number' ? offsetPixels : `${offsetPixels.xPixels},${offsetPixels.yPixels}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => void popup.setOffset(offsetPixels), [popup, offsetKey])
  useLayoutEffect(() => void popup.setAnchor(anchor), [popup, anchor])
  useLayoutEffect(() => void popup.setCloseOnClick(closeOnClick), [popup, closeOnClick])
  useLayoutEffect(() => void popup.setCloseOnMove(closeOnMove), [popup, closeOnMove])
  useLayoutEffect(() => void popup.setFocusAfterOpen(focusAfterOpen), [popup, focusAfterOpen])
  useLayoutEffect(() => void popup.setMaximumWidth(maximumWidthPixels), [popup, maximumWidthPixels])
  useLayoutEffect(() => void popup.setLabel(label ?? 'Map popup'), [popup, label])
  useLayoutEffect(() => {
    const names = className?.split(/\s+/).filter(Boolean) ?? []
    popup.element.classList.add(...names)
    return () => popup.element.classList.remove(...names)
  }, [popup, className])

  const handlers = useRef({ onOpen, onClose })
  useLayoutEffect(() => {
    handlers.current = { onOpen, onClose }
  })
  const controlled = open !== undefined
  useLayoutEffect(() => {
    // Controlled, the app opens it: `onOpen` is the user's request (a marker click), not the opening itself.
    const opened = () => {
      if (!controlled) handlers.current.onOpen?.()
    }
    const closed = () => {
      // Closed because its marker left the map (unmounting, moving): not the user's doing.
      if (marker !== null && marker.getEarth() === null) return
      handlers.current.onClose?.()
    }
    popup.addEventListener('open', opened)
    popup.addEventListener('close', closed)
    return () => {
      popup.removeEventListener('open', opened)
      popup.removeEventListener('close', closed)
    }
  }, [popup, marker, controlled])

  // Controlled on a marker: a click asks the app (`onOpen`) to open it, or closes it (`onClose`).
  useLayoutEffect(() => {
    if (marker === null || !controlled) return
    marker.togglePopupOnClick = false
    const clicked = () => {
      if (popup.isOpen()) popup.remove()
      else handlers.current.onOpen?.()
    }
    marker.addEventListener('click', clicked)
    return () => {
      marker.togglePopupOnClick = true
      marker.removeEventListener('click', clicked)
    }
  }, [marker, popup, controlled])

  // A passive effect, so a `<Marker>` around it (whose layout effect runs after this component's) is on the map.
  const shouldOpen = open ?? (marker === null ? true : undefined)
  useEffect(() => {
    if (shouldOpen === undefined) return
    const target = marker === null ? { earth, container: parent } : { earth: marker.getEarth(), container: marker.getContainer() }
    if (shouldOpen && !popup.isOpen() && target.earth !== null && target.container !== null) popup.addTo(target.earth, target.container, { focus: marker !== null })
    if (!shouldOpen && popup.isOpen()) popup.remove()
  }, [popup, shouldOpen, marker, earth, parent])
  // A standalone popup closes when it unmounts; on a marker, `setPopup(null)` above closes it.
  useLayoutEffect(() => () => void popup.remove(), [popup])

  useDomRoot(popup.contentElement, children)
  return null
}

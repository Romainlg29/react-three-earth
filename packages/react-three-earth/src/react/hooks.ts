import { useFrame } from '@react-three/fiber/extension'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { Earth } from '../core/Earth.js'
import type { EarthCamera } from '../core/EarthCamera.js'
import type { EarthEventMap, EarthEventType } from '../core/events.js'
import type { LayerEventOptions, LayerEventType, LayerPointerEvent } from '../core/LayerEvents.js'
import type { EarthPlugin } from '../plugins/plugin.js'
import { useEarth } from './context.js'

/** Runs every frame with the vanilla `Earth`. Never causes a React render. */
export function useEarthFrame(callback: (earth: Earth, deltaSeconds: number) => void): void {
  const earth = useEarth()
  const latest = useRef(callback)
  latest.current = callback
  useFrame((_, deltaSeconds) => latest.current(earth, deltaSeconds), { phase: 'update', after: 'earth:update' })
}

/**
 * Reads Earth state for UI. Renders only when the selected value changes, at most `hz` times a second.
 * @example const tilesLoaded = useEarthState(earth => earth.inspect().terrain?.tilesLoaded ?? 0, { hz: 4 })
 */
export function useEarthState<T>(selector: (earth: Earth) => T, { hz = 10 }: { hz?: number } = {}): T {
  const earth = useEarth()
  const [value, setValue] = useState(() => selector(earth))
  const latest = useRef(selector)
  latest.current = selector
  useEffect(() => {
    const id = setInterval(() => {
      const next = latest.current(earth)
      setValue(previous => (Object.is(previous, next) ? previous : next))
    }, 1000 / hz)
    return () => clearInterval(id)
  }, [earth, hz])
  return value
}

/**
 * The vanilla `EarthCamera` of the nearest `<Earth>`: `getView()`, `jumpTo()`, `easeTo()`, `flyTo()`,
 * `fitBounds()`, `getBounds()`, `project()`, `unproject()`. Reading it never causes a React render; call its
 * methods in handlers or `useEarthFrame`.
 */
export function useEarthCamera(): EarthCamera {
  return useEarth().camera
}

/**
 * Listens to an `Earth` event (`load`, `idle`, `movestart`, `move`, `moveend`, `zoom`, `rotate`, `pitch`,
 * `click`, `doubleclick`, `contextmenu`, `pointermove`, …) while the component is mounted. The handler may
 * change between renders without re-subscribing. Never causes a React render.
 *
 * With `{ layers }`, the handler runs only over features of those style layers, and gets them in `event.features`
 * (top-most first): `click`, `doubleclick`, `contextmenu`, `pointermove`, and `pointerenter` / `pointerleave`
 * (MapLibre's `mouseenter` / `mouseleave`). See `LayerEvents`.
 * @example useEarthEvent('click', event => console.log(event.geographic))
 * @example useEarthEvent('click', event => select(event.features[0]), { layers: ['countries'] })
 */
export function useEarthEvent<T extends LayerEventType>(type: T, handler: (event: LayerPointerEvent<T>) => void, options: LayerEventOptions): void
export function useEarthEvent<T extends EarthEventType>(type: T, handler: (event: EarthEventMap[T] & { type: T; target: Earth }) => void): void
export function useEarthEvent(type: string, handler: (event: never) => void, options?: LayerEventOptions): void {
  const earth = useEarth()
  const latest = useRef(handler)
  useLayoutEffect(() => {
    latest.current = handler
  })
  const layersKey = options === undefined ? null : JSON.stringify(options.layers)
  const tolerancePixels = options?.tolerancePixels ?? 0
  useEffect(() => {
    const listener = (event: unknown) => latest.current(event as never)
    if (layersKey !== null) {
      const layers = JSON.parse(layersKey) as string[]
      return earth.layerEvents.addEventListener(type as LayerEventType, listener, { layers, tolerancePixels })
    }
    earth.addEventListener(type as EarthEventType, listener as never)
    return () => earth.removeEventListener(type as EarthEventType, listener as never)
  }, [earth, type, layersKey, tolerancePixels])
}

/**
 * Shows `cursor` (default 'pointer') on the map while the pointer is over features of `layers`, while the
 * component is mounted. See `LayerEvents.addCursor`.
 * @example useLayerCursor(['countries'])
 */
export function useLayerCursor(layers: readonly string[], cursor = 'pointer', options: Omit<LayerEventOptions, 'layers'> = {}): void {
  const earth = useEarth()
  const layersKey = JSON.stringify(layers)
  const tolerancePixels = options.tolerancePixels ?? 0
  useEffect(() => earth.layerEvents.addCursor(JSON.parse(layersKey) as string[], cursor, { tolerancePixels }), [earth, layersKey, cursor, tolerancePixels])
}

/**
 * Sets feature-state `{ hover: true }` (or `stateKey`) on the top-most feature of `layers` under the pointer, and
 * `false` when it leaves, while the component is mounted. Paint with `['boolean', ['feature-state', 'hover'], false]`.
 * See `LayerEvents.addHoverState`.
 * @example useHoverFeatureState(['countries'])
 */
export function useHoverFeatureState(layers: readonly string[], options: Omit<LayerEventOptions, 'layers'> & { stateKey?: string } = {}): void {
  const earth = useEarth()
  const layersKey = JSON.stringify(layers)
  const { stateKey = 'hover', tolerancePixels = 0 } = options
  useEffect(() => earth.layerEvents.addHoverState(JSON.parse(layersKey) as string[], { stateKey, tolerancePixels }), [earth, layersKey, stateKey, tolerancePixels])
}

/**
 * Installs a plugin on the nearest `<Earth>` while the component is mounted, and removes it on unmount. Pass
 * the same plugin object across renders (create it outside render or with `useState`), or it is reinstalled.
 * For plugins the whole map uses, prefer `<Earth plugins>`.
 * @example
 * const [plugin] = useState(() => measurementTools())
 * usePlugin(plugin)
 */
export function usePlugin(plugin: EarthPlugin): void {
  const earth = useEarth()
  useLayoutEffect(() => {
    earth.addPlugin(plugin)
    return () => earth.removePlugin(plugin)
  }, [earth, plugin])
}

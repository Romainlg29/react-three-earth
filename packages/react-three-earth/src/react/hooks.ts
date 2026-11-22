import { useFrame } from '@react-three/fiber/extension'
import { useEffect, useRef, useState } from 'react'

import type { Earth } from '../core/Earth.js'
import { useEarth } from './context.js'

/** Runs every frame with the vanilla `Earth`. Never causes a React render. */
export function useEarthFrame(callback: (earth: Earth, deltaSeconds: number) => void): void {
  const earth = useEarth()
  const latest = useRef(callback)
  latest.current = callback
  useFrame((_, deltaSeconds) => latest.current(earth, deltaSeconds), { after: 'earth:update' })
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

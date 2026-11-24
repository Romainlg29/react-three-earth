import { useFrame, useThree } from '@react-three/fiber/extension'
import { useLayoutEffect, useState } from 'react'

import { EarthViewControls } from '../core/EarthControls.js'
import { DEFAULT_KEYBOARD_OPTIONS, type KeyboardControlsOptions } from '../core/KeyboardControls.js'
import { useEarth } from './context.js'

export interface EarthControlsProps {
  /** Smooth the camera's motion after the pointer lets go. Default: true. */
  enableDamping?: boolean
  /** On the flat map, the steepest tilt away from looking straight down, in degrees. Default: 0. */
  maximumFlatMapTiltDegrees?: number
  /**
   * Move the camera with the keyboard while the map has focus: arrows pan, `+` / `-` zoom, `Shift` + arrows
   * turn and tilt. Options change the steps. Default: true.
   */
  keyboard?: boolean | KeyboardControlsOptions
  /** Double-click or double-tap zooms in on that point. Default: true. */
  doubleClickZoom?: boolean
  /** What screen readers call the map (its `aria-label`, with `role="region"`). Default: "Map". */
  label?: string
}

/**
 * Orbit, pan and zoom around the globe with mouse, touch or keyboard; pan, zoom and rotate on the flat map
 * (`<Earth view="2d">`). Input is ignored while the view morphs. The map's element joins the tab order as a
 * labelled region, so keyboard and screen reader users reach it.
 */
export function EarthControls({ enableDamping = true, maximumFlatMapTiltDegrees = 0, keyboard = true, doubleClickZoom = true, label = 'Map' }: EarthControlsProps) {
  const earth = useEarth()
  const camera = useThree(state => state.camera)
  const domElement = useThree(state => state.events.connected ?? state.renderer.domElement) as HTMLElement
  const [controls] = useState(() => new EarthViewControls(earth))

  useLayoutEffect(() => {
    controls.label = label
    controls.setCamera(camera)
    controls.attach(domElement)
    controls.enableDamping = enableDamping
    return () => controls.detach()
  }, [controls, camera, domElement, enableDamping, label])

  useLayoutEffect(() => {
    controls.flatMap.maximumTiltRadians = (maximumFlatMapTiltDegrees * Math.PI) / 180
  }, [controls, maximumFlatMapTiltDegrees])

  // Each option on its own, so a new options object with the same values changes nothing
  const keyboardEnabled = keyboard !== false
  const { panStepPixels, zoomStep, rotateStepDegrees, pitchStepDegrees, durationSeconds } = { ...DEFAULT_KEYBOARD_OPTIONS, ...(typeof keyboard === 'object' ? keyboard : {}) }
  useLayoutEffect(() => {
    controls.keyboard.enabled = keyboardEnabled
    controls.keyboard.setOptions({ panStepPixels, zoomStep, rotateStepDegrees, pitchStepDegrees, durationSeconds })
  }, [controls, keyboardEnabled, panStepPixels, zoomStep, rotateStepDegrees, pitchStepDegrees, durationSeconds])

  useLayoutEffect(() => {
    controls.doubleClickZoom = doubleClickZoom
  }, [controls, doubleClickZoom])

  useLayoutEffect(() => () => controls.dispose(), [controls])

  // Before the Earth updates tiles, so tiles are chosen for this frame's camera.
  useFrame(({ delta }) => controls.update(delta), { id: 'earth:controls', phase: 'update', before: 'earth:update' })

  return null
}

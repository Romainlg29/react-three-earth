/**
 * How to turn the compass needle so it points north. `headingDegrees` is the camera's compass direction (as
 * `getView()` gives it), `pitchDegrees` its angle below the horizon (-90 looks straight down). With
 * `visualizePitch` the needle also tilts back as the camera tilts, like MapLibre's.
 */
export function compassRotation(headingDegrees: number, pitchDegrees: number, visualizePitch: boolean): { rotateDegrees: number; tiltDegrees: number } {
  // Tilt is the angle away from looking straight down, 0 to 90
  const tiltDegrees = visualizePitch ? Math.min(Math.max(pitchDegrees + 90, 0), 90) : 0
  return { rotateDegrees: -headingDegrees, tiltDegrees }
}

/** The CSS transform that applies `compassRotation`. */
export function compassTransform(headingDegrees: number, pitchDegrees: number, visualizePitch: boolean): string {
  const { rotateDegrees, tiltDegrees } = compassRotation(headingDegrees, pitchDegrees, visualizePitch)
  const roundedRotate = Math.round(rotateDegrees * 10) / 10
  return visualizePitch ? `perspective(100px) rotateX(${tiltDegrees}deg) rotateZ(${roundedRotate}deg)` : `rotate(${roundedRotate}deg)`
}

/** True when the camera is turned away from north or tilted, so the compass has something to reset. */
export function compassIsReset(headingDegrees: number, pitchDegrees: number, visualizePitch: boolean): boolean {
  const heading = ((headingDegrees % 360) + 540) % 360 - 180
  return Math.abs(heading) < 0.01 && (!visualizePitch || pitchDegrees <= -89.99)
}

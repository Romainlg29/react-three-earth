import type { CameraView, Earth } from '@earthkit/globe'

import { useFixtures } from './data'

/** A named camera view for a panel button. */
export interface Place {
  name: string
  view: CameraView
}

/** Flies the camera to a place, MapLibre style (zooms out and back in). */
export function flyToPlace(earth: Earth | null, place: Place): void {
  void earth?.camera.flyTo(place.view)
}

/** The fixture terrain's highest hill (3900 m at -90°, 0°), where the synthetic buildings stand. */
export const FIXTURE_PEAK: Place = {
  name: 'Fixture peak',
  view: { longitudeDegrees: -90, latitudeDegrees: 0, heightMeters: 3900, distanceMeters: 2500, headingDegrees: 30, pitchDegrees: -35 },
}

/** Picks the live places, or the fixture's stand-ins for the browser checks. */
export function placesFor<T extends Place>(live: T[], fixture: T[]): T[] {
  return useFixtures ? fixture : live
}

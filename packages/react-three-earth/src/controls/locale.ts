/** Every text the map controls show or announce. Give a partial object to translate some of it. */
export interface ControlsLocale {
  zoomIn: string
  zoomOut: string
  /** The compass button: clicking turns the map back to north. */
  resetNorth: string
  /** The compass button while the camera also looks tilted: clicking turns north and looks down. */
  resetNorthAndPitch: string
  /** The label of the navigation control's group of buttons. */
  navigation: string
  enterFullscreen: string
  exitFullscreen: string
  /** The view button while the globe shows: clicking flattens the map. */
  switchTo2D: string
  /** The view button while the flat map shows: clicking makes it a globe. */
  switchTo3D: string
  /** The text on the view button that switches to the flat map. */
  view2D: string
  /** The text on the view button that switches to the globe. */
  view3D: string
  geolocate: string
  geolocateWaiting: string
  geolocateStopTracking: string
  geolocateFollow: string
  geolocateDenied: string
  geolocateUnavailable: string
  geolocateFailed: string
  /** The accessible name of the scale bar. */
  scale: string
  /** Units of the scale bar: metres, kilometres, feet, miles and nautical miles. */
  unitMeters: string
  unitKilometers: string
  unitFeet: string
  unitMiles: string
  unitNauticalMiles: string
}

export const DEFAULT_CONTROLS_LOCALE: ControlsLocale = {
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  resetNorth: 'Reset bearing to north',
  resetNorthAndPitch: 'Reset bearing to north and look straight down',
  navigation: 'Map navigation',
  enterFullscreen: 'Enter fullscreen',
  exitFullscreen: 'Exit fullscreen',
  switchTo2D: 'Switch to the flat map',
  switchTo3D: 'Switch to the globe',
  view2D: '2D',
  view3D: '3D',
  geolocate: 'Show my location',
  geolocateWaiting: 'Finding your location',
  geolocateStopTracking: 'Stop following my location',
  geolocateFollow: 'Follow my location',
  geolocateDenied: 'Location access is turned off for this site',
  geolocateUnavailable: 'This browser cannot tell where you are',
  geolocateFailed: 'Your location could not be found, try again',
  scale: 'Map scale',
  unitMeters: 'm',
  unitKilometers: 'km',
  unitFeet: 'ft',
  unitMiles: 'mi',
  unitNauticalMiles: 'nm',
}

/** The defaults with `locale` laid over them. */
export function resolveLocale(locale: Partial<ControlsLocale> | undefined): ControlsLocale {
  return locale === undefined ? DEFAULT_CONTROLS_LOCALE : { ...DEFAULT_CONTROLS_LOCALE, ...locale }
}

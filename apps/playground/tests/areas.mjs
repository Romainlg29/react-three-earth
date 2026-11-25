// Browser check areas: the first part of a check id (`labels/webgl2` is in `labels`). Name an area or a group on the
// command line to run its checks (`run.mjs labels buildings`); see selection.mjs for the default, changed-only run.

export const AREAS = [
  'precision', 'map', '2d', 'vector', 'patterns', 'attribution', 'controls', 'accessibility', 'gestures', 'invalidate', 'style', 'geojson', 'heatmap',
  'query', 'afterburner', 'camera', 'markers', 'animations', 'sdf', 'layers', 'relief', 'georef', 'effects', 'labels', 'scripts', 'symbol-effects', 'buildings',
  'roads', 'dem', 'exaggeration', 'style-root', 'screen-clip', 'examples', 'draw',
]

/** A name that runs several areas: the group's own area first. */
export const GROUPS = {
  map: ['map', '2d'],
  vector: ['vector', 'patterns', 'invalidate', 'style', 'geojson', 'heatmap', 'query', 'layers'],
  controls: ['controls', 'accessibility', 'gestures'],
  camera: ['camera', 'animations'],
  labels: ['labels', 'roads', 'scripts', 'symbol-effects'],
  dem: ['dem', 'exaggeration'],
}

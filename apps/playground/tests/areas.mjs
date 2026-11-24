// Which browser check areas to run: named on the command line, or picked from the files a branch changed.
//   node apps/playground/tests/run.mjs                    every area
//   node apps/playground/tests/run.mjs labels buildings   those areas (a group name expands to its members)
//   node apps/playground/tests/run.mjs --changed          the areas the branch's changes reach, against origin/master
//   node apps/playground/tests/run.mjs --changed=main     … against another base
import { execFileSync } from 'node:child_process'

export const AREAS = [
  'precision', 'map', '2d', 'vector', 'patterns', 'attribution', 'controls', 'accessibility', 'invalidate', 'style', 'geojson', 'heatmap',
  'query', 'afterburner', 'camera', 'markers', 'animations', 'sdf', 'layers', 'relief', 'georef', 'effects', 'labels', 'scripts', 'buildings',
  'roads', 'dem', 'exaggeration',
]

/** A name that runs several areas: the group's own area first. */
export const GROUPS = {
  map: ['map', '2d'],
  vector: ['vector', 'patterns', 'invalidate', 'style', 'geojson', 'heatmap', 'query', 'layers'],
  controls: ['controls', 'accessibility'],
  camera: ['camera', 'animations'],
  labels: ['labels', 'roads', 'scripts'],
  dem: ['dem', 'exaggeration'],
}

const ALL = Symbol('every area')
const VECTOR_CORE = [...GROUPS.vector, 'labels', 'roads', 'scripts', 'buildings', 'relief', 'effects']
const LIBRARY = 'packages/react-three-earth/src/'
const PLAYGROUND = 'apps/playground/src/'

/**
 * Changed path → areas it can break. First match wins. A library or playground source file that no rule names runs
 * every area (shared code: Earth, the renderer, tiles, atmosphere, view, plugins), so a missing rule costs time, never
 * coverage. Files outside those folders (docs, skills, unit tests, workflows) need no browser check.
 */
export const RULES = [
  [/^apps\/playground\/public\/georef\//, ['georef']],
  [/^apps\/playground\/(tests|fixtures|public)\//, ALL],
  [/^apps\/playground\/(index\.html|vite\.config\.ts|package\.json)$/, ALL],
  [new RegExp(`^${LIBRARY}vector/extrusions/`), ['buildings']],
  [new RegExp(`^${LIBRARY}vector/raster/`), ['relief', 'dem', 'exaggeration']],
  [new RegExp(`^${LIBRARY}(vector|react)/GeoJsonSource\\.tsx?$`), ['geojson', 'heatmap']],
  [new RegExp(`^${LIBRARY}vector/`), VECTOR_CORE],
  [new RegExp(`^${LIBRARY}tiles/(dem/|RasterDemTerrainPlugin\\.ts$)`), ['dem', 'exaggeration', 'relief']],
  [new RegExp(`^${LIBRARY}(controls/AttributionControl\\.ts|react/AttributionControl\\.tsx)$`), ['attribution']],
  [new RegExp(`^${LIBRARY}(controls/|react/controls\\.tsx$)`), ['controls', 'accessibility']],
  [new RegExp(`^${LIBRARY}(core/(Marker|Popup|markerLayout)\\.ts|react/(Marker|Popup|domRoot)\\.tsx)$`), ['markers']],
  [new RegExp(`^${LIBRARY}core/cameraAnimation\\.ts$`), ['animations', 'camera', 'controls', 'accessibility']],
  [new RegExp(`^${LIBRARY}(core/(EarthControls|KeyboardControls|TouchGestures)\\.ts|react/EarthControls\\.tsx)$`), ['camera', 'animations', 'controls', 'accessibility']],
  [new RegExp(`^${LIBRARY}core/(featureQuery|LayerEvents)\\.ts$`), ['query', 'labels', 'roads', 'scripts']],
  [new RegExp(`^${LIBRARY}(plugins/(drapedLayers|renderPasses)\\.ts|tiles/imagery/DrapedLayerOverlay\\.ts|core/ScreenOverlay\\.ts)$`), ['effects']],
  [new RegExp(`^${LIBRARY}tiles/imagery/GeoreferencedImageOverlay\\.ts$`), ['georef']],
  [new RegExp(`^${LIBRARY}plugins/styleLayerTypes\\.ts$`), ['layers']],
  [new RegExp(`^${PLAYGROUND}heatmap/`), ['heatmap']],
  [new RegExp(`^${PLAYGROUND}geojson/`), ['geojson']],
  [new RegExp(`^${PLAYGROUND}sdf/`), ['sdf']],
  [new RegExp(`^${PLAYGROUND}styleLayers/`), ['layers', 'patterns']],
  [new RegExp(`^${PLAYGROUND}effects/`), ['effects']],
  [new RegExp(`^${PLAYGROUND}(aeronautic/|AfterburnerDemo\\.tsx$)`), ['afterburner']],
  [new RegExp(`^${PLAYGROUND}PrecisionTest\\.tsx$`), ['precision']],
  [new RegExp(`^(${LIBRARY}|${PLAYGROUND})`), ALL],
]

/** Areas a set of changed paths reaches, in suite order; every area when any path is shared code. */
export function areasForFiles(files) {
  const areas = new Set()
  for (const file of files) {
    const rule = RULES.find(([pattern]) => pattern.test(file))
    if (rule === undefined) continue
    if (rule[1] === ALL) return [...AREAS]
    for (const area of rule[1]) areas.add(area)
  }
  return AREAS.filter(area => areas.has(area))
}

/** Files changed since the merge base with `base`, plus uncommitted and untracked ones. */
export function changedFiles(base = 'origin/master') {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean)
  let mergeBase
  try {
    mergeBase = git('merge-base', base, 'HEAD')[0]
  } catch {
    throw new Error(`No merge base with ${base}: run \`git fetch origin master\` (unshallow a shallow clone with \`git fetch --unshallow\`), or pass --changed=<base>`)
  }
  return [...new Set([...git('diff', '--name-only', '--no-renames', mergeBase), ...git('ls-files', '--others', '--exclude-standard')])]
}

/** Areas from command-line arguments, every area when none is named. Unknown names throw with the list of valid ones. */
export function selectAreas(argv) {
  const changed = argv.find(argument => argument.startsWith('--changed'))
  if (changed !== undefined) {
    if (argv.some(argument => !argument.startsWith('-'))) throw new Error('Pass either --changed or area names, not both')
    const files = changedFiles(changed.slice(changed.indexOf('=') + 1 || changed.length) || undefined)
    return areasForFiles(files)
  }
  const names = argv.filter(argument => !argument.startsWith('-'))
  if (names.length === 0) return [...AREAS]
  const unknown = names.filter(name => !AREAS.includes(name))
  if (unknown.length > 0) throw new Error(`Unknown browser check area ${unknown.join(', ')}: use one of ${AREAS.join(', ')}`)
  const areas = new Set(names.flatMap(name => GROUPS[name] ?? [name]))
  return AREAS.filter(area => areas.has(area))
}

// Fails (exit 1) when the browser checks in test-results/results.json fall outside their expected ranges.
// Run after tests/run.mjs. Thresholds leave margin over the values measured on SwiftShader (docs/spike/SPIKE.md).
import { readFileSync } from 'node:fs'

const results = JSON.parse(readFileSync(new URL('../test-results/results.json', import.meta.url), 'utf8'))

/** check name → assertions on its result, each [description, passes]. */
const expectations = {
  'precision, highPrecision on': r => [
    ['1 cm spans more than 100 px', r.separationPx > 100],
    ['worst centroid error under 2 px', r.maxErrorPx !== null && r.maxErrorPx < 2],
  ],
  // Without 64-bit matrices the cubes collapse or jump; this proves the precision check can fail.
  'precision, highPrecision off': r => [['cubes lost or off by more than 5 px', r.maxErrorPx === null || r.maxErrorPx > 5]],
  'map with fixtures, atmosphere off': r => [
    ['more than 20 tiles loaded', r.tilesLoaded > 20],
    ['imagery drapes on terrain (over 50 % checker pixels)', r.greenShare > 0.5],
  ],
  'map with fixtures, atmosphere on': r => [
    ['more than 20 tiles loaded', r.tilesLoaded > 20],
    ['sky and haze render (over 50 % blue pixels)', r.blueSkyShare > 0.5],
    ['no black frame (under 5 % black pixels)', r.blackShare < 0.05],
  ],
  // The flat map: the atmosphere fades out, so imagery shows unlit with or without it.
  'map with fixtures, 2d, atmosphere off': r => [
    ['view settled on the map', r.view?.mode === '2d' && r.view?.morph === 1],
    ['imagery drapes on the map (over 50 % checker pixels)', r.greenShare > 0.5],
  ],
  'map with fixtures, 2d, atmosphere on': r => [
    ['view settled on the map', r.view?.mode === '2d' && r.view?.morph === 1],
    ['imagery drapes on the map (over 50 % checker pixels)', r.greenShare > 0.5],
  ],
  'map controls': r => [
    ['the controls are in the top-right corner', r.corner.top >= 0 && r.corner.right >= 0 && r.corner.right < 40],
    ['navigation, view, geolocate and fullscreen buttons are there', ['Zoom in', 'Zoom out', 'Switch to the flat map', 'Show my location', 'Enter fullscreen'].every(l => r.labels.includes(l))],
    ['zoom in adds one level', Math.abs(r.zoomInDelta - 1) < 0.05],
    ['two zoom outs after it go one level below the start', Math.abs(r.zoomOutDelta + 1) < 0.05],
    ['the compass needle turns against the heading', r.compassTurned.includes('rotateZ(-45')],
    ['the compass resets north and looks down', Math.abs(r.resetHeading) < 0.5 && r.resetPitch < -89],
    ['the scale is a round number', /^(1|2|3|5)0* (m|km)$/.test(r.scaleText ?? '') && r.scaleWidth > 20 && r.scaleWidth <= 101],
    ['the scale changes with the zoom', r.scaleAfterZoom !== r.scaleText],
    ['the view button flattens the map and offers the globe', r.flat.mode === '2d' && r.flat.text.trim() === '3D'],
    ['and goes back', r.globe.mode === '3d' && r.globe.text.trim() === '2D'],
    ['a press on a control is not a click on the map', r.mapClicksFromControls === 0],
    ['geolocate flies to the position', Math.abs(r.geolocate.longitude + 90) < 0.05 && Math.abs(r.geolocate.latitude - 0.02) < 0.05],
    ['geolocate follows, with a dot and an accuracy circle', r.geolocate.pressed === 'true' && r.geolocate.circle],
    ['a second press stops following and removes the dot', r.geolocate.dotAfterStop === false],
    ['fullscreen enters and leaves', (r.fullscreen.native || r.fullscreen.pseudo) && r.fullscreen.pressed === 'true' && r.fullscreenExited],
    ['phone: every button is at least 44 pixels and inside the screen', r.phone.sizes.length >= 6 && r.phone.sizes.every(size => size >= 44) && r.phone.inside],
    ['phone: a tap on zoom in zooms', Math.abs(r.phone.zoomInDelta - 1) < 0.05],
  ],
  'attribution control': r => [
    ['wide window shows the terrain and OpenStreetMap credits', r.wide.text === 'Synthetic test terrain | © OpenStreetMap contributors'],
    ['the OpenStreetMap credit is a safe link', r.wide.links.length === 1 && r.wide.links[0].href === 'https://www.openstreetmap.org/copyright' && r.wide.links[0].target === '_blank' && r.wide.links[0].rel === 'noopener noreferrer'],
    ['it sits in the bottom-right corner', r.wide.bottomRight?.right === 0 && r.wide.bottomRight?.bottom === 0],
    ['earth.getAttributions() lists terrain first, then imagery', JSON.stringify(r.wide.earthAttributions) === JSON.stringify(['Synthetic test terrain', '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'])],
    ['wide window has no toggle button', r.wide.textVisible && !r.wide.buttonVisible],
    ['narrow window is compact: only the button', r.compact.buttonVisible && !r.compact.textVisible],
    ['the button expands the credits', r.expanded.buttonVisible && r.expanded.textVisible && r.expanded.text.includes('OpenStreetMap')],
    ['a style\'s source attribution shows once it loads', r.vector.text === 'Synthetic test terrain | © Fixture map data' && r.vector.links[0]?.href === 'https://example.com/fixture-map'],
  ],
  // Redrawn in place: the lakes change colour and never disappear while regions redraw.
  'vector map style with fixtures, invalidate': r => [
    ['lakes start blue', r.before.blueShare > 0.002 && r.before.pinkShare < 0.0005],
    ['invalidate reports pending recompositions', r.pendingAfterCall > 0],
    ['lakes end pink', r.after.pinkShare > r.before.blueShare * 0.6 && r.after.blueShare < r.before.blueShare * 0.2],
    ['no frame of missing texture (lakes stay drawn)', r.minimumLakeShareDuringRedraw > r.before.blueShare * 0.6],
    // The bounds cover the lakes, not the whole view: far regions (the horizon, the globe) stay as they are.
    ['only regions reaching into the bounds marked', r.pendingAfterCall < r.regionsHeld],
    ['each marked region redrawn once (a few new tiles may load meanwhile)', r.regionsRedrawn >= r.pendingAfterCall && r.regionsRedrawn <= r.pendingAfterCall + 10],
  ],
  // Raster, colour relief and hillshade layers of a style (fixture imagery and Terrarium DEM), under the vector roads.
  ...Object.fromEntries(['2d', '2d webgl2'].map(name => [`relief style with fixtures, ${name}`, r => [
    ['the raster layer draws the imagery (over 40 % green checker)', r.imageryShare > 0.4],
    ['vector roads draw above it', r.primaryRoadShare > 0.003],
    ['hillshade lights and shades the hills', r.lightShare > 0.02 && r.shadedShare > 0.005],
    ['no warnings', r.warnings.length === 0],
  ]])),
  // Terrain from Terrarium tiles of the quantized-mesh fixture's heights.
  'raster-dem terrain, heights': r => [
    ['every point of the grid has a height', r.heightErrorsMeters?.count === 49],
    ['over hills 500 m high or more', r.heightErrorsMeters?.heightRangeMeters >= 500],
    ['heights match the fixture within 3 m (measured: under 2 m; quantized-mesh: under 5 m)', r.heightErrorsMeters?.maximum < 3],
  ],
  'raster-dem terrain, heights, quantized-mesh for comparison': r => [['every point of the grid has a height', r.heightErrorsMeters?.count === 49]],
  ...Object.fromEntries(['pitched', 'pitched webgl2'].map(name => [`raster-dem terrain, ${name}`, r => [
    ['imagery drapes on the terrain (over 50 % checker pixels)', r.greenShare > 0.5],
    ['the terrain credit shows', r.attributions?.[0] === 'Synthetic test elevation'],
  ]])),
  'raster-dem terrain, north pole': r => [['no hole at the pole (no black at the centre)', r.centreBlackShare === 0]],
  'raster-dem terrain, 2d': r => [
    ['view settled on the map', r.view?.mode === '2d' && r.view?.morph === 1],
    ['imagery drapes on the map (over 50 % checker pixels)', r.greenShare > 0.5],
  ],
  'relief style with fixtures, 3d': r => [
    ['the raster layer drapes on the terrain', r.imageryShare > 0.2],
    ['no warnings', r.warnings.length === 0],
  ],
  ...Object.fromEntries(['hillshade seams', 'hillshade seams webgl2', 'hillshade globe'].map(name => [`relief style with fixtures, ${name}`, r => [
    ['no seam at tile or region edges', r.seams.length === 0],
    ['hills are lit and shaded', r.litShare > 0.01 && r.shadedShare > 0.05],
    ['no warnings', r.warnings.length === 0],
  ]])),
  // The runtime style API: setPaintProperty, setLayerVisibility, addLayer, setFeatureState on fixture lakes.
  'vector map style with fixtures, runtime style': r => [
    ['lakes start blue', r.before.blueShare > 0.002 && r.before.pinkShare < 0.0005],
    ['setPaintProperty recolours the lakes', r.recoloured.pinkShare > r.before.blueShare * 0.6 && r.recoloured.blueShare < r.before.blueShare * 0.2],
    ['setLayerVisibility hides them', r.hidden.pinkShare < r.before.blueShare * 0.1 && r.hidden.blueShare < r.before.blueShare * 0.1],
    ['they come back blue', r.restored.blueShare > r.before.blueShare * 0.8 && r.restored.pinkShare < 0.0005],
    ['setFeatureState highlights one lake of three', r.hovered.pinkShare > r.before.blueShare * 0.05 && r.hovered.blueShare > r.before.blueShare * 0.2],
    ['feature-state reads back', r.featureState.hover === true],
    ['a hover redraws regions without processing tiles again', r.tilesProcessedDuringHover === 0 && r.hover.regionsRedrawn > 0],
  ],
  // queryRenderedFeatures, layer click / pointerenter / pointerleave, hover feature-state and cursor, querySourceFeatures.
  'vector map style with fixtures, feature queries and layer events': r => [
    ['a point on Lake Kawaguchi returns it, as a polygon', r.lake.features.some(feature => feature.layer === 'water' && feature.id === 1 && feature.name === 'Lake Kawaguchi' && feature.geometry === 'Polygon')],
    ['a point on East Road 6 returns the road above its casing', r.road.features.findIndex(feature => feature.layer === 'road' && feature.name === 'East Road 6') !== -1 && r.road.features.findIndex(feature => feature.layer === 'road' && feature.name === 'East Road 6') < r.road.features.findIndex(feature => feature.layer === 'road-casing')],
    ['a mouse click reaches the layer listener with the lake only', r.clicked.length === 1 && JSON.stringify(r.clicked[0]) === JSON.stringify([{ layer: 'water', id: 1 }])],
    ['lakes start blue', r.before.blueShare > 0.002 && r.before.pinkShare < 0.0005],
    ['hovering sets feature-state, the pointer cursor and pointerenter', r.hover.state.hover === true && r.hover.cursor === 'pointer' && JSON.stringify(r.hover.entered) === '[1]'],
    ['the hovered lake turns pink, the others stay blue', r.hovered.pinkShare > 0.0005 && r.hovered.blueShare > 0.001],
    ['leaving clears the state, the cursor and fires pointerleave', r.leave.state.hover === false && r.leave.cursor === '' && r.leave.entered.length === 0],
    ['the lake is blue again', r.left.pinkShare < 0.0005 && r.left.blueShare > r.before.blueShare * 0.8],
    ['a whole-screen query and querySourceFeatures list the three lakes', JSON.stringify(r.screenLakes) === '[1,2,3]' && JSON.stringify(r.sourceLakes) === '[1,2,3]'],
  ],
  ...Object.fromEntries(['webgpu', 'webgl2'].map(name => [`vector map style with fixtures, patterns, ${name}`, r => [
    ['background-pattern covers the land (green checks)', r.sprite.meadowShare > 0.5],
    ['fill-pattern stripes the lakes, dark and light', r.sprite.darkBlueShare > 0.004 && r.sprite.lightBlueShare > 0.003],
    ['line-pattern dashes the primary roads', r.sprite.redShare > 0.008],
    ['the image the sprite lacks draws nothing and is reported once', r.sprite.magentaShare === 0 && JSON.stringify(r.missing) === '["hatch"]'],
    ['addImage draws it', r.added.magentaShare > 0.001],
    ['updateImage replaces it', r.updated.magentaShare < r.added.magentaShare * 0.1 && r.updated.yellowShare > r.added.yellowShare + 0.001],
    ['the other patterns stay', r.updated.darkBlueShare > r.sprite.darkBlueShare * 0.8 && r.updated.redShare > r.sprite.redShare * 0.8],
  ]])),
  'camera and events with fixtures': r => {
    const angle = (a, b) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180)
    return [
      ['unproject then project lands within 1 px', r.worstProjectErrorPixels < 1],
      ['unproject lands on the terrain queryTerrainElevation reports (within 1 m)', r.worstElevationErrorMeters < 1],
      ['a terrain point round-trips through the screen within 1 m', r.worstRoundTripMeters < 1],
      ['the flat map round-trips within 1 px', r.worstFlatProjectErrorPixels < 1],
      ['getView keeps centre, zoom and heading through the morph', Math.abs(r.flatView.longitudeDegrees - r.topDownView.longitudeDegrees) < 1e-4 && Math.abs(r.flatView.latitudeDegrees - r.topDownView.latitudeDegrees) < 1e-4 && Math.abs(r.flatView.zoom - r.topDownView.zoom) < 0.01 && angle(r.flatView.headingDegrees, r.topDownView.headingDegrees) < 0.1],
      ['the morph fires movestart, moveend, then idle', r.morphEvents.join() === 'movestart,moveend,idle'],
    ]
  },
  'markers and popups with fixtures': r => [
    ['the pin sits on the hill (terrain height within 50 m of 3900 m)', Math.abs(r.peakHeightMeters - 3900) < 50],
    ['the pin is a labelled button', r.peakRole === 'button' && r.peakTabIndex === 0 && r.peakLabel === 'Fixture peak'],
    ['React content renders in the marker', r.buriedText === 'sea level'],
    ['a marker under the hill fades (occluded, opacity 0.2)', r.buriedVisibility === 'occluded' && Number(r.buriedOpacity) === 0.2],
    ['checked on every frame of the camera move, the pin crossing the screen', r.frames >= 35 && r.travelPixels > 50],
    // Rounded to whole pixels: at most half a pixel on each axis. A frame of lag would be several pixels here.
    ['the marker is placed in the frame that draws (transform within pixel rounding of project)', r.maximumTransformErrorPixels <= Math.SQRT1_2 + 1e-6],
    ['the pin\'s tip stays within 1 px of its projected point while the camera moves', r.maximumElementErrorPixels <= 1],
    ['hidden behind the globe', r.behindHorizon.visibility === 'hidden' && r.behindHorizon.cssVisibility === 'hidden'],
    ['the popup opens on click, above the pin, with focus inside', r.popup.text.includes('Fixture peak') && r.popup.anchor === 'bottom' && r.popup.focusInside && Math.abs(r.popup.gapAbovePinPixels) <= 1 && r.popup.centreOffsetPixels <= 1],
    ['Escape closes the popup and gives focus back to the marker', !r.afterEscape.open && r.afterEscape.focusOnMarker],
    ['dragging moves the marker, fires dragend once, and leaves the map still', r.drag.dragEnds === 1 && r.drag.movedPixels > 60 && r.drag.cameraMovedMeters < 1],
    ['controlled popups: a click on another marker moves the selection (one open), a second click closes it', JSON.stringify(r.selection) === JSON.stringify({ afterFirst: { selected: 'east', open: ['Place east'] }, afterSecond: { selected: 'west', open: ['Place west'] }, afterThird: { selected: null, open: [] } })],
    ['under StrictMode: five markers, four pins, content and popup render, no errors', r.strictMode.markerElements === 5 && r.strictMode.pinsShown === 4 && r.strictMode.buriedText === 'sea level' && r.strictMode.popupText.includes('Fixture peak') && r.strictMode.errors.length === 0],
  ],
  'camera animations and pointer events with fixtures': r => {
    const angle = (a, b) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180)
    const endsAt = (flight, pitchDegrees) =>
      flight.completed &&
      Math.abs(flight.view.longitudeDegrees - r.target.longitudeDegrees) < 1e-6 &&
      Math.abs(flight.view.latitudeDegrees - r.target.latitudeDegrees) < 1e-6 &&
      Math.abs(flight.view.zoom - r.target.zoom) < 1e-3 &&
      angle(flight.view.headingDegrees, r.target.headingDegrees) < 0.01 &&
      Math.abs(flight.view.pitchDegrees - pitchDegrees) < 0.01
    const click = r.clicks[0]
    return [
      ['flyTo Tokyo → Paris ends at the requested view on the globe', endsAt(r.globe, -50)],
      ['flyTo Tokyo → Paris ends at the requested view on the flat map', endsAt(r.flat, -90)],
      ['the flights zoom out on the way', r.globe.lowestZoom < 6 && r.flat.lowestZoom < 6],
      ['the flights take about their 4 s', Math.abs(r.globe.seconds - 4) < 1 && Math.abs(r.flat.seconds - 4) < 1],
      ['zoom and rotate events fire inside movestart and moveend', ['globe', 'flat'].every(name => r[name].events.join() === 'movestart,zoomstart,rotatestart,zoomend,rotateend,moveend')],
      ['the mouse wheel stops a running flight', r.flightCompleted === false],
      ['fitBounds puts the box inside 40 px of padding', r.fit.completed && r.fit.corners.every(corner => corner.xPixels > 39 && corner.xPixels < 761 && corner.yPixels > 39 && corner.yPixels < 561)],
      ['one click (a drag is not a click)', r.clicks.length === 1],
      ['the click reports its screen position', click?.screen.xPixels === 400 && click?.screen.yPixels === 300],
      ['the click reports the position under it, on the terrain', click?.geographic != null && Math.abs(click.geographic.longitudeDegrees + 89.6) < 1e-4 && Math.abs(click.geographic.latitudeDegrees - 0.3) < 1e-4 && Math.abs(click.geographic.heightMeters - r.elevationAtCenter) < 1 && r.elevationAtCenter > 1000],
      ['pointermove fires with the pointer', r.pointerMoves > 0],
    ]
  },
  // The example plugin (src/sdf/): a raymarched shape on the fixture peak, half buried.
  'sdf shapes plugin, near, atmosphere off': r => [
    ['the plugin shows one shape with one pipeline', r.plugin?.details?.shown === 1 && r.plugin?.details?.pipelines === 1],
    // Without the written depth, the box's back faces (underground) hide the lower visible part: 0.0006 measured.
    ['the shape renders, depth written (over 0.085 % orange pixels)', r.orangeShare > 0.00085],
    ['the terrain hides its buried half', r.orangeBelowGround < 20],
  ],
  'sdf shapes plugin, near, atmosphere on': r => [
    ['lit by the atmosphere: orange at its centre', r.samples[0][0] - r.samples[0][2] > 60],
    ['no black frame', r.blackShare < 0.05],
    ['the terrain hides its buried half', r.orangeBelowGround < 20],
  ],
  'sdf shapes plugin, far, atmosphere on': r => {
    const near = results.find(other => other.check === 'sdf shapes plugin, near, atmosphere on')
    const saturation = sample => sample[0] - sample[2]
    return [['hazed with distance: less saturated far away than near', near !== undefined && saturation(r.samples[0]) < saturation(near.samples[0]) - 20]]
  },
  'sdf shapes plugin, 2d': r => [
    ['on its spot on the flat map: orange at its projected centre', r.centreVisible && r.samples[0][0] > 180 && r.samples[0][0] - r.samples[0][2] > 100],
    ['not black on the map (emits its colour)', r.orangeShare > 0.002 && r.blackShare < 0.01],
  ],
  'sdf shapes plugin, webgl2': r => {
    const webgpu = results.find(other => other.check === 'sdf shapes plugin, near, atmosphere off')
    return [['WebGL2 draws the same shape as WebGPU', webgpu !== undefined && Math.abs(r.orangeShare - webgpu.orangeShare) <= webgpu.orangeShare * 0.25 && r.orangeBelowGround < 20]]
  },
  // Custom style layer types (src/styleLayers/): a glow around primary roads and striped lakes.
  'style layer types, webgpu': r => styleLayerExpectations(r),
  'style layer types, webgl2': r => {
    const webgpu = results.find(other => other.check === 'style layer types, webgpu')
    return [
      ...styleLayerExpectations(r),
      ['WebGL2 draws the same glow as WebGPU', webgpu !== undefined && Math.abs(r.magentaShare - webgpu.magentaShare) <= webgpu.magentaShare * 0.1],
    ]
  },
  'style layer types, registered late': r => [
    ['nothing custom before the plugins are installed', r.before.magentaShare < 0.001 && r.before.stripeDarkShare < 0.001],
    ...styleLayerExpectations(r.added).map(([label, ok]) => [`installed after the style loaded: ${label}`, ok]),
    ['gone again once the plugins are removed', r.removed.magentaShare < 0.001 && r.removed.stripeDarkShare < 0.001],
    ['no tile fetched again for either change', r.tileRequestsAfterLoad === 0],
  ],
  // Render passes and draped layers (src/effects/), installed at runtime, the selection moved, then removed.
  'render passes and draped layers, webgpu': r => effectExpectations(r, { glowIsMagenta: true }),
  'render passes and draped layers, webgl2': r => {
    const webgpu = results.find(other => other.check === 'render passes and draped layers, webgpu')
    return [
      ...effectExpectations(r, { glowIsMagenta: true }),
      ['WebGL2 draws the same glow as WebGPU', webgpu !== undefined && Math.abs(r.selected.magentaShare - webgpu.selected.magentaShare) <= webgpu.selected.magentaShare * 0.1],
    ]
  },
  'render passes and draped layers, atmosphere on': r => [
    ...effectExpectations(r, { glowIsMagenta: false }),
    ['the built-in FXAA is reported, last in the display stage', r.plain.renderPasses.map(pass => pass.name).join() === 'fxaa' && r.installed.renderPasses.map(pass => pass.name).join() === 'highlight-lift,vignette,fxaa' && r.installed.renderPasses.at(-1).timing === 'unavailable'],
  ],
  // StrictMode mounts, unmounts and mounts again: the plugin is removed and installed once more, its shape kept.
  // GeoJSON sources (`?geojson`): an area, a route with a line gradient, clustered points; setData redraws near the change.
  ...Object.fromEntries(['webgpu', 'webgl2', 'strict mode'].map(name => [`geojson sources, ${name}`, r => [
    ['the area draws (magenta)', r.before.magentaShare > 0.002],
    ['the route draws with its gradient, red at the start and cyan at the end', r.before.redShare > 0.001 && r.before.cyanShare > 0.003],
    ['the clusters draw (green)', r.before.greenShare > 0.0008 && r.close.greenShare > 0.003],
    ['a new data prop moves the area east', r.moved.magentaCentreX > r.before.magentaCentreX + 0.05 && Math.abs(r.moved.magentaShare - r.before.magentaShare) < r.before.magentaShare * 0.5],
    ['the route and clusters stay as they were', Math.abs(r.moved.cyanShare - r.before.cyanShare) < 0.001 && Math.abs(r.moved.greenShare - r.before.greenShare) < 0.0005],
    ['updateData redraws regions', r.regionsRedrawnAfterUpdateData > 0],
    ['setData far from the view leaves the detailed regions in view as they are', r.detailedRegionsHeld >= 4 && r.detailedRegionsRedrawn === 0 && r.regionsRedrawnFarFromView < r.regionsHeldClose],
    ['a cluster query reaches the worker and states the fix', /has no cluster 987654.*use a `cluster_id`/.test(r.clusterQuery)],
  ]])),
  'sdf shapes plugin, strict mode': r => {
    const plain = results.find(other => other.check === 'sdf shapes plugin, near, atmosphere off')
    return [
      ['one shape, one pipeline, no error', r.plugin?.ready === true && r.plugin?.details?.shown === 1 && r.plugin?.details?.pipelines === 1 && r.errors.length === 0],
      ['draws the same shape as without StrictMode', plain !== undefined && Math.abs(r.orangeShare - plain.orangeShare) <= plain.orangeShare * 0.1],
    ]
  },
}

/** The `?glow` layers as drawn: glow along primary roads only, stripes of both blues in the lakes. */
function styleLayerExpectations(r) {
  const magenta = ([red, green, blue]) => red > 110 && blue > 80 && red > green + 60 && blue > green + 40
  return [
    ['the glow covers part of the map (over 3 % magenta pixels)', r.magentaShare > 0.03],
    ['beside a primary road: glow', magenta(r.samples[0])],
    ['beside a minor road: no glow (the layer filter applies)', !magenta(r.samples[1])],
    ['lakes are striped in both blues', r.stripeDarkShare > 0.003 && r.stripeLightShare > 0.003 && r.stripeChanges > 40],
  ]
}

/** The `?effects` examples: a vignette darkens the corners only, the glow follows the selection, removal restores the plain map. */
function effectExpectations(r, { glowIsMagenta }) {
  const pink = ([red, green, blue]) => glowIsMagenta ? red > 110 && blue > 80 && red > green + 60 && blue > green + 40 : red > green + 30 && blue > green + 15
  const pluginPasses = inspection => inspection.renderPasses.filter(pass => pass.name !== 'fxaa')
  return [
    ['the vignette darkens the corners (by over 15 %) and leaves the middle', r.installed.corners < r.plain.corners * 0.85 && Math.abs(r.installed.reference - r.plain.reference) < r.plain.reference * 0.03],
    ['both passes are built, fused', pluginPasses(r.installed).map(pass => `${pass.name}:${pass.stage}:${pass.active}:${pass.timing}`).join() === 'highlight-lift:radiance:true:fused,vignette:display:true:fused'],
    ['nothing glows before a selection, and no region is drawn', r.installed.magentaShare === 0 && r.installed.drapedLayers[0]?.regionsDrawn === 0 && !pink(r.installed.samples[0])],
    ['selecting marks only the regions around the place', r.pendingAfterSelect > 0 && r.pendingAfterSelect < r.selected.drapedLayers[0].regions / 2],
    ['the glow draws at the selected place, above the imagery', pink(r.selected.samples[0]) && !pink(r.selected.samples[1]) && (!glowIsMagenta || r.selected.magentaShare > 0.001)],
    ['only regions inside the bounds get a texture', r.selected.drapedLayers[0].regionsDrawn > 0 && r.selected.drapedLayers[0].regionsDrawn < r.selected.drapedLayers[0].regions / 2],
    ['moving the selection moves the glow and clears the old place', pink(r.moved.samples[1]) && !pink(r.moved.samples[0])],
    ['removing the plugins restores the plain map', r.removed.magentaShare === 0 && pluginPasses(r.removed).length === 0 && r.removed.drapedLayers.length === 0 && Math.abs(r.removed.corners - r.plain.corners) < 1],
  ]
}

// Screen-space labels on a dense grid of towns (124 labels, a third fit at 40 km).
const screenLabels = (r, textShare = 0.005) => [
  ...(textShare === null ? [] : [[`text draws (over ${textShare * 100} % text pixels)`, r.textShare > textShare]]),
  ['between 20 and 80 labels show, most of them towns', r.labelsShown >= 20 && r.labelsShown <= 80 && r.towns >= r.labelsShown - r.roadNames - 6],
  ['no two placed labels overlap (road names glyph by glyph)', r.overlaps === 0],
  ['no text repeats at one place', r.duplicates === 0],
  ['every label shown is on the screen', r.onScreen],
  ['labels at the centre are 14 to 26 px tall (text size and padding)', r.centralBoxHeightPixels !== null && r.centralBoxHeightPixels > 14 && r.centralBoxHeightPixels < 26],
  ['all terrain heights read', r.inspection?.elevationsPending === 0],
  ['no label hidden behind the flat fixture ground', r.inspection?.labelsOccluded === 0],
  ['some towns moved beside their point (variable anchors)', r.townsBesideTheirPoint > 0],
  ['places show their icons, which collide apart from their text', r.iconLabels >= 2],
  ...(textShare === null ? [] : [['red pins and the blue summit disc draw', r.redPixels > 20 && r.bluePixels > 20]]),
  ['a feature query at a label answers its town', r.queryAtLabel !== null && r.queryAtLabel.names[0] === r.queryAtLabel.text],
]
for (const name of ['top-down', 'pitched', 'webgl2', 'strict mode']) expectations[`screen-space labels, ${name}`] = r => screenLabels(r)
// The haze covers the text colour: no text-pixel count, but the same placement as without it.
expectations['screen-space labels, atmosphere on'] = r => screenLabels(r, null)
// Unlit on the flat map: the same placement as the top-down globe, thinner text against the grey land.
expectations['screen-space labels, 2d'] = r => screenLabels(r, 0.002)
for (const name of ['road names, pitched', 'road names, top-down']) {
  expectations[`screen-space labels, ${name}`] = r => [
    ['road names show along their roads, none upside down', r.roadNames >= 2 && r.roadNamesUpsideDown === 0],
    ['no label hidden behind the flat fixture ground', r.inspection?.labelsOccluded === 0],
    ['no two placed labels overlap (road names glyph by glyph)', r.overlaps === 0],
    ['no text repeats at one place', r.duplicates === 0],
    ['all terrain heights read', r.inspection?.elevationsPending === 0],
  ]
}
expectations['screen-space labels, draped'] = r => [
  ['no label faces the viewer', r.labelsShown === 0 && r.inspection === null && r.queryAtLabel === null],
  ['labels are drawn on the ground instead', r.textShare > 0.005],
]

let failures = 0
for (const [check, assertions] of Object.entries(expectations)) {
  const result = results.find(r => r.check === check)
  if (result === undefined) {
    console.error(`✗ ${check}: missing from results.json`)
    failures++
    continue
  }
  const all = [...assertions(result), ['no console errors', result.errors.length === 0]]
  for (const [description, passes] of all) {
    console.log(`${passes ? '✓' : '✗'} ${check}: ${description}`)
    if (!passes) failures++
  }
  if (result.errors.length > 0) console.error(result.errors.join('\n'))
}

if (failures > 0) {
  console.error(`\n${failures} browser check assertion(s) failed.`)
  process.exit(1)
}

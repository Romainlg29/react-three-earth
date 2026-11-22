export { Earth, type EarthOptions, type EarthInspection } from './core/Earth.js'
export {
  AttributionTracker,
  attributionText,
  collectAttributions,
  normalizeAttributions,
  parseAttribution,
  resolveCompact,
  type AttributionInput,
  type AttributionProvider,
  type AttributionSegment,
} from './core/attribution.js'
export { AttributionControl, type AttributionControlOptions } from './controls/AttributionControl.js'
export { Marker, type MarkerDragEvent, type MarkerEventMap, type MarkerHeight, type MarkerOptions } from './core/Marker.js'
export { Popup, type PopupEventMap, type PopupOptions } from './core/Popup.js'
export {
  anchoredBox,
  anchoredTransform,
  anchorFraction,
  anchorTransformOrigin,
  CLICK_TOLERANCE_PIXELS,
  markerRotation,
  popupOffset,
  popupPointOnBox,
  resolvePopupAnchor,
  SCREEN_ANCHORS,
  type MarkerAlignment,
  type ScreenAnchor,
  type ScreenBox,
  type ScreenOffset,
} from './core/markerLayout.js'
export {
  acquireScreenLayer,
  releaseScreenLayer,
  ScreenOverlay,
  TERRAIN_RAYCASTS_PER_FRAME,
  type ScreenOverlayFrame,
  type ScreenOverlayItem,
  type ScreenVisibility,
} from './core/ScreenOverlay.js'
export { holdContainerPosition, releaseContainerPosition } from './core/containerPosition.js'
export { PerformanceMonitor, type PerformanceSample } from './core/PerformanceMonitor.js'
export { prefersWebGLBackend } from './core/renderer.js'
export { Terrain, type TerrainOptions } from './core/Terrain.js'
export { Imagery, type ImageryOptions } from './core/Imagery.js'
export {
  Atmosphere,
  type AtmosphereOptions,
  type AerialPerspectiveOptions,
  type AerialPerspectiveAlongRay,
  type SceneBackdrop,
} from './core/Atmosphere.js'
export * from './atmosphere/index.js'
export { EarthControls, EarthViewControls, FlatMapControls } from './core/EarthControls.js'
export { ViewMorph, type ViewMode, type ViewTransitionOptions } from './view/ViewMorph.js'
export * from './view/webMercator.js'
export { EarthTilesRenderer } from './tiles/EarthTilesRenderer.js'
export { FlatMapPlugin, FLAT_POSITION_ATTRIBUTE } from './tiles/FlatMapPlugin.js'
export {
  MapStyleSource,
  QuantizedMeshSource,
  RasterTileSource,
  type MapStyleSourceOptions,
  type QuantizedMeshSourceOptions,
  type RasterTileSourceOptions,
  type TerrainSource,
  type ImagerySource,
} from './core/sources.js'
export { ImageOverlayPlugin } from './tiles/ImageOverlayPlugin.js'
export { TilesFadePlugin } from './tiles/TilesFadePlugin.js'
export { QuantizedMeshVersionPlugin } from './tiles/QuantizedMeshVersionPlugin.js'
export { ImageryCompositor, type CompositeDraw, type CompositionPriority, type CompositionRenderer } from './tiles/imagery/ImageryCompositor.js'
export { ImageryStatistics, type ImageryFrameStatistics } from './tiles/imagery/ImageryStatistics.js'
export { XYZImageryOverlay, type XYZImageryOverlayOptions } from './tiles/imagery/XYZImageryOverlay.js'
export { TileMaterialReplacementPlugin, type MaterialFactory } from './tiles/TileMaterialReplacementPlugin.js'
export {
  placeCameraAround,
  setCameraView,
  toCartesian,
  type CameraView,
  type GeographicBounds,
  type GeographicPosition,
} from './core/camera.js'
export { EarthCamera, type MapView, type MapViewChange } from './core/EarthCamera.js'
export {
  CameraMotionDetector,
  EarthEventTracker,
  type EarthEventMap,
  type EarthEventType,
  type EarthFrameState,
} from './core/events.js'
export { isOccludedByEllipsoid, type ProjectedPosition, type ScreenPosition } from './core/projection.js'
export * from './core/zoom.js'
export { MapStyleOverlay, type MapStyleOverlayOptions } from './vector/MapStyleOverlay.js'
export { createVectorTileWorker } from './vector/MapStyleBackend.js'

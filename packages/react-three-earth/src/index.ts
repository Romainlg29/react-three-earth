export { Earth, type EarthOptions, type EarthInspection } from './core/Earth.js'
export { PLUGIN_API_VERSION, type EarthPlugin, type PluginContext, type PluginFrame } from './plugins/plugin.js'
export { PluginInstallation, PluginManager, type PluginInspection } from './plugins/PluginManager.js'
export {
  StyleLayerTypeRegistry,
  type StyleLayerGeometry,
  type StyleLayerGeometryInput,
  type StyleLayerMaterialInputs,
  type StyleLayerOffscreen,
  type StyleLayerPaintNodes,
  type StyleLayerPropertyDefinition,
  type StyleLayerPropertyType,
  type StyleLayerTileNodes,
  type StyleLayerTypeDefinition,
  type StyleLayerWorkerModule,
} from './plugins/styleLayerTypes.js'
export {
  getLayerSymbolEffect,
  SYMBOL_EFFECT_METADATA_KEY,
  SymbolEffectRegistry,
  type SymbolEffectDefinition,
  type SymbolEffectInputs,
} from './plugins/symbolEffects.js'
export {
  TerrainShadingRegistry,
  type TerrainShadingDefinition,
  type TerrainShadingInputs,
  type TerrainShadingOutputs,
} from './plugins/terrainShadings.js'
export type * from './plugins/pluginWorker.js'
export {
  RenderPassRegistry,
  RENDER_PASS_STAGES,
  type RenderPassDefinition,
  type RenderPassInputs,
  type RenderPassInspection,
  type RenderPassResource,
  type RenderPassStage,
  type RenderPassTiming,
} from './plugins/renderPasses.js'
export {
  DrapedLayerRegistry,
  RegisteredDrapedLayer,
  type DrapedLayerDefinition,
  type DrapedLayerDrawInputs,
  type DrapedLayerHandle,
  type DrapedLayerInspection,
  type DrapedLayerRegion,
} from './plugins/drapedLayers.js'
export {
  EarthRenderPipeline,
  type EarthRenderPipelineAntialiasing,
  type EarthRenderPipelineInputs,
  type EarthRenderPipelineOptions,
  type EarthRenderPipelineOutput,
} from './core/EarthRenderPipeline.js'
export {
  TRANSLUCENT_LAYER,
  TRANSLUCENT_RENDER_PASS,
  TRANSLUCENT_RENDER_PASS_NAME,
  TranslucentCompositeNode,
  TranslucentPassNode,
} from './core/TranslucentPass.js'
export { GeographicAnchor, type GeographicAnchorOptions } from './core/GeographicAnchor.js'
export { createFlatMapEmissionNode, createLocalCameraPositionNode, depthFromViewZ, getLocalCameraPosition } from './core/sceneNodes.js'
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
export { AttributionControl, appendAttribution, type AttributionControlOptions, type AttributionControlState } from './controls/AttributionControl.js'
export {
  geographicToMercator,
  screenToMercatorQuery,
  type FeatureGeometry,
  type MercatorPoint,
  type RenderedFeature,
  type RenderedFeatureQueryOptions,
  type RenderedSourceFeature,
  type ScreenQueryGeometry,
  type SourceFeature,
  type SourceFeatureQueryOptions,
} from './core/featureQuery.js'
export { PointerInteractions, type PointerInteraction, type PointerInteractionEvent } from './core/PointerInteractions.js'
export { LayerEvents, type LayerEventListener, type LayerEventOptions, type LayerEventType, type LayerPointerEvent } from './core/LayerEvents.js'
export { Controls, CONTROLS_ATTRIBUTE, MapControl, type ControlsOptions, type ControlStateListener } from './controls/Controls.js'
export { NavigationControl, type NavigationControlOptions, type NavigationControlState } from './controls/NavigationControl.js'
export { ScaleControl, type ScaleControlOptions, type ScaleControlState } from './controls/ScaleControl.js'
export {
  GeolocateControl,
  type GeolocateControlOptions,
  type GeolocateControlState,
  type GeolocateEventMap,
  type GeolocateStatus,
  type UserLocation,
} from './controls/GeolocateControl.js'
export { FullscreenControl, fullscreenSupported, type FullscreenControlOptions, type FullscreenControlState } from './controls/FullscreenControl.js'
export { ViewControl, type ViewControlEventMap, type ViewControlOptions, type ViewControlState } from './controls/ViewControl.js'
export { DEFAULT_CONTROLS_LOCALE, resolveLocale, type ControlsLocale } from './controls/locale.js'
export { computeScaleBar, formatScaleBar, roundScaleLength, type ScaleBar, type ScaleUnit } from './controls/scale.js'
export { compassIsReset, compassRotation, compassTransform } from './controls/navigation.js'
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
export { screenClipPlane, type ScreenClip, type ScreenClipSide } from './core/screenClip.js'
export {
  Atmosphere,
  type AtmosphereOptions,
  type AerialPerspectiveOptions,
  type AerialPerspectiveAlongRay,
  type SceneBackdrop,
} from './core/Atmosphere.js'
export * from './atmosphere/index.js'
export { EarthControls, EarthViewControls, FlatMapControls } from './core/EarthControls.js'
export { BoxZoom, boundsAroundPositions, boxSamplePoints } from './core/BoxZoom.js'
export {
  CooperativeGestures,
  DEFAULT_COOPERATIVE_GESTURES_LOCALE,
  touchDecision,
  wheelDecision,
  type CooperativeDecision,
  type CooperativeGesturesLocale,
  type CooperativeGesturesOptions,
} from './core/CooperativeGestures.js'
export {
  DEFAULT_KEYBOARD_OPTIONS,
  isEditableTarget,
  keyboardAction,
  KeyboardControls,
  type KeyboardAction,
  type KeyboardControlsOptions,
  type KeyPress,
} from './core/KeyboardControls.js'
export { TouchGestures, type TwoFingerFrame } from './core/TouchGestures.js'
export { ViewMorph, type ViewMode, type ViewTransitionOptions } from './view/ViewMorph.js'
export * from './view/webMercator.js'
export { EarthTilesRenderer } from './tiles/EarthTilesRenderer.js'
export { FlatMapPlugin, FLAT_POSITION_ATTRIBUTE, terrainFlatMorph } from './tiles/FlatMapPlugin.js'
export {
  TERRAIN_SURFACE_ATTRIBUTE,
  terrainAspectDegrees,
  terrainAspectRadians,
  terrainElevationMeters,
  terrainNormalEastNorthUp,
  terrainSlopeDegrees,
  terrainSlopePercent,
  terrainSlopeRadians,
} from './tiles/terrainSurface.js'
export { terrainWaterMask, TerrainWaterMaskPlugin, type TerrainWaterMaskPluginOptions } from './tiles/terrainWaterMask.js'
export {
  ImageSource,
  MapStyleSource,
  QuantizedMeshSource,
  RasterDemSource,
  RasterTileSource,
  VideoSource,
  type GeoreferencedCorners,
  type ImageSourceOptions,
  type VideoSourceOptions,
  type MapStyleSourceOptions,
  type QuantizedMeshSourceOptions,
  type RasterDemSourceOptions,
  type RasterTileSourceOptions,
  type TerrainSource,
  type ImagerySource,
} from './core/sources.js'
export { ImageOverlayPlugin } from './tiles/ImageOverlayPlugin.js'
export { TilesFadePlugin } from './tiles/TilesFadePlugin.js'
export { QuantizedMeshVersionPlugin } from './tiles/QuantizedMeshVersionPlugin.js'
export { RasterDemTerrainPlugin, type RasterDemTerrainPluginOptions } from './tiles/RasterDemTerrainPlugin.js'
export { createRasterDemWorker } from './tiles/dem/DemMeshBuilder.js'
export { ImageryCompositor, type CompositeDraw, type CompositionPriority, type CompositionRenderer } from './tiles/imagery/ImageryCompositor.js'
export { ImageryStatistics, type ImageryFrameStatistics } from './tiles/imagery/ImageryStatistics.js'
export { XYZImageryOverlay, type XYZImageryOverlayOptions } from './tiles/imagery/XYZImageryOverlay.js'
export { DrapedLayerOverlay } from './tiles/imagery/DrapedLayerOverlay.js'
export { GeoreferencedImageOverlay } from './tiles/imagery/GeoreferencedImageOverlay.js'
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
export { type CameraLimits } from './core/cameraLimits.js'
export {
  createFlightPath,
  cubicBezier,
  defaultEasing,
  DEFAULT_FIT_MAXIMUM_ZOOM,
  fitBoundsOnMap,
  flightDurationSeconds,
  linearEasing,
  prefersReducedMotion,
  toViewPadding,
  type AnimationOptions,
  type FitBoundsOptions,
  type FlightPath,
  type FlyToOptions,
  type PaddingPixels,
  type ViewPadding,
} from './core/cameraAnimation.js'
export { formatViewHash, parseViewHash } from './core/viewHash.js'
export {
  CameraMotionDetector,
  EarthEventTracker,
  type EarthEventMap,
  type EarthEventType,
  type EarthFrameState,
  type EarthPointerEvent,
  type ViewSample,
} from './core/events.js'
export { isOccludedByEllipsoid, type ProjectedPosition, type ScreenPosition } from './core/projection.js'
export * from './core/zoom.js'
export { MapStyleOverlay, type MapStyleOverlayOptions } from './vector/MapStyleOverlay.js'
export { createVectorTileWorker } from './vector/MapStyleBackend.js'
export {
  MapStyle,
  type MapStyleEventMap,
  type MapStyleOptions,
  type ProtocolLoader,
  type ProtocolRequest,
  type TransformRequest,
} from './vector/MapStyle.js'
export { StyleLayer, type StyleLayerOptions } from './vector/StyleLayer.js'
export { GeoJsonSource, type GeoJsonSourceOptions } from './vector/GeoJsonSource.js'
export type { GeoJsonFeatureId, GeoJsonFeatureUpdate, GeoJsonSourceDiff } from './vector/worker/geoJsonData.js'
export { featureKey, type FeatureIdentifier } from './vector/worker/featureState.js'
export type { StyleDocument, StyleDocumentLayer } from './vector/worker/styleDocument.js'
export type { FeatureState, ResourceKind } from './vector/worker/types.js'
export type { RawImage, StyleImageInput, StyleImageOptions } from './vector/styleImageInput.js'
export type { StyleImage } from './vector/worker/types.js'

export { Draw, type DrawEventMap, type DrawFeatureInput, type DrawOptions, type DrawState, type DrawStateListener } from './Draw.js'
export { DrawMode, StaticMode, hitTolerancePixels, IDLE_STATUS, NO_FEATURE_IDS, type DrawModeContext, type DrawModeStatus } from './modes/DrawMode.js'
export {
  ELEMENT_MODES,
  GIZMO_SPACES,
  GIZMO_TOOLS,
  SelectMode,
  type ElementMode,
  type FeatureElements,
  type PickedElement,
  type GizmoBasis,
  type GizmoHandle,
  type GizmoHandleOnScreen,
  type GizmoSpace,
  type GizmoTool,
  type SelectDrag,
  type SelectModeOptions,
  type TransformKind,
} from './modes/SelectMode.js'
export {
  altitudeRangeOf,
  baseAltitudeOf,
  extrudeFeature,
  featureAxes,
  featureCenter,
  featureRotationDegrees,
  liftFeature,
  meshTopOf,
  moveMeshTop,
  offsetFeature,
  placeOnTerrain,
  rotateFeature,
  rotateFeatureAroundAxis,
  scaleFeature,
  scaleFeatureAlongAxis,
  stretchFeature,
  WORLD_AXES,
  transformFrame,
  type TransformAxis,
  type TransformFrame,
  type TransformSideHandle,
} from './transform.js'
export {
  featureMidpoints,
  featureVertices,
  hitFeature,
  insertVertex,
  moveVertex,
  moveVertices,
  removeVertex,
  translateFeature,
  type FeatureMidpoint,
  type FeatureVertex,
  type HitTestInput,
  type VertexPath,
} from './editing.js'
export { LineStringMode, PathMode, PointMode, PolygonMode, type PlacementModeOptions } from './modes/PathModes.js'
export { CircleMode, RectangleMode, SphereMode, TwoTapShapeMode, type ShapeModeOptions } from './modes/ShapeModes.js'
export {
  bearingDegrees,
  createCircle,
  createEllipse,
  createRectangle,
  createRegularPolygon,
  createSphere,
  destination,
  ellipseRing,
  type RoundShapeOptions,
  type ShapeFeature,
  type ShapeOptions,
  type SphereOptions,
} from './shapes.js'
export {
  indexMesh,
  isClosedMesh,
  isMeshFeature,
  isMeshGeometry,
  type MeshGeometry,
  meshAltitudeRange,
  meshEdges,
  meshFaces,
  meshFromIndexed,
  meshSharpEdges,
  meshTop,
  meshVolume,
  newellNormal,
  openRing,
  prismMesh,
  setMeshTop,
  sphereMesh,
  wallMesh,
  type BaseHeightOf,
  type IndexedMesh,
  type MeshFeature,
  type SphereMeshOptions,
} from './mesh.js'
export { extrudeMeshFace, meshElementFrame, meshFaceArea, meshFaceNormal, meshFaceTriangles, meshFaceVertices, moveMeshVertices, pushMeshFace } from './meshEditing.js'
export { LocalFrame, type LocalPoint } from './localFrame.js'
export { createFeatureId, FeatureStore, validateFeature, type FeatureStoreChange, type FeatureStoreListener } from './FeatureStore.js'
export { DEFAULT_DRAW_STYLE, DEFAULT_SELECTED_STYLE, resolveStyle } from './style.js'
export {
  closeRing,
  distanceMeters,
  distanceToSegment,
  EARTH_RADIUS_METERS,
  fromMercator,
  geometryBounds,
  geometryLines,
  geometryPolygons,
  geometryPositions,
  hasAltitude,
  mapGeometryPositions,
  pointInPolygon,
  storedPositions,
  toMercator,
  triangulatePolygon,
  unwrapLongitudeNear,
  unwrapPositions,
  wrapLongitude,
  type MercatorCoordinate,
} from './geometry.js'
export { DrapedFeatures } from './render/DrapedFeatures.js'
export { HeightSampler, LiveOverlay, type OverlayContent, type OverlayHandle, type OverlayLine, type OverlayPolygon } from './render/LiveOverlay.js'
export { ShapeBatch } from './render/ShapeBatch.js'
export { buildSolidGeometry, isSolidFeature, refineTriangles, SolidFeatures, type SolidGeometry } from './render/SolidFeatures.js'
export type { DrawFeature, DrawGeometry, DrawPointerEvent, DrawStyle, DrawStyleInput, DrawStyleState, GroundHeight, LongitudeLatitude } from './types.js'

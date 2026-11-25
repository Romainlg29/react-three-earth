export {
  evaluateTerrainExpression,
  interpolationFactor,
  parseTerrainExpression,
  TERRAIN_INPUTS,
  type TerrainColor,
  type TerrainExpression,
  type TerrainExpressionNode,
  type TerrainInput,
  type TerrainInputValues,
  type TerrainValueType,
} from './expression.js'
export { compileTerrainColor, compileTerrainNumber } from './compile.js'
export { TERRAIN_STYLE_PRESETS, type TerrainStylePreset } from './presets.js'
export { TerrainStyle, type TerrainStyleOptions } from './TerrainStyle.js'

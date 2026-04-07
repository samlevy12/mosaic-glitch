import { bilateralFilter, slicSuperpixels } from './slic'
import { mergeRegions } from './merge'
import { Region, RenderMode } from './types'
import { seededRandom } from './prng'
import { getGPUSlic } from './gpu-slic'

const INK_COLOR_DEFAULT = { r: 31, g: 8, b: 18 }
const BACKGROUND_COLOR = { r: 255, g: 249, b: 245 }
const ERROR_COLOR = { r: 228, g: 149, b: 158 }

/** Parse a hex color string like '#ff0000' or '#f00' into {r, g, b} */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '')
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    }
  }
  return {
    r: parseInt(clean.substring(0, 2), 16) || 0,
    g: parseInt(clean.substring(2, 4), 16) || 0,
    b: parseInt(clean.substring(4, 6), 16) || 0,
  }
}

function relabelContiguous(labelMap: Uint32Array): { relabeled: Uint32Array; count: number } {
  const uniqueLabels = new Set(labelMap)
  const oldToNew = new Map<number, number>()
  let newLabel = 0
  
  for (const oldLabel of Array.from(uniqueLabels).sort((a, b) => a - b)) {
    oldToNew.set(oldLabel, newLabel++)
  }
  
  const relabeled = new Uint32Array(labelMap.length)
  for (let i = 0; i < labelMap.length; i++) {
    relabeled[i] = oldToNew.get(labelMap[i])!
  }
  
  return { relabeled, count: newLabel }
}

function hashLabelToColor(label: number): { r: number; g: number; b: number } {
  let hash = label * 2654435761
  hash = ((hash >> 16) ^ hash) * 0x45d9f3b
  hash = ((hash >> 16) ^ hash) * 0x45d9f3b
  hash = (hash >> 16) ^ hash
  
  const r = (hash & 0xFF)
  const g = ((hash >> 8) & 0xFF)
  const b = ((hash >> 16) & 0xFF)
  
  return { r, g, b }
}

export function extractRegions(labelMap: Uint32Array, width: number, height: number): Region[] {
  const regionData = new Map<number, {
    sumX: number
    sumY: number
    count: number
    minX: number
    maxX: number
    minY: number
    maxY: number
  }>()

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const label = labelMap[idx]

      if (!regionData.has(label)) {
        regionData.set(label, {
          sumX: 0,
          sumY: 0,
          count: 0,
          minX: width,
          maxX: 0,
          minY: height,
          maxY: 0
        })
      }

      const data = regionData.get(label)!
      data.sumX += x
      data.sumY += y
      data.count++
      data.minX = Math.min(data.minX, x)
      data.maxX = Math.max(data.maxX, x)
      data.minY = Math.min(data.minY, y)
      data.maxY = Math.max(data.maxY, y)
    }
  }

  const regions: Region[] = []
  for (const [id, data] of regionData.entries()) {
    regions.push({
      id,
      centroid: {
        x: data.sumX / data.count,
        y: data.sumY / data.count
      },
      area: data.count,
      bbox: {
        x: data.minX,
        y: data.minY,
        w: data.maxX - data.minX + 1,
        h: data.maxY - data.minY + 1
      },
      trackId: -1
    })
  }

  return regions
}

export function createInkMask(
  labelMap: Uint32Array,
  width: number,
  height: number,
  thickness: number
): Uint8Array {
  const mask = new Uint8Array(width * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const label = labelMap[idx]

      let isBoundary = false
      
      if (x + 1 < width && labelMap[idx + 1] !== label) isBoundary = true
      else if (x > 0 && labelMap[idx - 1] !== label) isBoundary = true
      else if (y + 1 < height && labelMap[idx + width] !== label) isBoundary = true
      else if (y > 0 && labelMap[idx - width] !== label) isBoundary = true
      
      if (isBoundary) mask[idx] = 1
    }
  }

  if (thickness > 1) {
    const dilated = new Uint8Array(mask)
    const halfThickness = Math.floor(thickness / 2)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        if (mask[idx] === 1) {
          for (let dy = -halfThickness; dy <= halfThickness; dy++) {
            for (let dx = -halfThickness; dx <= halfThickness; dx++) {
              const nx = x + dx
              const ny = y + dy
              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                const nidx = ny * width + nx
                dilated[nidx] = 1
              }
            }
          }
        }
      }
    }
    return dilated
  }

  return mask
}

/** Result of processFrame — can be cached for temporal stride reuse. */
export interface ProcessFrameResult {
  regions: Region[]
  inkMask: Uint8Array
  labelMap: Uint32Array
  slicCount: number
  mergedCount: number
}

/**
 * Compute adaptive segment count based on local contrast / edge density.
 * High-contrast frames (faces, text, detailed textures) get MORE segments.
 * Flat frames keep the base count — never reduce below 1.0× because a mosaic
 * needs visible tiles everywhere, even on uniform backgrounds.
 *
 * Returns a multiplier in [1.0, 1.6] applied to the base segment count.
 */
function computeAdaptiveDensityMultiplier(
  imageData: Uint8ClampedArray,
  width: number,
  height: number
): number {
  // Sample a grid of pixels and compute gradient magnitude (Sobel-like)
  const step = Math.max(1, Math.floor(Math.min(width, height) / 80))
  let gradientSum = 0
  let sampleCount = 0

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const idxL = (y * width + (x - step)) * 4
      const idxR = (y * width + (x + step)) * 4
      const idxU = ((y - step) * width + x) * 4
      const idxD = ((y + step) * width + x) * 4

      const lL = 0.299 * imageData[idxL] + 0.587 * imageData[idxL + 1] + 0.114 * imageData[idxL + 2]
      const lR = 0.299 * imageData[idxR] + 0.587 * imageData[idxR + 1] + 0.114 * imageData[idxR + 2]
      const lU = 0.299 * imageData[idxU] + 0.587 * imageData[idxU + 1] + 0.114 * imageData[idxU + 2]
      const lD = 0.299 * imageData[idxD] + 0.587 * imageData[idxD + 1] + 0.114 * imageData[idxD + 2]

      const gx = Math.abs(lR - lL)
      const gy = Math.abs(lD - lU)
      gradientSum += Math.sqrt(gx * gx + gy * gy)
      sampleCount++
    }
  }

  if (sampleCount === 0) return 1.0

  const meanGradient = gradientSum / sampleCount
  // Typical range: ~2 (very flat) to ~40+ (highly detailed)
  // Only BOOST for detailed content, never reduce below base count
  const normalized = Math.min(1, meanGradient / 30) // 0→1
  return 1.0 + normalized * 0.6 // 1.0→1.6
}

/**
 * Detect skin-tone regions in the frame to boost SLIC density around faces.
 * Returns a per-pixel boost map: 1.0 = normal, 2.0 = double density (face area).
 * Uses a fast HSL-based skin detection heuristic.
 */
function computeFaceDensityBoost(
  imageData: Uint8ClampedArray,
  width: number,
  height: number
): { hasFace: boolean; faceAreaFraction: number } {
  // Sample every 4th pixel for speed
  const step = 4
  let skinPixels = 0
  let totalSampled = 0

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4
      const r = imageData[idx]
      const g = imageData[idx + 1]
      const b = imageData[idx + 2]

      // Skin detection heuristic (works across skin tones):
      // R > 60, G > 40, B > 20
      // R > G > B (warm bias)
      // |R-G| > 15 (not grey)
      // R - B > 15
      if (r > 60 && g > 40 && b > 20 &&
          r > g && g > b &&
          Math.abs(r - g) > 15 &&
          r - b > 15) {
        skinPixels++
      }
      totalSampled++
    }
  }

  const fraction = totalSampled > 0 ? skinPixels / totalSampled : 0
  // If >3% of frame is skin-colored, consider face present
  return { hasFace: fraction > 0.03, faceAreaFraction: fraction }
}

export async function processFrame(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  density: 'coarse' | 'medium' | 'fine',
  compactness: number,
  chunkiness: number,
  inkThickness: number
): Promise<ProcessFrameResult> {
  // Base segment counts are calibrated for 1080p. At 540p (scale ~0.19),
  // medium produces ~2300 pre-merge segments — enough for a visible mosaic.
  const densityMap = {
    coarse: 4000,
    medium: 12000,
    fine: 24000
  }

  const baseSegments = densityMap[density]
  const scaleFactor = (width * height) / (1920 * 1080)
  const adaptiveMultiplier = computeAdaptiveDensityMultiplier(imageData, width, height)

  // Face-aware density boost: always active — increase segments near skin tones
  // so face regions get finer tile detail (default behavior, no opt-out)
  const { faceAreaFraction } = computeFaceDensityBoost(imageData, width, height)
  // Always apply a minimum 1.7× boost + up to 0.3× more based on face area
  const faceBoost = 1.7 + Math.min(0.3, faceAreaFraction * 3)

  const targetSegments = Math.floor(baseSegments * scaleFactor * adaptiveMultiplier * faceBoost)
  const numSegments = Math.max(500, Math.min(30000, targetSegments))

  const yield_ = () => new Promise<void>(resolve => setTimeout(resolve, 0))

  // Try GPU SLIC first (5-10× faster), fall back to CPU
  let labelMap: Uint32Array
  const gpu = getGPUSlic()

  if (gpu) {
    try {
      labelMap = await gpu.run(imageData, width, height, numSegments, compactness)
    } catch (err) {
      console.warn('[processFrame] GPU SLIC failed, falling back to CPU:', (err as Error).message)
      const filtered = bilateralFilter(imageData, width, height)
      await yield_()
      labelMap = slicSuperpixels(filtered, width, height, numSegments, compactness)
    }
  } else {
    const filtered = bilateralFilter(imageData, width, height)
    await yield_()
    labelMap = slicSuperpixels(filtered, width, height, numSegments, compactness)
  }
  await yield_()

  const slicUniqueLabels = new Set(labelMap)
  const slicCount = slicUniqueLabels.size

  if (slicCount < 50 || slicCount > 50000) {
    throw new Error(`SLIC failed: ${slicCount} segments (expected 50-50000). Try different density/compactness.`)
  }

  // Compute per-SLIC-label skin fraction so merge can protect face detail
  const labelSkinFrac = new Map<number, number>()
  {
    const skinCounts = new Map<number, number>()
    const totalCounts = new Map<number, number>()
    const step = 2 // sample every 2nd pixel for speed
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = y * width + x
        const lbl = labelMap[i]
        totalCounts.set(lbl, (totalCounts.get(lbl) ?? 0) + 1)
        const p = i * 4
        const r = imageData[p], g = imageData[p + 1], b = imageData[p + 2]
        if (r > 60 && g > 40 && b > 20 && r > g && g > b &&
            Math.abs(r - g) > 15 && r - b > 15) {
          skinCounts.set(lbl, (skinCounts.get(lbl) ?? 0) + 1)
        }
      }
    }
    for (const [lbl, total] of totalCounts) {
      labelSkinFrac.set(lbl, (skinCounts.get(lbl) ?? 0) / total)
    }
  }

  const mergedMap = mergeRegions(labelMap, imageData, width, height, chunkiness, labelSkinFrac)
  await yield_()

  const { relabeled, count: mergedCount } = relabelContiguous(mergedMap)

  if (mergedCount < 10) {
    console.warn(`Warning: Only ${mergedCount} merged regions. Chunkiness may be too high.`)
  }

  const regions = extractRegions(relabeled, width, height)
  const inkMask = createInkMask(relabeled, width, height, inkThickness)
  await yield_()

  return { regions, inkMask, labelMap: relabeled, slicCount, mergedCount }
}

export type DiagnosticMode = 'regionsSolid' | 'inkOnly' | 'assignmentMap' | undefined

export interface RegionTrackerInterface {
  getAssignment(trackId: number): { imageIndex: number; rect?: { x: number; y: number; w: number; h: number } } | null
  setAssignment(trackId: number, assignment: { imageIndex: number; rect?: { x: number; y: number; w: number; h: number } }): void
}

export interface CachedImage {
  width: number
  height: number
  data: Uint8ClampedArray
  /** Mean luminance 0-255 (0.299R + 0.587G + 0.114B), used for brightness-matched tile selection */
  meanL: number
  /** Color temperature: >0 = warm (red/orange/yellow), <0 = cool (blue/green/purple), 0 = neutral */
  colorTemp?: number
}

/**
 * Compute color temperature of an RGBA pixel buffer.
 * Returns a value in roughly [-1, 1]: positive = warm, negative = cool, 0 = neutral.
 * Based on (R - B) normalized by luminance — warm images have R >> B, cool have B >> R.
 */
export function computeColorTemp(data: Uint8ClampedArray): number {
  let rSum = 0, bSum = 0
  const n = data.length / 4
  for (let i = 0; i < n; i++) {
    const p = i * 4
    rSum += data[p]
    bSum += data[p + 2]
  }
  if (n === 0) return 0
  const meanR = rSum / n
  const meanB = bSum / n
  // Normalize to [-1, 1] range. Difference of 80+ is strongly warm/cool.
  return Math.max(-1, Math.min(1, (meanR - meanB) / 80))
}

/** Compute mean luminance of an RGBA pixel buffer (0-255). */
export function computeMeanL(data: Uint8ClampedArray): number {
  let sum = 0
  const n = data.length / 4
  for (let i = 0; i < n; i++) {
    const p = i * 4
    sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }
  return n > 0 ? sum / n : 128
}

export function renderFrame(
  labelMap: Uint32Array,
  inkMask: Uint8Array,
  regions: Region[],
  width: number,
  height: number,
  mode: RenderMode,
  imageCache: CachedImage[],
  seed: number,
  planesK: number,
  diagnosticMode?: DiagnosticMode,
  tracker?: RegionTrackerInterface,
  /** Source video frame pixels — enables brightness-matched tile selection */
  sourceData?: Uint8ClampedArray,
  /** Optional neutral tile pool — used for background regions when neutralBackground is enabled */
  neutralCache?: CachedImage[],
  /** Which neutral background mode */
  neutralMode?: 'off' | 'skin' | 'skin-reverse' | 'luminance' | 'size',
  /** Line color between tiles (hex string like '#000000') */
  inkColor?: string,
  /** Character contrast: 0-1. Splits tile pool so skin regions use different tiles than background. */
  characterContrast?: number,
): ImageData {
  const output = new ImageData(width, height)
  const data = output.data
  const INK_COLOR = inkColor ? parseHexColor(inkColor) : INK_COLOR_DEFAULT

  if (diagnosticMode === 'inkOnly') {
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4
      if (inkMask[i] === 1) {
        data[idx] = INK_COLOR.r
        data[idx + 1] = INK_COLOR.g
        data[idx + 2] = INK_COLOR.b
      } else {
        data[idx] = BACKGROUND_COLOR.r
        data[idx + 1] = BACKGROUND_COLOR.g
        data[idx + 2] = BACKGROUND_COLOR.b
      }
      data[idx + 3] = 255
    }
    return output
  }

  if (diagnosticMode === 'regionsSolid') {
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4
      const label = labelMap[i]
      const color = hashLabelToColor(label)
      data[idx] = color.r
      data[idx + 1] = color.g
      data[idx + 2] = color.b
      data[idx + 3] = 255
    }
    return output
  }

  const maxLabel = regions.length > 0 ? Math.max(...regions.map(r => r.id)) : 0
  const labelToRegionIndex = new Int32Array(maxLabel + 1).fill(-1)
  for (let i = 0; i < regions.length; i++) {
    labelToRegionIndex[regions[i].id] = i
  }

  // ── Luminance × Color Temperature tile selection ──────────────────────────
  // Two-dimensional matching:
  //   Dimension 1: Luminance band (5 bands: very dark → very light)
  //   Dimension 2: Color temperature (warm vs cool)
  //
  // Each luminance band is split into warm/cool sub-pools.
  // Source region's brightness + color temp → matching sub-pool → random pick.
  // This makes skin (warm+light) get warm tiles, shadows (cool+dark) get cool tiles.

  const NUM_BANDS = 10
  const BAND_WIDTH = 256 / NUM_BANDS

  type TileEntry = { i: number; L: number; temp: number }

  // Classify each tile by luminance band and warm/cool
  const warmBands: Array<TileEntry[]> = Array.from({ length: NUM_BANDS }, () => [])
  const coolBands: Array<TileEntry[]> = Array.from({ length: NUM_BANDS }, () => [])
  const allBands: Array<TileEntry[]> = Array.from({ length: NUM_BANDS }, () => [])

  for (let i = 0; i < imageCache.length; i++) {
    const img = imageCache[i]
    const L = img.meanL ?? 128
    const temp = img.colorTemp ?? 0
    const band = Math.min(NUM_BANDS - 1, Math.floor(L / BAND_WIDTH))
    const entry: TileEntry = { i, L, temp }

    allBands[band].push(entry)
    if (temp > 0.05) {
      warmBands[band].push(entry)
    } else if (temp < -0.05) {
      coolBands[band].push(entry)
    } else {
      // Neutral — goes in both pools so neither runs dry
      warmBands[band].push(entry)
      coolBands[band].push(entry)
    }
  }

  // ── Character/Background pool split ──────────────────────────────────────
  // When characterContrast > 0, split each luminance band into two disjoint subsets.
  // Character (skin) regions pick from subset A, background from subset B.
  // At contrast=1, the subsets are fully disjoint (even/odd index).
  // At contrast=0.5, there's 50% overlap. At 0, they're identical (no effect).
  const contrast = characterContrast ?? 0
  const useContrast = contrast > 0 && imageCache.length >= 4

  // Build character (A) and background (B) bands by filtering allBands
  const charBands: Array<TileEntry[]> = Array.from({ length: NUM_BANDS }, () => [])
  const bgBands: Array<TileEntry[]> = Array.from({ length: NUM_BANDS }, () => [])

  if (useContrast) {
    // Sort tiles within each band by color temperature so the split is visually meaningful
    // (characters get warmer tiles, background gets cooler tiles)
    for (let b = 0; b < NUM_BANDS; b++) {
      const sorted = [...allBands[b]].sort((a, c) => c.temp - a.temp) // warm first
      const splitPoint = Math.max(1, Math.round(sorted.length * 0.5))

      // Primary split: warm half for characters, cool half for background
      const warmHalf = sorted.slice(0, splitPoint)
      const coolHalf = sorted.slice(splitPoint)

      // Blend based on contrast: at contrast=1, fully disjoint. At 0.5, 50% overlap.
      const overlapCount = Math.round(Math.min(warmHalf.length, coolHalf.length) * (1 - contrast))

      charBands[b] = [...warmHalf]
      bgBands[b] = [...coolHalf]

      // Add overlap tiles from the other half
      if (overlapCount > 0) {
        charBands[b].push(...coolHalf.slice(0, overlapCount))
        bgBands[b].push(...warmHalf.slice(warmHalf.length - overlapCount))
      }
    }
  }

  // Fallback: find nearest non-empty band
  function findFallbackBand(bands: Array<TileEntry[]>, target: number): number {
    if (bands[target].length > 0) return target
    for (let d = 1; d < NUM_BANDS; d++) {
      if (target - d >= 0 && bands[target - d].length > 0) return target - d
      if (target + d < NUM_BANDS && bands[target + d].length > 0) return target + d
    }
    return target
  }

  // ── Neutral tile pools (for neutral background modes) ───────────────────
  const useNeutral = neutralMode && neutralMode !== 'off' && neutralCache && neutralCache.length > 0
  const neutralBands: Array<TileEntry[]> = Array.from({ length: NUM_BANDS }, () => [])
  if (useNeutral) {
    for (let i = 0; i < neutralCache.length; i++) {
      const img = neutralCache[i]
      const L = img.meanL ?? 128
      const band = Math.min(NUM_BANDS - 1, Math.floor(L / BAND_WIDTH))
      neutralBands[band].push({ i, L, temp: img.colorTemp ?? 0 })
    }
  }

  // Precompute per-region: mean luminance, color temperature, skin fraction, saturation
  let regionMeanL: Float32Array | null = null
  let regionTemp: Float32Array | null = null
  let regionSkinFrac: Float32Array | null = null
  let regionSaturation: Float32Array | null = null

  if (sourceData && sourceData.length === width * height * 4) {
    const len = maxLabel + 2
    regionMeanL = new Float32Array(len).fill(-1)
    regionTemp = new Float32Array(len)
    regionSkinFrac = new Float32Array(len)
    regionSaturation = new Float32Array(len)
    const lumSums = new Float32Array(len)
    const rSums = new Float32Array(len)
    const gSums = new Float32Array(len)
    const bSums = new Float32Array(len)
    const skinCounts = new Int32Array(len)
    const satSums = new Float32Array(len)
    const counts = new Int32Array(len)

    for (let i = 0; i < width * height; i++) {
      const lbl = labelMap[i]
      if (lbl < len) {
        const p = i * 4
        const r = sourceData[p], g = sourceData[p + 1], b = sourceData[p + 2]
        lumSums[lbl] += 0.299 * r + 0.587 * g + 0.114 * b
        rSums[lbl] += r
        gSums[lbl] += g
        bSums[lbl] += b
        counts[lbl]++

        // Skin detection (same heuristic as computeFaceDensityBoost)
        if (r > 60 && g > 40 && b > 20 && r > g && g > b &&
            Math.abs(r - g) > 15 && r - b > 15) {
          skinCounts[lbl]++
        }

        // Simple saturation: (max - min) / max
        const mx = Math.max(r, g, b)
        const mn = Math.min(r, g, b)
        satSums[lbl] += mx > 0 ? ((mx - mn) / mx) * 100 : 0
      }
    }
    for (let l = 0; l < len; l++) {
      if (counts[l] > 0) {
        regionMeanL[l] = lumSums[l] / counts[l]
        regionTemp[l] = Math.max(-1, Math.min(1, ((rSums[l] / counts[l]) - (bSums[l] / counts[l])) / 80))
        regionSkinFrac[l] = skinCounts[l] / counts[l]
        regionSaturation[l] = satSums[l] / counts[l]
      }
    }
  }

  /** Should this region use neutral tiles instead of emotion-matched? */
  // For size-based split: compute median region area to set threshold
  let sizeThreshold = 0
  if (neutralMode === 'size' && regions.length > 0) {
    const areas = regions.map(r => r.area).sort((a, b) => a - b)
    const median = areas[Math.floor(areas.length / 2)]
    // Regions below median size are "detail" → neutral
    sizeThreshold = median
  }

  /** Should this region use neutral tiles instead of emotion-matched? */
  function isNeutralRegion(regionId: number): boolean {
    if (!useNeutral || !regionMeanL || regionMeanL[regionId] < 0) return false

    if (neutralMode === 'skin') {
      // Non-skin regions → neutral. A region with >15% skin pixels is "face".
      const skinFrac = regionSkinFrac ? regionSkinFrac[regionId] : 0
      return skinFrac < 0.15
    }

    if (neutralMode === 'skin-reverse') {
      // Reverse: skin/face regions → neutral, background → emotional
      const skinFrac = regionSkinFrac ? regionSkinFrac[regionId] : 0
      return skinFrac >= 0.15
    }

    if (neutralMode === 'luminance') {
      // Dark (L < 60) or desaturated (sat < 15%) → neutral
      const L = regionMeanL[regionId]
      const sat = regionSaturation ? regionSaturation[regionId] : 50
      return L < 60 || sat < 15
    }

    if (neutralMode === 'size') {
      // Small regions (fine detail: faces, edges, hair) → neutral for readability
      // Large regions (flat areas: walls, sky, background) → emotional for color
      const regionIdx = labelToRegionIndex[regionId]
      if (regionIdx >= 0 && regionIdx < regions.length) {
        return regions[regionIdx].area < sizeThreshold
      }
    }

    return false
  }

  function pickTileIndex(regionId: number, trackId: number, fromNeutral: boolean, isCharacter?: boolean): number {
    const seedVal = trackId >= 0 ? trackId : regionId
    const rng = seededRandom(seed, seedVal)

    // If using neutral pool, pick from neutral bands by luminance
    if (fromNeutral && neutralCache && neutralCache.length > 0) {
      if (regionMeanL && regionMeanL[regionId] >= 0) {
        const L = regionMeanL[regionId]
        const rawBand = Math.min(NUM_BANDS - 1, Math.floor(L / BAND_WIDTH))
        const band = findFallbackBand(neutralBands, rawBand)
        if (neutralBands[band].length > 0) {
          // Return negative index to signal "use neutralCache" — we encode it as -(idx+1)
          return -(neutralBands[band][Math.floor(rng() * neutralBands[band].length)].i + 1)
        }
      }
      // Fallback: random neutral tile
      return -(Math.floor(rng() * neutralCache.length) + 1)
    }

    // Normal emotion-matched selection
    if (regionMeanL && regionMeanL[regionId] >= 0) {
      const L = regionMeanL[regionId]
      const temp = regionTemp ? regionTemp[regionId] : 0
      const rawBand = Math.min(NUM_BANDS - 1, Math.floor(L / BAND_WIDTH))

      // If character contrast is active, use the split pools instead of warm/cool
      if (useContrast && isCharacter !== undefined) {
        const contrastBands = isCharacter ? charBands : bgBands
        const band = findFallbackBand(contrastBands, rawBand)
        if (contrastBands[band].length > 0) {
          return contrastBands[band][Math.floor(rng() * contrastBands[band].length)].i
        }
        // Fallback to allBands if contrast pool is empty
      }

      let pool: TileEntry[]
      if (temp > 0.1) {
        const band = findFallbackBand(warmBands, rawBand)
        pool = warmBands[band]
      } else if (temp < -0.1) {
        const band = findFallbackBand(coolBands, rawBand)
        pool = coolBands[band]
      } else {
        const band = findFallbackBand(allBands, rawBand)
        pool = allBands[band]
      }

      if (pool.length > 0) {
        return pool[Math.floor(rng() * pool.length)].i
      }

      const fallBand = findFallbackBand(allBands, rawBand)
      if (allBands[fallBand].length > 0) {
        return allBands[fallBand][Math.floor(rng() * allBands[fallBand].length)].i
      }
    }

    if (imageCache.length === 0) return 0
    return Math.floor(rng() * imageCache.length)
  }

  // Negative index = neutral cache, positive = emotion cache
  const regionAssignments = new Array<{ imgIdx: number; isNeutral: boolean }>(regions.length)

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]
    let imgIdx: number
    const wantNeutral = isNeutralRegion(region.id)

    // Determine if this region is a "character" (skin) for contrast splitting
    const isChar = useContrast && regionSkinFrac
      ? regionSkinFrac[region.id] >= 0.15
      : undefined

    if (wantNeutral) {
      // Neutral background region — always pick from neutral cache
      const raw = pickTileIndex(region.id, region.trackId, true, isChar)
      // Decode: negative means neutral cache index
      imgIdx = raw < 0 ? -(raw + 1) : raw
      regionAssignments[i] = { imgIdx, isNeutral: true }
    } else if (tracker) {
      const existingAssignment = tracker.getAssignment(region.trackId)
      if (
        existingAssignment &&
        existingAssignment.imageIndex >= 0 &&
        existingAssignment.imageIndex < imageCache.length
      ) {
        imgIdx = existingAssignment.imageIndex
      } else {
        imgIdx = pickTileIndex(region.id, region.trackId, false, isChar)
        tracker.setAssignment(region.trackId, { imageIndex: imgIdx })
      }
      regionAssignments[i] = { imgIdx, isNeutral: false }
    } else {
      imgIdx = pickTileIndex(region.id, region.trackId, false, isChar)
      regionAssignments[i] = { imgIdx, isNeutral: false }
    }
  }

  if (diagnosticMode === 'assignmentMap') {
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4
      const label = labelMap[i]
      const regionIdx = labelToRegionIndex[label]
      
      if (regionIdx >= 0 && regionIdx < regionAssignments.length) {
        const assignment = regionAssignments[regionIdx]
        if (assignment.imgIdx >= 0 && assignment.imgIdx < imageCache.length) {
          const color = hashLabelToColor(assignment.imgIdx)
          data[idx] = color.r
          data[idx + 1] = color.g
          data[idx + 2] = color.b
        } else {
          data[idx] = ERROR_COLOR.r
          data[idx + 1] = ERROR_COLOR.g
          data[idx + 2] = ERROR_COLOR.b
        }
      } else {
        data[idx] = ERROR_COLOR.r
        data[idx + 1] = ERROR_COLOR.g
        data[idx + 2] = ERROR_COLOR.b
      }
      data[idx + 3] = 255
    }
    return output
  }

  if (imageCache.length === 0) {
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4
      data[idx] = ERROR_COLOR.r
      data[idx + 1] = ERROR_COLOR.g
      data[idx + 2] = ERROR_COLOR.b
      data[idx + 3] = 255
    }
    return output
  }

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4

    if (inkMask[i] === 1) {
      data[idx] = INK_COLOR.r
      data[idx + 1] = INK_COLOR.g
      data[idx + 2] = INK_COLOR.b
      data[idx + 3] = 255
      continue
    }

    const label = labelMap[i]
    const regionIdx = labelToRegionIndex[label]

    if (regionIdx < 0 || regionIdx >= regionAssignments.length) {
      data[idx] = ERROR_COLOR.r
      data[idx + 1] = ERROR_COLOR.g
      data[idx + 2] = ERROR_COLOR.b
      data[idx + 3] = 255
      continue
    }

    const region = regions[regionIdx]
    const assignment = regionAssignments[regionIdx]

    // Pick from the right cache (neutral or emotion)
    const activeCache = assignment.isNeutral && neutralCache ? neutralCache : imageCache

    if (assignment.imgIdx < 0 || assignment.imgIdx >= activeCache.length) {
      data[idx] = ERROR_COLOR.r
      data[idx + 1] = ERROR_COLOR.g
      data[idx + 2] = ERROR_COLOR.b
      data[idx + 3] = 255
      continue
    }

    const imgData = activeCache[assignment.imgIdx]
    const x = i % width
    const y = Math.floor(i / width)

    if (mode === 'sticker') {
      // Adaptive tile sampling: two strategies based on region size.
      //
      // LARGE regions (bbox > 40px on shortest side): scale-to-fit the full
      // tile image into the region (aspect-fill). The tile is recognizable.
      //
      // SMALL regions (bbox < 40px): the full image squeezed into <40px is
      // unreadable noise. Instead, center-crop: sample only the middle portion
      // of the tile at a coarser scale, so you see a recognizable detail
      // (a face, a petal, a texture) rather than the entire image shrunk to mud.
      const bbox = region.bbox
      const regionW = Math.max(1, bbox.w)
      const regionH = Math.max(1, bbox.h)
      const localX = x - bbox.x
      const localY = y - bbox.y

      const minDim = Math.min(regionW, regionH)
      const SMALL_THRESHOLD = 40

      let sx: number, sy: number

      if (minDim >= SMALL_THRESHOLD) {
        // Large region: scale-to-fit the full tile (aspect-fill)
        const scaleX = imgData.width / regionW
        const scaleY = imgData.height / regionH
        const scale = Math.max(scaleX, scaleY)
        const fitW = regionW * scale
        const fitH = regionH * scale
        const offsetX = (fitW - imgData.width) / 2
        const offsetY = (fitH - imgData.height) / 2
        sx = Math.floor(localX * scale - offsetX)
        sy = Math.floor(localY * scale - offsetY)
      } else {
        // Small region: center-crop the tile at a readable scale.
        // Instead of fitting the whole 2000px image into 20px (100:1 ratio),
        // show only the center 20-40% of the tile, so details are visible.
        // The crop fraction scales with region size: tiny regions show less,
        // medium-small regions show more.
        const cropFrac = 0.15 + 0.25 * (minDim / SMALL_THRESHOLD) // 0.15 to 0.40
        const cropW = Math.floor(imgData.width * cropFrac)
        const cropH = Math.floor(imgData.height * cropFrac)
        const cropX0 = Math.floor((imgData.width - cropW) / 2)
        const cropY0 = Math.floor((imgData.height - cropH) / 2)

        // Map region pixel → crop pixel (aspect-fill within the crop)
        const scaleX = cropW / regionW
        const scaleY = cropH / regionH
        const scale = Math.max(scaleX, scaleY)
        const fitW = regionW * scale
        const fitH = regionH * scale
        const offsetX = (fitW - cropW) / 2
        const offsetY = (fitH - cropH) / 2
        sx = cropX0 + Math.floor(localX * scale - offsetX)
        sy = cropY0 + Math.floor(localY * scale - offsetY)
      }

      // Clamp to image bounds
      sx = Math.max(0, Math.min(imgData.width - 1, sx))
      sy = Math.max(0, Math.min(imgData.height - 1, sy))
      const sampleIdx = (sy * imgData.width + sx) * 4

      data[idx] = imgData.data[sampleIdx]
      data[idx + 1] = imgData.data[sampleIdx + 1]
      data[idx + 2] = imgData.data[sampleIdx + 2]
      data[idx + 3] = 255
    } else if (mode === 'wrap' || mode === 'planes') {
      // Wrap mode also scales to fit region bbox for consistency
      const bbox = region.bbox
      const regionW = Math.max(1, bbox.w)
      const regionH = Math.max(1, bbox.h)
      const localX = x - bbox.x
      const localY = y - bbox.y

      const sampleX = Math.floor((localX / regionW) * imgData.width) % imgData.width
      const sampleY = Math.floor((localY / regionH) * imgData.height) % imgData.height
      const sx = Math.max(0, Math.min(imgData.width - 1, (sampleX + imgData.width) % imgData.width))
      const sy = Math.max(0, Math.min(imgData.height - 1, (sampleY + imgData.height) % imgData.height))
      const sampleIdx = (sy * imgData.width + sx) * 4

      data[idx] = imgData.data[sampleIdx]
      data[idx + 1] = imgData.data[sampleIdx + 1]
      data[idx + 2] = imgData.data[sampleIdx + 2]
      data[idx + 3] = 255
    } else {
      data[idx] = ERROR_COLOR.r
      data[idx + 1] = ERROR_COLOR.g
      data[idx + 2] = ERROR_COLOR.b
      data[idx + 3] = 255
    }
  }

  return output
}

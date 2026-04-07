/**
 * image-color-analyzer.ts
 * Analyzes uploaded images, computes dominant hue/saturation,
 * and assigns each image to an emotion bucket.
 *
 * Base from Ollama (deepseek-coder-v2:16b), corrected.
 */

import type { ImageAsset } from './types'
import type { Emotion } from './emotion-color-mapping'
import { rgbToHsl, getEmotionFromColor, EMOTION_COLOR_MAPPINGS } from './emotion-color-mapping'
import { v4 as uuidv4 } from 'uuid'
import type { EmotionSection } from './emotion-timeline'
import type { CachedImage } from './renderer'
import { computeMeanL, computeColorTemp } from './renderer'

export interface EmotionBuckets {
  [emotion: string]: ImageAsset[]
}

/**
 * Check if file is actually available (not just listed in iCloud)
 * iCloud files might exist in file system but not be downloaded yet
 */
async function isFileAvailable(file: File, timeoutMs = 10000): Promise<boolean> {
  try {
    // Check file size first (quick check)
    if (file.size === 0) {
      console.warn(`[isFileAvailable] ${file.name}: size is 0`)
      return false
    }

    // Try to read first few KB with timeout to verify it's actually accessible
    const chunkSize = Math.min(4096, file.size)
    const chunk = await Promise.race([
      file.slice(0, chunkSize).arrayBuffer(),
      new Promise<ArrayBuffer>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout reading chunk')), timeoutMs)
      )
    ])

    const available = chunk.byteLength > 0
    if (!available) {
      console.warn(`[isFileAvailable] ${file.name}: chunk is empty`)
    }
    return available
  } catch (err) {
    console.warn(`[isFileAvailable] ${file.name}: ${(err as Error).message}`)
    return false
  }
}

/**
 * Analyzes a single image's dominant color and maps it to an emotion
 *
 * Process:
 * 1. Verify file is accessible (not just in iCloud listing)
 * 2. Downsample image to 50×50 for speed
 * 3. Calculate average RGB across all pixels (dominant color)
 * 4. Convert RGB to HSL color space (hue determines color, saturation = intensity)
 * 5. Match HSL to emotion based on hue range + saturation threshold
 *
 * Example: A bright yellow image → hue ~55° → Happy emotion
 *          A deep blue image → hue ~220° → Sad emotion
 */
export async function analyzeImage(file: File): Promise<ImageAsset> {
  try {
    // Check if file is actually available (not pending iCloud download)
    const available = await isFileAvailable(file, 15000) // 15s timeout for availability check
    if (!available) {
      throw new Error(`File not yet available — may still be downloading from iCloud`)
    }

    // Create bitmap with 120-second timeout (prevents hanging on corrupt/huge images)
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const bitmapPromise = createImageBitmap(file)
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('Image bitmap creation timeout — file may be corrupted or too large'))
      }, 120000)
    })

    let bitmap: ImageBitmap
    try {
      bitmap = await Promise.race([bitmapPromise, timeoutPromise])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }

    const canvas = document.createElement('canvas')
    canvas.width = 50
    canvas.height = 50
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap as any, 0, 0, 50, 50)

    // Extract dominant color by averaging all pixels
    const imageData = ctx.getImageData(0, 0, 50, 50)
    let rSum = 0, gSum = 0, bSum = 0
    for (let i = 0; i < imageData.data.length; i += 4) {
      rSum += imageData.data[i]
      gSum += imageData.data[i + 1]
      bSum += imageData.data[i + 2]
    }
    const pixels = 50 * 50
    const avgR = Math.round(rSum / pixels)
    const avgG = Math.round(gSum / pixels)
    const avgB = Math.round(bSum / pixels)

    // Convert to HSL and map to emotion
    const [h, s, l] = rgbToHsl(avgR, avgG, avgB)
    const emotion = getEmotionFromColor(h, s, l)

    return { id: uuidv4(), file, bitmap: bitmap as any, dominantHue: h, dominantSat: s, emotion }
  } catch (error) {
    const errorMsg = (error as Error).message
    const timestamp = new Date().toLocaleTimeString()
    if (errorMsg.includes('iCloud') || errorMsg.includes('not yet available')) {
      console.warn(`[${timestamp}] ⚠️  iCloud sync issue - ${file.name}: ${errorMsg} → using neutral fallback`)
    } else if (errorMsg.includes('timeout')) {
      console.warn(`[${timestamp}] ⏱️  Timeout - ${file.name}: File took too long to download → using neutral fallback`)
    } else if (errorMsg.includes('bitmap')) {
      console.warn(`[${timestamp}] 🖼️  Bitmap error - ${file.name}: ${errorMsg} → using neutral fallback`)
    } else {
      console.warn(`[${timestamp}] ❌ Failed to analyze - ${file.name}: ${errorMsg} → using neutral fallback`)
    }
    // Return fallback with neutral emotion
    return {
      id: uuidv4(),
      file,
      bitmap: null as any,
      dominantHue: 0,
      dominantSat: 0,
      emotion: 'neutral'
    }
  }
}

/**
 * Scans an image on a 4×4 grid and generates loose crops for a specific set
 * of target emotions. Only emotions in `targetEmotions` are attempted — this
 * lets the caller skip emotions whose buckets are already full.
 *
 * The crop is ~60% of image size centered on the best-matching cell, so it
 * retains context but skews toward the target color.
 */
export async function generateSecondaryCrops(
  asset: ImageAsset,
  targetEmotions: Set<Emotion>,
  minScore = 12
): Promise<ImageAsset[]> {
  if (!asset.bitmap || targetEmotions.size === 0) return []

  const GRID = 4
  const bw = asset.bitmap.width
  const bh = asset.bitmap.height
  if (bw < 10 || bh < 10) return []

  // Draw full image to canvas for pixel access
  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = bw
  srcCanvas.height = bh
  const srcCtx = srcCanvas.getContext('2d')!
  srcCtx.drawImage(asset.bitmap, 0, 0)

  const cellW = bw / GRID
  const cellH = bh / GRID

  // Compute average HSL for each grid cell
  const cells: Array<{ row: number; col: number; h: number; s: number; l: number }> = []
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const x = Math.round(col * cellW)
      const y = Math.round(row * cellH)
      const w = Math.max(1, Math.round(cellW))
      const h = Math.max(1, Math.round(cellH))
      const data = srcCtx.getImageData(x, y, w, h).data
      let rSum = 0, gSum = 0, bSum = 0
      const px = data.length / 4
      for (let i = 0; i < data.length; i += 4) {
        rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2]
      }
      const [hue, sat, lig] = rgbToHsl(rSum / px, gSum / px, bSum / px)
      cells.push({ row, col, h: hue, s: sat, l: lig })
    }
  }

  const crops: ImageAsset[] = []

  // If the source image is neutral/confused, it has low overall saturation
  // but may have pockets of subtle color. Lower the sat threshold so those
  // pockets can still be cropped into emotion buckets.
  const isNeutralSource = asset.emotion === 'neutral' || asset.emotion === 'confused'
  const satReduction = isNeutralSource ? 0.5 : 1.0 // halve sat requirement for neutral sources

  for (const mapping of EMOTION_COLOR_MAPPINGS) {
    const emotion = mapping.emotion
    if (!targetEmotions.has(emotion)) continue // only fill deficient buckets
    if (emotion === 'neutral' || emotion === 'confused') continue // don't crop *for* these buckets

    const [minHue, maxHue] = mapping.hueRange
    const effectiveSatMin = mapping.saturationMin * satReduction

    // Find the cell with the strongest signal for this emotion
    let bestCell: typeof cells[0] | null = null
    let bestScore = 0

    for (const cell of cells) {
      if (cell.s < effectiveSatMin) continue

      const inRange = minHue > maxHue
        ? cell.h >= minHue || cell.h <= maxHue
        : cell.h >= minHue && cell.h <= maxHue

      if (!inRange) continue

      // Score by saturation × how well-centered in hue range
      const rangeSpan = minHue > maxHue ? (360 - minHue + maxHue) : (maxHue - minHue)
      const midHue = minHue > maxHue ? ((minHue + maxHue + 360) / 2) % 360 : (minHue + maxHue) / 2
      let hueDist = Math.abs(cell.h - midHue)
      if (hueDist > 180) hueDist = 360 - hueDist
      const hueScore = rangeSpan > 0 ? Math.max(0, 1 - hueDist / (rangeSpan / 2)) : 1
      const score = cell.s * hueScore

      if (score > bestScore) {
        bestScore = score
        bestCell = cell
      }
    }

    // Require at least moderate color signal to generate a crop
    if (!bestCell || bestScore < minScore) continue

    // Loose crop: 60% of image centered on the best cell
    const cropCenterX = (bestCell.col + 0.5) * cellW
    const cropCenterY = (bestCell.row + 0.5) * cellH
    const cropW = bw * 0.6
    const cropH = bh * 0.6
    const cropX = Math.max(0, Math.min(bw - cropW, cropCenterX - cropW / 2))
    const cropY = Math.max(0, Math.min(bh - cropH, cropCenterY - cropH / 2))

    // Render the crop
    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = Math.round(cropW)
    cropCanvas.height = Math.round(cropH)
    const cropCtx = cropCanvas.getContext('2d')!
    cropCtx.drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

    const blob = await new Promise<Blob>((resolve) =>
      cropCanvas.toBlob(b => resolve(b!), 'image/jpeg', 0.85)
    )
    const cropFile = new File([blob], `${asset.file.name}_crop_${emotion}.jpg`, { type: 'image/jpeg' })
    const cropBitmap = await createImageBitmap(blob)

    crops.push({
      id: uuidv4(),
      file: cropFile,
      bitmap: cropBitmap,
      dominantHue: bestCell.h,
      dominantSat: bestCell.s,
      emotion,
    })
  }

  return crops
}

/**
 * Analyzes a pool of images by dominant color, then does a targeted crop pass
 * to fill any emotion buckets below the target count.
 *
 * Flow:
 * 1. Primary pass — bucket every image by dominant color
 * 2. Check deficits — which emotions are below bucketTarget?
 * 3. Crop pass — iterate images again, generating crops only for deficient
 *    emotions, removing each from the target set once it hits bucketTarget
 */
export async function analyzeImagePool(
  files: File[],
  onProgress?: (progress: number) => void,
  bucketTarget = 50
): Promise<{ assets: ImageAsset[]; buckets: EmotionBuckets }> {
  const assets: ImageAsset[] = []
  const buckets: EmotionBuckets = {}
  let skipped = 0

  console.log(`[${new Date().toLocaleTimeString()}] 📊 Primary pass: analyzing ${files.length} image(s)...`)

  // ── Pass 1: primary bucketing ─────────────────────────────────────────────
  for (let i = 0; i < files.length; i++) {
    try {
      const asset = await analyzeImage(files[i])
      assets.push(asset)
      if (!buckets[asset.emotion]) buckets[asset.emotion] = []
      buckets[asset.emotion].push(asset)
      if (asset.emotion === 'neutral' && asset.bitmap === null) skipped++
    } catch {
      skipped++
    }
    onProgress?.(((i + 1) / files.length) * 0.6) // primary pass = first 60% of progress
  }

  // ── Pass 1b: redistribute excess neutrals into thin buckets ─────────────
  // Neutral images still have a dominant hue — it's just low saturation.
  // Use that hue to find the closest emotion and move the image there,
  // evening out bucket sizes. Keep a reserve in neutral for background modes.
  const neutralReserve = Math.min(bucketTarget, Math.ceil((buckets['neutral']?.length ?? 0) * 0.3))
  const neutralPool = (buckets['neutral'] ?? []).filter(a => a.bitmap !== null)

  if (neutralPool.length > neutralReserve) {
    // Sort emotion buckets by size (smallest first) so we fill the thinnest first
    const emotionTargets = EMOTION_COLOR_MAPPINGS
      .map(m => m.emotion)
      .filter(e => e !== 'neutral' && e !== 'confused')

    // For each redistributable neutral, find closest emotion by hue (ignoring sat)
    const redistributable = neutralPool.slice(neutralReserve) // keep reserve
    let moved = 0

    for (const asset of redistributable) {
      // Find the emotion whose hue range contains this image's hue
      const hue = asset.dominantHue
      let bestEmotion: Emotion | null = null
      let bestBucketSize = Infinity

      for (const mapping of EMOTION_COLOR_MAPPINGS) {
        if (mapping.emotion === 'neutral' || mapping.emotion === 'confused') continue
        if (mapping.saturationMin === 0) continue // skip catch-all mappings

        const [minHue, maxHue] = mapping.hueRange
        const inRange = minHue > maxHue
          ? hue >= minHue || hue <= maxHue
          : hue >= minHue && hue <= maxHue

        if (inRange) {
          const bucketSize = buckets[mapping.emotion]?.length ?? 0
          // Prefer the thinnest bucket when multiple hue ranges match
          if (bucketSize < bestBucketSize) {
            bestBucketSize = bucketSize
            bestEmotion = mapping.emotion
          }
        }
      }

      // If no hue match, find the globally thinnest bucket
      if (!bestEmotion) {
        let minSize = Infinity
        for (const e of emotionTargets) {
          const size = buckets[e]?.length ?? 0
          if (size < minSize) { minSize = size; bestEmotion = e }
        }
      }

      if (bestEmotion) {
        // Move from neutral to target bucket
        const neutralBucket = buckets['neutral']
        if (neutralBucket) {
          const idx = neutralBucket.indexOf(asset)
          if (idx >= 0) neutralBucket.splice(idx, 1)
        }
        asset.emotion = bestEmotion
        if (!buckets[bestEmotion]) buckets[bestEmotion] = []
        buckets[bestEmotion].push(asset)
        moved++
      }
    }

    if (moved > 0) {
      console.log(`[${new Date().toLocaleTimeString()}] Redistributed ${moved} neutral image(s) into emotion buckets (kept ${buckets['neutral']?.length ?? 0} in neutral reserve)`)
    }
  }

  // ── Pass 2: targeted crop fill ────────────────────────────────────────────
  // Build set of emotions that need topping up
  const needed = new Set<Emotion>(
    EMOTION_COLOR_MAPPINGS
      .map(m => m.emotion)
      .filter(e => e !== 'neutral' && e !== 'confused')
      .filter(e => (buckets[e]?.length ?? 0) < bucketTarget)
  )

  if (needed.size > 0) {
    console.log(`[${new Date().toLocaleTimeString()}] 🎨 Crop pass: filling ${needed.size} thin bucket(s): ${[...needed].join(', ')}`)

    const sourceAssets = assets.filter(a => a.bitmap !== null)

    for (let i = 0; i < sourceAssets.length && needed.size > 0; i++) {
      try {
        const crops = await generateSecondaryCrops(sourceAssets[i], new Set(needed))

        for (const crop of crops) {
          if (!needed.has(crop.emotion)) continue // bucket may have filled mid-image
          if (!buckets[crop.emotion]) buckets[crop.emotion] = []
          buckets[crop.emotion].push(crop)
          assets.push(crop)

          // Remove from needed once target is hit
          if (buckets[crop.emotion].length >= bucketTarget) {
            needed.delete(crop.emotion)
          }
        }
      } catch {
        // skip
      }
      onProgress?.(0.6 + ((i + 1) / sourceAssets.length) * 0.4) // crop pass = last 40%
    }
  }

  // ── Pass 3: aggressive fill for truly empty buckets ──────────────────────
  // Any bucket still at zero after pass 2 gets a low-threshold crop sweep
  const stillEmpty = new Set<Emotion>(
    EMOTION_COLOR_MAPPINGS
      .map(m => m.emotion)
      .filter(e => e !== 'neutral' && e !== 'confused')
      .filter(e => !buckets[e]?.length)
  )

  if (stillEmpty.size > 0) {
    console.log(`[${new Date().toLocaleTimeString()}] 🔍 Aggressive pass: ${stillEmpty.size} bucket(s) still empty: ${[...stillEmpty].join(', ')} — lowering score threshold to 4`)

    const sourceAssets = assets.filter(a => a.bitmap !== null)
    for (let i = 0; i < sourceAssets.length && stillEmpty.size > 0; i++) {
      try {
        const crops = await generateSecondaryCrops(sourceAssets[i], new Set(stillEmpty), 4)
        for (const crop of crops) {
          if (!stillEmpty.has(crop.emotion)) continue
          if (!buckets[crop.emotion]) buckets[crop.emotion] = []
          buckets[crop.emotion].push(crop)
          assets.push(crop)
          // Stop once we have at least a few images in this bucket
          if (buckets[crop.emotion].length >= 5) {
            stillEmpty.delete(crop.emotion)
          }
        }
      } catch {
        // skip
      }
    }

    if (stillEmpty.size > 0) {
      console.log(`[${new Date().toLocaleTimeString()}] ⚠️  Still empty after aggressive pass: ${[...stillEmpty].join(', ')} — will use neutral fallback at render time`)
    }
  }

  const bucketSummary = Object.entries(buckets)
    .filter(([, imgs]) => imgs.length > 0)
    .map(([emotion, imgs]) => `${emotion}: ${imgs.length}`)
    .join(', ')

  console.log(`[${new Date().toLocaleTimeString()}] ✅ Done: ${files.length} source images → ${assets.length} total (incl. crops), ${skipped} skipped → ${bucketSummary}`)

  return { assets, buckets }
}

/**
 * Defines emotional neighbors for fallback purposes
 * When primary emotion has no images, try these related emotions in order
 */
const EMOTION_NEIGHBORS: Record<Emotion, Emotion[]> = {
  happy: ['excited', 'confident', 'calm'],
  excited: ['happy', 'confident', 'surprised'],
  angry: ['fearful', 'disgusted', 'sad'],
  sad: ['calm', 'mysterious', 'fearful'],
  calm: ['tender', 'happy', 'mysterious'],
  surprised: ['excited', 'fearful', 'confused'],
  fearful: ['sad', 'mysterious', 'angry'],
  disgusted: ['angry', 'sad', 'fearful'],
  tender: ['calm', 'happy', 'confident'],
  confident: ['happy', 'excited', 'calm'],
  confused: ['mysterious', 'calm', 'neutral'],
  mysterious: ['calm', 'fearful', 'confused'],
  neutral: ['calm', 'happy', 'mysterious'],
}

export function getImagesForEmotion(
  buckets: EmotionBuckets,
  emotion: Emotion
): ImageAsset[] {
  // 1. Try primary emotion bucket
  if (buckets[emotion]?.length) return buckets[emotion]

  // 2. Try neighboring emotions in order (for emotional continuity)
  const neighbors = EMOTION_NEIGHBORS[emotion] || []
  for (const neighbor of neighbors) {
    if (buckets[neighbor]?.length) return buckets[neighbor]
  }

  // 3. Fall back to neutral bucket
  if (buckets['neutral']?.length) return buckets['neutral']

  // 4. Use any available bucket (graceful degradation)
  return Object.values(buckets).flat()
}

// ── Section-based image assignment ───────────────────────────────────────────

/**
 * Builds per-section image caches WITHOUT color analysis.
 * Shuffles all files, then divides them proportionally across sections
 * (longer sections get more images). Each section gets a unique image slice.
 *
 * Returns Map<sectionIndex, CachedImage[]>.
 */
export async function buildSectionCaches(
  files: File[],
  sections: EmotionSection[],
  onProgress?: (p: number) => void
): Promise<Map<number, CachedImage[]>> {
  const result = new Map<number, CachedImage[]>()
  if (sections.length === 0 || files.length === 0) return result

  // Shuffle files so assignment is random
  const shuffled = [...files]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  // Compute how many images each section gets (proportional to frameCount)
  const totalFrames = sections.reduce((s, sec) => s + sec.frameCount, 0)
  const allocations: number[] = sections.map(sec =>
    Math.max(1, Math.round((sec.frameCount / totalFrames) * shuffled.length))
  )
  // Clamp total to file count — give any remainder to the largest section
  const allocTotal = allocations.reduce((a, b) => a + b, 0)
  if (allocTotal > shuffled.length) {
    const largest = allocations.indexOf(Math.max(...allocations))
    allocations[largest] -= allocTotal - shuffled.length
  }

  // Load & decode each file, assign to section
  let fileIdx = 0
  for (let si = 0; si < sections.length; si++) {
    const count = allocations[si]
    const sectionCache: CachedImage[] = []

    for (let k = 0; k < count && fileIdx < shuffled.length; k++, fileIdx++) {
      const file = shuffled[fileIdx]
      try {
        const bitmap = await createImageBitmap(file)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        sectionCache.push({ width: canvas.width, height: canvas.height, data: imgData.data, meanL: computeMeanL(imgData.data), colorTemp: computeColorTemp(imgData.data) })
        bitmap.close()
      } catch { /* skip unreadable files */ }
    }

    result.set(sections[si].sectionIndex, sectionCache)
    onProgress?.((si + 1) / sections.length)
  }

  return result
}

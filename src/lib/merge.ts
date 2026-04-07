import { rgbToLab } from './slic'

export function mergeRegions(
  labelMap: Uint32Array,
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  chunkiness: number,
  /** Optional per-label skin fraction map — skin regions get a tighter merge cap */
  skinFractions?: Map<number, number>
): Uint32Array {
  if (chunkiness === 0) {
    return labelMap
  }

  const merged = new Uint32Array(labelMap)
  const numPixels = width * height

  const uniqueLabels = new Set(labelMap)
  const labelsArray = Array.from(uniqueLabels)

  const meanColors = new Map<number, [number, number, number]>()
  const labelCounts = new Map<number, number>()

  // Track bounding boxes per label for aspect ratio constraint
  const labelBBox = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>()

  for (const label of labelsArray) {
    meanColors.set(label, [0, 0, 0])
    labelCounts.set(label, 0)
    labelBBox.set(label, { minX: width, minY: height, maxX: 0, maxY: 0 })
  }

  for (let i = 0; i < numPixels; i++) {
    const label = labelMap[i]
    const idx = i * 4
    const [L, a, b] = rgbToLab(imageData[idx], imageData[idx + 1], imageData[idx + 2])
    const current = meanColors.get(label)!
    meanColors.set(label, [current[0] + L, current[1] + a, current[2] + b])
    labelCounts.set(label, labelCounts.get(label)! + 1)

    // Update bounding box
    const x = i % width
    const y = Math.floor(i / width)
    const bb = labelBBox.get(label)!
    if (x < bb.minX) bb.minX = x
    if (x > bb.maxX) bb.maxX = x
    if (y < bb.minY) bb.minY = y
    if (y > bb.maxY) bb.maxY = y
  }

  for (const label of labelsArray) {
    const count = labelCounts.get(label)!
    const sum = meanColors.get(label)!
    meanColors.set(label, [sum[0] / count, sum[1] / count, sum[2] / count])
  }

  const adjacency = new Map<number, Set<number>>()
  for (const label of labelsArray) {
    adjacency.set(label, new Set())
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const label = labelMap[idx]

      const neighbors = [
        { dx: 1, dy: 0 },
        { dx: 0, dy: 1 }
      ]

      for (const { dx, dy } of neighbors) {
        const nx = x + dx
        const ny = y + dy
        if (nx < width && ny < height) {
          const nidx = ny * width + nx
          const nlabel = labelMap[nidx]
          if (nlabel !== label) {
            adjacency.get(label)!.add(nlabel)
            adjacency.get(nlabel)!.add(label)
          }
        }
      }
    }
  }

  const threshold = 50 * (1 - chunkiness / 100)
  // Cap merged region size at 0.3% of total frame pixels to prevent
  // transitive chaining across uniform areas (stone walls, dark backgrounds).
  const maxRegionPixels = Math.floor(numPixels * 0.003)
  // Skin/face regions get a much tighter merge cap (1/4 of normal) to preserve detail
  const maxSkinPixels = Math.floor(maxRegionPixels * 0.25)
  // Max aspect ratio for merged regions — prevents thin horizontal/vertical stripes
  const MAX_ASPECT_RATIO = 4.0

  const parent = new Map<number, number>()
  const regionSize = new Map<number, number>()
  // Track merged bounding boxes (union of constituent bboxes)
  const regionBBox = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>()
  // Track whether a region contains skin (inherits when merging)
  const regionIsSkin = new Map<number, boolean>()
  for (const label of labelsArray) {
    parent.set(label, label)
    regionSize.set(label, labelCounts.get(label)!)
    regionBBox.set(label, { ...labelBBox.get(label)! })
    regionIsSkin.set(label, skinFractions ? (skinFractions.get(label) ?? 0) >= 0.15 : false)
  }

  function find(x: number): number {
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!))
    }
    return parent.get(x)!
  }

  function union(x: number, y: number) {
    const px = find(x)
    const py = find(y)
    if (px !== py) {
      const combined = (regionSize.get(px) ?? 0) + (regionSize.get(py) ?? 0)
      // Use tighter cap if either region contains skin
      const isSkin = regionIsSkin.get(px) || regionIsSkin.get(py)
      const cap = isSkin ? maxSkinPixels : maxRegionPixels
      if (combined > cap) return // skip — would create too-large region

      // Aspect ratio check: compute the merged bounding box
      const bbA = regionBBox.get(px)!
      const bbB = regionBBox.get(py)!
      const mergedW = Math.max(bbA.maxX, bbB.maxX) - Math.min(bbA.minX, bbB.minX) + 1
      const mergedH = Math.max(bbA.maxY, bbB.maxY) - Math.min(bbA.minY, bbB.minY) + 1
      const aspect = Math.max(mergedW / Math.max(1, mergedH), mergedH / Math.max(1, mergedW))
      if (aspect > MAX_ASPECT_RATIO) return // skip — would create a thin stripe

      parent.set(px, py)
      regionSize.set(py, combined)
      // Merge bounding boxes
      regionBBox.set(py, {
        minX: Math.min(bbA.minX, bbB.minX),
        minY: Math.min(bbA.minY, bbB.minY),
        maxX: Math.max(bbA.maxX, bbB.maxX),
        maxY: Math.max(bbA.maxY, bbB.maxY),
      })
      // Propagate skin flag
      if (isSkin) regionIsSkin.set(py, true)
    }
  }

  for (const label of labelsArray) {
    const color1 = meanColors.get(label)!
    const neighbors = adjacency.get(label)!

    for (const neighbor of neighbors) {
      const color2 = meanColors.get(neighbor)!
      const dL = color1[0] - color2[0]
      const da = color1[1] - color2[1]
      const db = color1[2] - color2[2]
      const dist = Math.sqrt(dL * dL + da * da + db * db)

      if (dist < threshold) {
        union(label, neighbor)
      }
    }
  }

  for (let i = 0; i < numPixels; i++) {
    merged[i] = find(labelMap[i])
  }

  return merged
}

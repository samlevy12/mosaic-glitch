/**
 * library-manager.ts
 * Scans iCloud folders for images, analyzes colors, and manages image library
 * Supports Phase 1 (basic library) and Phase 2 (smart crops)
 */

import type { ImageAsset } from './types'
import type { Emotion } from './emotion-color-mapping'
import { rgbToHsl, getEmotionFromColor } from './emotion-color-mapping'
import { v4 as uuidv4 } from 'uuid'

export interface LibraryImage {
  id: string
  fileName: string
  fileHandle: FileSystemFileHandle
  file: File | null // Only loaded when downloaded
  emotion: Emotion
  dominantHue: number
  dominantSat: number
  color: string // hex color
  fileSize: number
  downloaded: boolean
  crops?: ImageCrop[]
}

export interface ImageCrop {
  id: string
  sourceImageId: string
  emotion: Emotion // Emotion this crop is for
  region: { x: number; y: number; w: number; h: number }
  confidence: number // 0-1, how confident we are this region matches the emotion
  color: string // hex color of the region
}

export interface EmotionLibrary {
  [emotion: string]: LibraryImage[]
}

// ── Library Index (persisted to disk) ───────────────────────────────────────

export interface LibraryImageMeta {
  fileName: string
  emotion: Emotion
  dominantHue: number
  dominantSat: number
  color: string
  fileSize: number
}

export interface LibraryIndex {
  version: 1
  scannedAt: string
  folderName: string
  totalImages: number
  emotions: Partial<Record<Emotion, LibraryImageMeta[]>>
}

/**
 * Save a completed library scan as a tiny .emosaic-library.json index file.
 * Contains only filenames + color metadata — no image data.
 */
export function saveLibraryIndex(library: EmotionLibrary, folderName = 'unknown'): void {
  const emotions: Partial<Record<Emotion, LibraryImageMeta[]>> = {}
  for (const [emotion, images] of Object.entries(library)) {
    emotions[emotion as Emotion] = images.map(img => ({
      fileName: img.fileName,
      emotion: img.emotion,
      dominantHue: img.dominantHue,
      dominantSat: img.dominantSat,
      color: img.color,
      fileSize: img.fileSize,
    }))
  }

  const index: LibraryIndex = {
    version: 1,
    scannedAt: new Date().toISOString(),
    folderName,
    totalImages: Object.values(emotions).reduce((sum, imgs) => sum + (imgs?.length ?? 0), 0),
    emotions,
  }

  const blob = new Blob([JSON.stringify(index, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `emosaic-library-${folderName}-${Date.now()}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

/**
 * Load a previously saved library index from disk (opens file picker).
 */
export async function loadLibraryIndex(): Promise<LibraryIndex> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) { reject(new Error('No file selected')); return }
      try {
        const text = await file.text()
        const index = JSON.parse(text) as LibraryIndex
        if (index.version !== 1) throw new Error('Unsupported index version')
        resolve(index)
      } catch (err) {
        reject(new Error(`Invalid library index: ${(err as Error).message}`))
      }
    }
    input.oncancel = () => reject(new Error('cancelled'))
    input.click()
  })
}

/**
 * Match a loaded index to a newly opened folder.
 * Re-opens the folder (instant, no downloads) and matches filenames.
 * Returns a library with fileHandles attached — ready to download from.
 */
export async function matchIndexToFolder(
  index: LibraryIndex,
  samplePerEmotion = Infinity,
  onProgress?: (message: string, current: number, total: number) => void
): Promise<{ library: EmotionLibrary; allImages: LibraryImage[]; matched: number; unmatched: number }> {
  if (!('showDirectoryPicker' in window)) {
    throw new Error('Folder selection not supported in this browser')
  }

  onProgress?.('Opening folder to match files...', 0, 1)
  const dirHandle = await (window as any).showDirectoryPicker()

  // Build a filename → fileHandle map (fast, no downloads)
  onProgress?.('Reading folder entries...', 0, 1)
  const handleMap = new Map<string, FileSystemFileHandle>()
  for await (const [name, handle] of (dirHandle as any).entries()) {
    if (handle.kind === 'file') {
      handleMap.set(name, handle)
    }
  }

  onProgress?.(`Folder has ${handleMap.size} files — matching to index...`, 0, 1)

  const allImages: LibraryImage[] = []
  const library: EmotionLibrary = {}
  let matched = 0
  let unmatched = 0

  // Randomly sample N per emotion from the index if samplePerEmotion is set
  const sampledEmotions: typeof index.emotions = {}
  for (const [emotion, metas] of Object.entries(index.emotions)) {
    if (!metas) continue
    if (samplePerEmotion === Infinity || metas.length <= samplePerEmotion) {
      sampledEmotions[emotion as Emotion] = metas
    } else {
      // Shuffle and take N
      const shuffled = [...metas].sort(() => Math.random() - 0.5)
      sampledEmotions[emotion as Emotion] = shuffled.slice(0, samplePerEmotion)
    }
  }

  const allMeta = Object.values(sampledEmotions).flat().filter(Boolean) as LibraryImageMeta[]

  for (let i = 0; i < allMeta.length; i++) {
    const meta = allMeta[i]
    const handle = handleMap.get(meta.fileName)

    if (!handle) {
      unmatched++
      continue
    }

    matched++
    const img: LibraryImage = {
      id: uuidv4(),
      fileName: meta.fileName,
      fileHandle: handle,
      file: null,
      emotion: meta.emotion,
      dominantHue: meta.dominantHue,
      dominantSat: meta.dominantSat,
      color: meta.color,
      fileSize: meta.fileSize,
      downloaded: false,
    }

    allImages.push(img)
    if (!library[meta.emotion]) library[meta.emotion] = []
    library[meta.emotion].push(img)

    onProgress?.(`Matched ${matched} files`, i + 1, allMeta.length)
  }

  return { library, allImages, matched, unmatched }
}

// ── Shared: browse folder and get N random handles ──────────────────────────

export async function pickRandomHandles(
  sampleSize: number,
  onProgress?: (message: string, current: number, total: number) => void
): Promise<{ handles: Array<{ name: string; handle: FileSystemFileHandle }>; totalFound: number; folderName: string }> {
  if (!('showDirectoryPicker' in window)) {
    throw new Error('Folder selection not supported. Please use Chrome, Edge, or Safari 16.4+')
  }

  const dirHandle = await (window as any).showDirectoryPicker()
  const folderName: string = dirHandle.name ?? 'folder'

  onProgress?.('Scanning folder for images...', 0, 1)

  // Collect all image file handles
  const allHandles: Array<{ name: string; handle: FileSystemFileHandle }> = []
  for await (const [name, handle] of (dirHandle as any).entries()) {
    if (handle.kind === 'file' && name.match(/\.(jpg|jpeg|png|webp|gif)$/i)) {
      allHandles.push({ name, handle })
    }
  }

  const totalFound = allHandles.length
  onProgress?.(`Found ${totalFound} images — selecting ${Math.min(sampleSize, totalFound)} randomly`, 0, 1)

  // Fisher-Yates shuffle, take first N
  for (let i = allHandles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allHandles[i], allHandles[j]] = [allHandles[j], allHandles[i]]
  }

  const handles = allHandles.slice(0, Math.min(sampleSize, allHandles.length))
  return { handles, totalFound, folderName }
}

/**
 * Scan folder: browse, randomly select N, analyze colors (no download)
 */
export async function scanLibraryFolder(
  sampleSize = Infinity,
  onProgress?: (message: string, current: number, total: number) => void
): Promise<{ library: EmotionLibrary; allImages: LibraryImage[]; folderName: string }> {
  const { handles, totalFound, folderName } = await pickRandomHandles(
    sampleSize === Infinity ? 999999 : sampleSize,
    onProgress
  )

  console.log(`[Library] Analyzing ${handles.length}/${totalFound} images from "${folderName}"`)
  onProgress?.(`Analyzing ${handles.length} images...`, 0, handles.length)

  const allImages: LibraryImage[] = []
  const library: EmotionLibrary = {}

  for (let i = 0; i < handles.length; i++) {
    const { name, handle } = handles[i]
    const file = await (handle as any).getFile()

    try {
      const result = await analyzeColorFromPreview(file)
      const [h, s, l] = result.hsl
      const color = hslToHex(h, s, l)

      const libraryImage: LibraryImage = {
        id: uuidv4(),
        fileName: name,
        fileHandle: handle,
        file: null,
        emotion: result.emotion,
        dominantHue: h,
        dominantSat: s,
        color,
        fileSize: file.size,
        downloaded: false,
      }

      allImages.push(libraryImage)
      if (!library[result.emotion]) library[result.emotion] = []
      library[result.emotion].push(libraryImage)

      onProgress?.(`Analyzing ${name}`, i + 1, handles.length)
    } catch (err) {
      console.warn(`[Library] Failed to analyze ${name}: ${(err as Error).message}`)
    }
  }

  console.log(`[Library] Scan complete: ${allImages.length} images analyzed`)
  return { library, allImages, folderName }
}

/**
 * Smart Crops: browse folder, randomly select N, download them, scan for color regions
 */
export async function smartCropFromFolder(
  sampleSize: number,
  targetEmotions: Emotion[],
  onProgress?: (stage: string, current: number, total: number) => void
): Promise<{ crops: ImageCrop[]; sources: LibraryImage[] }> {
  // Step 1: Pick random handles
  const { handles, totalFound } = await pickRandomHandles(sampleSize, (msg, c, t) =>
    onProgress?.(msg, c, t)
  )

  onProgress?.(`Downloading ${handles.length} images...`, 0, handles.length)

  // Step 2: Download them
  const sources: LibraryImage[] = []
  for (let i = 0; i < handles.length; i++) {
    const { name, handle } = handles[i]
    try {
      const file = await (handle as any).getFile()
      const buffer = await downloadWithTimeout(file, 180000)
      const localFile = new File([buffer], name, { type: file.type })

      sources.push({
        id: uuidv4(),
        fileName: name,
        fileHandle: handle,
        file: localFile,
        emotion: 'neutral' as Emotion, // placeholder — we don't analyze dominant here
        dominantHue: 0,
        dominantSat: 0,
        color: '#888',
        fileSize: buffer.byteLength,
        downloaded: true,
      })
      onProgress?.(`Downloaded ${i + 1}/${handles.length}`, i + 1, handles.length)
    } catch (err) {
      console.warn(`[SmartCrop] Skipped ${name}: ${(err as Error).message}`)
    }
  }

  // Step 3: Scan each image for target emotion color regions
  const allCrops: ImageCrop[] = []
  const total = sources.length * targetEmotions.length
  let done = 0

  for (const img of sources) {
    for (const emotion of targetEmotions) {
      try {
        const found = await findColorRegions(img, emotion)
        allCrops.push(...found)
      } catch { /* skip */ }
      done++
      onProgress?.(`Scanning for ${emotion} regions`, done, total)
    }
  }

  return { crops: allCrops, sources }
}

/**
 * Analyze image color from a lightweight preview without downloading full file
 */
async function analyzeColorFromPreview(
  file: File,
  maxWaitMs = 30000
): Promise<{ emotion: Emotion; hsl: [number, number, number] }> {
  // Create a very small preview bitmap
  const bitmapPromise = createImageBitmap(file)
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Preview timeout')), maxWaitMs)
  )

  let bitmap: ImageBitmap
  try {
    bitmap = await Promise.race([bitmapPromise, timeoutPromise])
  } catch (err) {
    throw new Error(`Failed to create preview: ${(err as Error).message}`)
  }

  // Downsample to 1x1 to get average color
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, 1, 1)

  const imgData = ctx.getImageData(0, 0, 1, 1)
  const [r, g, b] = [imgData.data[0], imgData.data[1], imgData.data[2]]

  const [h, s, l] = rgbToHsl(r, g, b)
  const emotion = getEmotionFromColor(h, s, l)

  return { emotion, hsl: [h, s, l] }
}

/**
 * PHASE 2: Scan images for secondary color regions (crops)
 */
export async function findColorRegions(
  libraryImage: LibraryImage,
  targetEmotion: Emotion,
  onProgress?: (current: number, total: number) => void
): Promise<ImageCrop[]> {
  if (!libraryImage.file) {
    throw new Error('Image not downloaded yet')
  }

  const bitmap = await createImageBitmap(libraryImage.file)
  const crops: ImageCrop[] = []

  // Scan image in grid, finding regions of target emotion color
  const gridSize = 32 // 32x32 grid
  const regionSize = Math.max(1, Math.floor(bitmap.width / gridSize))

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      // Sample this grid cell
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const ctx = canvas.getContext('2d')!

      const sx = (gx / gridSize) * bitmap.width
      const sy = (gy / gridSize) * bitmap.height
      const sw = regionSize
      const sh = regionSize

      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, 1, 1)
      const imgData = ctx.getImageData(0, 0, 1, 1)
      const [r, g, b] = [imgData.data[0], imgData.data[1], imgData.data[2]]
      const [h, s, l] = rgbToHsl(r, g, b)
      const emotion = getEmotionFromColor(h, s, l)

      // If this grid cell matches target emotion, create a crop
      if (emotion === targetEmotion) {
        const confidence = calculateColorConfidence(h, s, l, emotion)
        crops.push({
          id: uuidv4(),
          sourceImageId: libraryImage.id,
          emotion: targetEmotion,
          region: { x: sx, y: sy, w: sw, h: sh },
          confidence,
          color: hslToHex(h, s, l),
        })
      }

      onProgress?.(gy * gridSize + gx, gridSize * gridSize)
    }
  }

  return crops
}

/**
 * Download selected library images
 */
export async function downloadLibraryImages(
  images: LibraryImage[],
  onProgress?: (current: number, total: number, fileName: string) => void
): Promise<void> {
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    try {
      const file = await (img.fileHandle as any).getFile()
      const buffer = await downloadWithTimeout(file, 180000)

      // Create local File from buffer
      img.file = new File([buffer], img.fileName, { type: file.type })
      img.downloaded = true

      onProgress?.(i + 1, images.length, img.fileName)
    } catch (err) {
      console.warn(`[Library] Failed to download ${img.fileName}: ${(err as Error).message}`)
    }
  }
}

/**
 * Helper: Download file with timeout
 */
async function downloadWithTimeout(file: File, timeoutMs: number): Promise<ArrayBuffer> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Download timeout after ${timeoutMs / 1000}s`))
    }, timeoutMs)
  })

  try {
    const buffer = await Promise.race([file.arrayBuffer(), timeoutPromise])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    return buffer
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    throw err
  }
}

/**
 * Helpers: Color conversion
 */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2

  let r = 0,
    g = 0,
    b = 0
  if (h >= 0 && h < 60) [r, g, b] = [c, x, 0]
  else if (h >= 60 && h < 120) [r, g, b] = [x, c, 0]
  else if (h >= 120 && h < 180) [r, g, b] = [0, c, x]
  else if (h >= 180 && h < 240) [r, g, b] = [0, x, c]
  else if (h >= 240 && h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]

  const toHex = (val: number) => {
    const hex = Math.round((val + m) * 255).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function calculateColorConfidence(h: number, s: number, l: number, emotion: Emotion): number {
  // Higher saturation and appropriate lightness = higher confidence
  const satConfidence = Math.min(1, s / 0.7)
  const lightnessConfidence = l > 0.1 && l < 0.9 ? 1 : 0.5

  return Math.min(1, satConfidence * lightnessConfidence)
}

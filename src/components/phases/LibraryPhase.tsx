import { useState, useCallback } from 'react'
import type { Emotion } from '../../lib/emotion-color-mapping'
import { EMOTION_COLOR_MAPPINGS, rgbToHsl, getEmotionFromColor } from '../../lib/emotion-color-mapping'
import type { CachedImage } from '../../lib/renderer'
import { computeMeanL, computeColorTemp } from '../../lib/renderer'
// PDF support loaded dynamically

// ── Types ────────────────────────────────────────────────────────────────────

/** One image with its emotion + luminance classification */
interface SortedImage {
  file: File
  emotion: Emotion
  meanL: number
  lumBand: number  // 0-4 (dark → light)
  fileName: string
  /** Where this file currently lives */
  source: 'loose' | 'emotion-subfolder' | 'other-subfolder'
  /** Original subfolder name (if from a subfolder) */
  sourceDir?: string
}

/** Summary of a bucket: emotion × luminance band */
interface BucketSummary {
  emotion: Emotion
  band: number
  count: number
  images: SortedImage[]
}

interface LibraryPhaseProps {
  /** Send sorted caches directly to the render pipeline (emotion → CachedImage[]) */
  onSendToRender?: (caches: Map<string, CachedImage[]>) => void
  onLog: (level: 'info' | 'success' | 'warning' | 'error' | 'debug', message: string) => void
  onSetActiveProcess: (name: string | null) => void
}

// ── Constants ────────────────────────────────────────────────────────────────

const EMOTION_META = EMOTION_COLOR_MAPPINGS.reduce<Record<string, { color: string; label: string }>>(
  (acc, m) => { acc[m.emotion] = { color: m.primaryColor, label: m.displayName }; return acc },
  {}
)

const EMOTION_NAMES = new Set<string>(EMOTION_COLOR_MAPPINGS.map(m => m.emotion))

const NUM_LUM_BANDS = 5
const LUM_BAND_WIDTH = 256 / NUM_LUM_BANDS
const LUM_BAND_LABELS = ['Very Dark', 'Dark', 'Mid', 'Light', 'Very Light']

function getLumBand(meanL: number): number {
  return Math.min(NUM_LUM_BANDS - 1, Math.floor(meanL / LUM_BAND_WIDTH))
}

/**
 * Smart-crop: scan a 4×4 grid of an image and find the cell with the highest saturation.
 * Returns that cell's { hue, saturation } — the "most colorful pocket" of a neutral image.
 * Used to classify neutral images by their strongest color signal instead of the overall average.
 */
function findMostColorfulCell(imgData: ImageData): { h: number; s: number } {
  const { width, height, data } = imgData
  const GRID = 4
  const cellW = Math.floor(width / GRID)
  const cellH = Math.floor(height / GRID)

  let bestH = 0, bestS = 0

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0
      const x0 = gx * cellW
      const y0 = gy * cellH
      // Sample every other pixel for speed
      for (let y = y0; y < y0 + cellH && y < height; y += 2) {
        for (let x = x0; x < x0 + cellW && x < width; x += 2) {
          const i = (y * width + x) * 4
          rSum += data[i]
          gSum += data[i + 1]
          bSum += data[i + 2]
          count++
        }
      }
      if (count === 0) continue
      const [h, s] = rgbToHsl(rSum / count, gSum / count, bSum / count)
      if (s > bestS) {
        bestH = h
        bestS = s
      }
    }
  }

  return { h: bestH, s: bestS }
}

/**
 * Re-classify a neutral/confused image by its hue alone (ignoring saturation gates).
 * Only truly achromatic images (sat < 5%) stay neutral.
 * This evens out bucket distribution by redistributing the large neutral pile.
 */
function getEmotionFromHue(h: number, s: number): Emotion {
  // Truly achromatic — keep as neutral
  if (s < 5) return 'neutral'

  const normalizedHue = ((h % 360) + 360) % 360

  // Match hue to emotion ranges (same ranges as EMOTION_COLOR_MAPPINGS, but no saturation gate)
  for (const mapping of EMOTION_COLOR_MAPPINGS) {
    if (mapping.saturationMin === 0) continue // Skip neutral/confused entries
    const [minHue, maxHue] = mapping.hueRange
    const isInRange =
      minHue > maxHue
        ? normalizedHue >= minHue || normalizedHue <= maxHue
        : normalizedHue >= minHue && normalizedHue <= maxHue
    if (isInRange) return mapping.emotion
  }

  return 'neutral'
}

// ── Component ────────────────────────────────────────────────────────────────

export function LibraryPhase({ onSendToRender, onLog, onSetActiveProcess }: LibraryPhaseProps) {
  const [sortedImages, setSortedImages] = useState<SortedImage[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState(0)
  const [scanLabel, setScanLabel] = useState('')
  const [folderName, setFolderName] = useState('')
  const [rootHandle, setRootHandle] = useState<any>(null) // keep folder handle for in-place sort
  const [sorting, setSorting] = useState(false)
  const [sending, setSending] = useState(false)

  const loaded = sortedImages.length > 0

  // ── Scan folder ──────────────────────────────────────────────────────────

  const handleScanFolder = useCallback(async () => {
    if (!('showDirectoryPicker' in window)) {
      onLog('error', 'Folder selection not supported — use Chrome or Edge')
      return
    }

    setScanning(true)
    setScanProgress(0)
    setScanLabel('Opening folder...')
    onSetActiveProcess('Library Scan')
    onLog('info', '─── Library Sort ─────────────────────────────────────────')

    try {
      const root = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
      setFolderName(root.name)
      setRootHandle(root)
      onLog('info', `Scanning "${root.name}"...`)

      // Phase 1: Discover structure — emotion subfolders + loose files
      const emotionSubfolders: Array<{ emotion: Emotion; handles: any[] }> = []
      const looseImageHandles: Array<{ name: string; handle: any; sourceDir?: string }> = []

      for await (const [name, handle] of (root as any).entries()) {
        if (handle.kind === 'directory') {
          // Check if subfolder name matches an emotion
          const lower = name.toLowerCase()
          if (EMOTION_NAMES.has(lower)) {
            // Collect images from this emotion subfolder
            const imgHandles: any[] = []
            for await (const [imgName, imgHandle] of handle.entries()) {
              if (imgHandle.kind === 'file' && imgName.match(/\.(jpg|jpeg|png|webp|gif|bmp|avif|tiff?|heic|heif|pdf)$/i)) {
                imgHandles.push({ name: imgName, handle: imgHandle })
              }
            }
            if (imgHandles.length > 0) {
              emotionSubfolders.push({ emotion: lower as Emotion, handles: imgHandles })
              onLog('debug', `  ${name}/ → "${lower}" (${imgHandles.length} images)`)
            }
          } else {
            // Non-emotion subfolder — collect images as loose
            for await (const [imgName, imgHandle] of handle.entries()) {
              if (imgHandle.kind === 'file' && imgName.match(/\.(jpg|jpeg|png|webp|gif|bmp|avif|tiff?|heic|heif|pdf)$/i)) {
                looseImageHandles.push({ name: imgName, handle: imgHandle, sourceDir: name })
              }
            }
            onLog('debug', `  ${name}/ — not an emotion name, treating images as unsorted`)
          }
        } else if (handle.kind === 'file' && name.match(/\.(jpg|jpeg|png|webp|gif|bmp|avif|tiff?|heic|heif|pdf)$/i)) {
          looseImageHandles.push({ name, handle })
        }
      }

      const totalPreSorted = emotionSubfolders.reduce((s, f) => s + f.handles.length, 0)
      onLog('info', `Found ${totalPreSorted} pre-sorted + ${looseImageHandles.length} loose images`)

      const allSorted: SortedImage[] = []
      let processed = 0
      const totalImages = totalPreSorted + looseImageHandles.length

      // Phase 2: Load pre-sorted subfolder images (keep their emotion, compute luminance)
      for (const { emotion, handles } of emotionSubfolders) {
        for (const { name: imgName, handle: imgHandle } of handles) {
          try {
            const file: File = await imgHandle.getFile()
            const buf = await file.arrayBuffer()
            if (buf.byteLength === 0) continue
            const localFile = new File([buf], imgName, { type: file.type })

            // Compute luminance
            const bitmap = await createImageBitmap(localFile)
            const canvas = document.createElement('canvas')
            canvas.width = Math.min(64, bitmap.width)
            canvas.height = Math.min(64, bitmap.height)
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
            const meanL = computeMeanL(imgData.data)
            bitmap.close()

            allSorted.push({
              file: localFile,
              emotion,
              meanL,
              lumBand: getLumBand(meanL),
              fileName: imgName,
              source: 'emotion-subfolder',
              sourceDir: emotion,
            })
          } catch { /* skip unreadable */ }

          processed++
          setScanProgress(processed / totalImages)
          setScanLabel(`Processing ${imgName}`)
        }
      }

      // Phase 2.5: Expand PDFs into page images
      const expandedLooseHandles: Array<{ name: string; file: File; sourceDir?: string }> = []
      for (const { name: imgName, handle: imgHandle, sourceDir } of looseImageHandles) {
        try {
          const file: File = await imgHandle.getFile()
          if (imgName.match(/\.pdf$/i)) {
            setScanLabel(`Extracting ${imgName}...`)
            const { extractPDFPages } = await import('../../lib/pdf-extractor')
            const { images } = await extractPDFPages(file, 2)
            for (const img of images) {
              expandedLooseHandles.push({ name: img.name, file: img, sourceDir })
            }
            onLog('debug', `  Extracted ${images.length} page(s) from ${imgName}`)
          } else {
            const buf = await file.arrayBuffer()
            if (buf.byteLength === 0) continue
            expandedLooseHandles.push({ name: imgName, file: new File([buf], imgName, { type: file.type }), sourceDir })
          }
        } catch { /* skip */ }
      }

      const totalWithExpanded = totalPreSorted + expandedLooseHandles.length
      if (expandedLooseHandles.length !== looseImageHandles.length) {
        onLog('info', `Expanded to ${expandedLooseHandles.length} images (PDFs extracted)`)
      }

      // Phase 3: Color-analyze loose images → assign emotion + luminance
      for (const { name: imgName, file: localFile, sourceDir } of expandedLooseHandles) {
        try {

          // Downsample to small canvas for color + luminance analysis
          const bitmap = await createImageBitmap(localFile)
          const canvas = document.createElement('canvas')
          canvas.width = Math.min(64, bitmap.width)
          canvas.height = Math.min(64, bitmap.height)
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)

          // Dominant color → emotion
          const px = imgData.data
          let rSum = 0, gSum = 0, bSum = 0
          const n = px.length / 4
          for (let i = 0; i < n; i++) {
            rSum += px[i * 4]
            gSum += px[i * 4 + 1]
            bSum += px[i * 4 + 2]
          }
          const [h, s, l] = rgbToHsl(rSum / n, gSum / n, bSum / n)
          let emotion = getEmotionFromColor(h, s, l)

          // Smart-crop: if overall color is neutral, scan 4×4 grid for the most
          // colorful cell and use THAT cell's color to classify instead.
          // This finds color pockets in otherwise grey/muted images.
          let finalH = h, finalS = s
          if (emotion === 'neutral' || emotion === 'confused') {
            const cell = findMostColorfulCell(imgData)
            if (cell.s > s && cell.s >= 8) {
              // Found a more colorful pocket — reclassify from it
              const cellEmotion = getEmotionFromColor(cell.h, cell.s, l)
              if (cellEmotion !== 'neutral' && cellEmotion !== 'confused') {
                emotion = cellEmotion
              }
              finalH = cell.h
              finalS = cell.s
            }
          }

          // Luminance
          const meanL = computeMeanL(imgData.data)
          bitmap.close()

          // Store hue + saturation for redistribution pass (use best signal found)
          ;(localFile as any)._hue = finalH
          ;(localFile as any)._sat = finalS

          allSorted.push({
            file: localFile,
            emotion,
            meanL,
            lumBand: getLumBand(meanL),
            fileName: imgName,
            source: sourceDir ? 'other-subfolder' : 'loose',
            sourceDir,
          })
        } catch { /* skip */ }

        processed++
        setScanProgress(processed / totalWithExpanded)
        setScanLabel(`Analyzing ${imgName}`)
}

      // ── Redistribution pass: move neutrals into thinnest buckets ──────
      // Count current bucket sizes (excluding neutral/confused)
      const REDISTRIBUTABLE = new Set(['neutral', 'confused'])
      const emotionBuckets = new Set(
        EMOTION_COLOR_MAPPINGS.map(m => m.emotion).filter(e => !REDISTRIBUTABLE.has(e))
      )
      const bucketCounts = new Map<string, number>()
      for (const e of emotionBuckets) bucketCounts.set(e, 0)
      for (const img of allSorted) {
        if (emotionBuckets.has(img.emotion)) {
          bucketCounts.set(img.emotion, (bucketCounts.get(img.emotion) ?? 0) + 1)
        }
      }

      // Collect neutral/confused images that have SOME color (sat >= 5)
      const neutralImages = allSorted.filter(
        img => REDISTRIBUTABLE.has(img.emotion) && ((img.file as any)._sat ?? 0) >= 5
      )

      if (neutralImages.length > 0) {
        // Keep 20% of neutrals as actual neutral (some neutral tiles are useful)
        const keepNeutral = Math.ceil(neutralImages.length * 0.2)
        // Sort by saturation ascending — keep the most achromatic ones as neutral
        neutralImages.sort((a, b) => ((a.file as any)._sat ?? 0) - ((b.file as any)._sat ?? 0))
        const toRedistribute = neutralImages.slice(keepNeutral)

        let redistributed = 0
        for (const img of toRedistribute) {
          const hue = (img.file as any)._hue ?? 0
          const sat = (img.file as any)._sat ?? 0

          // Find the thinnest bucket, with hue affinity as tiebreaker
          const hueMatch = getEmotionFromHue(hue, sat)
          let bestEmotion = hueMatch !== 'neutral' ? hueMatch : null
          let bestCount = bestEmotion ? (bucketCounts.get(bestEmotion) ?? Infinity) : Infinity

          // Check if there's a significantly thinner bucket (>30% thinner than hue match)
          for (const [emotion, count] of bucketCounts) {
            if (count < bestCount * 0.7) {
              bestEmotion = emotion
              bestCount = count
            }
          }

          if (bestEmotion && emotionBuckets.has(bestEmotion)) {
            img.emotion = bestEmotion as Emotion
            bucketCounts.set(bestEmotion, (bucketCounts.get(bestEmotion) ?? 0) + 1)
            redistributed++
          }
        }

        if (redistributed > 0) {
          onLog('info', `Redistributed ${redistributed} neutral images into thinner emotion buckets`)
        }
      }

      // Clean up temp properties
      for (const img of allSorted) {
        delete (img.file as any)._hue
        delete (img.file as any)._sat
      }

      setSortedImages(allSorted)

      // Summary
      const emotionCounts: Record<string, number> = {}
      for (const img of allSorted) {
        emotionCounts[img.emotion] = (emotionCounts[img.emotion] ?? 0) + 1
      }
      const summary = Object.entries(emotionCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([e, n]) => `${e}: ${n}`)
        .join(' · ')
      onLog('success', `Sorted ${allSorted.length} images → ${summary}`)

    } catch (err) {
      if ((err as any).name !== 'AbortError') {
        onLog('error', `Scan failed: ${(err as Error).message}`)
      }
    } finally {
      setScanning(false)
      onSetActiveProcess(null)
    }
  }, [onLog, onSetActiveProcess])

  // ── Sort in place: move loose files into emotion/lum subfolders ──────────

  const handleSortInPlace = useCallback(async () => {
    if (!rootHandle) {
      onLog('error', 'No folder handle — scan a folder first')
      return
    }

    // Only move files that aren't already in the right place
    const toMove = sortedImages.filter(img => img.source !== 'emotion-subfolder')
    if (toMove.length === 0) {
      onLog('info', 'All images are already in emotion subfolders — nothing to move')
      return
    }

    setSorting(true)
    onSetActiveProcess('Sorting Files')
    onLog('info', `─── Sort In Place ───────────────────────────────────────`)
    onLog('info', `Moving ${toMove.length} unsorted images into emotion/luminance subfolders...`)

    try {
      let moved = 0
      for (const img of toMove) {
        try {
          // Create emotion subfolder
          const emotionDir = await rootHandle.getDirectoryHandle(img.emotion, { create: true })
          // Create luminance sub-subfolder
          const lumLabel = LUM_BAND_LABELS[img.lumBand].toLowerCase().replace(' ', '-')
          const lumDir = await emotionDir.getDirectoryHandle(lumLabel, { create: true })

          // Write file to new location
          const newHandle = await lumDir.getFileHandle(img.fileName, { create: true })
          const writable = await (newHandle as any).createWritable()
          await writable.write(await img.file.arrayBuffer())
          await writable.close()

          // Remove from old location
          if (img.source === 'loose') {
            // Was in root — remove from root
            try { await rootHandle.removeEntry(img.fileName) } catch { /* may not exist */ }
          } else if (img.source === 'other-subfolder' && img.sourceDir) {
            // Was in a non-emotion subfolder — remove from there
            try {
              const oldDir = await rootHandle.getDirectoryHandle(img.sourceDir)
              await oldDir.removeEntry(img.fileName)
            } catch { /* may not exist */ }
          }

          moved++
          if (moved % 10 === 0) {
            onLog('debug', `  ${moved}/${toMove.length} moved`)
          }
        } catch (err) {
          onLog('debug', `  Skipped ${img.fileName}: ${(err as Error).message}`)
        }
      }

      // Update the source tags so re-scanning shows them as sorted
      setSortedImages(prev => prev.map(img =>
        img.source !== 'emotion-subfolder'
          ? { ...img, source: 'emotion-subfolder' as const, sourceDir: img.emotion }
          : img
      ))

      onLog('success', `Sorted ${moved}/${toMove.length} files in place — folder is now organized`)
    } catch (err) {
      if ((err as any).name !== 'AbortError') {
        onLog('error', `Sort failed: ${(err as Error).message}`)
      }
    } finally {
      setSorting(false)
      onSetActiveProcess(null)
    }
  }, [rootHandle, sortedImages, onLog, onSetActiveProcess])

  // ── Send direct to render pipeline ───────────────────────────────────────

  const handleSendToRender = useCallback(async () => {
    if (!onSendToRender) return
    setSending(true)
    onSetActiveProcess('Building Render Cache')
    onLog('info', '─── Building Render Cache ───────────────────────────────')

    try {
      const cacheMap = new Map<string, CachedImage[]>()

      for (let i = 0; i < sortedImages.length; i++) {
        const img = sortedImages[i]
        try {
          const bitmap = await createImageBitmap(img.file)
          const canvas = document.createElement('canvas')
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(bitmap, 0, 0)
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          bitmap.close()

          const cached: CachedImage = {
            width: canvas.width,
            height: canvas.height,
            data: imgData.data,
            meanL: img.meanL,
            colorTemp: computeColorTemp(imgData.data),
          }

          const existing = cacheMap.get(img.emotion) ?? []
          existing.push(cached)
          cacheMap.set(img.emotion, existing)
        } catch { /* skip */ }

        if (i % 20 === 0) {
          onLog('debug', `  ${i + 1}/${sortedImages.length} cached`)
        }
      }

      const summary = [...cacheMap.entries()]
        .map(([e, c]) => `${e}: ${c.length}`)
        .join(' · ')
      onLog('success', `Render cache ready — ${summary}`)
      onSendToRender(cacheMap)
    } catch (err) {
      onLog('error', `Cache build failed: ${(err as Error).message}`)
    } finally {
      setSending(false)
      onSetActiveProcess(null)
    }
  }, [sortedImages, onSendToRender, onLog, onSetActiveProcess])

  // ── Compute bucket summaries ─────────────────────────────────────────────

  const bucketSummaries: BucketSummary[] = []
  const emotionGroups = new Map<string, SortedImage[]>()
  for (const img of sortedImages) {
    const list = emotionGroups.get(img.emotion) ?? []
    list.push(img)
    emotionGroups.set(img.emotion, list)
  }
  for (const [emotion, images] of emotionGroups) {
    // Group by luminance band
    const bandGroups = new Map<number, SortedImage[]>()
    for (const img of images) {
      const list = bandGroups.get(img.lumBand) ?? []
      list.push(img)
      bandGroups.set(img.lumBand, list)
    }
    for (let band = 0; band < NUM_LUM_BANDS; band++) {
      const imgs = bandGroups.get(band) ?? []
      if (imgs.length > 0) {
        bucketSummaries.push({ emotion: emotion as Emotion, band, count: imgs.length, images: imgs })
      }
    }
  }
  bucketSummaries.sort((a, b) => {
    const emotionOrder = [...EMOTION_NAMES]
    const ai = emotionOrder.indexOf(a.emotion)
    const bi = emotionOrder.indexOf(b.emotion)
    if (ai !== bi) return ai - bi
    return a.band - b.band
  })

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Image Library</h2>
        <p className="body-text">
          Sort a folder of images into emotion + luminance buckets. Works with mixed folders — pre-sorted emotion subfolders are kept, loose files get auto-analyzed.
        </p>
      </div>

      {/* How it works */}
      {!loaded && !scanning && (
        <div className="border border-border bg-muted/30 px-4 py-3 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">How it works</p>
          <ol className="text-xs text-muted-foreground space-y-0.5 list-decimal list-inside">
            <li>Pick a folder — can have <code className="bg-muted px-1">Calm/</code>, <code className="bg-muted px-1">Excited/</code> subfolders AND/OR loose images</li>
            <li>Emotion subfolders keep their assignment. Loose files get color-analyzed automatically</li>
            <li>Every image gets a luminance band (dark / mid / light) for tonal separation</li>
            <li><span className="text-foreground font-medium">Sort In Place</span> moves loose files into subfolders in your folder — reuse it forever</li>
            <li>Or <span className="text-foreground font-medium">Send to Render</span> to pipe sorted images directly into the pipeline</li>
          </ol>
        </div>
      )}

      {/* Scan button / progress */}
      <div className="space-y-3">
        {scanning ? (
          <div className="border border-border p-4 space-y-2">
            <div className="w-full bg-border h-1">
              <div className="h-1 bg-[#B98B82] transition-all" style={{ width: `${Math.round(scanProgress * 100)}%` }} />
            </div>
            <p className="caption text-muted-foreground">{scanLabel} — {Math.round(scanProgress * 100)}%</p>
          </div>
        ) : (
          <button
            onClick={handleScanFolder}
            className="w-full py-2.5 text-xs uppercase tracking-wider border border-border hover:border-[#B98B82] hover:text-[#B98B82] transition-colors"
          >
            {loaded ? `Rescan (current: ${folderName}/)` : 'Select Folder to Sort'}
          </button>
        )}
      </div>

      {/* Results */}
      {loaded && (
        <>
          {/* Summary bar */}
          <div className="border border-border p-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{folderName}/</p>
              <p className="caption text-muted-foreground">
                {sortedImages.length} images · {emotionGroups.size} emotions · {bucketSummaries.length} buckets
              </p>
            </div>
          </div>

          {/* Emotion groups with luminance sub-buckets */}
          <div className="space-y-3">
            {[...emotionGroups.entries()]
              .sort((a, b) => b[1].length - a[1].length)
              .map(([emotion, images]) => {
                const meta = EMOTION_META[emotion]
                const bandCounts = new Array(NUM_LUM_BANDS).fill(0)
                for (const img of images) bandCounts[img.lumBand]++

                return (
                  <div key={emotion} className="border border-border p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: meta?.color ?? '#ccc' }} />
                        <span className="text-sm font-medium">{meta?.label ?? emotion}</span>
                      </div>
                      <span className="numeric text-xs text-muted-foreground">{images.length}</span>
                    </div>

                    {/* Luminance sub-bucket bar */}
                    <div className="flex h-5 overflow-hidden border border-border/50">
                      {bandCounts.map((count, band) => {
                        if (count === 0) return null
                        const pct = (count / images.length) * 100
                        const brightness = 25 + band * 50 // 25, 75, 125, 175, 225
                        return (
                          <div
                            key={band}
                            title={`${LUM_BAND_LABELS[band]}: ${count} images`}
                            className="flex items-center justify-center text-[9px] font-mono"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: `rgb(${brightness},${brightness},${brightness})`,
                              color: band < 2 ? '#fff' : '#000',
                              minWidth: count > 0 ? '20px' : 0,
                            }}
                          >
                            {count}
                          </div>
                        )
                      })}
                    </div>

                    {/* Band labels */}
                    <div className="flex justify-between">
                      {bandCounts.map((count, band) => (
                        <span key={band} className={`text-[9px] ${count > 0 ? 'text-muted-foreground' : 'text-muted-foreground/30'}`}>
                          {LUM_BAND_LABELS[band]}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
          </div>

          {/* Unsorted count */}
          {(() => {
            const unsorted = sortedImages.filter(i => i.source !== 'emotion-subfolder').length
            const alreadySorted = sortedImages.length - unsorted
            return unsorted > 0 ? (
              <div className="border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 px-4 py-3 text-xs">
                <span className="text-amber-700 dark:text-amber-400">
                  {unsorted} image{unsorted !== 1 ? 's' : ''} unsorted
                </span>
                {alreadySorted > 0 && (
                  <span className="text-muted-foreground"> · {alreadySorted} already in emotion subfolders</span>
                )}
              </div>
            ) : (
              <div className="border border-[#667761]/40 bg-[#667761]/5 px-4 py-3 text-xs text-[#667761]">
                ✓ All {sortedImages.length} images are in emotion subfolders — folder is ready to use
              </div>
            )
          })()}

          {/* Actions */}
          <div className="flex gap-2">
            {sortedImages.some(i => i.source !== 'emotion-subfolder') && (
              <button
                onClick={handleSortInPlace}
                disabled={sorting || scanning}
                className="flex-1 py-2.5 text-xs uppercase tracking-wider border border-[#667761] text-[#667761] hover:bg-[#667761] hover:text-white disabled:opacity-30 transition-colors"
              >
                {sorting ? 'Moving files...' : `Sort ${sortedImages.filter(i => i.source !== 'emotion-subfolder').length} Files In Place`}
              </button>
            )}
            {onSendToRender && (
              <button
                onClick={handleSendToRender}
                disabled={sending || scanning}
                className="flex-1 py-2.5 text-xs uppercase tracking-wider bg-[#B98B82] text-white hover:bg-[#a0786f] disabled:opacity-30 transition-colors"
              >
                {sending ? 'Building cache...' : 'Send to Render →'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

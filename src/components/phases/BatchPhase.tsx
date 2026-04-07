import { useRef, useState, useCallback, useEffect } from 'react'
import type {
  EmotionFrame, Shot, MosaicSettings, InkSettings,
  StabilitySettings, ExportSettings, RenderMode, Region,
} from '../../lib/types'
import type { EmotionBuckets } from '../../lib/image-color-analyzer'
import type { CachedImage, ProcessFrameResult } from '../../lib/renderer'
import { computeMeanL, computeColorTemp } from '../../lib/renderer'
import { analyzeImagePool, buildSectionCaches } from '../../lib/image-color-analyzer'
import type { Emotion } from '../../lib/emotion-color-mapping'
import { processFrame, renderFrame } from '../../lib/renderer'
import { createFrameEncoder } from '../../lib/stitcher'
import { RegionTracker } from '../../lib/region-tracker'
import { smoothTimeline, computeSections, buildSectionFrameMap } from '../../lib/emotion-timeline'
import { tryAutoLoadNeutralCache, pickNeutralFolder } from '../../lib/neutral-loader'
import type { ConsoleEntry } from '../Console'

// ── Types ─────────────────────────────────────────────────────────────────────

type SubfolderStatus = 'pending' | 'scanning' | 'analyzing' | 'rendering' | 'done' | 'error'

interface SubfolderItem {
  name: string
  files: File[]          // up to 50 downloaded image files
  imageCount: number     // total images found before sampling
  buckets: EmotionBuckets | null
  status: SubfolderStatus
  error?: string
  outputBlob: Blob | null
  progress: number       // 0-1
  framesTotal: number
  framesCurrent: number
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface BatchPhaseProps {
  filteredVideoBlob: Blob | null
  emotionTimeline: EmotionFrame[]
  filteredShots: Shot[]
  mosaic: MosaicSettings
  ink: InkSettings
  stability: StabilitySettings
  exportSettings: ExportSettings
  renderMode: RenderMode
  videoFileName?: string
  onMosaicChange: (s: MosaicSettings) => void
  onInkChange: (s: InkSettings) => void
  onStabilityChange: (s: StabilitySettings) => void
  onExportChange: (s: ExportSettings) => void
  onRenderModeChange: (m: RenderMode) => void
  onLog: (level: ConsoleEntry['level'], message: string, data?: any) => void
  onSetActiveProcess: (name: string | null) => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function downloadWithTimeout(file: File, timeoutMs: number): Promise<ArrayBuffer> {
  let handle: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs / 1000}s`)), timeoutMs)
  })
  try {
    const buf = await Promise.race([file.arrayBuffer(), timeout])
    if (handle) clearTimeout(handle)
    return buf
  } catch (err) {
    if (handle) clearTimeout(handle)
    throw err
  }
}

// ── Combined render helpers ───────────────────────────────────────────────────

const EMOTION_NAMES = new Set<string>([
  'happy', 'sad', 'angry', 'surprised', 'fearful', 'disgusted',
  'calm', 'excited', 'tender', 'confident', 'mysterious', 'confused', 'neutral',
])

function resolveSubfolderEmotion(name: string): Emotion | null {
  const lower = name.toLowerCase()
  return EMOTION_NAMES.has(lower) ? lower as Emotion : null
}

async function loadFilesToCache(
  files: File[],
  onProgress?: (p: number) => void
): Promise<CachedImage[]> {
  const cache: CachedImage[] = []
  for (let i = 0; i < files.length; i++) {
    try {
      const bitmap = await createImageBitmap(files[i])
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width; canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      cache.push({ width: canvas.width, height: canvas.height, data: imgData.data, meanL: computeMeanL(imgData.data), colorTemp: computeColorTemp(imgData.data) })
      bitmap.close()
    } catch { /* skip unreadable files */ }
    onProgress?.((i + 1) / files.length)
  }
  return cache
}

async function buildImageCachesFromBuckets(
  buckets: EmotionBuckets
): Promise<Map<string, CachedImage[]>> {
  const map = new Map<string, CachedImage[]>()
  for (const [emotion, assets] of Object.entries(buckets)) {
    const cached: CachedImage[] = []
    for (const asset of assets) {
      if (!asset.bitmap) continue
      try {
        const canvas = document.createElement('canvas')
        canvas.width = asset.bitmap.width
        canvas.height = asset.bitmap.height
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        ctx.drawImage(asset.bitmap, 0, 0)
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        cached.push({ width: canvas.width, height: canvas.height, data: imgData.data, meanL: computeMeanL(imgData.data), colorTemp: computeColorTemp(imgData.data) })
      } catch { /* skip */ }
    }
    map.set(emotion, cached)
  }
  return map
}

// ── Component ─────────────────────────────────────────────────────────────────

// Batch uses its own lower-quality defaults so renders are actually tractable.
// 12fps @ 540p = ~4× fewer frames and smaller canvas than 24fps @ 720p.
const BATCH_DEFAULT_EXPORT: ExportSettings = { resolution: '1080', fps: 60 }

export function BatchPhase({
  filteredVideoBlob,
  emotionTimeline,
  filteredShots,
  mosaic,
  ink,
  stability,
  renderMode,
  videoFileName,
  onMosaicChange,
  onInkChange,
  onStabilityChange,
  onRenderModeChange,
  onLog,
  onSetActiveProcess,
}: BatchPhaseProps) {
  const [subfolders, setSubfolders] = useState<SubfolderItem[]>([])
  const [scanning, setScanning] = useState(false)
  const [running, setRunning] = useState(false)
  // Batch has its own export settings — lower defaults so it doesn't lock the browser
  const [batchExport, setBatchExport] = useState<ExportSettings>(BATCH_DEFAULT_EXPORT)
  // Output style: combined = 1 video (subfolder per emotion), separate = N videos (one per subfolder)
  const [renderStyle, setRenderStyle] = useState<'combined' | 'separate'>('combined')
  // Image assignment mode (separate mode only)
  const [assignMode, setAssignMode] = useState<'color' | 'section'>('section')
  // Combined render output
  const [combinedOutputBlob, setCombinedOutputBlob] = useState<Blob | null>(null)
  const [combinedProgress, setCombinedProgress] = useState(0)
  const [combinedFrameCurrent, setCombinedFrameCurrent] = useState(0)
  const [combinedFrameTotal, setCombinedFrameTotal] = useState(0)
  const abortRef = useRef(false)
  const lastPct = useRef<Record<string, number>>({})

  // ── Neutral tile cache (white/grey images from user's Neutral folder) ──
  const hardcodedNeutralCache = useRef<CachedImage[]>([])
  const [neutralLoaded, setNeutralLoaded] = useState(false)
  const [neutralCount, setNeutralCount] = useState(0)
  useEffect(() => {
    tryAutoLoadNeutralCache().then(cache => {
      hardcodedNeutralCache.current = cache
      setNeutralCount(cache.length)
      setNeutralLoaded(cache.length > 0)
      if (cache.length > 0) onLog('debug', `Auto-loaded ${cache.length} neutral tiles`)
    })
  }, [])

  async function handlePickNeutralFolder() {
    const cache = await pickNeutralFolder()
    hardcodedNeutralCache.current = cache
    setNeutralCount(cache.length)
    setNeutralLoaded(cache.length > 0)
    if (cache.length > 0) onLog('info', `Loaded ${cache.length} neutral tiles from selected folder`)
  }

  // Estimate total frames for current settings + video duration
  const estimatedFramesPerRender = (() => {
    if (!filteredVideoBlob) return null
    // We don't have duration here without loading the blob, so we use emotionTimeline length as proxy
    if (emotionTimeline.length === 0) return null
    const durationSec = emotionTimeline.length / 30 // timeline is at 30fps
    return Math.floor(durationSec * batchExport.fps)
  })()

  const estimatedMinPerRender = estimatedFramesPerRender
    ? Math.round(estimatedFramesPerRender * 1.2 / 60) // ~1.2s per frame for SLIC
    : null

  // ── Subfolder updaters ──────────────────────────────────────────────────────

  const updateItem = useCallback((index: number, patch: Partial<SubfolderItem>) => {
    setSubfolders(prev => prev.map((item, i) => i === index ? { ...item, ...patch } : item))
  }, [])

  // ── Folder picker ───────────────────────────────────────────────────────────

  const handlePickFolder = useCallback(async () => {
    if (!('showDirectoryPicker' in window)) {
      onLog('error', 'Folder selection not supported — use Chrome, Edge, or Safari 16.4+')
      return
    }
    setScanning(true)
    onLog('info', '─── Batch Folder Scan ────────────────────────────────────')
    try {
      const root = await (window as any).showDirectoryPicker()
      onLog('info', `Scanning "${root.name}" for subfolders...`)

      const discovered: SubfolderItem[] = []

      for await (const [name, handle] of (root as any).entries()) {
        if (handle.kind !== 'directory') continue

        // Scan subfolder for image files
        const imageHandles: any[] = []
        for await (const [imgName, imgHandle] of handle.entries()) {
          if (imgHandle.kind === 'file' && imgName.match(/\.(jpg|jpeg|png|webp|gif|bmp|avif|tiff?|heic|heif|pdf)$/i)) {
            imageHandles.push(imgHandle)
          }
        }
        if (imageHandles.length === 0) continue

        // Sample up to 50 randomly
        const sampled = shuffle(imageHandles).slice(0, 50)
        onLog('debug', `  ${name}/ — found ${imageHandles.length} images, sampling ${sampled.length}`)

        // Download sampled files
        const rawFiles: File[] = []
        for (let i = 0; i < sampled.length; i++) {
          try {
            const file: File = await sampled[i].getFile()
            const buf = await downloadWithTimeout(file, 120000)
            if (buf.byteLength > 0) {
              rawFiles.push(new File([buf], file.name, { type: file.type }))
            }
          } catch { /* skip slow/missing files */ }
        }

        // Expand PDFs into page images
        const files: File[] = []
        for (const f of rawFiles) {
          if (f.name.match(/\.pdf$/i)) {
            try {
              const { extractPDFPages: extract } = await import('../../lib/pdf-extractor')
              const { images } = await extract(f, 2)
              files.push(...images)
            } catch { files.push(f) /* fallback: skip broken PDF */ }
          } else {
            files.push(f)
          }
        }

        discovered.push({
          name,
          files,
          imageCount: imageHandles.length,
          buckets: null,
          status: 'pending',
          outputBlob: null,
          progress: 0,
          framesTotal: 0,
          framesCurrent: 0,
        })
      }

      if (discovered.length === 0) {
        onLog('warning', 'No subfolders with images found in selected folder')
        return
      }

      setSubfolders(discovered)
      onLog('success', `Found ${discovered.length} subfolder(s) ready for batch render`)
    } catch (err) {
      if ((err as any).name !== 'AbortError') {
        onLog('error', `Folder scan failed: ${(err as Error).message}`)
      }
    } finally {
      setScanning(false)
    }
  }, [onLog])

  // ── Render one subfolder ────────────────────────────────────────────────────

  const renderSubfolder = useCallback(async (
    index: number,
    item: SubfolderItem
  ): Promise<void> => {
    if (!filteredVideoBlob) throw new Error('No character cut video available')

    const label = `[${item.name}]`

    // ── Smooth timeline (shared between both modes) ────────────────────────
    updateItem(index, { status: 'analyzing', progress: 0 })
    const shotsForSmoothing = filteredShots && filteredShots.length > 0 ? filteredShots : []
    const smoothedTimeline = smoothTimeline(emotionTimeline, shotsForSmoothing, stability.emotionSmoothing)
    if (!smoothedTimeline || smoothedTimeline.length === 0) {
      throw new Error(`${label} Failed to create smoothed timeline`)
    }

    // ── Build image cache — two paths ─────────────────────────────────────

    // Map used in the render loop: key is either emotion (color mode) or sectionIndex (section mode)
    let imageCache_byEmotion: Map<string, CachedImage[]> = new Map()
    let imageCache_bySection: Map<number, CachedImage[]> = new Map()
    let sectionFrameMap: Int32Array | null = null

    if (assignMode === 'section') {
      // Section mode: divide images proportionally across timeline sections, no color analysis
      onLog('info', `${label} Section assign — loading ${item.files.length} images across timeline sections...`)
      const sections = computeSections(smoothedTimeline)
      sectionFrameMap = buildSectionFrameMap(sections, smoothedTimeline.length)
      imageCache_bySection = await buildSectionCaches(
        item.files,
        sections,
        p => updateItem(index, { progress: p * 0.15 })
      )
      const totalCached = [...imageCache_bySection.values()].reduce((s, c) => s + c.length, 0)
      if (totalCached === 0) throw new Error(`${label} No valid images loaded`)
      onLog('debug', `${label} ${sections.length} sections · ${totalCached} images distributed`)
    } else {
      // Color mode: existing color-analysis → emotion buckets path
      onLog('info', `${label} Color match — analyzing ${item.files.length} images...`)
      const { buckets } = await analyzeImagePool(
        item.files,
        p => updateItem(index, { progress: p * 0.15 }),
        50
      )
      updateItem(index, { buckets })
      const bucketSummary = Object.entries(buckets)
        .filter(([, imgs]) => imgs.length > 0)
        .map(([e, imgs]) => `${e}:${imgs.length}`)
        .join(' ')
      onLog('debug', `${label} Buckets: ${bucketSummary || 'empty'}`)
      imageCache_byEmotion = await buildImageCachesFromBuckets(buckets)
      const totalCached = [...imageCache_byEmotion.values()].reduce((s, c) => s + c.length, 0)
      if (totalCached === 0) throw new Error(`${label} No valid images cached after analysis`)
      onLog('debug', `${label} ${totalCached} images cached across ${imageCache_byEmotion.size} emotion(s)`)
    }

    // ── Step 3: Render mosaic ──────────────────────────────────────────────
    updateItem(index, { status: 'rendering', progress: 0.15 })
    onLog('info', `${label} Rendering mosaic (${assignMode === 'section' ? 'section assign' : 'color match'})...`)

    const url = URL.createObjectURL(filteredVideoBlob)
    const video = document.createElement('video')
    video.src = url
    await new Promise<void>(r => { video.onloadedmetadata = () => r() })

    const resMap: Record<string, number> = { original: video.videoHeight, '1080': 1080, '720': 720, '540': 540 }
    const targetH = resMap[batchExport.resolution] ?? video.videoHeight
    const scale = targetH / video.videoHeight
    const W = Math.round(video.videoWidth * scale)
    const H = Math.round(video.videoHeight * scale)
    const FPS = batchExport.fps
    const totalFrames = Math.floor(video.duration * FPS)

    onLog('debug', `${label} ${W}×${H} · ${totalFrames} frames @ ${FPS}fps`)
    updateItem(index, { framesTotal: totalFrames })

    const srcCanvas = document.createElement('canvas')
    srcCanvas.width = W; srcCanvas.height = H
    const srcCtx = srcCanvas.getContext('2d')!

    const outCanvas = document.createElement('canvas')
    outCanvas.width = W; outCanvas.height = H

    const encoder = await createFrameEncoder(FPS)
    const tracker = new RegionTracker(stability.holdFrames, stability.reassignAggression, stability.reassignAggression > 0)
    let prevRegions: Region[] | null = null
    lastPct.current[item.name] = -1

    // Temporal stride: reuse SLIC results for N consecutive frames (~3× speed)
    const STRIDE_INTERVAL = 3
    let cachedSLIC: ProcessFrameResult | null = null

    for (let fi = 0; fi < totalFrames; fi++) {
      if (abortRef.current) {
        URL.revokeObjectURL(url)
        throw new Error(`${label} Aborted at frame ${fi + 1}/${totalFrames}`)
      }

      video.currentTime = fi / FPS
      await new Promise<void>(r => { video.onseeked = () => r() })

      srcCtx.drawImage(video, 0, 0, W, H)
      const imageData = srcCtx.getImageData(0, 0, W, H)

      // Only run full SLIC pipeline every STRIDE_INTERVAL frames
      if (fi % STRIDE_INTERVAL === 0 || !cachedSLIC) {
        const result = await processFrame(
          imageData.data, W, H,
          mosaic.density, mosaic.compactness, mosaic.chunkiness, ink.thickness
        )
        if (!result.regions || result.regions.length === 0) {
          URL.revokeObjectURL(url)
          throw new Error(`${label} Frame ${fi + 1}: no regions from SLIC`)
        }
        cachedSLIC = result
      }

      const { regions, inkMask, labelMap } = cachedSLIC

      const tracked = tracker.trackRegions(regions, prevRegions)
      prevRegions = tracked

      const emotion = smoothedTimeline[fi]?.emotion ?? 'neutral'
      let imageCache: CachedImage[]
      if (assignMode === 'section' && sectionFrameMap) {
        const si = sectionFrameMap[fi] ?? 0
        imageCache =
          imageCache_bySection.get(si) ??
          [...imageCache_bySection.values()].find(c => c.length > 0) ??
          []
      } else {
        imageCache =
          imageCache_byEmotion.get(emotion) ??
          imageCache_byEmotion.get('neutral') ??
          [...imageCache_byEmotion.values()].find(c => c.length > 0) ??
          []
      }

      if (imageCache.length === 0) {
        URL.revokeObjectURL(url)
        throw new Error(`${label} Frame ${fi + 1}: empty image cache for ${assignMode === 'section' ? `section ${sectionFrameMap?.[fi]}` : `emotion "${emotion}"`}`)
      }

      const neutralCacheArr = hardcodedNeutralCache.current.length > 0 ? hardcodedNeutralCache.current : (imageCache_byEmotion?.get('neutral') ?? [])
      const output = renderFrame(labelMap, inkMask, tracked, W, H, renderMode, imageCache, stability.seed, 3, undefined, tracker, imageData.data, neutralCacheArr, mosaic.neutralBackground ?? 'off', ink.color, mosaic.characterContrast ?? 0)
      outCanvas.getContext('2d')!.putImageData(output, 0, 0)
      await encoder.addFrame(outCanvas)

      // Progress: analysis was 15%, render is 15%→100%
      const renderFrac = (fi + 1) / totalFrames
      const overallProgress = 0.15 + renderFrac * 0.85
      updateItem(index, { progress: overallProgress, framesCurrent: fi + 1 })

      // Log milestones
      const pct = Math.floor(renderFrac * 5) * 20
      if (pct > (lastPct.current[item.name] ?? -1)) {
        lastPct.current[item.name] = pct
        onLog('debug', `${label} ${pct}% (frame ${fi + 1}/${totalFrames})`)
      }

      await new Promise(r => setTimeout(r, 0))
    }

    URL.revokeObjectURL(url)
    onLog('debug', `${label} Encoding ${totalFrames} frames to MP4...`)
    const blob = await encoder.finalize()
    updateItem(index, { status: 'done', progress: 1, outputBlob: blob })
    onLog('success', `${label} Done — ${(blob.size / 1024 / 1024).toFixed(1)} MB MP4`)
  }, [filteredVideoBlob, emotionTimeline, filteredShots, mosaic, ink, stability, batchExport, renderMode, assignMode, updateItem, onLog])

  // ── Queue runner ────────────────────────────────────────────────────────────

  const handleStartQueue = useCallback(async () => {
    if (!filteredVideoBlob) {
      onLog('error', 'No character cut video — complete the characters phase first')
      return
    }
    if (subfolders.length === 0) {
      onLog('error', 'No subfolders loaded — pick a folder first')
      return
    }

    setRunning(true)
    abortRef.current = false
    onSetActiveProcess('Batch Render')
    onLog('info', `─── Batch Render Queue (${subfolders.length} subfolder(s)) ──────────`)

    for (let i = 0; i < subfolders.length; i++) {
      if (abortRef.current) {
        onLog('warning', 'Batch render aborted by user')
        break
      }
      const item = subfolders[i]
      if (item.status === 'done') {
        onLog('debug', `[${item.name}] Already done — skipping`)
        continue
      }
      onLog('info', `[${item.name}] Starting (${i + 1}/${subfolders.length})...`)
      try {
        await renderSubfolder(i, item)
      } catch (err) {
        updateItem(i, { status: 'error', error: (err as Error).message })
        onLog('error', `[${item.name}] Failed: ${(err as Error).message}`)
        if (abortRef.current) break
        // Continue with next subfolder on non-abort errors
      }
    }

    setRunning(false)
    onSetActiveProcess(null)
    const doneCount = subfolders.filter(s => s.status === 'done').length
    onLog(doneCount > 0 ? 'success' : 'warning', `Batch complete — ${doneCount}/${subfolders.length} render(s) succeeded`)
  }, [filteredVideoBlob, subfolders, renderSubfolder, updateItem, onLog, onSetActiveProcess])

  // ── Combined render: all subfolders → emotion map → single output ──────────

  const handleCombinedRender = useCallback(async () => {
    if (!filteredVideoBlob) {
      onLog('error', 'No character cut video — complete the characters phase first')
      return
    }
    if (subfolders.length === 0) {
      onLog('error', 'No subfolders loaded — pick a folder first')
      return
    }

    setRunning(true)
    setCombinedOutputBlob(null)
    setCombinedProgress(0)
    setCombinedFrameCurrent(0)
    abortRef.current = false
    onSetActiveProcess('Combined Render')
    onLog('info', '─── Combined Render ──────────────────────────────────')

    // ── Step 1: Smooth timeline ────────────────────────────────────────────
    const shotsForSmoothing = filteredShots && filteredShots.length > 0 ? filteredShots : []
    const smoothedTimeline = smoothTimeline(emotionTimeline, shotsForSmoothing, stability.emotionSmoothing)
    if (!smoothedTimeline || smoothedTimeline.length === 0) {
      onLog('error', 'Failed to create smoothed timeline')
      setRunning(false); onSetActiveProcess(null)
      return
    }

    // ── Step 2: Build emotion→image cache map from all subfolders ──────────
    onLog('info', `Mapping ${subfolders.length} subfolder(s) to emotions...`)
    const emotionCacheMap = new Map<string, CachedImage[]>()

    for (let i = 0; i < subfolders.length; i++) {
      if (abortRef.current) break
      const item = subfolders[i]
      const namedEmotion = resolveSubfolderEmotion(item.name)
      onLog('info', `[${item.name}] → ${namedEmotion ? `"${namedEmotion}"` : 'color analysis'}`)

      if (namedEmotion) {
        // Direct load — name matches emotion exactly, no color analysis needed
        const cache = await loadFilesToCache(
          item.files,
          p => setCombinedProgress(((i + p) / subfolders.length) * 0.2)
        )
        const existing = emotionCacheMap.get(namedEmotion) ?? []
        emotionCacheMap.set(namedEmotion, [...existing, ...cache])
        onLog('debug', `  ${cache.length} images → "${namedEmotion}"`)
      } else {
        // Color analyze — assign images to whichever emotion their colors match
        const { buckets } = await analyzeImagePool(
          item.files,
          p => setCombinedProgress(((i + p) / subfolders.length) * 0.2),
          50
        )
        const emotionCaches = await buildImageCachesFromBuckets(buckets)
        for (const [emotion, cache] of emotionCaches) {
          if (cache.length === 0) continue
          const existing = emotionCacheMap.get(emotion) ?? []
          emotionCacheMap.set(emotion, [...existing, ...cache])
        }
        const mapped = [...emotionCaches.entries()].filter(([, c]) => c.length > 0).map(([e, c]) => `${e}:${c.length}`).join(' ')
        onLog('debug', `  color analysis → ${mapped || 'empty'}`)
      }
    }

    const totalMapped = [...emotionCacheMap.values()].reduce((s, c) => s + c.length, 0)
    if (totalMapped === 0) {
      onLog('error', 'No images loaded from any subfolder')
      setRunning(false); onSetActiveProcess(null)
      return
    }
    const emotionSummary = [...emotionCacheMap.entries()]
      .filter(([, c]) => c.length > 0)
      .map(([e, c]) => `${e}:${c.length}`)
      .join(' · ')
    onLog('success', `Emotion map ready — ${emotionSummary}`)

    // ── Step 3: Single render pass ─────────────────────────────────────────
    const url = URL.createObjectURL(filteredVideoBlob)
    const video = document.createElement('video')
    video.src = url
    await new Promise<void>(r => { video.onloadedmetadata = () => r() })

    const resMap: Record<string, number> = { original: video.videoHeight, '1080': 1080, '720': 720, '540': 540 }
    const targetH = resMap[batchExport.resolution] ?? video.videoHeight
    const scale = targetH / video.videoHeight
    const W = Math.round(video.videoWidth * scale)
    const H = Math.round(video.videoHeight * scale)
    const FPS = batchExport.fps
    const totalFrames = Math.floor(video.duration * FPS)

    setCombinedFrameTotal(totalFrames)
    onLog('debug', `${W}×${H} · ${totalFrames} frames @ ${FPS}fps`)

    const srcCanvas = document.createElement('canvas')
    srcCanvas.width = W; srcCanvas.height = H
    const srcCtx = srcCanvas.getContext('2d')!
    const outCanvas = document.createElement('canvas')
    outCanvas.width = W; outCanvas.height = H

    const encoder = await createFrameEncoder(FPS)
    const tracker = new RegionTracker(stability.holdFrames, stability.reassignAggression, stability.reassignAggression > 0)
    let prevRegions: Region[] | null = null
    let lastLogPct = -1

    // Temporal stride: reuse SLIC results for N consecutive frames (~3× speed)
    const STRIDE_INTERVAL = 3
    let cachedSLIC: ProcessFrameResult | null = null

    try {
      for (let fi = 0; fi < totalFrames; fi++) {
        if (abortRef.current) {
          URL.revokeObjectURL(url)
          onLog('warning', `Aborted at frame ${fi + 1}/${totalFrames}`)
          break
        }

        video.currentTime = fi / FPS
        await new Promise<void>(r => { video.onseeked = () => r() })

        srcCtx.drawImage(video, 0, 0, W, H)
        const imageData = srcCtx.getImageData(0, 0, W, H)

        // Only run full SLIC pipeline every STRIDE_INTERVAL frames
        if (fi % STRIDE_INTERVAL === 0 || !cachedSLIC) {
          const result = await processFrame(
            imageData.data, W, H,
            mosaic.density, mosaic.compactness, mosaic.chunkiness, ink.thickness
          )
          if (!result.regions || result.regions.length === 0) {
            URL.revokeObjectURL(url); throw new Error(`Frame ${fi + 1}: no regions from SLIC`)
          }
          cachedSLIC = result
        }

        const { regions, inkMask, labelMap } = cachedSLIC

        const tracked = tracker.trackRegions(regions, prevRegions)
        prevRegions = tracked

        const emotion = smoothedTimeline[fi]?.emotion ?? 'neutral'
        const imageCache =
          emotionCacheMap.get(emotion) ??
          emotionCacheMap.get('neutral') ??
          [...emotionCacheMap.values()].find(c => c.length > 0) ?? []

        // Always re-render pixels with fresh source data for brightness matching
        const neutralCacheArr = hardcodedNeutralCache.current.length > 0 ? hardcodedNeutralCache.current : (emotionCacheMap.get('neutral') ?? [])
        const output = renderFrame(labelMap, inkMask, tracked, W, H, renderMode, imageCache, stability.seed, 3, undefined, tracker, imageData.data, neutralCacheArr, mosaic.neutralBackground ?? 'off', ink.color, mosaic.characterContrast ?? 0)
        outCanvas.getContext('2d')!.putImageData(output, 0, 0)
        await encoder.addFrame(outCanvas)

        const renderFrac = (fi + 1) / totalFrames
        setCombinedProgress(0.2 + renderFrac * 0.8)
        setCombinedFrameCurrent(fi + 1)

        const pct = Math.floor(renderFrac * 5) * 20
        if (pct > lastLogPct) {
          lastLogPct = pct
          onLog('debug', `${pct}% (frame ${fi + 1}/${totalFrames}) — ${emotion}`)
        }
        await new Promise(r => setTimeout(r, 0))
      }

      if (!abortRef.current) {
        URL.revokeObjectURL(url)
        onLog('debug', `Encoding ${totalFrames} frames to MP4...`)
        const blob = await encoder.finalize()
        setCombinedOutputBlob(blob)
        onLog('success', `Done — ${(blob.size / 1024 / 1024).toFixed(1)} MB MP4`)
      }
    } catch (err) {
      URL.revokeObjectURL(url)
      onLog('error', `Combined render failed: ${(err as Error).message}`)
    }

    setRunning(false)
    onSetActiveProcess(null)
  }, [filteredVideoBlob, emotionTimeline, filteredShots, subfolders, mosaic, ink, stability, batchExport, renderMode, onLog, onSetActiveProcess])

  // ── Download helper ─────────────────────────────────────────────────────────

  function downloadBlob(blob: Blob, subfolderName: string) {
    const base = videoFileName?.replace(/\.[^.]+$/, '') ?? 'output'
    const filename = `${base}_${subfolderName}_mosaic.mp4`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    onLog('success', `Downloaded: ${filename}`)
  }

  // ── Settings slider ─────────────────────────────────────────────────────────

  const SliderRow = ({ label, value, min, max, step, onChange }: {
    label: string; value: number; min: number; max: number; step: number
    onChange: (v: number) => void
  }) => (
    <div className="flex items-center gap-3">
      <label className="w-28 shrink-0">{label}</label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 accent-[#B98B82]" />
      <span className="numeric text-xs w-10 text-right">{value}</span>
    </div>
  )

  // ── Status badge ────────────────────────────────────────────────────────────

  function StatusBadge({ item }: { item: SubfolderItem }) {
    const statusColors: Record<SubfolderStatus, string> = {
      pending: 'text-muted-foreground',
      scanning: 'text-[#B98B82]',
      analyzing: 'text-[#B98B82]',
      rendering: 'text-[#667761]',
      done: 'text-[#667761]',
      error: 'text-destructive',
    }
    const statusLabels: Record<SubfolderStatus, string> = {
      pending: 'waiting',
      scanning: 'scanning...',
      analyzing: 'analyzing...',
      rendering: `rendering ${item.framesCurrent}/${item.framesTotal}`,
      done: 'done',
      error: `error: ${item.error ?? 'unknown'}`,
    }
    return (
      <div className="flex items-center gap-2 min-w-0">
        <span className={`text-xs ${statusColors[item.status]}`}>
          {statusLabels[item.status]}
        </span>
        {(item.status === 'analyzing' || item.status === 'rendering') && (
          <div className="flex-1 max-w-32 bg-border h-1">
            <div
              className="h-1 bg-[#B98B82] transition-all"
              style={{ width: `${Math.round(item.progress * 100)}%` }}
            />
          </div>
        )}
      </div>
    )
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Step 6 — Batch Render</h2>
        <p className="body-text">
          {renderStyle === 'combined'
            ? 'Pick a parent folder of emotion subfolders (Calm/, Excited/, Sad/…). Each subfolder supplies tiles only during its matching emotion section — one combined output video.'
            : 'Pick a parent folder. Each subfolder becomes its own mosaic render using 50 random images from that folder.'}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* Left: folder + queue */}
        <div className="space-y-4">
          {/* Folder picker */}
          <div className="flex gap-2">
            <button
              onClick={handlePickFolder}
              disabled={scanning || running}
              className="flex-1 py-2.5 text-xs uppercase tracking-wider border border-border hover:border-[#B98B82] hover:text-[#B98B82] disabled:opacity-30 transition-colors"
            >
              {scanning ? 'Scanning folder...' : 'Select Vibes Folder'}
            </button>
            {subfolders.length > 0 && !running && (
              <button
                onClick={handlePickFolder}
                disabled={scanning}
                className="px-4 py-2.5 text-xs uppercase tracking-wider border border-border text-muted-foreground hover:text-foreground transition-colors"
                title="Rescan / pick different folder"
              >
                ↺
              </button>
            )}
          </div>

          {/* Subfolder list */}
          {subfolders.length > 0 && (
            <div className="border border-border divide-y divide-border">
              {subfolders.map((item, i) => (
                <div key={item.name} className="px-4 py-3 flex items-center gap-4">
                  {/* Index */}
                  <span className="text-xs text-muted-foreground/50 w-5 shrink-0">{i + 1}</span>

                  {/* Name + image count */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{item.name}/</p>
                      {renderStyle === 'combined' && (
                        <span className={`text-xs px-1.5 py-0.5 border shrink-0 ${
                          resolveSubfolderEmotion(item.name)
                            ? 'border-[#667761]/40 text-[#667761]'
                            : 'border-border text-muted-foreground'
                        }`}>
                          {resolveSubfolderEmotion(item.name) ?? 'color →'}
                        </span>
                      )}
                    </div>
                    <p className="caption">
                      {item.files.length} sampled
                      {item.imageCount > item.files.length ? ` of ${item.imageCount}` : ''} images
                    </p>
                  </div>

                  {/* Status (separate mode only) */}
                  {renderStyle === 'separate' && <StatusBadge item={item} />}

                  {/* Download (separate mode only) */}
                  {renderStyle === 'separate' && item.status === 'done' && item.outputBlob && (
                    <button
                      onClick={() => downloadBlob(item.outputBlob!, item.name)}
                      className="px-3 py-1 text-xs uppercase tracking-wider border border-[#667761] text-[#667761] hover:bg-[#667761] hover:text-white transition-colors shrink-0"
                    >
                      ↓ MP4
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Queue / combined controls */}
          {subfolders.length > 0 && (
            <div className="space-y-2">
              {/* Time estimate (both modes) */}
              {estimatedFramesPerRender && !running && (
                <div className={`px-3 py-2 text-xs border ${
                  estimatedMinPerRender && estimatedMinPerRender > 10
                    ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400'
                    : 'border-border text-muted-foreground'
                }`}>
                  {renderStyle === 'combined'
                    ? `~${estimatedFramesPerRender} frames · ~${estimatedMinPerRender} min`
                    : `~${estimatedFramesPerRender} frames per render · ~${estimatedMinPerRender} min each · ~${Math.round((estimatedMinPerRender ?? 0) * subfolders.filter(s => s.status !== 'done').length)} min total`}
                  {estimatedMinPerRender && estimatedMinPerRender > 10 && (
                    <span className="ml-1">— consider lowering FPS or resolution →</span>
                  )}
                </div>
              )}

              {/* Combined render progress */}
              {renderStyle === 'combined' && running && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{combinedFrameCurrent === 0 ? 'Loading images...' : `Frame ${combinedFrameCurrent} / ${combinedFrameTotal}`}</span>
                    <span>{Math.round(combinedProgress * 100)}%</span>
                  </div>
                  <div className="bg-border h-1">
                    <div className="h-1 bg-[#B98B82] transition-all" style={{ width: `${Math.round(combinedProgress * 100)}%` }} />
                  </div>
                </div>
              )}

              {/* Combined output download */}
              {renderStyle === 'combined' && combinedOutputBlob && !running && (
                <button
                  onClick={() => downloadBlob(combinedOutputBlob, 'combined')}
                  className="w-full py-2.5 text-xs uppercase tracking-wider border border-[#667761] text-[#667761] hover:bg-[#667761] hover:text-white transition-colors"
                >
                  ↓ Download Combined MP4
                </button>
              )}

            <div className="flex gap-2">
              {renderStyle === 'combined' ? (
                <button
                  onClick={handleCombinedRender}
                  disabled={running || !filteredVideoBlob}
                  className="flex-1 py-2.5 text-xs uppercase tracking-wider bg-[#37515F] text-white disabled:opacity-30 hover:bg-[#2d4450] transition-colors"
                >
                  {running ? 'Rendering combined...' : `Render Combined (${subfolders.length} emotion${subfolders.length !== 1 ? 's' : ''})`}
                </button>
              ) : (
                <button
                  onClick={handleStartQueue}
                  disabled={running || !filteredVideoBlob}
                  className="flex-1 py-2.5 text-xs uppercase tracking-wider bg-[#B98B82] text-white disabled:opacity-30 hover:bg-[#a0786f] transition-colors"
                >
                  {running
                    ? `Rendering ${subfolders.filter(s => s.status === 'rendering').map(s => s.name).join(', ')}...`
                    : `Start Queue (${subfolders.length} render${subfolders.length !== 1 ? 's' : ''})`
                  }
                </button>
              )}
              {running && (
                <button
                  onClick={() => { abortRef.current = true }}
                  className="px-4 py-2.5 text-xs uppercase tracking-wider border border-destructive text-destructive hover:bg-destructive hover:text-white transition-colors"
                >
                  Abort
                </button>
              )}
            </div>
            </div>
          )}

          {/* Empty state */}
          {subfolders.length === 0 && !scanning && (
            <div className="border border-dashed border-border p-8 text-center space-y-2">
              <p className="text-sm text-muted-foreground">No folder selected yet</p>
              <p className="caption">
                {renderStyle === 'combined'
                  ? <>Pick a parent folder with subfolders named after emotions.<br />
                      e.g. <code className="text-xs bg-muted px-1">Calm/</code> <code className="text-xs bg-muted px-1">Excited/</code> <code className="text-xs bg-muted px-1">Sad/</code> → one video, tiles swap at each section.</>
                  : <>Pick a parent folder containing subfolders.<br />
                      Each subfolder (e.g. <code className="text-xs bg-muted px-1">nature/</code>, <code className="text-xs bg-muted px-1">urban/</code>) becomes one mosaic render.</>
                }
              </p>
            </div>
          )}

          {/* No video warning */}
          {!filteredVideoBlob && (
            <div className="border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/20 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
              No character cut video — go back to the Characters phase and generate one first.
            </div>
          )}
        </div>

        {/* Right: settings */}
        <div className="space-y-4">
          {/* Output style */}
          <div className="border border-border p-4 space-y-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Output</h2>
            <div className="flex gap-1">
              {(['combined', 'separate'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setRenderStyle(s)}
                  disabled={running}
                  className={`flex-1 py-1.5 text-xs border transition-colors ${
                    renderStyle === s ? 'bg-[#37515F] text-white border-[#37515F]' : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {s === 'combined' ? 'Combined' : 'Separate'}
                </button>
              ))}
            </div>
            <p className="caption text-muted-foreground">
              {renderStyle === 'combined'
                ? '1 video — each subfolder supplies tiles only during its matching emotion section'
                : 'N videos — one complete render per subfolder using all its images'}
            </p>
          </div>

          {/* Image assignment mode (separate only) */}
          {renderStyle === 'separate' && (
          <div className="border border-border p-4 space-y-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Image Assignment</h2>
            <div className="flex gap-1">
              {(['section', 'color'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setAssignMode(m)}
                  className={`flex-1 py-1.5 text-xs border transition-colors ${
                    assignMode === m ? 'bg-[#B98B82] text-white border-[#B98B82]' : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m === 'section' ? 'Section Assign' : 'Color Match'}
                </button>
              ))}
            </div>
            <p className="caption text-muted-foreground">
              {assignMode === 'section'
                ? 'Each timeline section gets its own unique slice of images — works for any subfolder regardless of color'
                : 'Images sorted into emotion buckets by dominant color — best when subfolder has color variety'}
            </p>
          </div>
          )}

          {/* Render mode */}
          <div className="border border-border p-4 space-y-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Render Mode</h2>
            <div className="flex gap-1">
              {(['sticker', 'wrap', 'planes'] as RenderMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => onRenderModeChange(m)}
                  className={`flex-1 py-1.5 text-xs border transition-colors ${
                    renderMode === m ? 'bg-[#B98B82] text-white border-[#B98B82]' : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Mosaic */}
          <div className="border border-border p-4 space-y-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Mosaic</h2>

            <div>
              <div className="flex items-center gap-3 mb-1">
                <label className="w-28 shrink-0 text-xs">Density</label>
                <div className="flex gap-1 flex-1">
                  {([
                    { key: 'coarse' as const, label: 'Coarse (~500)' },
                    { key: 'medium' as const, label: 'Medium (~2k)' },
                    { key: 'fine' as const, label: 'Fine (~5k)' },
                  ]).map(d => (
                    <button key={d.key} onClick={() => onMosaicChange({ ...mosaic, density: d.key })}
                      className={`flex-1 py-1 text-xs border transition-colors ${mosaic.density === d.key ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground'}`}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">Tile count at 1080p. More tiles = more detail but slower.</p>
            </div>

            <div>
              <SliderRow label="Tile Shape" value={mosaic.compactness} min={1} max={40} step={1} onChange={v => onMosaicChange({ ...mosaic, compactness: v })} />
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">Low = organic shapes that follow edges. High = uniform grid.</p>
            </div>

            <div>
              <SliderRow label="Tile Merge" value={mosaic.chunkiness} min={0} max={100} step={1} onChange={v => onMosaicChange({ ...mosaic, chunkiness: v })} />
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">How much similar tiles merge. 0 = all small. 100 = similar colors become one region.</p>
            </div>

            <div>
              <div className="flex items-center gap-3 mb-1">
                <label className="w-28 shrink-0 text-xs">Neutral BG</label>
                <div className="flex gap-1 flex-1">
                  {([
                    { key: 'off' as const, label: 'Off' },
                    { key: 'skin' as const, label: 'Face Color' },
                    { key: 'skin-reverse' as const, label: 'Face Neutral' },
                    { key: 'luminance' as const, label: 'Brightness' },
                    { key: 'size' as const, label: 'Size' },
                  ]).map(mode => (
                    <button key={mode.key} onClick={() => onMosaicChange({ ...mosaic, neutralBackground: mode.key })}
                      className={`flex-1 py-1 text-[10px] border transition-colors ${(mosaic.neutralBackground ?? 'off') === mode.key ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground'}`}>
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">
                {(mosaic.neutralBackground ?? 'off') === 'skin'
                  ? 'Face/skin = emotional tiles, background = neutral. Makes faces pop with color.'
                  : (mosaic.neutralBackground ?? 'off') === 'skin-reverse'
                  ? 'Face/skin = neutral tiles, background = emotional. Colors surround the face.'
                  : (mosaic.neutralBackground ?? 'off') === 'luminance'
                  ? 'Dark/colorless = neutral, bright/colorful = emotional.'
                  : (mosaic.neutralBackground ?? 'off') === 'size'
                  ? 'Small detail = neutral (readability), large flat = emotional (color).'
                  : 'All tiles chosen by emotion.'}
              </p>
              <div className="flex items-center gap-2 mt-1 ml-[7.5rem]">
                <button onClick={handlePickNeutralFolder}
                  className="px-2 py-0.5 text-[10px] border border-border text-muted-foreground hover:bg-muted transition-colors">
                  {neutralLoaded ? 'Change Neutral Folder' : 'Set Neutral Folder'}
                </button>
                {neutralCount > 0 && <span className="text-[10px] text-muted-foreground">{neutralCount} tiles loaded</span>}
              </div>
            </div>

            <div>
              <SliderRow label="Figure/Ground" value={mosaic.characterContrast ?? 0} min={0} max={1} step={0.05} onChange={v => onMosaicChange({ ...mosaic, characterContrast: v })} />
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">Separates faces from background using different tile subsets. 0 = off. Higher = more contrast between character and surroundings.</p>
            </div>
          </div>

          {/* Ink */}
          <div className="border border-border p-4 space-y-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Ink</h2>
            <div>
              <SliderRow label="Thickness" value={ink.thickness} min={1} max={8} step={1} onChange={v => onInkChange({ ...ink, thickness: v })} />
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">Outline between tiles. 1 = hairline. 8 = thick comic-book borders.</p>
            </div>
            <div>
              <div className="flex items-center gap-3">
                <label className="w-28 shrink-0 text-xs">Color</label>
                <input
                  type="color"
                  value={ink.color ?? '#1f0812'}
                  onChange={e => onInkChange({ ...ink, color: e.target.value })}
                  className="w-8 h-8 border border-border cursor-pointer bg-transparent p-0"
                />
                <span className="text-xs text-muted-foreground font-mono">{ink.color ?? '#1f0812'}</span>
              </div>
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">Outline color. Click to pick any color.</p>
            </div>
          </div>

          {/* Stability */}
          <div className="border border-border p-4 space-y-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Stability</h2>
            <div>
              <SliderRow label="Hold Frames" value={stability.holdFrames} min={0} max={30} step={1} onChange={v => onStabilityChange({ ...stability, holdFrames: v })} />
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">How many frames a tile keeps its assigned image before it can change. Higher = less flickering, calmer video.</p>
            </div>
            <div>
              <SliderRow label="Tile Swap" value={stability.reassignAggression} min={0} max={100} step={1} onChange={v => onStabilityChange({ ...stability, reassignAggression: v })} />
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">0 = tiles keep their image forever. Higher = tiles swap images more often when emotion changes.</p>
            </div>
            <div>
              <SliderRow label="Timeline Smooth" value={stability.emotionSmoothing} min={0} max={1} step={0.05} onChange={v => onStabilityChange({ ...stability, emotionSmoothing: v })} />
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">0 = raw per-frame emotion. 1 = one emotion per camera cut. Reduces flickering between emotions.</p>
            </div>
          </div>

          {/* Export */}
          <div className="border border-border p-4 space-y-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Export</h2>
            <div>
              <div className="flex items-center gap-3">
                <label className="w-28 shrink-0">Resolution</label>
                <select
                  value={batchExport.resolution}
                  onChange={e => setBatchExport(s => ({ ...s, resolution: e.target.value as ExportSettings['resolution'] }))}
                  className="flex-1 border border-border bg-background text-xs px-2 py-1"
                >
                  {['original', '1080', '720', '540'].map(r => (
                    <option key={r} value={r}>{r === 'original' ? 'Original' : `${r}p`}</option>
                  ))}
                </select>
              </div>
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">Output video height. Higher = more detail but slower render. 1080p is full HD.</p>
            </div>
            <div>
              <SliderRow label="FPS" value={batchExport.fps} min={6} max={60} step={1} onChange={v => setBatchExport(s => ({ ...s, fps: v }))} />
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">Frames per second. 24 = cinematic, 30 = standard video, 60 = buttery smooth. Higher = longer render.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

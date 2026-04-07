import { useRef, useState, useCallback, useEffect } from 'react'
import type { MosaicSettings, InkSettings, StabilitySettings, ExportSettings, EmotionFrame, RenderMode, ExportProgress, Shot, Region } from '../../lib/types'
import type { EmotionBuckets } from '../../lib/image-color-analyzer'
import type { CachedImage, ProcessFrameResult } from '../../lib/renderer'
import { processFrame, renderFrame, computeMeanL, computeColorTemp } from '../../lib/renderer'
import { createFrameEncoder } from '../../lib/stitcher'
import { RegionTracker } from '../../lib/region-tracker'
import { getEmotionAtFrame, smoothTimeline } from '../../lib/emotion-timeline'
import { tryAutoLoadNeutralCache, pickNeutralFolder } from '../../lib/neutral-loader'
import type { ConsoleEntry } from '../Console'

interface RenderPhaseProps {
  filteredVideoBlob: Blob | null
  emotionTimeline: EmotionFrame[]
  filteredShots: Shot[]
  buckets: EmotionBuckets
  mosaic: MosaicSettings
  ink: InkSettings
  stability: StabilitySettings
  exportSettings: ExportSettings
  renderMode: RenderMode
  onMosaicChange: (s: MosaicSettings) => void
  onInkChange: (s: InkSettings) => void
  onStabilityChange: (s: StabilitySettings) => void
  onExportChange: (s: ExportSettings) => void
  onRenderModeChange: (m: RenderMode) => void
  onLog: (level: ConsoleEntry['level'], message: string, data?: any) => void
  onSetActiveProcess: (name: string | null) => void
}

export function RenderPhase({
  filteredVideoBlob,
  emotionTimeline,
  filteredShots: inputFilteredShots,
  buckets,
  mosaic,
  ink,
  stability,
  exportSettings,
  renderMode,
  onMosaicChange,
  onInkChange,
  onStabilityChange,
  onExportChange,
  onRenderModeChange,
  onLog,
  onSetActiveProcess,
}: RenderPhaseProps) {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const [rendering, setRendering] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [outputUrl, setOutputUrl] = useState<string | null>(null)
  const abortRef = useRef(false)
  const lastRenderPct = useRef(-1)

  // Ensure filteredShots is always defined (may be empty array)
  const filteredShots = inputFilteredShots ?? []

  // ── Neutral tile cache (white/grey images from user's Neutral folder) ──
  // Persisted via File System Access API — auto-loads if permission granted,
  // otherwise needs a one-time folder pick via the "Set Neutral Folder" button.
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

  // ── Image cache builder ───────────────────────────────────────────────────

  const imageCacheByEmotion = useRef<Map<string, CachedImage[]>>(new Map())

  async function buildImageCaches() {
    imageCacheByEmotion.current.clear()

    // Check for pre-built library caches first (from Library → Send to Render)
    const libCaches = (window as any).__libraryCaches as Map<string, CachedImage[]> | undefined
    if (libCaches && libCaches.size > 0) {
      let total = 0
      for (const [emotion, cached] of libCaches) {
        imageCacheByEmotion.current.set(emotion, cached)
        total += cached.length
        onLog('debug', `  ${emotion}: ${cached.length} image(s) from library cache`)
      }
      onLog('success', `Using library cache — ${total} image(s) across ${libCaches.size} emotion(s)`)
      return
    }

    const allEmotions = Object.keys(buckets)
    onLog('info', `Building image caches for ${allEmotions.length} emotion bucket(s)...`)

    let totalAssets = 0, totalCached = 0, skipped = 0

    for (const emotion of allEmotions) {
      const assets = buckets[emotion] ?? []
      totalAssets += assets.length

      const cached: CachedImage[] = []
      for (const asset of assets) {
        try {
          // Check for pre-cached data from library
          if ((asset as any)._cachedData) {
            cached.push((asset as any)._cachedData as CachedImage)
            totalCached++
            continue
          }

          // Skip assets with null bitmap (failed iCloud downloads)
          if (!asset.bitmap) {
            onLog('debug', `  ${emotion}: skipping ${asset.file.name} (null bitmap)`)
            skipped++
            continue
          }

          const canvas = document.createElement('canvas')
          canvas.width = asset.bitmap.width
          canvas.height = asset.bitmap.height
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            onLog('debug', `  ${emotion}: skipping ${asset.file.name} (no canvas context)`)
            skipped++
            continue
          }

          ctx.drawImage(asset.bitmap, 0, 0)
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          cached.push({ width: canvas.width, height: canvas.height, data: imgData.data, meanL: computeMeanL(imgData.data), colorTemp: computeColorTemp(imgData.data) })
          totalCached++
        } catch (err) {
          onLog('debug', `  ${emotion}: skipping ${asset.file.name} (${(err as Error).message})`)
          skipped++
        }
      }

      imageCacheByEmotion.current.set(emotion, cached)
      onLog('debug', `  ${emotion}: ${cached.length}/${assets.length} image(s) cached (${assets.length - cached.length} skipped)`)
    }

    if (totalCached === 0) {
      throw new Error(`No valid images to cache (${skipped} skipped, ${totalAssets} total)`)
    }

    onLog('success', `Image caches ready — ${totalCached}/${totalAssets} image(s) cached (${skipped} skipped)`)
  }

  function getImageCacheForFrame(frameIndex: number): CachedImage[] {
    const emotion = getEmotionAtFrame(emotionTimeline, frameIndex)
    if (imageCacheByEmotion.current.has(emotion)) {
      return imageCacheByEmotion.current.get(emotion)!
    }
    // fallback: neutral → any
    const neutral = imageCacheByEmotion.current.get('neutral')
    if (neutral?.length) return neutral
    const first = [...imageCacheByEmotion.current.values()].find(c => c.length > 0)
    return first ?? []
  }

  // ── Preview single frame ──────────────────────────────────────────────────

  async function previewFrame() {
    if (!filteredVideoBlob || !previewCanvasRef.current) {
      onLog('error', 'Cannot generate preview: no video or canvas ref')
      return
    }

    try {
      onLog('info', '─── Preview Frame ────────────────────────────────────────')
      onLog('info', 'Generating mosaic preview (10% into video)...')

    const url = URL.createObjectURL(filteredVideoBlob)
    const video = document.createElement('video')
    video.src = url
    await new Promise<void>(r => { video.onloadedmetadata = () => r() })

    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 960 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')!
    video.currentTime = video.duration * 0.1
    await new Promise<void>(r => { video.onseeked = () => r() })
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)

    onLog('debug', `Canvas: ${canvas.width}×${canvas.height} — running SLIC segmentation...`)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    await buildImageCaches()

    const { regions, inkMask, labelMap } = await processFrame(
      imageData.data, canvas.width, canvas.height,
      mosaic.density, mosaic.compactness, mosaic.chunkiness, ink.thickness
    )
    if (!regions || regions.length === 0) {
      throw new Error('processFrame returned no regions')
    }
    onLog('debug', `${regions.length} superpixel region(s) segmented`)

    const imageCache = getImageCacheForFrame(0)
    if (!imageCache || imageCache.length === 0) {
      throw new Error('No valid image cache available for preview')
    }

    const neutralCacheArr = hardcodedNeutralCache.current.length > 0 ? hardcodedNeutralCache.current : (imageCacheByEmotion.current.get('neutral') ?? [])
    const output = renderFrame(labelMap, inkMask, regions, canvas.width, canvas.height, renderMode, imageCache, stability.seed, 3, undefined, undefined, imageData.data, neutralCacheArr, mosaic.neutralBackground ?? 'off', ink.color, mosaic.characterContrast ?? 0)
    if (!output) {
      throw new Error('renderFrame returned no output')
    }

    const out = previewCanvasRef.current
    if (!out) {
      throw new Error('Preview canvas ref not available')
    }
    out.width = canvas.width
    out.height = canvas.height
    out.getContext('2d')!.putImageData(output, 0, 0)
    onLog('success', 'Preview ready')
    } catch (err) {
      onLog('error', `Preview failed: ${(err as Error).message}`)
    }
  }

  // ── Single pass renderer ──────────────────────────────────────────────────

  const renderPass = useCallback(async (
    smoothingFactor: number,
    passLabel: string,
    onPassProgress?: (current: number, total: number) => void
  ): Promise<Blob> => {
    if (!filteredVideoBlob) throw new Error('No video to render')

    try {
      onLog('debug', `${passLabel} — loading video blob...`)

      // Validate filteredShots exists (may be empty if character detection was skipped)
      if (!filteredShots || filteredShots.length === 0) {
        onLog('debug', `${passLabel} — no filtered shots available, using raw emotion timeline`)
      }

      // Apply smoothing to emotion timeline
      const shotsForSmoothing = filteredShots && filteredShots.length > 0 ? filteredShots : []
      const smoothedTimeline = smoothTimeline(emotionTimeline, shotsForSmoothing, smoothingFactor)
      if (!smoothedTimeline || smoothedTimeline.length === 0) {
        throw new Error('Failed to create smoothed timeline')
      }
      onLog('debug', `${passLabel} — timeline smoothed (${smoothedTimeline.length} frames)`)

      const url = URL.createObjectURL(filteredVideoBlob)
      const video = document.createElement('video')
      video.src = url
      await new Promise<void>(r => { video.onloadedmetadata = () => r() })
      onLog('debug', `${passLabel} — video loaded (${video.duration.toFixed(1)}s · ${video.videoWidth}×${video.videoHeight})`)

    const resMap: Record<string, number> = { original: video.videoHeight, '1080': 1080, '720': 720, '540': 540 }
    const targetH = resMap[exportSettings.resolution] ?? video.videoHeight
    const scale = targetH / video.videoHeight
    const W = Math.round(video.videoWidth * scale)
    const H = Math.round(video.videoHeight * scale)

    const FPS = exportSettings.fps
    const totalFrames = Math.floor(video.duration * FPS)

    const srcCanvas = document.createElement('canvas')
    srcCanvas.width = W
    srcCanvas.height = H
    const srcCtx = srcCanvas.getContext('2d')!

    const outCanvas = document.createElement('canvas')
    outCanvas.width = W
    outCanvas.height = H

    const encoder = await createFrameEncoder(FPS)
    const tracker = new RegionTracker(stability.holdFrames, stability.reassignAggression, stability.reassignAggression > 0)
    let prevRegions: Region[] | null = null

    // Temporal stride: reuse SLIC segmentation results for N consecutive frames
    // Only re-run processFrame every STRIDE_INTERVAL frames (~3× speed boost)
    const STRIDE_INTERVAL = 3
    let cachedSLIC: ProcessFrameResult | null = null

    onLog('debug', `${passLabel} — ${W}×${H} · ${totalFrames} frames @ ${FPS}fps · smoothing=${smoothingFactor.toFixed(2)} · stride=${STRIDE_INTERVAL}`)

    for (let fi = 0; fi < totalFrames; fi++) {
      if (abortRef.current) {
        URL.revokeObjectURL(url)
        throw new Error(`Pass aborted at frame ${fi + 1}/${totalFrames}`)
      }

      const time = fi / FPS
      video.currentTime = time
      await new Promise<void>(r => { video.onseeked = () => r() })

      srcCtx.drawImage(video, 0, 0, W, H)
      const imageData = srcCtx.getImageData(0, 0, W, H)

      // Only run full SLIC pipeline every STRIDE_INTERVAL frames (or first frame)
      if (fi % STRIDE_INTERVAL === 0 || !cachedSLIC) {
        const result = await processFrame(
          imageData.data, W, H,
          mosaic.density, mosaic.compactness, mosaic.chunkiness, ink.thickness
        )

        if (!result.regions || result.regions.length === 0) {
          URL.revokeObjectURL(url)
          throw new Error(`Frame ${fi + 1}: processFrame returned no regions`)
        }

        cachedSLIC = result
      }

      const { regions, inkMask, labelMap } = cachedSLIC

      const tracked = tracker.trackRegions(regions, prevRegions)
      prevRegions = tracked

      const emotion = smoothedTimeline[fi]?.emotion ?? 'neutral'
      const imageCache = imageCacheByEmotion.current.get(emotion) ??
        (imageCacheByEmotion.current.get('neutral') ?? [...imageCacheByEmotion.current.values()].find(c => c.length > 0) ?? [])

      if (!imageCache || imageCache.length === 0) {
        URL.revokeObjectURL(url)
        throw new Error(`Frame ${fi + 1}: no image cache for emotion "${emotion}"`)
      }

      // Always re-render pixels with fresh source data (brightness matching uses current frame)
      const neutralCacheArr = hardcodedNeutralCache.current.length > 0 ? hardcodedNeutralCache.current : (imageCacheByEmotion.current.get('neutral') ?? [])
      const output = renderFrame(labelMap, inkMask, tracked, W, H, renderMode, imageCache, stability.seed, 3, undefined, tracker, imageData.data, neutralCacheArr, mosaic.neutralBackground ?? 'off', ink.color, mosaic.characterContrast ?? 0)
      if (!output) {
        URL.revokeObjectURL(url)
        throw new Error(`Frame ${fi + 1}: renderFrame returned no output`)
      }

      outCanvas.getContext('2d')!.putImageData(output, 0, 0)
      if (fi === 0) {
        const px = output.data
        onLog('debug', `${passLabel} — frame 0 pixel[0]: rgba(${px[0]},${px[1]},${px[2]},${px[3]}) — regions: ${tracked.length}`)
      }
      await encoder.addFrame(outCanvas)
      onPassProgress?.(fi + 1, totalFrames)

      const pct = Math.floor((fi / totalFrames) * 5) * 20
      if (pct > lastRenderPct.current) {
        lastRenderPct.current = pct
        onLog('debug', `${passLabel} — ${pct}% (frame ${fi + 1}/${totalFrames})`)
      }

      await new Promise(r => setTimeout(r, 0))
    }

    URL.revokeObjectURL(url)
    onLog('debug', `${passLabel} — encoding ${totalFrames} frames to MP4...`)
    return await encoder.finalize()
    } catch (err) {
      onLog('error', `${passLabel} failed: ${(err as Error).message}`)
      throw err
    }
  }, [filteredVideoBlob, emotionTimeline, filteredShots, buckets, mosaic, ink, stability, exportSettings, renderMode, onLog])

  // ── Multi-pass export orchestrator ─────────────────────────────────────────

  const exportVideo = useCallback(async () => {
    if (!filteredVideoBlob) {
      onLog('error', 'No filtered video blob — cannot start render')
      return
    }

    if (Object.keys(buckets).length === 0 || Object.values(buckets).every(imgs => imgs.length === 0)) {
      onLog('error', 'No images available — upload images in the previous phase')
      return
    }

    if (!emotionTimeline || emotionTimeline.length === 0) {
      onLog('error', 'No emotion timeline — complete the emotion phase first')
      return
    }

    if (!filteredShots) {
      onLog('debug', 'No filtered shots available — will use raw emotion timeline for smoothing')
    }

    setRendering(true)
    abortRef.current = false
    lastRenderPct.current = -1
    setOutputUrl(null)
    onSetActiveProcess('Rendering')

    const resLabel = exportSettings.resolution === 'original' ? 'original res' : `${exportSettings.resolution}p`

    try {
      await buildImageCaches()

      onLog('info', '─── Export ───────────────────────────────────────────────')
      onLog('info', `Rendering with ${Math.round(stability.emotionSmoothing * 100)}% emotion smoothing (${resLabel}, ${exportSettings.fps} fps)`)

      const blob = await renderPass(stability.emotionSmoothing, 'Rendering', (current, total) => {
        setProgress({ stage: 'mosaic', current, total })
      })
      const outUrl = URL.createObjectURL(blob)
      setOutputUrl(outUrl)

      onLog('success', `Export complete — ${(blob.size / 1024 / 1024).toFixed(1)} MB MP4 · ready to download`)
    } catch (err) {
      if (String(err).includes('aborted')) {
        onLog('warning', 'Export cancelled by user')
      } else {
        onLog('error', `Export failed: ${String(err)}`)
      }
    } finally {
      setRendering(false)
      onSetActiveProcess(null)
    }
  }, [filteredVideoBlob, emotionTimeline, filteredShots, buckets, mosaic, ink, stability, exportSettings, renderMode, onLog, onSetActiveProcess, renderPass, buildImageCaches])

  // ── Settings panel helpers ────────────────────────────────────────────────

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

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Step 5 — Render</h2>
        <p className="body-text">Configure the mosaic and export your emotion-driven video.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* Left: preview canvas */}
        <div className="space-y-3">
          <div className="border border-border bg-muted flex items-center justify-center min-h-48">
            {outputUrl ? (
              <video src={outputUrl} controls className="w-full max-h-[480px]" />
            ) : (
              <canvas ref={previewCanvasRef} className="max-w-full max-h-[480px]" />
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={previewFrame}
              disabled={!filteredVideoBlob || rendering}
              className="flex-1 py-2 text-xs uppercase tracking-wider border border-border hover:border-[#B98B82] hover:text-[#B98B82] disabled:opacity-30 transition-colors"
            >
              Preview Frame
            </button>
            <button
              onClick={exportVideo}
              disabled={!filteredVideoBlob || rendering}
              className="flex-1 py-2 text-xs uppercase tracking-wider bg-[#B98B82] text-white disabled:opacity-30 hover:bg-[#a0786f] transition-colors"
            >
              {rendering ? 'Rendering...' : 'Export'}
            </button>
            {rendering && (
              <button
                onClick={() => { abortRef.current = true }}
                className="px-4 py-2 text-xs uppercase tracking-wider border border-destructive text-destructive hover:bg-destructive hover:text-white transition-colors"
              >
                Abort
              </button>
            )}
          </div>

          {progress && rendering && (
            <div className="space-y-1">
              <div className="w-full bg-border h-1">
                <div className="h-1 bg-[#B98B82] transition-all" style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }} />
              </div>
              <p className="caption">
                {progress.current} / {progress.total} frames — {Math.round((progress.current / progress.total) * 100)}%
              </p>
            </div>
          )}

          {outputUrl && (
            <a
              href={outputUrl}
              download="emotion-mosaic.mp4"
              className="block text-center py-2 text-xs uppercase tracking-wider border border-[#667761] text-[#667761] hover:bg-[#667761] hover:text-white transition-colors"
            >
              Download MP4
            </a>
          )}
        </div>

        {/* Right: settings */}
        <div className="space-y-4">
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

          {/* Mosaic settings */}
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
                  value={exportSettings.resolution}
                  onChange={e => onExportChange({ ...exportSettings, resolution: e.target.value as ExportSettings['resolution'] })}
                  className="flex-1 border border-border bg-background text-xs px-2 py-1"
                >
                  {['original', '1080', '720', '540'].map(r => <option key={r} value={r}>{r === 'original' ? 'Original' : `${r}p`}</option>)}
                </select>
              </div>
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">Output video height. Higher = more detail but slower render. 1080p is full HD.</p>
            </div>
            <div>
              <SliderRow label="FPS" value={exportSettings.fps} min={12} max={60} step={1} onChange={v => onExportChange({ ...exportSettings, fps: v })} />
              <p className="text-[10px] text-muted-foreground leading-tight ml-[7.5rem]">Frames per second. 24 = cinematic, 30 = standard video, 60 = buttery smooth. Higher = longer render.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

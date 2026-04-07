import { useState, useCallback, useRef, useEffect } from 'react'
import type {
  AppPhase, VideoMetadata, EmotionFrame, Shot,
  MosaicSettings, InkSettings, StabilitySettings, ExportSettings, RenderMode,
} from './lib/types'
import type { EmotionBuckets } from './lib/image-color-analyzer'
import type { ImageAsset } from './lib/types'
import type { CachedImage } from './lib/renderer'

import { UploadPhase } from './components/phases/UploadPhase'
import { EmotionPhase } from './components/phases/EmotionPhase'
import { ImagesPhase } from './components/phases/ImagesPhase'
import { RenderPhase } from './components/phases/RenderPhase'
import { BatchPhase } from './components/phases/BatchPhase'
import { LibraryPhase } from './components/phases/LibraryPhase'
import { ErrorBoundary } from './components/ErrorBoundary'

import { analyzeImagePool } from './lib/image-color-analyzer'
import { buildAutoTimeline } from './lib/emotion-timeline'
import { extractSceneFeatures } from './lib/emotion-inference'
import type { SceneFeatures } from './lib/emotion-inference'

import { Console } from './components/Console'
import type { ConsoleEntry } from './components/Console'
import { saveSession, loadSession } from './lib/session-manager'
import type { SessionState } from './lib/session-manager'

const DEFAULT_MOSAIC: MosaicSettings = { density: 'fine', compactness: 5, chunkiness: 30, neutralBackground: 'off' }
const DEFAULT_INK: InkSettings = { thickness: 1 }
const DEFAULT_STABILITY: StabilitySettings = { holdFrames: 12, reassignAggression: 22, allowReassign: false, seed: 42, emotionSmoothing: 0.5 }
const DEFAULT_EXPORT: ExportSettings = { resolution: '1080', fps: 60 }

const PHASE_ORDER: AppPhase[] = ['upload', 'emotion', 'images', 'render', 'batch']

export default function App() {
  // ── Phase ─────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<AppPhase>('upload')
  const [libraryOpen, setLibraryOpen] = useState(false)

  // ── Video ─────────────────────────────────────────────────────────────────
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoMetadata, setVideoMetadata] = useState<VideoMetadata | null>(null)
  const [filteredVideoBlob, setFilteredVideoBlob] = useState<Blob | null>(null)
  const [filteredShots] = useState<Shot[]>([])

  // ── Emotion ───────────────────────────────────────────────────────────────
  const [emotionMode, setEmotionMode] = useState<'auto' | 'equal'>('equal')
  const [emotionTimeline, setEmotionTimeline] = useState<EmotionFrame[]>([])
  const [autoDetecting, setAutoDetecting] = useState(false)
  const [autoProgress, setAutoProgress] = useState(0)

  // ── Images ────────────────────────────────────────────────────────────────
  const [imageAssets, setImageAssets] = useState<ImageAsset[]>([])
  const [imageBuckets, setImageBuckets] = useState<EmotionBuckets>({})
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeProgress, setAnalyzeProgress] = useState(0)
  const [analyzeCount, setAnalyzeCount] = useState(0)
  const [bucketTarget, setBucketTarget] = useState(50)

  // ── Mosaic settings ───────────────────────────────────────────────────────
  const [mosaicSettings, setMosaicSettings] = useState<MosaicSettings>(DEFAULT_MOSAIC)
  const [inkSettings, setInkSettings] = useState<InkSettings>(DEFAULT_INK)
  const [stabilitySettings, setStabilitySettings] = useState<StabilitySettings>(DEFAULT_STABILITY)
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT)
  const [renderMode, setRenderMode] = useState<RenderMode>('sticker')

  // ── Console ───────────────────────────────────────────────────────────────
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [consoleExpanded, setConsoleExpanded] = useState(false)
  const [activeProcess, setActiveProcess] = useState<string | null>(null)
  const lastPct = useRef<Record<string, number>>({})

  const log = useCallback((level: ConsoleEntry['level'], message: string, data?: any) => {
    setConsoleEntries(prev => [...prev, { timestamp: Date.now(), level, message, data }])
    if (level !== 'debug') setConsoleExpanded(true)
  }, [])

  const logProgress = useCallback((key: string, label: string, p: number, detail?: string) => {
    const pct = Math.floor(p * 10) * 10
    if ((lastPct.current[key] ?? -1) < pct) {
      lastPct.current[key] = pct
      setConsoleEntries(prev => [...prev, {
        timestamp: Date.now(),
        level: 'debug' as const,
        message: `${label}: ${pct}%${detail ? ' — ' + detail : ''}`,
      }])
    }
  }, [])

  // ── Nav helpers ───────────────────────────────────────────────────────────
  const phaseIndex = PHASE_ORDER.indexOf(phase)
  function canNavigateTo(p: AppPhase): boolean {
    const idx = PHASE_ORDER.indexOf(p)
    if (idx <= phaseIndex) return true
    if (p === 'emotion') return true  // always accessible — user can add video directly here
    if (p === 'images' && !!videoFile) return true
    if (p === 'render' && imageAssets.length > 0) return true
    if (p === 'batch' && !!filteredVideoBlob) return true
    return false
  }

  useEffect(() => {
    console.log(`[App] Phase: ${phase.toUpperCase()} — video: ${!!videoFile} | filtered: ${!!filteredVideoBlob} | emotions: ${emotionTimeline.length} | images: ${imageAssets.length}`)
  }, [phase])

  // ── Phase 1 handlers ──────────────────────────────────────────────────────
  function handleVideoSelected(file: File, meta: VideoMetadata) {
    setVideoFile(file)
    setVideoMetadata(meta)
    log('info', `Video loaded: ${file.name}`)
    log('debug', `${meta.duration.toFixed(1)}s · ${meta.fps} fps · ${meta.width}×${meta.height} · ${(file.size / 1024 / 1024).toFixed(1)} MB`)
    // Video goes straight through — no character isolation
    setFilteredVideoBlob(new Blob([file], { type: file.type || 'video/mp4' }))
    setEmotionTimeline([])
  }

  // ── Quick-add video shortcut (skip upload) ──────────────────────────────
  async function handleAddVideoShortcut() {
    try {
      const [fileHandle] = await (window as any).showOpenFilePicker({
        types: [{ description: 'Video files', accept: { 'video/*': ['.mp4', '.mov', '.webm', '.mkv'] } }],
        multiple: false,
      })
      const file: File = await fileHandle.getFile()
      log('info', `Quick-loading video: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`)

      // Extract metadata
      const url = URL.createObjectURL(file)
      const vid = document.createElement('video')
      vid.src = url
      await new Promise<void>((resolve, reject) => {
        vid.onloadedmetadata = () => resolve()
        vid.onerror = () => reject(new Error('Failed to load video metadata'))
      })
      const meta: VideoMetadata = {
        filename: file.name,
        duration: vid.duration,
        fps: 30,
        width: vid.videoWidth,
        height: vid.videoHeight,
      }
      URL.revokeObjectURL(url)

      setVideoFile(file)
      setVideoMetadata(meta)
      const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'video/mp4' })
      setFilteredVideoBlob(blob)

      // Auto-generate equal-split timeline
      const totalFrames = Math.floor(meta.duration * 30)
      const emotions: import('./lib/emotion-color-mapping').Emotion[] = [
        'happy', 'excited', 'confident', 'calm', 'tender', 'neutral',
        'mysterious', 'surprised', 'fearful', 'sad', 'angry',
      ]
      const framesPerEmotion = Math.floor(totalFrames / emotions.length)
      const raw: EmotionFrame[] = []
      for (let f = 0; f < totalFrames; f++) {
        const emotionIdx = Math.floor(f / framesPerEmotion)
        const emotion = emotions[Math.min(emotionIdx, emotions.length - 1)]
        raw.push({ frameIndex: f, emotion, confidence: 0.8, source: 'equal' as any })
      }
      setEmotionTimeline(raw)
      setEmotionMode('equal')

      log('success', `Video loaded — ${meta.width}×${meta.height}, ${meta.duration.toFixed(1)}s, ${totalFrames} frames, ${emotions.length} emotion sections`)
    } catch (err) {
      if ((err as any).name !== 'AbortError') {
        log('error', `Failed to load video: ${(err as Error).message}`)
      }
    }
  }

  // ── Phase 3 handlers ──────────────────────────────────────────────────────
  async function handleDetectEmotions() {
    if (!filteredVideoBlob) return
    setAutoDetecting(true)
    setAutoProgress(0)
    setActiveProcess('Emotion Analysis')
    lastPct.current = {}
    log('info', '─── Emotion Analysis ─────────────────────────────────────')

    try {
      if (emotionMode === 'equal') {
        log('info', 'Building emotion timeline with equal distribution across emotions...')
        const totalFrames = filteredShots.length > 0
          ? filteredShots[filteredShots.length - 1].endFrame + 1
          : (videoMetadata ? Math.floor(videoMetadata.duration * 30) : 1000)

        const emotions: import('./lib/emotion-color-mapping').Emotion[] = ['happy', 'excited', 'confident', 'calm', 'tender', 'neutral', 'mysterious', 'surprised', 'fearful', 'sad', 'angry']
        const framesPerEmotion = Math.floor(totalFrames / emotions.length)

        const raw: EmotionFrame[] = []
        for (let f = 0; f < totalFrames; f++) {
          const emotionIdx = Math.floor(f / framesPerEmotion)
          const emotion = emotions[Math.min(emotionIdx, emotions.length - 1)]
          raw.push({ frameIndex: f, emotion, confidence: 0.8, source: 'equal' as any })
        }

        setEmotionTimeline(raw)
        log('success', `Emotion timeline built — ${raw.length} frames across ${emotions.length} emotions`)
        setAutoDetecting(false)
        return
      }

      const totalFrames = videoMetadata ? Math.floor(videoMetadata.duration * 30) : 1000
      let expressionMap = new Map<number, Record<string, number>>()

      // ── Scene feature extraction ──────────────────────────────────────
      const sceneFeatureMap = new Map<number, SceneFeatures>()
      const file = new File([filteredVideoBlob], 'filtered.mp4', { type: 'video/mp4' })

      // Color-based emotion analysis (no character detection)
      log('info', 'Using color-based emotion analysis...')
      const { analyzeVideoEmotions } = await import('./lib/emotion-color-mapping')
      const segments = await analyzeVideoEmotions(file, 2, p => {
        setAutoProgress(p * 0.7)
        logProgress('emotion', 'Color analysis', p)
      })
      for (const seg of segments) {
        const startF = Math.round(seg.startTime * 30)
        const endF = Math.round(seg.endTime * 30)
        for (let f = startF; f < endF; f++) {
          expressionMap.set(f, { [seg.emotion]: seg.confidence })
        }
      }

      // ── Scene feature pass — extract color/brightness/contrast per frame ──
      log('info', 'Extracting scene features (color, brightness, contrast)...')
      try {
        const sceneVideo = document.createElement('video')
        sceneVideo.src = URL.createObjectURL(filteredVideoBlob)
        sceneVideo.muted = true
        sceneVideo.playsInline = true
        sceneVideo.preload = 'auto'
        await new Promise<void>((resolve, reject) => {
          sceneVideo.onloadedmetadata = () => resolve()
          sceneVideo.onerror = () => reject(new Error('Failed to load video for scene analysis'))
        })

        const sceneCW = Math.min(sceneVideo.videoWidth, 320)
        const sceneCH = Math.round(sceneVideo.videoHeight * (sceneCW / sceneVideo.videoWidth))
        const sceneCanvas = document.createElement('canvas')
        sceneCanvas.width = sceneCW
        sceneCanvas.height = sceneCH
        const sceneCtx = sceneCanvas.getContext('2d', { willReadFrequently: true })!

        const sceneFps = 2 // sample scene at 2fps — enough for color/brightness
        const sceneDuration = sceneVideo.duration
        const sceneSamples = Math.floor(sceneDuration * sceneFps)

        for (let si = 0; si <= sceneSamples; si++) {
          const time = si / sceneFps
          if (time > sceneDuration) break

          await new Promise<void>(resolve => {
            const handler = () => { sceneVideo.removeEventListener('seeked', handler); resolve() }
            sceneVideo.addEventListener('seeked', handler)
            sceneVideo.currentTime = time
          })

          sceneCtx.drawImage(sceneVideo, 0, 0, sceneCW, sceneCH)
          const features = extractSceneFeatures(sceneCtx, sceneCW, sceneCH)

          // Map to 30fps frame indices — fill the range this sample covers
          const startF = Math.round(time * 30)
          const endF = Math.round(Math.min(time + 1 / sceneFps, sceneDuration) * 30)
          for (let f = startF; f < endF; f++) {
            sceneFeatureMap.set(f, features)
          }

          setAutoProgress(0.7 + (si / sceneSamples) * 0.25)
        }

        URL.revokeObjectURL(sceneVideo.src)
        log('success', `Scene features extracted — ${sceneFeatureMap.size} frames`)
      } catch (err) {
        log('warning', `Scene feature extraction failed: ${err instanceof Error ? err.message : 'unknown'} — using face data only`)
      }

      // ── Build fused timeline ──────────────────────────────────────────────
      setAutoProgress(0.95)
      const raw = buildAutoTimeline(expressionMap, totalFrames, sceneFeatureMap.size > 0 ? sceneFeatureMap : undefined)
      setEmotionTimeline(raw)
      const emotionCounts = raw.reduce((acc, f) => { acc[f.emotion] = (acc[f.emotion] ?? 0) + 1; return acc }, {} as Record<string, number>)
      const sorted = Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])
      const top3 = sorted.slice(0, 3).map(([e, c]) => `${e}(${c})`).join(', ')
      const uniqueEmotions = sorted.length
      log('success', `Emotion timeline built — ${raw.length} frames · ${uniqueEmotions} emotions detected · top: ${top3}`)
    } catch (err) {
      log('error', `Emotion detection failed: ${String(err)}`)
    } finally {
      setAutoDetecting(false)
      setActiveProcess(null)
    }
  }


  // ── Phase 4 handlers ──────────────────────────────────────────────────────
  async function handleFolderBrowse(imageCount: number): Promise<File[]> {
    if (!('showDirectoryPicker' in window)) {
      log('error', 'Folder selection not supported. Use Chrome, Edge, or Safari 16.4+')
      return []
    }
    try {
      setActiveProcess('Folder Selection')
      log('info', '─── Image Selection ───────────────────────────────────────')
      log('info', 'Opening folder browser...')
      const dirHandle = await (window as any).showDirectoryPicker()
      const allImages: File[] = []
      log('info', 'Scanning folder for images...')
      for await (const [name, handle] of (dirHandle as any).entries()) {
        if (handle.kind === 'file' && name.match(/\.(jpg|jpeg|png|webp|gif|bmp|avif|tiff?|heic|heif|pdf)$/i)) {
          const file = await (handle as any).getFile()
          allImages.push(file)
        }
      }
      log('info', `Found ${allImages.length} image(s) in folder`)
      const shuffled = allImages.sort(() => Math.random() - 0.5)
      const selected = shuffled.slice(0, Math.min(imageCount, allImages.length))
      log('info', `Randomly selected ${selected.length} image(s)`)
      log('info', `Downloading ${selected.length} file(s)...`)
      const downloadedFiles: File[] = []
      const downloadWithTimeout = async (file: File, timeoutMs: number): Promise<ArrayBuffer> => {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs / 1000}s`)), timeoutMs)
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
      for (let i = 0; i < selected.length; i++) {
        const file = selected[i]
        try {
          const arrayBuffer = await downloadWithTimeout(file, 180000)
          if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            log('warning', `[${i + 1}/${selected.length}] ${file.name} — skipped (empty)`)
            continue
          }
          const localFile = new File([arrayBuffer], file.name, { type: file.type })
          downloadedFiles.push(localFile)
          logProgress('folder', 'Download', (i + 1) / selected.length, `${i + 1}/${selected.length}`)
        } catch (err) {
          log('warning', `[${i + 1}/${selected.length}] ${file.name} — ${(err as Error).message}`)
        }
      }
      log('success', `Downloaded ${downloadedFiles.length}/${selected.length} files`)

      // Expand PDFs into page images
      const hasPDFs = downloadedFiles.some(f => f.name.match(/\.pdf$/i))
      if (hasPDFs) {
        const { expandPDFs } = await import('./lib/pdf-extractor')
        log('info', 'Extracting PDF pages...')
        const expanded = await expandPDFs(downloadedFiles, label => log('debug', `  ${label}`))
        log('info', `${expanded.length} images after PDF extraction`)
        return expanded
      }

      return downloadedFiles
    } catch (err) {
      if ((err as any).name !== 'AbortError') {
        log('error', `Folder selection failed: ${(err as Error).message}`)
      }
      return []
    } finally {
      setActiveProcess(null)
    }
  }

  function handleLibrarySendToRender(caches: Map<string, CachedImage[]>) {
    // Convert CachedImage map to EmotionBuckets (ImageAsset[]) for compatibility
    // with the existing render phase which reads from imageBuckets
    const buckets: EmotionBuckets = {}
    const assets: ImageAsset[] = []
    let id = 0
    for (const [emotion, cached] of caches) {
      buckets[emotion] = []
      for (const img of cached) {
        const asset = {
          id: `lib-${id++}`,
          file: new File([], `library-${emotion}-${id}.png`),
          bitmap: null,
          dominantHue: 0,
          dominantSat: 0,
          emotion: emotion as any,
          _cachedData: img, // accessed dynamically in RenderPhase.buildImageCaches
        } as ImageAsset & { _cachedData: typeof img }
        buckets[emotion].push(asset)
        assets.push(asset)
      }
    }
    setImageAssets(assets)
    setImageBuckets(buckets)
    // Store the pre-built caches so render phases can use them directly
    ;(window as any).__libraryCaches = caches
    setLibraryOpen(false)
    setPhase('render')
    const summary = [...caches.entries()].map(([e, c]) => `${e}: ${c.length}`).join(' · ')
    log('success', `Library sent ${[...caches.values()].reduce((s, c) => s + c.length, 0)} images to render — ${summary}`)
  }

  async function handleFilesSelected(files: File[]) {
    setAnalyzing(true)
    setAnalyzeProgress(0)
    setAnalyzeCount(files.length)
    setActiveProcess('Image Analysis')
    lastPct.current = {}
    log('info', '─── Image Analysis ───────────────────────────────────────')
    log('info', `Analyzing ${files.length} image(s) for emotion color buckets...`)
    try {
      const { assets, buckets } = await analyzeImagePool(files, p => {
        setAnalyzeProgress(p)
        logProgress('images', 'Image analysis', p, `${Math.round(p * files.length)}/${files.length} images`)
      }, bucketTarget)
      setImageAssets(assets)
      setImageBuckets(buckets)
      const bucketList = Object.entries(buckets).filter(([, imgs]) => imgs.length > 0)
      log('success', `Analysis complete — ${assets.length} images in ${bucketList.length} emotion bucket(s)`)
      bucketList.forEach(([emotion, imgs]) => log('debug', `  ${emotion}: ${imgs.length}`))
    } finally {
      setAnalyzing(false)
      setActiveProcess(null)
      setAnalyzeCount(0)
    }
  }

  // ── Session Save/Load ─────────────────────────────────────────────────────
  function handleSaveSession() {
    const state: SessionState = {
      phase, characters: [], mainCharacterId: null, shots: [], filteredShots: [],
      frameCharacterMap: {},
      emotionMode, emotionTimeline,
      mosaicSettings, inkSettings, stabilitySettings, exportSettings, renderMode,
      imageAssetMeta: imageAssets.map(a => ({
        id: a.id, fileName: a.file.name, emotion: a.emotion,
        dominantHue: a.dominantHue, dominantSat: a.dominantSat,
      })),
    }
    saveSession(state)
    log('success', 'Session saved')
  }

  async function handleLoadSession() {
    try {
      const state = await loadSession()
      setPhase(state.phase)
      setEmotionMode(state.emotionMode); setEmotionTimeline(state.emotionTimeline)
      setMosaicSettings(state.mosaicSettings); setInkSettings(state.inkSettings)
      setStabilitySettings(state.stabilitySettings); setExportSettings(state.exportSettings)
      setRenderMode(state.renderMode)
      log('success', `Session loaded — phase: ${state.phase}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('cancelled')) log('error', `Failed to load session: ${msg}`)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center justify-between shrink-0">
        <div>
          <h1>MOSAIC GLITCH</h1>
          <p className="caption mt-0.5">glitch-driven mosaic video composer</p>
        </div>
        <div className="flex items-center gap-3">
          <nav className="flex items-center gap-1">
            {/* Main path: upload → emotion */}
            {(['upload', 'emotion'] as const).map((p, i) => {
              const active = phase === p
              const accessible = canNavigateTo(p)
              return (
                <button
                  key={p}
                  onClick={() => accessible && !libraryOpen && setPhase(p)}
                  disabled={!accessible}
                  className={`px-3 py-1.5 text-xs uppercase tracking-wider border transition-colors ${
                    active && !libraryOpen
                      ? 'bg-[#00ffa3] text-[#0a0a0a] border-[#00ffa3]'
                      : accessible
                      ? 'border-border text-muted-foreground hover:text-foreground hover:border-foreground'
                      : 'border-border/30 text-muted-foreground/30 cursor-not-allowed'
                  }`}
                >
                  <span className="opacity-50 mr-1">{i + 1}</span>{p}
                </button>
              )
            })}

            {/* Fork indicator */}
            <span className="text-muted-foreground/40 px-1 text-xs select-none">→</span>

            {/* Single render path */}
            <div className="flex gap-0.5 border border-border/50 p-0.5" title="Single render path">
              {(['images', 'render'] as const).map((p, i) => {
                const active = phase === p
                const accessible = canNavigateTo(p)
                return (
                  <button
                    key={p}
                    onClick={() => accessible && !libraryOpen && setPhase(p)}
                    disabled={!accessible}
                    className={`px-3 py-1 text-xs uppercase tracking-wider border transition-colors ${
                      active && !libraryOpen
                        ? 'bg-[#00ffa3] text-[#0a0a0a] border-[#00ffa3]'
                        : accessible
                        ? 'border-border text-muted-foreground hover:text-foreground hover:border-foreground'
                        : 'border-border/30 text-muted-foreground/30 cursor-not-allowed'
                    }`}
                  >
                    <span className="opacity-50 mr-1">{i + 3}</span>{p}
                  </button>
                )
              })}
            </div>

            {/* "or" separator */}
            <span className="text-muted-foreground/40 text-xs px-0.5 select-none">or</span>

            {/* Batch path */}
            {(() => {
              const active = phase === 'batch'
              const accessible = canNavigateTo('batch')
              return (
                <div className="border border-border/50 p-0.5" title="Batch render path">
                  <button
                    onClick={() => accessible && !libraryOpen && setPhase('batch')}
                    disabled={!accessible}
                    className={`px-3 py-1 text-xs uppercase tracking-wider border transition-colors ${
                      active && !libraryOpen
                        ? 'bg-[#0d2818] text-[#00ffa3] border-[#0d2818]'
                        : accessible
                        ? 'border-border text-muted-foreground hover:text-foreground hover:border-foreground'
                        : 'border-border/30 text-muted-foreground/30 cursor-not-allowed'
                    }`}
                  >
                    batch
                  </button>
                </div>
              )
            })()}
          </nav>
          <div className="flex gap-1 border-l border-border pl-3">
            <button
              onClick={() => setLibraryOpen(o => !o)}
              className={`px-3 py-1.5 text-xs uppercase tracking-wider border transition-colors ${
                libraryOpen
                  ? 'bg-[#0d2818] text-[#00ffa3] border-[#0d2818]'
                  : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground'
              }`}
            >
              Library
            </button>
            <button
              onClick={handleSaveSession}
              className="px-3 py-1.5 text-xs uppercase tracking-wider border border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
            >
              Save Session
            </button>
            <button
              onClick={handleLoadSession}
              className="px-3 py-1.5 text-xs uppercase tracking-wider border border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
            >
              Load Session
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-8 pb-4">
        {libraryOpen && (
          <LibraryPhase
            onSendToRender={handleLibrarySendToRender}
            onLog={log}
            onSetActiveProcess={setActiveProcess}
          />
        )}

        {!libraryOpen && phase === 'upload' && (
          <UploadPhase
            videoFile={videoFile}
            videoMetadata={videoMetadata}
            onVideoSelected={handleVideoSelected}
            onProceed={() => setPhase('emotion')}
          />
        )}

        {!libraryOpen && phase === 'emotion' && (
          <EmotionPhase
            duration={videoMetadata?.duration ?? 0}
            fps={videoMetadata?.fps ?? 30}
            emotionMode={emotionMode}
            emotionTimeline={emotionTimeline}
            shots={[]}
            autoDetecting={autoDetecting}
            autoProgress={autoProgress}
            onModeChange={setEmotionMode}
            onDetectEmotions={handleDetectEmotions}
            onProceed={() => setPhase('images')}
            onProceedBatch={() => setPhase('batch')}
            onAddVideo={handleAddVideoShortcut}
            hasVideo={!!filteredVideoBlob}
          />
        )}

        {!libraryOpen && phase === 'images' && (
          <ImagesPhase
            assets={imageAssets}
            buckets={imageBuckets}
            analyzing={analyzing}
            analyzeProgress={analyzeProgress}
            analyzeCount={analyzeCount}
            emotionTimeline={emotionTimeline}
            bucketTarget={bucketTarget}
            onBucketTargetChange={setBucketTarget}
            onBrowseFolder={handleFolderBrowse}
            onFilesSelected={handleFilesSelected}
            onProceed={() => {
              log('info', `Image phase complete — ${imageAssets.length} images ready`)
              setPhase('render')
            }}
          />
        )}

        {!libraryOpen && phase === 'render' && (
          <ErrorBoundary
            fallback={(error, retry) => (
              <div className="max-w-3xl mx-auto p-6 space-y-4">
                <div className="border border-destructive/30 bg-destructive/5 p-4 rounded space-y-3">
                  <h2 className="text-sm font-semibold text-destructive">Render Error</h2>
                  <p className="text-xs text-muted-foreground break-words">{error.message}</p>
                  <div className="flex gap-2">
                    <button onClick={retry} className="text-xs px-3 py-1.5 border border-destructive text-destructive hover:bg-destructive hover:text-white transition-colors">Retry</button>
                    <button onClick={() => setPhase('images')} className="text-xs px-3 py-1.5 border border-border hover:bg-muted transition-colors">Back to Images</button>
                  </div>
                </div>
              </div>
            )}
          >
            <RenderPhase
              filteredVideoBlob={filteredVideoBlob}
              emotionTimeline={emotionTimeline}
              filteredShots={filteredShots}
              buckets={imageBuckets}
              mosaic={mosaicSettings}
              ink={inkSettings}
              stability={stabilitySettings}
              exportSettings={exportSettings}
              renderMode={renderMode}
              onMosaicChange={setMosaicSettings}
              onInkChange={setInkSettings}
              onStabilityChange={setStabilitySettings}
              onExportChange={setExportSettings}
              onRenderModeChange={setRenderMode}
              onLog={log}
              onSetActiveProcess={setActiveProcess}
            />
          </ErrorBoundary>
        )}
        {!libraryOpen && phase === 'batch' && (
          <BatchPhase
            filteredVideoBlob={filteredVideoBlob}
            emotionTimeline={emotionTimeline}
            filteredShots={filteredShots}
            mosaic={mosaicSettings}
            ink={inkSettings}
            stability={stabilitySettings}
            exportSettings={exportSettings}
            renderMode={renderMode}
            videoFileName={videoFile?.name}
            onMosaicChange={setMosaicSettings}
            onInkChange={setInkSettings}
            onStabilityChange={setStabilitySettings}
            onExportChange={setExportSettings}
            onRenderModeChange={setRenderMode}
            onLog={log}
            onSetActiveProcess={setActiveProcess}
          />
        )}
      </main>

      {/* Global console */}
      <div className="shrink-0 sticky bottom-0 z-50">
        <Console
          entries={consoleEntries}
          isExpanded={consoleExpanded}
          activeProcess={activeProcess}
          onToggle={() => setConsoleExpanded(v => !v)}
          onClear={() => setConsoleEntries([])}
        />
      </div>
    </div>
  )
}

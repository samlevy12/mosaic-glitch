import { useRef, useState, useMemo } from 'react'
import type { ImageAsset, EmotionFrame } from '../../lib/types'
import type { EmotionBuckets } from '../../lib/image-color-analyzer'
import type { Emotion } from '../../lib/emotion-color-mapping'
import { EMOTION_COLOR_MAPPINGS } from '../../lib/emotion-color-mapping'
// PDF support loaded dynamically to avoid bundling pdfjs upfront
const isPDF = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')

interface ImagesPhaseProps {
  assets: ImageAsset[]
  buckets: EmotionBuckets
  analyzing: boolean
  analyzeProgress: number
  analyzeCount: number
  emotionTimeline: EmotionFrame[]
  bucketTarget: number
  onBucketTargetChange: (value: number) => void
  onBrowseFolder: (imageCount: number) => Promise<File[]>
  onFilesSelected: (files: File[]) => void
  onProceed: () => void
  onSaveSnapshot?: () => void
}

const EMOTION_META = EMOTION_COLOR_MAPPINGS.reduce<Record<string, { color: string; label: string }>>(
  (acc, m) => { acc[m.emotion] = { color: m.primaryColor, label: m.displayName }; return acc },
  {}
)

export function ImagesPhase({
  assets,
  buckets,
  analyzing,
  analyzeProgress,
  analyzeCount,
  emotionTimeline,
  bucketTarget,
  onBucketTargetChange,
  onBrowseFolder,
  onFilesSelected,
  onProceed,
  onSaveSnapshot,
}: ImagesPhaseProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [imageCount, setImageCount] = useState(100)
  const [folderSelecting, setFolderSelecting] = useState(false)

  const [extractingPDF, setExtractingPDF] = useState(false)

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const allFiles = Array.from(files)
    const hasPDFs = allFiles.some(f => isPDF(f))

    if (hasPDFs) {
      setExtractingPDF(true)
      try {
        const { expandPDFs } = await import('../../lib/pdf-extractor')
        const expanded = await expandPDFs(allFiles)
        if (expanded.length > 0) onFilesSelected(expanded)
      } finally {
        setExtractingPDF(false)
      }
    } else {
      const imageFiles = allFiles.filter(f => f.type.startsWith('image/'))
      onFilesSelected(imageFiles)
    }
  }

  async function handleFolderSelection() {
    setFolderSelecting(true)
    try {
      const files = await onBrowseFolder(imageCount)
      if (files.length > 0) {
        onFilesSelected(files)
      }
    } finally {
      setFolderSelecting(false)
    }
  }

  const bucketEntries = Object.entries(buckets)
    .filter(([, imgs]) => imgs.length > 0)
    .sort((a, b) => b[1].length - a[1].length)

  const totalImages = assets.length

  // Compute emotion sections for preview
  const emotionSections = useMemo(() => {
    if (emotionTimeline.length === 0) return []

    const sections: Array<{
      emotion: Emotion
      color: string
      startFrame: number
      endFrame: number
      frameCount: number
      images: ImageAsset[]
    }> = []

    let currentEmotion: Emotion | undefined = emotionTimeline[0]?.emotion
    let sectionStart = 0

    for (let i = 1; i <= emotionTimeline.length; i++) {
      const nextEmotion: Emotion | undefined = i < emotionTimeline.length ? emotionTimeline[i].emotion : undefined
      if (nextEmotion !== currentEmotion) {
        if (currentEmotion !== undefined) {
          const endFrame = i - 1
          const meta = EMOTION_META[currentEmotion]
          sections.push({
            emotion: currentEmotion,
            color: meta?.color ?? '#ccc',
            startFrame: sectionStart,
            endFrame,
            frameCount: endFrame - sectionStart + 1,
            images: buckets[currentEmotion] ?? [],
          })
        }
        sectionStart = i
        currentEmotion = nextEmotion
      }
    }

    return sections
  }, [emotionTimeline, buckets])

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Step 4 — Image Pool</h2>
        <p className="body-text">Upload texture images for the mosaic tiles. They'll be sorted into emotion buckets by dominant color.</p>
        <p className="caption text-muted-foreground mt-1">Have a big iCloud folder? Use the <span className="text-foreground font-medium">Library</span> button in the header — scan once, save an index, reload instantly next time.</p>
      </div>

      {/* Upload zone */}
      <div className="space-y-4">
        <div
          className="border-2 border-dashed border-border hover:border-[#00ffa3]/50 transition-colors p-8 text-center cursor-pointer"
          onClick={() => inputRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*,.pdf"
            multiple
            className="hidden"
            onChange={e => handleFiles(e.target.files)}
          />
          <div className="space-y-1">
            <p className="body-text">{extractingPDF ? 'Extracting PDF pages...' : totalImages > 0 ? `${totalImages} images loaded — click to add more` : 'Drop images or PDFs here, or click to browse'}</p>
            <p className="caption">JPG, PNG, WebP, PDF — PDFs get extracted as page images</p>
          </div>
        </div>

        {/* Folder selection */}
        <div className="border border-border p-4 space-y-3">
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wider text-muted-foreground block">
              Or select from folder
            </label>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label htmlFor="imageCount" className="text-xs uppercase tracking-wider text-muted-foreground block mb-1">
                  How many images?
                </label>
                <input
                  id="imageCount"
                  type="number"
                  min="1"
                  max="500"
                  value={imageCount}
                  onChange={e => setImageCount(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full px-3 py-2 border border-border bg-background text-foreground text-sm"
                />
              </div>
              <button
                onClick={handleFolderSelection}
                disabled={folderSelecting}
                className="px-4 py-2 text-xs uppercase tracking-wider border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {folderSelecting ? 'Loading...' : 'Browse Folder'}
              </button>
            </div>
          </div>
          <p className="caption text-muted-foreground">Select a folder — we'll pick {imageCount} random images from it without loading everything</p>
        </div>

        {/* Bucket target */}
        <div className="border border-border p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider font-medium mb-0.5">Bucket Target</p>
            <p className="caption text-muted-foreground">Smart crops fill any emotion bucket below this count</p>
          </div>
          <input
            type="number"
            min={1}
            max={500}
            value={bucketTarget}
            onChange={e => onBucketTargetChange(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))}
            className="w-20 px-2 py-1.5 border border-border bg-background text-sm text-right font-mono"
          />
        </div>
      </div>

      {/* Analysis progress */}
      {analyzing && (
        <div className="border border-border p-4 space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Analyzing colors...</p>
          <div className="w-full bg-border h-1">
            <div className="h-1 bg-[#00ffa3] transition-all" style={{ width: `${Math.round(analyzeProgress * 100)}%` }} />
          </div>
          <p className="caption">{Math.round(analyzeProgress * analyzeCount)} / {analyzeCount} images</p>
        </div>
      )}

      {/* Bucket breakdown */}
      {bucketEntries.length > 0 && !analyzing && (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Emotion Buckets</h2>
            <span className="caption">{totalImages} total images</span>
          </div>

          {/* Bar chart */}
          <div className="space-y-1.5">
            {bucketEntries.map(([emotion, imgs]) => {
              const pct = Math.round((imgs.length / totalImages) * 100)
              const meta = EMOTION_META[emotion]
              return (
                <div key={emotion} className="flex items-center gap-3">
                  <div className="w-24 shrink-0 flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: meta?.color ?? '#ccc' }} />
                    <span className="caption truncate">{meta?.label.split('/')[0] ?? emotion}</span>
                  </div>
                  <div className="flex-1 bg-muted h-2">
                    <div
                      className="h-2 transition-all"
                      style={{ width: `${pct}%`, backgroundColor: meta?.color ?? '#ccc', opacity: 0.7 }}
                    />
                  </div>
                  <span className="caption w-16 text-right">{imgs.length} ({pct}%)</span>
                </div>
              )
            })}
          </div>

          {/* Thumbnail strips per bucket */}
          <div className="space-y-4 mt-4">
            {bucketEntries.slice(0, 6).map(([emotion, imgs]) => {
              const meta = EMOTION_META[emotion]
              return (
                <div key={emotion} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: meta?.color ?? '#ccc' }} />
                    <span className="text-xs font-medium">{meta?.label.split('/')[0]}</span>
                    <span className="caption">{imgs.length} images</span>
                  </div>
                  <div className="flex gap-1 overflow-x-auto pb-1">
                    {imgs.slice(0, 16).map((img: ImageAsset) => (
                      <img
                        key={img.id}
                        src={URL.createObjectURL(img.file)}
                        alt=""
                        className="w-12 h-12 object-cover shrink-0 border border-border/30"
                      />
                    ))}
                    {imgs.length > 16 && (
                      <div className="w-12 h-12 bg-muted border border-border/30 shrink-0 flex items-center justify-center caption text-center text-[10px]">
                        +{imgs.length - 16}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Warning if any bucket is empty */}
      {bucketEntries.length > 0 && !analyzing && (() => {
        const allEmotions: Emotion[] = ['happy', 'sad', 'angry', 'calm', 'excited', 'neutral']
        const missingBuckets = allEmotions.filter(e => !buckets[e]?.length)
        if (missingBuckets.length === 0) return null
        return (
          <div className="border border-border/60 bg-card p-3 text-xs text-muted-foreground">
            <span className="text-foreground font-medium">Note:</span> No images matched{' '}
            {missingBuckets.map(e => EMOTION_META[e]?.label.split('/')[0] ?? e).join(', ')}.
            The neutral bucket will be used as fallback.
          </div>
        )
      })()}

      {/* Emotion section preview */}
      {emotionSections.length > 0 && totalImages > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Render Preview</h2>
          <div className="space-y-2">
            {emotionSections.map((section, idx) => {
              const meta = EMOTION_META[section.emotion]
              const hasImages = section.images.length > 0
              return (
                <div key={idx} className="border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: section.color }} />
                      <span className="text-xs font-medium">{meta?.label.split('/')[0] ?? section.emotion}</span>
                    </div>
                    <span className="caption text-muted-foreground">{section.frameCount} frames</span>
                  </div>
                  <div className="bg-muted h-1.5">
                    <div
                      className="h-1.5 transition-all"
                      style={{
                        width: `${(section.frameCount / emotionTimeline.length) * 100}%`,
                        backgroundColor: section.color,
                        opacity: 0.7,
                      }}
                    />
                  </div>
                  {hasImages ? (
                    <div className="flex gap-1 overflow-x-auto pt-1">
                      {section.images.slice(0, 8).map((img: ImageAsset) => (
                        <img
                          key={img.id}
                          src={URL.createObjectURL(img.file)}
                          alt=""
                          className="w-10 h-10 object-cover shrink-0 border border-border/30"
                        />
                      ))}
                      {section.images.length > 8 && (
                        <div className="w-10 h-10 bg-muted border border-border/30 shrink-0 flex items-center justify-center caption text-[10px]">
                          +{section.images.length - 8}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="caption text-muted-foreground">No images — will use fallback</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        {onSaveSnapshot && totalImages > 0 && (
          <button
            onClick={onSaveSnapshot}
            className="px-4 py-2.5 text-xs uppercase tracking-wider border border-border hover:bg-muted transition-colors shrink-0"
            title="Save color bucket breakdown as PNG"
          >
            ↓ Save
          </button>
        )}
        <button
          onClick={onProceed}
          disabled={totalImages === 0 || analyzing}
          className="flex-1 py-2.5 text-xs uppercase tracking-wider border border-border disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#00ffa3] hover:text-[#0a0a0a] hover:border-[#00ffa3] transition-colors"
        >
          Render Mosaic →
        </button>
      </div>
    </div>
  )
}

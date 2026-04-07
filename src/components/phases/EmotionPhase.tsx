import type { EmotionFrame, Shot } from '../../lib/types'
import type { Emotion } from '../../lib/emotion-color-mapping'
import { EMOTION_COLOR_MAPPINGS } from '../../lib/emotion-color-mapping'

interface EmotionPhaseProps {
  duration: number
  fps: number
  emotionMode: 'auto' | 'equal'
  emotionTimeline: EmotionFrame[]
  shots: Shot[]
  autoDetecting: boolean
  autoProgress: number
  onModeChange: (mode: 'auto' | 'equal') => void
  onDetectEmotions: () => void
  onProceed: () => void
  onProceedBatch: () => void
  onAddVideo?: () => void
  hasVideo: boolean
}

const EMOTION_DISPLAY = EMOTION_COLOR_MAPPINGS.reduce<Record<string, { color: string; label: string }>>(
  (acc, m) => { acc[m.emotion] = { color: m.primaryColor, label: m.displayName }; return acc },
  {}
)

const LEGEND_EMOTIONS: Emotion[] = [
  'happy', 'sad', 'angry', 'calm', 'excited', 'fearful',
  'surprised', 'tender', 'confident', 'mysterious', 'neutral',
]

export function EmotionPhase({
  duration,
  fps,
  emotionMode,
  emotionTimeline,
  autoDetecting,
  autoProgress,
  onModeChange,
  onDetectEmotions,
  onProceed,
  onProceedBatch,
  onAddVideo,
  hasVideo,
}: EmotionPhaseProps) {

  function widthFromRange(start: number, end: number): string {
    return `${((end - start) / duration) * 100}%`
  }

  // Group consecutive same-emotion frames into bands for display
  const autoBands: Array<{ emotion: Emotion; start: number; end: number }> = []
  if (emotionTimeline.length > 0 && duration > 0) {
    let bandEmotion = emotionTimeline[0].emotion
    let bandStart = 0
    for (let i = 1; i < emotionTimeline.length; i++) {
      if (emotionTimeline[i].emotion !== bandEmotion) {
        autoBands.push({ emotion: bandEmotion, start: bandStart / fps, end: i / fps })
        bandEmotion = emotionTimeline[i].emotion
        bandStart = i
      }
    }
    autoBands.push({ emotion: bandEmotion, start: bandStart / fps, end: duration })
  }

  const canProceed = emotionTimeline.length > 0

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Step 3 — Emotion Timeline</h2>
          <p className="body-text">Map emotions to time ranges. The mosaic will use image colors matching each emotion.</p>
        </div>
        {onAddVideo && !hasVideo && (
          <button
            onClick={onAddVideo}
            className="shrink-0 ml-4 px-4 py-2 text-xs uppercase tracking-wider border border-border hover:border-[#B98B82] hover:text-[#B98B82] transition-colors"
          >
            + Add MP4
          </button>
        )}
        {hasVideo && (
          <span className="shrink-0 ml-4 px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground border border-border/50 bg-muted/20">
            ✓ Video loaded
          </span>
        )}
      </div>

      {/* Mode toggle */}
      <div className="flex border border-border">
        {(['equal', 'auto'] as const).map(mode => (
          <button
            key={mode}
            onClick={() => onModeChange(mode)}
            className={`flex-1 py-2 text-xs uppercase tracking-wider transition-colors ${
              emotionMode === mode
                ? 'bg-[#B98B82] text-white border-[#B98B82]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {mode === 'auto' ? 'Auto Detect' : 'Equal Split'}
          </button>
        ))}
      </div>

      {/* Equal mode */}
      {emotionMode === 'equal' && (
        <div className="space-y-4">
          {autoDetecting ? (
            <div className="border border-border p-4 space-y-2">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Building emotion timeline...</p>
              <div className="w-full bg-border h-1">
                <div className="h-1 bg-[#B98B82] transition-all" style={{ width: `${Math.round(autoProgress * 100)}%` }} />
              </div>
            </div>
          ) : emotionTimeline.length === 0 ? (
            <div className="border border-border bg-card p-6 text-center space-y-3">
              <p className="body-text text-muted-foreground">Divide video into equal emotion sections.</p>
              <button
                onClick={onDetectEmotions}
                className="px-6 py-2 text-xs uppercase tracking-wider border border-[#B98B82] text-[#B98B82] hover:bg-[#B98B82] hover:text-white transition-colors"
              >
                Build Timeline
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="caption">{autoBands.length} emotion sections</p>
              <div className="w-full h-8 flex overflow-hidden border border-border">
                {autoBands.map((band, i) => (
                  <div
                    key={i}
                    title={`${EMOTION_DISPLAY[band.emotion]?.label ?? band.emotion}`}
                    style={{
                      width: widthFromRange(band.start, band.end),
                      backgroundColor: EMOTION_DISPLAY[band.emotion]?.color ?? '#ccc',
                      opacity: 0.8,
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Auto mode */}
      {emotionMode === 'auto' && (
        <div className="space-y-4">
          {autoDetecting ? (
            <div className="border border-border p-4 space-y-2">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Detecting emotions...</p>
              <div className="w-full bg-border h-1">
                <div className="h-1 bg-[#B98B82] transition-all" style={{ width: `${Math.round(autoProgress * 100)}%` }} />
              </div>
            </div>
          ) : emotionTimeline.length === 0 ? (
            <div className="border border-border bg-card p-6 text-center space-y-3">
              <p className="body-text text-muted-foreground">No emotion data yet.</p>
              <button
                onClick={onDetectEmotions}
                className="px-6 py-2 text-xs uppercase tracking-wider border border-[#B98B82] text-[#B98B82] hover:bg-[#B98B82] hover:text-white transition-colors"
              >
                Detect Emotions
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="caption">{autoBands.length} emotion segments detected</p>
              <div className="w-full h-8 flex overflow-hidden border border-border">
                {autoBands.map((band, i) => (
                  <div
                    key={i}
                    title={`${EMOTION_DISPLAY[band.emotion]?.label ?? band.emotion} (${band.start.toFixed(1)}s – ${band.end.toFixed(1)}s)`}
                    style={{
                      width: widthFromRange(band.start, band.end),
                      backgroundColor: EMOTION_DISPLAY[band.emotion]?.color ?? '#ccc',
                      opacity: 0.8,
                    }}
                  />
                ))}
              </div>
              <button
                onClick={onDetectEmotions}
                className="text-xs text-muted-foreground hover:text-foreground uppercase tracking-wider"
              >
                Re-detect
              </button>
            </div>
          )}
        </div>
      )}

      {/* Emotion legend */}
      <div className="grid grid-cols-4 gap-x-4 gap-y-1">
        {LEGEND_EMOTIONS.map(emotion => (
          <div key={emotion} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: EMOTION_DISPLAY[emotion]?.color ?? '#ccc' }} />
            <span className="caption truncate">{EMOTION_DISPLAY[emotion]?.label.split('/')[0]}</span>
          </div>
        ))}
      </div>

      {/* Path fork */}
      <div className="border border-border p-4 space-y-3">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Choose your render path</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={onProceed}
            disabled={!canProceed}
            className="p-4 text-left border border-border disabled:opacity-30 disabled:cursor-not-allowed hover:border-[#B98B82] hover:bg-[#B98B82]/5 transition-colors space-y-1"
          >
            <div className="text-xs font-medium uppercase tracking-wider">Single Render</div>
            <div className="caption text-muted-foreground">Upload one image pool → one mosaic output</div>
          </button>
          <button
            onClick={onProceedBatch}
            disabled={!canProceed}
            className="p-4 text-left border border-border disabled:opacity-30 disabled:cursor-not-allowed hover:border-[#37515F] hover:bg-[#37515F]/5 transition-colors space-y-1"
          >
            <div className="text-xs font-medium uppercase tracking-wider">Batch Render</div>
            <div className="caption text-muted-foreground">Pick a folder of subfolders → one output per subfolder</div>
          </button>
        </div>
      </div>
    </div>
  )
}

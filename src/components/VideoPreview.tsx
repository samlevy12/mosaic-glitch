/**
 * VideoPreview.tsx
 * Reusable video player with optional canvas overlay for bounding boxes,
 * emotion strips, shot boundaries, etc.
 */

import { useRef, useEffect, useState, useCallback } from 'react'
import type { DetectedCharacter, Shot, EmotionFrame, BoundingBox } from '../lib/types'
import { EMOTION_COLOR_MAPPINGS } from '../lib/emotion-color-mapping'

const EMOTION_COLORS: Record<string, string> = EMOTION_COLOR_MAPPINGS.reduce(
  (acc, m) => { acc[m.emotion] = m.primaryColor; return acc }, {} as Record<string, string>
)

// Character colors for bounding boxes
const CHAR_COLORS = ['#B98B82', '#667761', '#37515F', '#9E8B88', '#C5B4A0', '#88A0A8']

interface VideoPreviewProps {
  // Video source — either a File/Blob or an object URL
  src: File | Blob | string | null
  // Optional overlays
  characters?: DetectedCharacter[]
  frameCharacterBoxes?: Map<number, Map<string, BoundingBox>>
  emotionTimeline?: EmotionFrame[]
  shots?: Shot[]
  fps?: number
  mainCharacterId?: string | null
  // Display
  label?: string
  className?: string
}

export function VideoPreview({
  src,
  characters = [],
  frameCharacterBoxes,
  emotionTimeline = [],
  shots = [],
  fps = 30,
  mainCharacterId,
  label,
  className = '',
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)

  // Create object URL from File/Blob
  useEffect(() => {
    if (!src) { setObjectUrl(null); setReady(false); return }
    if (typeof src === 'string') { setObjectUrl(src); return }
    const url = URL.createObjectURL(src)
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [src])

  // Draw overlays on canvas — runs every animation frame while playing
  const drawOverlay = useCallback(() => {
    const video = videoRef.current
    const canvas = overlayRef.current
    if (!video || !canvas || !ready) return

    const frame = Math.floor(video.currentTime * fps)
    setCurrentFrame(frame)

    canvas.width = video.videoWidth || video.clientWidth
    canvas.height = video.videoHeight || video.clientHeight
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const scaleX = canvas.width / (video.videoWidth || canvas.width)
    const scaleY = canvas.height / (video.videoHeight || canvas.height)

    // Draw bounding boxes for each character
    if (frameCharacterBoxes && characters.length > 0) {
      const boxes = frameCharacterBoxes.get(frame)
      if (boxes) {
        for (let ci = 0; ci < characters.length; ci++) {
          const char = characters[ci]
          const box = boxes.get(char.id)
          if (!box) continue

          const isMain = char.id === mainCharacterId
          const color = CHAR_COLORS[ci % CHAR_COLORS.length]

          const bx = box.x * scaleX
          const by = box.y * scaleY
          const bw = box.width * scaleX
          const bh = box.height * scaleY

          // Box
          ctx.strokeStyle = color
          ctx.lineWidth = isMain ? 3 : 1.5
          ctx.setLineDash(isMain ? [] : [4, 4])
          ctx.strokeRect(bx, by, bw, bh)
          ctx.setLineDash([])

          // Label background
          const label = char.id.slice(0, 6) + (isMain ? ' ★' : '')
          ctx.font = 'bold 11px monospace'
          const tw = ctx.measureText(label).width + 6
          ctx.fillStyle = color
          ctx.fillRect(bx, by - 18, tw, 18)

          // Label text
          ctx.fillStyle = '#fff'
          ctx.fillText(label, bx + 3, by - 5)
        }
      }
    }

    // Draw emotion color strip at bottom
    if (emotionTimeline.length > 0) {
      const emotion = emotionTimeline[Math.min(frame, emotionTimeline.length - 1)]?.emotion
      const color = EMOTION_COLORS[emotion] ?? '#888'

      // Thin colored strip at bottom
      ctx.fillStyle = color
      ctx.globalAlpha = 0.7
      ctx.fillRect(0, canvas.height - 6, canvas.width, 6)
      ctx.globalAlpha = 1

      // Emotion label bottom-left
      ctx.font = 'bold 11px monospace'
      const ew = ctx.measureText(emotion ?? '').width + 10
      ctx.fillStyle = color
      ctx.globalAlpha = 0.85
      ctx.fillRect(6, canvas.height - 28, ew, 20)
      ctx.globalAlpha = 1
      ctx.fillStyle = '#fff'
      ctx.fillText(emotion ?? '', 11, canvas.height - 14)
    }

    // Shot boundary flash
    if (shots.length > 0) {
      const onBoundary = shots.some(s => Math.abs(s.startFrame - frame) <= 1)
      if (onBoundary) {
        ctx.strokeStyle = '#ffffff88'
        ctx.lineWidth = 3
        ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2)
      }
    }

    rafRef.current = requestAnimationFrame(drawOverlay)
  }, [ready, fps, characters, frameCharacterBoxes, emotionTimeline, shots, mainCharacterId])

  // Start/stop overlay loop when video plays/pauses
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const start = () => { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(drawOverlay) }
    const stop = () => cancelAnimationFrame(rafRef.current)

    video.addEventListener('play', start)
    video.addEventListener('pause', stop)
    video.addEventListener('ended', stop)
    video.addEventListener('seeked', () => { drawOverlay() }) // single draw on seek

    return () => {
      video.removeEventListener('play', start)
      video.removeEventListener('pause', stop)
      video.removeEventListener('ended', stop)
      stop()
    }
  }, [drawOverlay])

  // Current emotion for display
  const currentEmotion = emotionTimeline.length > 0
    ? emotionTimeline[Math.min(currentFrame, emotionTimeline.length - 1)]?.emotion
    : null

  // Current shot
  const currentShot = shots.find(s => currentFrame >= s.startFrame && currentFrame <= s.endFrame)

  return (
    <div className={`space-y-2 ${className}`}>
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
          {currentEmotion && (
            <span className="text-xs font-mono px-2 py-0.5 rounded" style={{ backgroundColor: EMOTION_COLORS[currentEmotion] + '30', color: EMOTION_COLORS[currentEmotion] }}>
              {currentEmotion}
            </span>
          )}
          {currentShot && (
            <span className="caption text-muted-foreground">shot {shots.indexOf(currentShot) + 1}/{shots.length}</span>
          )}
        </div>
      )}

      {/* Video + overlay stacked */}
      <div className="relative bg-black border border-border overflow-hidden">
        {objectUrl ? (
          <>
            <video
              ref={videoRef}
              src={objectUrl}
              controls
              className="w-full max-h-[400px] block"
              onLoadedMetadata={() => setReady(true)}
              onSeeked={() => drawOverlay()}
            />
            {/* Overlay canvas — pointer-events: none so it doesn't block controls */}
            <canvas
              ref={overlayRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ top: 0, left: 0 }}
            />
          </>
        ) : (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-xs">
            No video loaded
          </div>
        )}
      </div>

      {/* Emotion timeline scrub strip (if available) */}
      {emotionTimeline.length > 0 && (
        <div className="relative h-3 bg-border overflow-hidden rounded-sm cursor-pointer"
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            const pct = (e.clientX - rect.left) / rect.width
            const video = videoRef.current
            if (video && ready) {
              video.currentTime = pct * video.duration
            }
          }}
        >
          {emotionTimeline.map((frame, i) => (
            <div
              key={i}
              className="absolute top-0 h-full"
              style={{
                left: `${(i / emotionTimeline.length) * 100}%`,
                width: `${(1 / emotionTimeline.length) * 100}%`,
                backgroundColor: EMOTION_COLORS[frame.emotion] ?? '#888',
              }}
            />
          ))}
          {/* Playhead */}
          {ready && videoRef.current && (
            <div
              className="absolute top-0 h-full w-0.5 bg-white/80 pointer-events-none"
              style={{ left: `${(currentFrame / emotionTimeline.length) * 100}%` }}
            />
          )}
          {/* Shot boundaries */}
          {shots.map((shot, i) => (
            <div
              key={i}
              className="absolute top-0 h-full w-px bg-white/40 pointer-events-none"
              style={{ left: `${(shot.startFrame / emotionTimeline.length) * 100}%` }}
            />
          ))}
        </div>
      )}

      {/* Shot scrub strip (if no emotion but shots available) */}
      {emotionTimeline.length === 0 && shots.length > 0 && videoRef.current && (
        <div className="relative h-2 bg-border overflow-hidden rounded-sm">
          {shots.map((shot, i) => (
            <div
              key={i}
              className="absolute top-0 h-full border-r border-white/30"
              style={{
                left: `${(shot.startFrame / (shots[shots.length - 1]?.endFrame || 1)) * 100}%`,
                width: `${((shot.endFrame - shot.startFrame) / (shots[shots.length - 1]?.endFrame || 1)) * 100}%`,
                backgroundColor: i % 2 === 0 ? '#37515F40' : '#B98B8240',
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

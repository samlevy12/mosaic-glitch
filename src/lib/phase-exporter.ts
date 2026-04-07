/**
 * phase-exporter.ts
 * Export utilities for saving each pipeline phase as an image/video file.
 * All exports are PNG unless noted.
 */

import type { DetectedCharacter, Shot, EmotionFrame, BoundingBox } from './types'
import type { EmotionBuckets } from './image-color-analyzer'
import { EMOTION_COLOR_MAPPINGS } from './emotion-color-mapping'

const EMOTION_COLORS: Record<string, string> = EMOTION_COLOR_MAPPINGS.reduce(
  (acc, m) => { acc[m.emotion] = m.primaryColor; return acc }, {} as Record<string, string>
)

// ── Download helper ──────────────────────────────────────────────────────────

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob(blob => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }, 'image/png')
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

// ── Phase 2: Characters ──────────────────────────────────────────────────────

/**
 * Export a labeled character map: one representative face crop per character,
 * arranged in a strip with their IDs and frame counts.
 */
export async function exportCharacterMap(
  videoFile: File,
  characters: DetectedCharacter[],
  frameCharacterBoxes: Map<number, Map<string, BoundingBox>>,
  frameCharacterMap: Map<number, string[]>,
  shots: Shot[],
  videoDuration: number,
  fps: number
): Promise<void> {
  if (characters.length === 0) return

  const THUMB = 160     // thumbnail size
  const PADDING = 16
  const LABEL_H = 48
  const canvasW = characters.length * (THUMB + PADDING) + PADDING
  const canvasH = THUMB + LABEL_H + PADDING * 2 + 120 // extra for timeline strip

  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  const ctx = canvas.getContext('2d')!

  // Background
  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, canvasW, canvasH)

  // Title
  ctx.fillStyle = '#e0e0e0'
  ctx.font = '13px monospace'
  ctx.fillText('CHARACTERS', PADDING, PADDING + 12)

  // Draw each character thumbnail from video
  const url = URL.createObjectURL(videoFile)
  const video = document.createElement('video')
  video.src = url
  await new Promise<void>(r => { video.onloadedmetadata = () => r() })

  for (let ci = 0; ci < characters.length; ci++) {
    const char = characters[ci]
    const x = PADDING + ci * (THUMB + PADDING)
    const y = PADDING + 24

    // Find a frame where this character appears and has a bounding box
    let sampleFrame = -1
    for (const [frame, ids] of frameCharacterMap.entries()) {
      if (ids.includes(char.id) && frameCharacterBoxes.get(frame)?.has(char.id)) {
        sampleFrame = frame
        break
      }
    }

    if (sampleFrame >= 0) {
      // Seek to that frame
      video.currentTime = sampleFrame / fps
      await new Promise<void>(r => { video.onseeked = () => r() })

      const box = frameCharacterBoxes.get(sampleFrame)?.get(char.id)

      // Draw the video frame into a temp canvas, then crop the face
      const tmp = document.createElement('canvas')
      tmp.width = video.videoWidth
      tmp.height = video.videoHeight
      tmp.getContext('2d')!.drawImage(video, 0, 0)

      if (box) {
        // Draw cropped face with some padding
        const pad = box.width * 0.3
        const sx = Math.max(0, box.x - pad)
        const sy = Math.max(0, box.y - pad)
        const sw = Math.min(tmp.width - sx, box.width + pad * 2)
        const sh = Math.min(tmp.height - sy, box.height + pad * 2)
        ctx.drawImage(tmp, sx, sy, sw, sh, x, y, THUMB, THUMB)
      } else {
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, THUMB, THUMB)
      }
    } else {
      // No frame found — draw placeholder
      ctx.fillStyle = '#EAE1DF'
      ctx.fillRect(x, y, THUMB, THUMB)
      ctx.fillStyle = '#9E8B88'
      ctx.font = '11px monospace'
      ctx.fillText('no frame', x + 10, y + THUMB / 2)
    }

    // Label: character ID and frame count
    ctx.fillStyle = '#e0e0e0'
    ctx.font = 'bold 11px monospace'
    ctx.fillText(char.id.slice(0, 8), x, y + THUMB + 14)
    ctx.fillStyle = '#545E56'
    ctx.font = '10px monospace'
    ctx.fillText(`${char.frameCount} frames`, x, y + THUMB + 28)
  }

  URL.revokeObjectURL(url)

  // Character appearance timeline strip at the bottom
  const timelineY = PADDING + 24 + THUMB + LABEL_H + PADDING
  const timelineW = canvasW - PADDING * 2
  const timelineH = 40
  const totalFrames = Math.floor(videoDuration * fps)
  const charColors = ['#00ffa3', '#667761', '#0d2818', '#9E8B88', '#C5B4A0', '#8B9E8B']

  ctx.fillStyle = '#EAE1DF'
  ctx.fillRect(PADDING, timelineY, timelineW, timelineH)

  // Draw shot boundaries
  for (const shot of shots) {
    const sx = PADDING + (shot.startFrame / totalFrames) * timelineW
    ctx.strokeStyle = '#e0e0e040'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(sx, timelineY)
    ctx.lineTo(sx, timelineY + timelineH)
    ctx.stroke()
  }

  // Draw character presence as rows
  const rowH = timelineH / Math.max(1, characters.length)
  for (let ci = 0; ci < characters.length; ci++) {
    const char = characters[ci]
    const color = charColors[ci % charColors.length]
    for (const [frame, ids] of frameCharacterMap.entries()) {
      if (ids.includes(char.id)) {
        const fx = PADDING + (frame / totalFrames) * timelineW
        ctx.fillStyle = color
        ctx.fillRect(fx, timelineY + ci * rowH, Math.max(1, timelineW / totalFrames), rowH)
      }
    }
  }

  // Timeline label
  ctx.fillStyle = '#545E56'
  ctx.font = '9px monospace'
  ctx.fillText('CHARACTER TIMELINE', PADDING, timelineY + timelineH + 12)

  downloadCanvas(canvas, 'mosaic-glitch-characters.png')
}

// ── Phase 3: Emotion Timeline ────────────────────────────────────────────────

/**
 * Export the emotion timeline as a tall color strip — readable as a mosaic input.
 */
export function exportEmotionTimeline(
  emotionTimeline: EmotionFrame[],
  shots: Shot[],
  duration: number,
  fps: number
): void {
  if (emotionTimeline.length === 0) return

  const W = 1920
  const STRIP_H = 120
  const LEGEND_H = 200
  const H = STRIP_H + LEGEND_H
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // Background
  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, W, H)

  // Draw each frame as a vertical slice
  const totalFrames = emotionTimeline.length
  const sliceW = W / totalFrames

  for (let fi = 0; fi < totalFrames; fi++) {
    const frame = emotionTimeline[fi]
    const color = EMOTION_COLORS[frame.emotion] ?? '#888'
    const x = (fi / totalFrames) * W
    ctx.fillStyle = color
    ctx.globalAlpha = frame.confidence ?? 1
    ctx.fillRect(x, 0, Math.ceil(sliceW), STRIP_H)
  }
  ctx.globalAlpha = 1

  // Shot boundary lines
  ctx.strokeStyle = '#e0e0e060'
  ctx.lineWidth = 1.5
  for (const shot of shots) {
    const x = (shot.startFrame / totalFrames) * W
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, STRIP_H)
    ctx.stroke()
  }

  // Title bar over the strip
  ctx.fillStyle = '#e0e0e088'
  ctx.fillRect(0, 0, W, 20)
  ctx.fillStyle = '#0a0a0a'
  ctx.font = '11px monospace'
  ctx.fillText(`EMOTION TIMELINE  ·  ${duration.toFixed(1)}s  ·  ${totalFrames} frames  ·  ${shots.length} shots`, 12, 14)

  // Legend below
  const legendY = STRIP_H + 20
  const emotionsInUse = [...new Set(emotionTimeline.map(f => f.emotion))]
  const cols = 4
  const cellW = W / cols
  const cellH = 36

  ctx.fillStyle = '#e0e0e0'
  ctx.font = 'bold 11px monospace'
  ctx.fillText('EMOTIONS IN THIS VIDEO', 12, legendY - 6)

  emotionsInUse.forEach((emotion, idx) => {
    const col = idx % cols
    const row = Math.floor(idx / cols)
    const ex = col * cellW + 12
    const ey = legendY + row * cellH

    const count = emotionTimeline.filter(f => f.emotion === emotion).length
    const pct = Math.round((count / totalFrames) * 100)
    const color = EMOTION_COLORS[emotion] ?? '#888'
    const meta = EMOTION_COLOR_MAPPINGS.find(m => m.emotion === emotion)

    // Swatch
    ctx.fillStyle = color
    ctx.fillRect(ex, ey, 20, 20)

    // Label
    ctx.fillStyle = '#e0e0e0'
    ctx.font = 'bold 11px monospace'
    ctx.fillText(meta?.displayName ?? emotion, ex + 28, ey + 10)
    ctx.fillStyle = '#545E56'
    ctx.font = '10px monospace'
    ctx.fillText(`${pct}%  (${count} frames)`, ex + 28, ey + 23)
  })

  downloadCanvas(canvas, 'mosaic-glitch-emotion-timeline.png')
}

// ── Phase 4/5: Image Library / Buckets ──────────────────────────────────────

/**
 * Export the color bucket breakdown as a horizontal bar chart PNG.
 */
export async function exportBucketBreakdown(
  buckets: EmotionBuckets,
  totalAnalyzed: number
): Promise<void> {
  const entries = Object.entries(buckets).filter(([, imgs]) => imgs.length > 0)
  if (entries.length === 0) return

  const W = 800
  const ROW_H = 48
  const THUMB_SIZE = 36
  const LABEL_W = 140
  const PADDING = 20
  const H = PADDING + entries.length * ROW_H + PADDING + 40
  const BAR_W = W - LABEL_W - PADDING * 3 - 80

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, W, H)

  // Title
  ctx.fillStyle = '#e0e0e0'
  ctx.font = 'bold 12px monospace'
  ctx.fillText(`COLOR BUCKETS  ·  ${totalAnalyzed} images analyzed`, PADDING, PADDING)

  const maxCount = Math.max(...entries.map(([, imgs]) => imgs.length))

  for (let i = 0; i < entries.length; i++) {
    const [emotion, imgs] = entries[i]
    const color = EMOTION_COLORS[emotion] ?? '#888'
    const meta = EMOTION_COLOR_MAPPINGS.find(m => m.emotion === emotion)
    const y = PADDING + 16 + i * ROW_H

    // Color swatch
    ctx.fillStyle = color
    ctx.fillRect(PADDING, y + 8, 16, 16)

    // Label
    ctx.fillStyle = '#e0e0e0'
    ctx.font = 'bold 11px monospace'
    ctx.fillText(meta?.displayName ?? emotion, PADDING + 24, y + 16)
    ctx.fillStyle = '#545E56'
    ctx.font = '10px monospace'
    ctx.fillText(`${imgs.length}`, PADDING + 24, y + 28)

    // Bar
    const barW = (imgs.length / maxCount) * BAR_W
    ctx.fillStyle = color
    ctx.globalAlpha = 0.6
    ctx.fillRect(LABEL_W + PADDING, y + 6, barW, ROW_H - 16)
    ctx.globalAlpha = 1

    // Thumbnail strip
    const thumbY = y + (ROW_H - THUMB_SIZE) / 2
    const startX = LABEL_W + PADDING + BAR_W + PADDING
    let thumbX = startX
    for (let t = 0; t < Math.min(3, imgs.length); t++) {
      try {
        const bitmap = imgs[t].bitmap
        if (bitmap) {
          const tmp = document.createElement('canvas')
          tmp.width = THUMB_SIZE
          tmp.height = THUMB_SIZE
          tmp.getContext('2d')!.drawImage(bitmap, 0, 0, THUMB_SIZE, THUMB_SIZE)
          ctx.drawImage(tmp, thumbX, thumbY, THUMB_SIZE, THUMB_SIZE)
        } else {
          ctx.fillStyle = color
          ctx.globalAlpha = 0.3
          ctx.fillRect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE)
          ctx.globalAlpha = 1
        }
        thumbX += THUMB_SIZE + 2
      } catch { /* skip */ }
    }
  }

  downloadCanvas(canvas, 'mosaic-glitch-color-buckets.png')
}

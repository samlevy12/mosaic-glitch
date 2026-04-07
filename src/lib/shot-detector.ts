/**
 * shot-detector.ts
 * Detects scene cuts via frame-to-frame pixel difference,
 * then labels each shot with which characters appear in it.
 *
 * Base structure from Ollama (deepseek-coder-v2:16b), corrected and completed.
 */

import type { Shot, ShotConflict } from './types'

export type ShotDetectorProgressCallback = (progress: number) => void

export function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => { video.removeEventListener('seeked', handler); resolve() }
    video.addEventListener('seeked', handler)
    video.currentTime = time
  })
}

export async function detectShots(
  videoFile: File,
  threshold: number = 0.15,
  onProgress?: ShotDetectorProgressCallback
): Promise<Shot[]> {
  const url = URL.createObjectURL(videoFile)
  const video = document.createElement('video')
  video.src = url
  video.muted = true

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Failed to load video for shot detection'))
  })

  const duration = video.duration
  const FPS = 30
  const totalFrames = Math.floor(duration * FPS)

  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 90
  const ctx = canvas.getContext('2d')!

  const shots: Shot[] = []
  let shotStart = 0
  let prevGray: Uint8ClampedArray | null = null

  for (let fi = 0; fi < totalFrames; fi++) {
    const time = fi / FPS
    await seekTo(video, time)
    ctx.drawImage(video, 0, 0, 160, 90)
    const imageData = ctx.getImageData(0, 0, 160, 90).data

    // Convert to grayscale
    const gray = new Uint8ClampedArray(160 * 90)
    for (let p = 0; p < 160 * 90; p++) {
      gray[p] = Math.round(0.299 * imageData[p * 4] + 0.587 * imageData[p * 4 + 1] + 0.114 * imageData[p * 4 + 2])
    }

    if (prevGray) {
      let diffSum = 0
      for (let p = 0; p < gray.length; p++) {
        diffSum += Math.abs(gray[p] - prevGray[p])
      }
      const meanDiff = diffSum / (gray.length * 255)

      if (meanDiff > threshold) {
        // Cut detected — close previous shot, start new one
        shots.push({
          startFrame: shotStart,
          endFrame: fi - 1,
          startTime: shotStart / FPS,
          endTime: (fi - 1) / FPS,
          characterIds: [],
        })
        shotStart = fi
      }
    }

    prevGray = gray
    onProgress?.(fi / totalFrames)
  }

  // Close final shot
  shots.push({
    startFrame: shotStart,
    endFrame: totalFrames - 1,
    startTime: shotStart / FPS,
    endTime: duration,
    characterIds: [],
  })

  URL.revokeObjectURL(url)
  return shots
}

export function labelShotsWithCharacters(
  shots: Shot[],
  frameCharacterMap: Map<number, string[]>
): Shot[] {
  return shots.map(shot => {
    const charSet = new Set<string>()
    for (const [frameIdx, charIds] of frameCharacterMap) {
      if (frameIdx >= shot.startFrame && frameIdx <= shot.endFrame) {
        for (const id of charIds) charSet.add(id)
      }
    }
    return { ...shot, characterIds: Array.from(charSet) }
  })
}

export function findConflictShots(
  shots: Shot[],
  selectedCharacterIds: string[]
): ShotConflict[] {
  const conflicts: ShotConflict[] = []
  for (const shot of shots) {
    const matching = shot.characterIds.filter(id => selectedCharacterIds.includes(id))
    if (matching.length > 1) {
      conflicts.push({ shot, characterIds: matching })
    }
  }
  return conflicts
}

export function filterShots(
  shots: Shot[],
  selectedCharacterIds: string[],
  resolvedConflicts: Map<string, boolean>
): Shot[] {
  return shots.filter(shot => {
    const hasSelected = shot.characterIds.some(id => selectedCharacterIds.includes(id))
    if (!hasSelected) return false

    const matching = shot.characterIds.filter(id => selectedCharacterIds.includes(id))
    if (matching.length > 1) {
      const key = `${shot.startFrame}-${shot.endFrame}`
      return resolvedConflicts.get(key) === true
    }

    return true
  })
}

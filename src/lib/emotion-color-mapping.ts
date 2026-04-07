/**
 * Emotion-Color Psychology Mapping
 * Maps color ranges to emotions for character animation segmentation
 */

export type Emotion =
  | 'happy'
  | 'excited'
  | 'angry'
  | 'sad'
  | 'calm'
  | 'surprised'
  | 'fearful'
  | 'disgusted'
  | 'tender'
  | 'confident'
  | 'confused'
  | 'mysterious'
  | 'neutral'

export interface EmotionColorMap {
  emotion: Emotion
  displayName: string
  primaryColor: string // Hex color for UI display
  hueRange: [number, number] // HSL hue range [min, max] in degrees (0-360)
  saturationMin: number // Minimum saturation % for color to be recognized
}

export const EMOTION_COLOR_MAPPINGS: EmotionColorMap[] = [
  {
    emotion: 'happy',
    displayName: 'Happy/Joyful',
    primaryColor: '#FFD700',
    hueRange: [45, 65], // Yellow
    saturationMin: 40,
  },
  {
    emotion: 'excited',
    displayName: 'Excited/Enthusiastic',
    primaryColor: '#FF8C00',
    hueRange: [25, 45], // Orange
    saturationMin: 40,
  },
  {
    emotion: 'angry',
    displayName: 'Angry/Aggressive',
    primaryColor: '#FF0000',
    hueRange: [350, 15], // Bright Red (wraps around 0)
    saturationMin: 50,
  },
  {
    emotion: 'sad',
    displayName: 'Sad/Melancholic',
    primaryColor: '#00008B',
    hueRange: [200, 240], // Deep Blue
    saturationMin: 30,
  },
  {
    emotion: 'calm',
    displayName: 'Calm/Peaceful',
    primaryColor: '#90EE90',
    hueRange: [100, 150], // Light Green
    saturationMin: 20,
  },
  {
    emotion: 'surprised',
    displayName: 'Surprised/Shocked',
    primaryColor: '#FF00FF',
    hueRange: [280, 320], // Bright Purple
    saturationMin: 50,
  },
  {
    emotion: 'fearful',
    displayName: 'Fearful/Anxious',
    primaryColor: '#4B0082',
    hueRange: [260, 280], // Dark Purple
    saturationMin: 40,
  },
  {
    emotion: 'disgusted',
    displayName: 'Disgusted/Repulsed',
    primaryColor: '#6B4423',
    hueRange: [20, 40], // Brown/Olive
    saturationMin: 20,
  },
  {
    emotion: 'tender',
    displayName: 'Tender/Loving',
    primaryColor: '#FF69B4',
    hueRange: [320, 350], // Pink/Magenta
    saturationMin: 35,
  },
  {
    emotion: 'confident',
    displayName: 'Confident/Proud',
    primaryColor: '#FFD700',
    hueRange: [40, 60], // Gold
    saturationMin: 50,
  },
  {
    emotion: 'confused',
    displayName: 'Confused/Uncertain',
    primaryColor: '#A9A9A9',
    hueRange: [0, 360], // Gray (any hue, low saturation)
    saturationMin: 0,
  },
  {
    emotion: 'mysterious',
    displayName: 'Mysterious/Intriguing',
    primaryColor: '#191970',
    hueRange: [240, 270], // Deep Indigo
    saturationMin: 40,
  },
  {
    emotion: 'neutral',
    displayName: 'Neutral/Natural',
    primaryColor: '#D3D3D3',
    hueRange: [0, 360], // Light Gray/Beige (any hue, very low saturation)
    saturationMin: 0,
  },
]

/**
 * Get emotion from HSL color values
 */
export function getEmotionFromColor(h: number, s: number, l: number): Emotion {
  // Normalize hue to 0-360
  const normalizedHue = ((h % 360) + 360) % 360

  // Handle low saturation colors (gray, neutral, confused)
  if (s < 15) {
    return 'neutral'
  }

  if (s < 25) {
    return 'confused'
  }

  // Find matching emotion by hue range
  for (const mapping of EMOTION_COLOR_MAPPINGS) {
    if (mapping.saturationMin === 0) continue // Skip neutral/confused, already handled

    const [minHue, maxHue] = mapping.hueRange

    // Handle hue wrapping (e.g., red spans 350-360 and 0-15)
    const isInRange =
      minHue > maxHue
        ? normalizedHue >= minHue || normalizedHue <= maxHue
        : normalizedHue >= minHue && normalizedHue <= maxHue

    if (isInRange && s >= mapping.saturationMin) {
      return mapping.emotion
    }
  }

  return 'neutral'
}

/**
 * Convert RGB to HSL
 */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      case b:
        h = ((r - g) / d + 4) / 6
        break
    }
  }

  return [h * 360, s * 100, l * 100]
}

/**
 * Get dominant color from video frame using canvas
 */
export async function getDominantColorFromFrame(
  video: HTMLVideoElement,
  timeSeconds: number
): Promise<[number, number, number]> {
  return new Promise((resolve, reject) => {
    video.currentTime = timeSeconds

    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)

      try {
        const canvas = document.createElement('canvas')
        canvas.width = 100 // Smaller for performance
        canvas.height = 100
        const ctx = canvas.getContext('2d')

        if (!ctx) {
          reject(new Error('Could not get canvas context'))
          return
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const data = imageData.data

        let r = 0,
          g = 0,
          b = 0
        const pixels = data.length / 4

        for (let i = 0; i < data.length; i += 4) {
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
        }

        r = Math.round(r / pixels)
        g = Math.round(g / pixels)
        b = Math.round(b / pixels)

        resolve([r, g, b])
      } catch (error) {
        reject(error)
      }
    }

    video.addEventListener('seeked', onSeeked, { once: true })
  })
}

export interface EmotionSegment {
  emotion: Emotion
  startTime: number // Seconds
  endTime: number
  dominantColor: string // Hex color
  confidence: number // 0-1, how confident we are in this emotion
}

/**
 * Analyze video and segment it by emotion/color
 */
export async function analyzeVideoEmotions(
  videoFile: File,
  segmentDurationSeconds: number = 2,
  onProgress?: (progress: number) => void
): Promise<EmotionSegment[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'

    const url = URL.createObjectURL(videoFile)
    video.src = url

    const onLoadedMetadata = async () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)

      try {
        const duration = video.duration
        const segments: EmotionSegment[] = []
        const numSegments = Math.ceil(duration / segmentDurationSeconds)

        for (let i = 0; i < numSegments; i++) {
          const startTime = i * segmentDurationSeconds
          const endTime = Math.min((i + 1) * segmentDurationSeconds, duration)
          const midTime = (startTime + endTime) / 2

          const [r, g, b] = await getDominantColorFromFrame(video, midTime)
          const [h, s, l] = rgbToHsl(r, g, b)
          const emotion = getEmotionFromColor(h, s, l)
          const confidence = s / 100 // Saturation as confidence

          segments.push({
            emotion,
            startTime,
            endTime,
            dominantColor: `rgb(${r},${g},${b})`,
            confidence,
          })

          onProgress?.((i + 1) / numSegments)
        }

        // Merge consecutive segments with same emotion
        const merged = mergeConsecutiveSegments(segments)
        resolve(merged)
      } catch (error) {
        reject(error)
      } finally {
        URL.revokeObjectURL(url)
      }
    }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
  })
}

/**
 * Merge consecutive segments with the same emotion
 */
function mergeConsecutiveSegments(segments: EmotionSegment[]): EmotionSegment[] {
  if (segments.length === 0) return []

  const merged: EmotionSegment[] = []
  let current = { ...segments[0] }

  for (let i = 1; i < segments.length; i++) {
    if (segments[i].emotion === current.emotion) {
      // Merge with current
      current.endTime = segments[i].endTime
      current.confidence = (current.confidence + segments[i].confidence) / 2
    } else {
      // Start new segment
      merged.push(current)
      current = { ...segments[i] }
    }
  }

  merged.push(current)
  return merged
}

/**
 * Extract frames from a video segment
 */
export async function extractFramesFromSegment(
  video: HTMLVideoElement,
  startTime: number,
  endTime: number,
  frameCount: number = 8
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = []
    let framesExtracted = 0

    const extractFrame = (timeSeconds: number) => {
      video.currentTime = timeSeconds

      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked)

        try {
          const canvas = document.createElement('canvas')
          canvas.width = 160
          canvas.height = 160
          const ctx = canvas.getContext('2d')

          if (!ctx) {
            reject(new Error('Could not get canvas context'))
            return
          }

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          frames.push(canvas.toDataURL('image/png'))
          framesExtracted++

          if (framesExtracted >= frameCount) {
            resolve(frames)
          } else {
            const nextTime = startTime + ((framesExtracted / frameCount) * (endTime - startTime))
            extractFrame(nextTime)
          }
        } catch (error) {
          reject(error)
        }
      }

      video.addEventListener('seeked', onSeeked, { once: true })
    }

    if (frameCount <= 0) {
      resolve([])
      return
    }

    extractFrame(startTime)
  })
}

/**
 * Get recommended FPS for an emotion
 * Slower emotions play back slower, faster emotions play back faster
 */
export function getEmotionFps(emotion: Emotion): number {
  const emotionFpsMap: Record<Emotion, number> = {
    calm: 6,
    tender: 7,
    neutral: 8,
    sad: 7,
    confused: 8,
    mysterious: 10,
    confident: 12,
    happy: 11,
    surprised: 13,
    excited: 14,
    fearful: 14,
    angry: 15,
    disgusted: 12,
  }
  return emotionFpsMap[emotion] || 10
}

/**
 * Get emotion display info
 */
export function getEmotionInfo(emotion: Emotion) {
  return EMOTION_COLOR_MAPPINGS.find((m) => m.emotion === emotion)
}

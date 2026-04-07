/**
 * emotion-inference.ts
 * Multi-signal emotion inference engine.
 *
 * face-api.js only outputs 7 basic expressions (happy, sad, angry, surprised,
 * fearful, disgusted, neutral). This module infers the full 13-emotion palette
 * by combining:
 *
 *   1. Composite expression scores — combinations of face-api scores map to
 *      emotions it can't detect directly (calm, excited, tender, confident,
 *      mysterious, confused).
 *
 *   2. Scene color signal — dominant hue/saturation/lightness of the frame,
 *      weighted as a secondary signal to disambiguate or fill gaps.
 *
 *   3. Scene energy — brightness + contrast of the frame. Dark low-contrast
 *      = mysterious/fearful, bright high-contrast = excited/confident.
 *
 *   4. Temporal smoothing — exponential moving average on raw 13-emotion
 *      scores before picking the winner, reducing single-frame noise.
 *
 * The output is a full 13-emotion score vector per frame, from which
 * buildAutoTimeline picks the top emotion.
 */

import type { Emotion } from './emotion-color-mapping'
import { rgbToHsl, getEmotionFromColor } from './emotion-color-mapping'

// ── Types ────────────────────────────────────────────────────────────────────

/** Full 13-emotion score vector, each 0-1 */
export type EmotionScores = Record<Emotion, number>

/** Scene-level features extracted from a video frame */
export interface SceneFeatures {
  /** Mean luminance 0-255 */
  brightness: number
  /** Standard deviation of luminance 0-255 */
  contrast: number
  /** Dominant hue 0-360 */
  hue: number
  /** Dominant saturation 0-100 */
  saturation: number
  /** Dominant lightness 0-100 */
  lightness: number
}

// ── Constants ────────────────────────────────────────────────────────────────

const ALL_EMOTIONS: Emotion[] = [
  'happy', 'sad', 'angry', 'surprised', 'fearful', 'disgusted',
  'calm', 'excited', 'tender', 'confident', 'mysterious', 'confused', 'neutral',
]

/** How much weight the face expression signal gets vs scene color (0-1) */
const FACE_WEIGHT = 0.65
const SCENE_WEIGHT = 0.20
const ENERGY_WEIGHT = 0.15

/** EMA alpha for temporal smoothing (higher = more responsive, lower = smoother) */
const EMA_ALPHA = 0.35

// ── Composite Expression Inference ───────────────────────────────────────────

/**
 * Takes the 7 raw face-api scores and produces a 13-emotion score vector.
 * The 6 missing emotions are inferred from combinations:
 *
 *   calm      = high neutral + slight happy + low energy in other scores
 *   excited   = high happy + high surprised + any angry energy
 *   tender    = moderate happy + low everything else (gentle smile)
 *   confident = moderate happy + low surprised + low fearful (composed)
 *   mysterious = moderate neutral + moderate fearful + moderate sad (ambiguous)
 *   confused  = mixed signals — no clear winner, multiple mid-range scores
 */
export function inferCompositeScores(
  faceScores: Record<string, number>
): EmotionScores {
  const h = faceScores.happy ?? 0
  const s = faceScores.sad ?? 0
  const a = faceScores.angry ?? 0
  const su = faceScores.surprised ?? 0
  const fe = faceScores.fearful ?? 0
  const d = faceScores.disgusted ?? 0
  const n = faceScores.neutral ?? 0

  // Start with the 7 direct scores
  const scores: EmotionScores = {
    happy: h,
    sad: s,
    angry: a,
    surprised: su,
    fearful: fe,
    disgusted: d,
    neutral: n,
    // Inferred emotions below
    calm: 0,
    excited: 0,
    tender: 0,
    confident: 0,
    mysterious: 0,
    confused: 0,
  }

  // ── Calm: neutral + a touch of happy, nothing intense ──────────────────
  // A relaxed, peaceful face — mostly neutral with maybe a slight smile,
  // no strong emotion signal.
  const intensity = Math.max(a, su, fe, d)  // how "activated" the face is
  scores.calm = Math.min(1, n * 0.6 + h * 0.3) * Math.max(0, 1 - intensity * 2)

  // ── Excited: happy + surprised, high activation ────────────────────────
  // Wide-eyed enthusiasm, big smile + raised eyebrows
  scores.excited = Math.min(1, (h * 0.5 + su * 0.5) * 1.4) * Math.max(0, 1 - s * 2 - fe * 2)

  // ── Tender: gentle happiness, low activation ───────────────────────────
  // Soft smile, no surprise or fear — warmth without excitement
  const gentleness = Math.max(0, 1 - su * 3 - a * 3 - fe * 3 - d * 3)
  scores.tender = Math.min(1, h * 0.7 * gentleness) * Math.max(0, 1 - n * 0.3)

  // ── Confident: composed happiness, low fear/surprise ───────────────────
  // Sure of themselves — happy but not surprised, not scared
  const composure = Math.max(0, 1 - su * 2 - fe * 3 - s * 2)
  scores.confident = Math.min(1, (h * 0.4 + n * 0.3) * composure * 1.3) * Math.max(0, 1 - a * 2)

  // ── Mysterious: ambiguous, neutral-leaning with hints of sadness/fear ──
  // Mona Lisa vibes — inscrutable, hints of something beneath the surface
  const ambiguity = Math.min(n, 0.8) // needs neutrality as a base
  const depth = Math.min(1, s * 0.4 + fe * 0.3 + d * 0.2) // subtle dark undertones
  scores.mysterious = ambiguity * depth * 2.5

  // ── Confused: no clear winner — scattered mid-range scores ─────────────
  // Multiple emotions at similar levels, nothing dominant
  const sorted = [h, s, a, su, fe, d, n].sort((a, b) => b - a)
  const gap = sorted[0] - sorted[1]  // small gap = confusion
  const entropy = 1 - gap  // high when scores are similar
  scores.confused = Math.min(1, entropy * 0.6) * Math.max(0, 1 - sorted[0] * 0.8)

  // ── Dampen neutral when composite emotions are strong ──────────────────
  // Prevent neutral from always winning by dampening it when we've inferred
  // a meaningful composite emotion
  const compositeMax = Math.max(scores.calm, scores.excited, scores.tender,
    scores.confident, scores.mysterious, scores.confused)
  if (compositeMax > 0.15) {
    scores.neutral *= Math.max(0.3, 1 - compositeMax * 0.8)
  }

  // ── Normalize: ensure scores sum to ~1 for clean comparison ────────────
  const sum = ALL_EMOTIONS.reduce((acc, e) => acc + scores[e], 0)
  if (sum > 0) {
    for (const e of ALL_EMOTIONS) scores[e] /= sum
  }

  return scores
}

// ── Scene Color Signal ───────────────────────────────────────────────────────

/**
 * Converts scene features into a 13-emotion score vector based on the
 * color-emotion mapping (same as image analysis uses).
 */
export function sceneColorToScores(features: SceneFeatures): EmotionScores {
  const scores: EmotionScores = {} as EmotionScores
  for (const e of ALL_EMOTIONS) scores[e] = 0

  // Primary: direct color → emotion mapping
  const primary = getEmotionFromColor(features.hue, features.saturation, features.lightness)
  scores[primary] = 0.6

  // Secondary: add softer signals from brightness/contrast
  // Dark scenes lean mysterious/fearful
  if (features.brightness < 80) {
    scores.mysterious += 0.15 * (1 - features.brightness / 80)
    scores.fearful += 0.1 * (1 - features.brightness / 80)
  }
  // Bright scenes lean happy/excited
  if (features.brightness > 170) {
    scores.happy += 0.1 * ((features.brightness - 170) / 85)
    scores.excited += 0.08 * ((features.brightness - 170) / 85)
  }
  // Low saturation = neutral/confused territory
  if (features.saturation < 20) {
    scores.neutral += 0.2
    scores.confused += 0.1
  }
  // High saturation = more emotional intensity
  if (features.saturation > 60) {
    scores[primary] += 0.15
  }

  // Normalize
  const sum = ALL_EMOTIONS.reduce((acc, e) => acc + scores[e], 0)
  if (sum > 0) for (const e of ALL_EMOTIONS) scores[e] /= sum

  return scores
}

/**
 * Converts scene energy (brightness + contrast) into emotion biases.
 */
export function sceneEnergyToScores(features: SceneFeatures): EmotionScores {
  const scores: EmotionScores = {} as EmotionScores
  for (const e of ALL_EMOTIONS) scores[e] = 0

  const b = features.brightness / 255  // 0-1
  const c = features.contrast / 128    // 0-~2, usually 0-1

  // High energy (bright + high contrast) → excited, confident, happy
  const energy = (b * 0.5 + Math.min(c, 1) * 0.5)
  scores.excited += energy * 0.3
  scores.confident += energy * 0.2
  scores.happy += energy * 0.15

  // Low energy (dark + low contrast) → calm, mysterious, sad
  const lethargy = (1 - b) * 0.5 + Math.max(0, 1 - c) * 0.5
  scores.calm += lethargy * 0.2
  scores.mysterious += lethargy * 0.25
  scores.sad += lethargy * 0.15

  // Mid-range = tender, neutral
  const midRange = 1 - Math.abs(energy - 0.5) * 2
  scores.tender += midRange * 0.15
  scores.neutral += midRange * 0.1

  // Normalize
  const sum = ALL_EMOTIONS.reduce((acc, e) => acc + scores[e], 0)
  if (sum > 0) for (const e of ALL_EMOTIONS) scores[e] /= sum

  return scores
}

// ── Fusion ───────────────────────────────────────────────────────────────────

/**
 * Fuse multiple signal vectors into a single 13-emotion score.
 */
export function fuseSignals(
  faceScores: EmotionScores | null,
  sceneScores: EmotionScores | null,
  energyScores: EmotionScores | null,
): EmotionScores {
  const result: EmotionScores = {} as EmotionScores
  for (const e of ALL_EMOTIONS) result[e] = 0

  let totalWeight = 0

  if (faceScores) {
    for (const e of ALL_EMOTIONS) result[e] += faceScores[e] * FACE_WEIGHT
    totalWeight += FACE_WEIGHT
  }
  if (sceneScores) {
    for (const e of ALL_EMOTIONS) result[e] += sceneScores[e] * SCENE_WEIGHT
    totalWeight += SCENE_WEIGHT
  }
  if (energyScores) {
    for (const e of ALL_EMOTIONS) result[e] += energyScores[e] * ENERGY_WEIGHT
    totalWeight += ENERGY_WEIGHT
  }

  // Normalize by total weight used
  if (totalWeight > 0) {
    for (const e of ALL_EMOTIONS) result[e] /= totalWeight
  }

  return result
}

// ── Temporal Smoothing ───────────────────────────────────────────────────────

/**
 * Exponential moving average smoother for score vectors.
 * Call `update()` for each frame in order — it returns the smoothed vector.
 */
export class EmotionEMA {
  private state: EmotionScores | null = null

  update(scores: EmotionScores): EmotionScores {
    if (!this.state) {
      this.state = { ...scores }
      return { ...scores }
    }

    const smoothed: EmotionScores = {} as EmotionScores
    for (const e of ALL_EMOTIONS) {
      smoothed[e] = EMA_ALPHA * scores[e] + (1 - EMA_ALPHA) * this.state[e]
    }
    this.state = smoothed
    return { ...smoothed }
  }

  reset() {
    this.state = null
  }
}

// ── Scene Feature Extraction ─────────────────────────────────────────────────

/**
 * Extract scene-level features from a canvas.
 * Samples a grid of pixels for speed — doesn't need every pixel.
 */
export function extractSceneFeatures(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): SceneFeatures {
  // Sample on a coarse grid for speed
  const step = Math.max(4, Math.floor(Math.min(width, height) / 50))
  let sumR = 0, sumG = 0, sumB = 0, sumL = 0, sumL2 = 0
  let count = 0

  const imgData = ctx.getImageData(0, 0, width, height)
  const d = imgData.data

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const r = d[i], g = d[i + 1], b = d[i + 2]
      sumR += r; sumG += g; sumB += b
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      sumL += lum
      sumL2 += lum * lum
      count++
    }
  }

  if (count === 0) {
    return { brightness: 128, contrast: 40, hue: 0, saturation: 0, lightness: 50 }
  }

  const meanR = sumR / count
  const meanG = sumG / count
  const meanB = sumB / count
  const meanL = sumL / count
  const variance = sumL2 / count - meanL * meanL
  const contrast = Math.sqrt(Math.max(0, variance))

  const [hue, saturation, lightness] = rgbToHsl(
    Math.round(meanR), Math.round(meanG), Math.round(meanB)
  )

  return { brightness: meanL, contrast, hue, saturation, lightness }
}

// ── Top-level convenience ────────────────────────────────────────────────────

/**
 * Pick the winning emotion from a score vector.
 */
export function topEmotion(scores: EmotionScores): { emotion: Emotion; confidence: number } {
  let best: Emotion = 'neutral'
  let bestScore = -1
  for (const e of ALL_EMOTIONS) {
    if (scores[e] > bestScore) {
      bestScore = scores[e]
      best = e
    }
  }
  return { emotion: best, confidence: bestScore }
}

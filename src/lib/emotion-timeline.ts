/**
 * emotion-timeline.ts
 * Builds and manages a per-frame emotion map from either:
 *   - Auto mode: face-api.js expression scores per frame
 *   - Manual mode: user-painted segments
 * Also applies temporal smoothing (per-frame ↔ per-shot window).
 *
 * Base from Ollama (deepseek-coder-v2:16b), corrected.
 */

import type { EmotionFrame, ManualSegment, Shot } from './types'
import type { Emotion } from './emotion-color-mapping'
import {
  inferCompositeScores,
  sceneColorToScores,
  sceneEnergyToScores,
  fuseSignals,
  topEmotion as pickTopEmotion,
  EmotionEMA,
} from './emotion-inference'
import type { EmotionScores, SceneFeatures } from './emotion-inference'

// Maps face-api expression names to our Emotion type
const FACEAPI_TO_EMOTION: Record<string, Emotion> = {
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  surprised: 'surprised',
  fearful: 'fearful',
  disgusted: 'disgusted',
  neutral: 'neutral',
}

/**
 * Build emotion timeline using multi-signal fusion.
 *
 * @param expressions  face-api expression scores per frame (7 basic emotions)
 * @param totalFrames  total frame count at 30fps
 * @param sceneFeatures  optional per-frame scene features (color, brightness, contrast)
 *                        — if provided, fused with face expressions for richer detection
 */
export function buildAutoTimeline(
  expressions: Map<number, Record<string, number>>,
  totalFrames: number,
  sceneFeatures?: Map<number, SceneFeatures>,
): EmotionFrame[] {
  const timeline: EmotionFrame[] = []
  const ema = new EmotionEMA()

  for (let i = 0; i < totalFrames; i++) {
    const rawFace = expressions.get(i) ?? null
    const scene = sceneFeatures?.get(i) ?? null

    if (rawFace || scene) {
      // Infer full 13-emotion scores from face expressions
      const faceScores = rawFace ? inferCompositeScores(rawFace) : null

      // Scene color + energy signals
      const colorScores = scene ? sceneColorToScores(scene) : null
      const energyScores = scene ? sceneEnergyToScores(scene) : null

      // Fuse all signals
      const fused = fuseSignals(faceScores, colorScores, energyScores)

      // Temporal smoothing via EMA
      const smoothed = ema.update(fused)

      const { emotion, confidence } = pickTopEmotion(smoothed)
      timeline.push({ frameIndex: i, emotion, confidence, source: 'auto' })
    } else {
      // No data for this frame — carry forward but decay through EMA
      const prev = timeline[timeline.length - 1]
      timeline.push({
        frameIndex: i,
        emotion: prev?.emotion ?? 'neutral',
        confidence: (prev?.confidence ?? 0) * 0.95, // slight decay
        source: 'auto',
      })
    }
  }

  return timeline
}

/** Legacy simple builder — picks top of 7 face-api emotions only. No fusion. */
export function buildManualTimeline(
  segments: ManualSegment[],
  totalFrames: number,
  fps: number
): EmotionFrame[] {
  const timeline: EmotionFrame[] = []

  for (let i = 0; i < totalFrames; i++) {
    const timeSec = i / fps
    const seg = segments.find(s => s.startTime <= timeSec && s.endTime >= timeSec)
    timeline.push({
      frameIndex: i,
      emotion: seg?.emotion ?? 'neutral',
      confidence: 1.0,
      source: 'equal',
    })
  }

  return timeline
}

export function smoothTimeline(
  timeline: EmotionFrame[],
  shots: Shot[],
  smoothing: number
): EmotionFrame[] {
  if (smoothing === 0) return timeline

  const result = timeline.map(f => ({ ...f }))

  for (const shot of shots) {
    const len = shot.endFrame - shot.startFrame + 1
    if (len <= 0) continue

    if (smoothing >= 1) {
      // Full shot smoothing: replace all frames with shot's dominant emotion
      const dominant = getDominantEmotion(result, shot.startFrame, shot.endFrame)
      for (let fi = shot.startFrame; fi <= shot.endFrame && fi < result.length; fi++) {
        result[fi].emotion = dominant
      }
    } else {
      // Sliding window: window size scales with smoothing
      const windowRadius = Math.max(1, Math.round((smoothing * len) / 2))
      for (let fi = shot.startFrame; fi <= shot.endFrame && fi < result.length; fi++) {
        const winStart = Math.max(shot.startFrame, fi - windowRadius)
        const winEnd = Math.min(shot.endFrame, fi + windowRadius)
        result[fi].emotion = getDominantEmotion(result, winStart, winEnd)
      }
    }
  }

  return result
}

function getDominantEmotion(
  timeline: EmotionFrame[],
  startFrame: number,
  endFrame: number
): Emotion {
  const counts: Partial<Record<Emotion, number>> = {}
  for (let fi = startFrame; fi <= endFrame && fi < timeline.length; fi++) {
    const e = timeline[fi].emotion
    counts[e] = (counts[e] ?? 0) + 1
  }
  let best: Emotion = 'neutral'
  let bestCount = 0
  for (const [emotion, count] of Object.entries(counts) as [Emotion, number][]) {
    if (count > bestCount) { bestCount = count; best = emotion }
  }
  return best
}

export function getEmotionAtFrame(
  timeline: EmotionFrame[],
  frameIndex: number
): Emotion {
  return timeline[frameIndex]?.emotion ?? 'neutral'
}

// ── Section utilities ─────────────────────────────────────────────────────────

export interface EmotionSection {
  emotion: Emotion
  startFrame: number
  endFrame: number
  frameCount: number
  sectionIndex: number
}

/**
 * Computes contiguous same-emotion runs from a (smoothed) timeline.
 * Two separate "calm" sections each get their own entry with a unique sectionIndex.
 */
export function computeSections(timeline: EmotionFrame[]): EmotionSection[] {
  if (timeline.length === 0) return []
  const sections: EmotionSection[] = []
  let current = timeline[0].emotion
  let start = 0

  for (let i = 1; i <= timeline.length; i++) {
    const next = i < timeline.length ? timeline[i].emotion : null
    if (next !== current) {
      sections.push({
        emotion: current,
        startFrame: start,
        endFrame: i - 1,
        frameCount: i - start,
        sectionIndex: sections.length,
      })
      if (next !== null) {
        current = next
        start = i
      }
    }
  }

  return sections
}

/**
 * Builds a per-frame lookup: sectionFrameMap[fi] = sectionIndex.
 * Uses -1 for frames beyond the section list (shouldn't happen in practice).
 */
export function buildSectionFrameMap(sections: EmotionSection[], totalFrames: number): Int32Array {
  const map = new Int32Array(totalFrames).fill(-1)
  for (const s of sections) {
    for (let fi = s.startFrame; fi <= s.endFrame && fi < totalFrames; fi++) {
      map[fi] = s.sectionIndex
    }
  }
  return map
}

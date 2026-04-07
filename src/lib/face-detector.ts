/**
 * face-detector.ts
 * Wraps face-api.js to detect faces, cluster them into characters,
 * and produce per-frame character presence maps + bounding boxes + expressions.
 *
 * Frame indices are always stored at 30fps to match shot-detector.ts.
 */

import * as faceapi from 'face-api.js'
import { v4 as uuidv4 } from 'uuid'
import type { DetectedCharacter, FaceDetectionResult, BoundingBox } from './types'

export type FaceDetectorProgressCallback = (progress: number, label: string) => void

const DETECTION_FPS = 30   // frame index space shared with shot-detector

let modelsLoaded = false

export async function loadFaceModels(): Promise<void> {
  if (modelsLoaded) return
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
    faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
    faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
    faceapi.nets.faceExpressionNet.loadFromUri('/models'),
  ])
  modelsLoaded = true
}

function euclideanDist(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum)
}

/**
 * Greedy nearest-neighbour clustering with incremental mean update.
 * threshold 0.6 = face-api.js recommended same-person boundary.
 */
export function clusterDescriptors(
  descriptors: Float32Array[],
  threshold = 0.6
): Float32Array[][] {
  const clusters: Float32Array[][] = []
  const means: Float32Array[] = []

  for (const desc of descriptors) {
    let minDist = Infinity
    let minIdx = -1
    for (let i = 0; i < means.length; i++) {
      const d = euclideanDist(desc, means[i])
      if (d < minDist) { minDist = d; minIdx = i }
    }

    if (minIdx >= 0 && minDist < threshold) {
      clusters[minIdx].push(desc)
      const mean = means[minIdx]
      const n = clusters[minIdx].length
      for (let i = 0; i < mean.length; i++) mean[i] = (mean[i] * (n - 1) + desc[i]) / n
    } else {
      clusters.push([desc])
      means.push(new Float32Array(desc))
    }
  }

  return clusters
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise(resolve => {
    const handler = () => { video.removeEventListener('seeked', handler); resolve() }
    video.addEventListener('seeked', handler)
    video.currentTime = time
  })
}

export async function detectCharacters(
  videoFile: File,
  sampleRate = 1,
  onProgress?: FaceDetectorProgressCallback
): Promise<FaceDetectionResult> {
  const url = URL.createObjectURL(videoFile)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Failed to load video for face detection'))
  })

  const duration = video.duration
  const videoW = video.videoWidth
  const videoH = video.videoHeight

  // 960px-wide detection canvas — better small-face detection than the old 640px
  const detScale = Math.min(1, 960 / Math.max(videoW, 1))
  const cw = Math.round(videoW * detScale)
  const ch = Math.round(videoH * detScale)

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  type RawDetection = {
    /** Frame index at DETECTION_FPS (30fps) — matches shot-detector.ts */
    frameIndex: number
    time: number
    descriptor: Float32Array
    expressions: Record<string, number>
    /** Box in detection-canvas coords */
    box: { x: number; y: number; width: number; height: number }
    /** Box in original video pixel coords */
    originalBox: BoundingBox
    confidence: number
  }

  const allDetections: RawDetection[] = []
  const totalSamples = Math.floor(duration * sampleRate)

  // ── Frame scan ─────────────────────────────────────────────────────────────
  for (let i = 0; i <= totalSamples; i++) {
    const time = i / sampleRate
    if (time > duration) break

    await seekTo(video, time)
    ctx.drawImage(video, 0, 0, cw, ch)

    try {
      const detections = await faceapi
        .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({
          minConfidence: 0.3,
          maxResults: 10,
        }))
        .withFaceLandmarks()
        .withFaceDescriptors()
        .withFaceExpressions()

      for (const det of detections) {
        const box = det.detection.box
        allDetections.push({
          // Store at DETECTION_FPS so frame indices match shot-detector
          frameIndex: Math.round(time * DETECTION_FPS),
          time,
          descriptor: det.descriptor,
          expressions: det.expressions as unknown as Record<string, number>,
          box,
          originalBox: {
            x: box.x / detScale,
            y: box.y / detScale,
            width: box.width / detScale,
            height: box.height / detScale,
          },
          confidence: det.detection.score,
        })
      }
    } catch {
      // skip frames where detection fails
    }

    const found = allDetections.length
    onProgress?.(
      (i / totalSamples) * 0.75,
      `Frame ${i}/${totalSamples} — ${found} face detection${found !== 1 ? 's' : ''} so far`
    )
  }

  if (allDetections.length === 0) {
    URL.revokeObjectURL(url)
    return {
      characters: [],
      frameCharacterMap: new Map(),
      frameCharacterBoxes: new Map(),
      frameCharacterExpressions: new Map(),
    }
  }

  // ── Cluster into characters ────────────────────────────────────────────────
  onProgress?.(0.76, `Clustering ${allDetections.length} detections into characters...`)
  const descriptors = allDetections.map(d => d.descriptor)
  const clusters = clusterDescriptors(descriptors, 0.6)

  const clusterMeans: Float32Array[] = clusters.map(cluster => {
    const mean = new Float32Array(128)
    for (const d of cluster) for (let j = 0; j < 128; j++) mean[j] += d[j]
    for (let j = 0; j < 128; j++) mean[j] /= cluster.length
    return mean
  })

  const characterIds = clusters.map(() => uuidv4())
  const frameCharacterMap = new Map<number, string[]>()
  const frameCharacterBoxes = new Map<number, Map<string, BoundingBox>>()
  const frameCharacterExpressions = new Map<number, Map<string, Record<string, number>>>()
  const characterFrameCounts = new Array<number>(clusters.length).fill(0)
  const characterBestDetection: Array<{ detectionIdx: number; score: number } | null> =
    clusters.map(() => null)

  for (let di = 0; di < allDetections.length; di++) {
    const det = allDetections[di]
    let minDist = Infinity
    let assigned = 0
    for (let ci = 0; ci < clusterMeans.length; ci++) {
      const d = euclideanDist(det.descriptor, clusterMeans[ci])
      if (d < minDist) { minDist = d; assigned = ci }
    }

    const charId = characterIds[assigned]

    // frameCharacterMap
    const existing = frameCharacterMap.get(det.frameIndex) ?? []
    if (!existing.includes(charId)) existing.push(charId)
    frameCharacterMap.set(det.frameIndex, existing)

    // frameCharacterBoxes — store original-video bounding box per frame per character
    if (!frameCharacterBoxes.has(det.frameIndex)) {
      frameCharacterBoxes.set(det.frameIndex, new Map())
    }
    frameCharacterBoxes.get(det.frameIndex)!.set(charId, det.originalBox)

    // frameCharacterExpressions — store expression scores per frame per character
    if (!frameCharacterExpressions.has(det.frameIndex)) {
      frameCharacterExpressions.set(det.frameIndex, new Map())
    }
    frameCharacterExpressions.get(det.frameIndex)!.set(charId, det.expressions)

    characterFrameCounts[assigned]++

    if (!characterBestDetection[assigned] || det.confidence > characterBestDetection[assigned]!.score) {
      characterBestDetection[assigned] = { detectionIdx: di, score: det.confidence }
    }
  }

  // ── Filter phantom characters (< 3 frames = likely false positive) ─────────
  const MIN_FRAMES = 3
  const validIndices = clusters.map((_, ci) => ci).filter(ci => characterFrameCounts[ci] >= MIN_FRAMES)

  onProgress?.(0.8, `Found ${validIndices.length} character(s) — extracting thumbnails...`)

  // ── Extract thumbnails ─────────────────────────────────────────────────────
  const cropCanvas = document.createElement('canvas')
  cropCanvas.width = 64
  cropCanvas.height = 64
  const cropCtx = cropCanvas.getContext('2d')!

  const characters: DetectedCharacter[] = []

  for (let vi = 0; vi < validIndices.length; vi++) {
    const ci = validIndices[vi]
    const bestRef = characterBestDetection[ci]
    let thumbnailDataUrl = ''

    if (bestRef) {
      const det = allDetections[bestRef.detectionIdx]
      await seekTo(video, det.time)
      ctx.drawImage(video, 0, 0, cw, ch)

      // 40% padding for recognizable head-and-shoulders thumbnails
      const pad = 0.4
      const bx = Math.max(0, det.box.x - det.box.width * pad)
      const by = Math.max(0, det.box.y - det.box.height * pad)
      const bw = Math.min(cw - bx, det.box.width * (1 + pad * 2))
      const bh = Math.min(ch - by, det.box.height * (1 + pad * 2))

      cropCtx.clearRect(0, 0, 64, 64)
      cropCtx.drawImage(canvas, bx, by, bw, bh, 0, 0, 64, 64)
      thumbnailDataUrl = cropCanvas.toDataURL('image/jpeg', 0.9)
    }

    characters.push({
      id: characterIds[ci],
      thumbnailDataUrl,
      bestFrameIndex: bestRef ? allDetections[bestRef.detectionIdx].frameIndex : 0,
      descriptor: clusterMeans[ci],
      frameCount: characterFrameCounts[ci],
    })

    onProgress?.(0.8 + (vi / validIndices.length) * 0.2, `Thumbnail ${vi + 1}/${validIndices.length}`)
  }

  URL.revokeObjectURL(url)
  return { characters, frameCharacterMap, frameCharacterBoxes, frameCharacterExpressions }
}

/**
 * Runs face-api expression detection on a video, matching each detected face
 * to the given character descriptor. Returns per-frame expression scores for
 * the matched character only — used in the emotion phase for the main character.
 */
export async function detectExpressionsForCharacter(
  videoFile: File,
  characterDescriptor: Float32Array,
  sampleRate = 1,
  onProgress?: FaceDetectorProgressCallback
): Promise<Map<number, Record<string, number>>> {
  const url = URL.createObjectURL(videoFile)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'

  await loadFaceModels()

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Failed to load video for expression detection'))
  })

  const duration = video.duration
  const videoW = video.videoWidth
  const videoH = video.videoHeight

  const detScale = Math.min(1, 960 / Math.max(videoW, 1))
  const cw = Math.round(videoW * detScale)
  const ch = Math.round(videoH * detScale)

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const result = new Map<number, Record<string, number>>()
  const totalSamples = Math.floor(duration * sampleRate)

  console.log(`[Expression] Starting scan: ${totalSamples} frames at ${sampleRate}fps`)

  for (let i = 0; i <= totalSamples; i++) {
    const time = i / sampleRate
    if (time > duration) break

    try {
      console.log(`[Expression] Frame ${i}/${totalSamples}: seeking to ${time.toFixed(2)}s`)
      await seekTo(video, time)

      console.log(`[Expression] Frame ${i}: drawing to canvas`)
      ctx.drawImage(video, 0, 0, cw, ch)

      // Add timeout to prevent hanging on problematic frames
      console.log(`[Expression] Frame ${i}: starting detection`)
      const detectionPromise = faceapi
        .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({
          minConfidence: 0.3,
          maxResults: 10,
        }))
        .withFaceLandmarks()
        .withFaceDescriptors()
        .withFaceExpressions()

      let detections = await Promise.race([
        detectionPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Detection timeout')), 30000)
        ),
      ]) as any[]

      console.log(`[Expression] Frame ${i}: detected ${detections.length} faces`)

      // Find the face closest to our main character's descriptor
      let bestDist = Infinity
      let bestExpressions: Record<string, number> | null = null

      for (const det of detections) {
        const dist = euclideanDist(det.descriptor, characterDescriptor)
        if (dist < bestDist) {
          bestDist = dist
          bestExpressions = det.expressions as unknown as Record<string, number>
        }
      }

      // Only accept the match if it's close enough to be the same person (< 0.7)
      if (bestExpressions && bestDist < 0.7) {
        const frameIndex = Math.round(time * DETECTION_FPS)
        result.set(frameIndex, bestExpressions)
      }
    } catch (err) {
      // Skip frames where detection fails or times out
      console.debug(`[Expression] Frame ${i} skipped:`, err instanceof Error ? err.message : 'unknown error')
    }

    onProgress?.(
      i / totalSamples,
      `Expression scan: frame ${i}/${totalSamples}`
    )
  }

  URL.revokeObjectURL(url)
  return result
}

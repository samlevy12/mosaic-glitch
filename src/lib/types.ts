import type { Emotion } from './emotion-color-mapping'

// ─── Video / images ───────────────────────────────────────────────────────────

export interface VideoMetadata {
  filename: string
  duration: number
  fps: number
  width: number
  height: number
}

export interface ImageAsset {
  id: string
  file: File
  bitmap: ImageBitmap | null
  /** Dominant hue 0-360, computed by image-color-analyzer */
  dominantHue: number
  /** Saturation 0-100 */
  dominantSat: number
  /** Which emotion bucket this image belongs to */
  emotion: Emotion
}

// ─── Face / character detection ───────────────────────────────────────────────

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface CropBox {
  /** Top-left in original video pixels (always even for h264 compatibility) */
  x: number
  y: number
  w: number
  h: number
  /** Scale back to these after crop */
  outW: number
  outH: number
}

export interface DetectedCharacter {
  id: string
  /** Best face-crop data URL for display */
  thumbnailDataUrl: string
  /** Frame index where the best crop was found */
  bestFrameIndex: number
  /** Raw face-api.js descriptor for matching */
  descriptor: Float32Array
  /** How many frames this character appeared in */
  frameCount: number
}

export interface FaceDetectionResult {
  characters: DetectedCharacter[]
  /** frame index (30fps) → character id list */
  frameCharacterMap: Map<number, string[]>
  /** frame index (30fps) → character id → bounding box in original video pixels */
  frameCharacterBoxes: Map<number, Map<string, BoundingBox>>
  /** frame index (30fps) → character id → face-api expression scores */
  frameCharacterExpressions: Map<number, Map<string, Record<string, number>>>
}

export interface CharacterSelection {
  characterId: string
  included: boolean
}

// ─── Character refinement ─────────────────────────────────────────────────────

export interface CharacterMergeHistory {
  timestamp: number
  before: DetectedCharacter[]
  after: DetectedCharacter[]
  mergedIds: string[] // which character IDs were merged together
}

export interface CharacterNameMap {
  characterId: string
  name: string // e.g. "young woman with dark hair"
}

// ─── Shot detection ───────────────────────────────────────────────────────────

export interface Shot {
  startFrame: number
  endFrame: number
  startTime: number
  endTime: number
  /** Which character IDs appear in this shot */
  characterIds: string[]
  /** Optional: zoom crop to apply in stitcher to hide unwanted faces */
  crop?: CropBox
}

export interface ShotConflict {
  shot: Shot
  characterIds: string[]
}

// ─── Shot refinement ──────────────────────────────────────────────────────────

export interface ShotEditHistory {
  timestamp: number
  before: Shot[]
  after: Shot[]
  changeType: 'adjust' | 'split' | 'merge'
  description: string
}

// ─── Emotion timeline ─────────────────────────────────────────────────────────

export type EmotionSource = 'auto' | 'equal'

export interface EmotionFrame {
  frameIndex: number
  emotion: Emotion
  /** 0-1 confidence from face-api expression scores */
  confidence: number
  source: EmotionSource
}

export interface ManualSegment {
  id: string
  startTime: number
  endTime: number
  emotion: Emotion
}

// ─── Mosaic / render settings (extended from mosaic-ink-video) ────────────────

export interface MosaicSettings {
  density: 'coarse' | 'medium' | 'fine'
  compactness: number
  chunkiness: number
  /** 'off' = all tiles emotion-matched; 'skin' = non-skin regions use neutral tiles;
   *  'skin-reverse' = skin/face regions use neutral, background uses emotional;
   *  'luminance' = dark/desaturated regions use neutral tiles;
   *  'size' = small detail regions (faces, edges) use neutral, large flat regions use emotional */
  neutralBackground?: 'off' | 'skin' | 'skin-reverse' | 'luminance' | 'size'
  /** Character contrast: split tile pool so faces/skin use a different subset than background.
   *  Creates visual separation even when both use the same emotion's color palette.
   *  0 = off (all regions share one pool). 1 = full split (no overlap). */
  characterContrast?: number
}

export interface InkSettings {
  thickness: number
  /** Line color between tiles as hex string (default '#1f0812' dark ink) */
  color?: string
}

export interface StabilitySettings {
  holdFrames: number
  reassignAggression: number
  allowReassign: boolean
  seed: number
  /** 0 = per-frame emotion, 1 = per-shot (smoothed) */
  emotionSmoothing: number
}

export interface ExportSettings {
  resolution: 'original' | '1080' | '720' | '540'
  fps: number
}

export type RenderMode = 'sticker' | 'wrap' | 'planes'

// ─── Region (from mosaic-ink-video) ──────────────────────────────────────────

export interface Region {
  id: number
  centroid: { x: number; y: number }
  area: number
  bbox: { x: number; y: number; w: number; h: number }
  trackId: number
}

export interface ProcessedFrame {
  regions: Region[]
  inkMask: Uint8Array
  labelMap: Uint32Array
  width: number
  height: number
}

export interface ExportProgress {
  stage: 'preprocessing' | 'stitching' | 'emotion' | 'mosaic' | 'encode' | 'mux'
  current: number
  total: number
  label?: string
}

// ─── App phase ────────────────────────────────────────────────────────────────

export type AppPhase = 'upload' | 'characters' | 'emotion' | 'images' | 'render' | 'batch'

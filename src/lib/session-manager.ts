/**
 * session-manager.ts
 * Save and load session state as a .emosaic.json file.
 * Video and image files are NOT saved (too large) — only metadata and computed state.
 */

import type {
  AppPhase,
  DetectedCharacter,
  Shot,
  EmotionFrame,
  ManualSegment,
  MosaicSettings,
  InkSettings,
  StabilitySettings,
  ExportSettings,
  RenderMode,
} from './types'
import type { Emotion } from './emotion-color-mapping'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ImageAssetMeta {
  id: string
  fileName: string
  emotion: Emotion
  dominantHue: number
  dominantSat: number
}

export interface SessionState {
  phase: AppPhase
  characters: DetectedCharacter[]
  mainCharacterId: string | null
  shots: Shot[]
  filteredShots: Shot[]
  /** Serialized form of Map<number, string[]> */
  frameCharacterMap: Record<string, string[]>
  emotionMode: 'auto' | 'equal'
  emotionTimeline: EmotionFrame[]
  manualSegments: ManualSegment[]
  smoothing: number
  mosaicSettings: MosaicSettings
  inkSettings: InkSettings
  stabilitySettings: StabilitySettings
  exportSettings: ExportSettings
  renderMode: RenderMode
  imageAssetMeta: ImageAssetMeta[]
}

// ─── Save ─────────────────────────────────────────────────────────────────────

/**
 * Serialise and download the current session state as a .emosaic.json file.
 */
export function saveSession(state: SessionState): void {
  // DetectedCharacter.descriptor is a Float32Array — convert to plain array for JSON
  const serialisable: SessionState = {
    ...state,
    characters: state.characters.map(c => ({
      ...c,
      descriptor: Array.from(c.descriptor) as unknown as Float32Array,
    })),
  }

  const json = JSON.stringify(serialisable, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = `session-${new Date().toISOString().replace(/[:.]/g, '-')}.emosaic.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)

  console.log('[SessionManager] Session saved')
}

// ─── Load ─────────────────────────────────────────────────────────────────────

/**
 * Open a file picker so the user can select a .emosaic.json file,
 * parse it, and return the restored SessionState.
 * Float32Array descriptors are reconstructed from the plain arrays stored in JSON.
 */
export function loadSession(): Promise<SessionState> {
  return new Promise<SessionState>((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.emosaic.json'

    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        reject(new Error('No file selected'))
        return
      }

      const reader = new FileReader()
      reader.onload = () => {
        try {
          const raw = JSON.parse(reader.result as string) as SessionState

          // Reconstruct Float32Array descriptors
          const restored: SessionState = {
            ...raw,
            characters: raw.characters.map(c => ({
              ...c,
              descriptor: new Float32Array(c.descriptor as unknown as number[]),
            })),
          }

          console.log('[SessionManager] Session loaded — phase:', restored.phase,
            '| characters:', restored.characters.length,
            '| shots:', restored.shots.length,
            '| emotionFrames:', restored.emotionTimeline.length,
            '| imageAssets:', restored.imageAssetMeta.length)

          resolve(restored)
        } catch (err) {
          reject(new Error(`Failed to parse session file: ${err}`))
        }
      }
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsText(file)
    }

    // Cancelled without selecting
    input.oncancel = () => reject(new Error('File selection cancelled'))

    document.body.appendChild(input)
    input.click()
    document.body.removeChild(input)
  })
}

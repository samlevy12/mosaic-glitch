import { useState } from 'react'
import type { DetectedCharacter, Shot, BoundingBox } from '../../lib/types'
import { CharacterMergeDialog } from '../CharacterMergeDialog'
import { ShotTimelineEditor } from '../ShotTimelineEditor'
import { CharacterAppearanceTimeline } from '../CharacterAppearanceTimeline'
import { VideoPreview } from '../VideoPreview'

interface CharactersPhaseProps {
  characters: DetectedCharacter[]
  mainCharacterId: string | null
  shots: Shot[]
  frameCharacterMap: Map<number, string[]>
  frameCharacterBoxes?: Map<number, Map<string, BoundingBox>>
  videoDurationFrames: number
  scanning: boolean
  stitching: boolean
  scanProgress: number
  scanLabel: string
  videoSrc?: File | Blob | null
  filteredVideoBlob?: Blob | null
  onScan: () => void
  onSelectMainCharacter: (id: string | null) => void
  onMergeCharacters: (indices: number[]) => void
  onShotAdjustment: (newShots: Shot[]) => void
  onStitchAndDownload?: () => void
  onProceed: () => void
  onSaveSnapshot?: () => void
}

export function CharactersPhase({
  characters,
  mainCharacterId,
  shots,
  frameCharacterMap,
  frameCharacterBoxes,
  videoDurationFrames,
  scanning,
  stitching,
  scanProgress,
  scanLabel,
  videoSrc,
  filteredVideoBlob,
  onScan,
  onSelectMainCharacter,
  onMergeCharacters,
  onShotAdjustment,
  onStitchAndDownload,
  onProceed,
  onSaveSnapshot,
}: CharactersPhaseProps) {
  const [scanned, setScanned] = useState(false)
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false)
  const [shotEditorOpen, setShotEditorOpen] = useState(false)

  async function handleScan() {
    setScanned(false)
    await onScan()
    setScanned(true)
  }

  function handleSelectMain(id: string) {
    // Clicking the current main deselects; clicking another sets them as main
    onSelectMainCharacter(mainCharacterId === id ? null : id)
  }

  function handleMerge(indices: number[]) {
    onMergeCharacters(indices)
    setMergeDialogOpen(false)
  }

  function handleShotSave(newShots: Shot[]) {
    onShotAdjustment(newShots)
    setShotEditorOpen(false)
  }

  const mainChar = characters.find(c => c.id === mainCharacterId)
  const otherChars = characters.filter(c => c.id !== mainCharacterId)

  // Count shots with main character vs shots with others present too
  const shotsWithMain = mainCharacterId
    ? shots.filter(s => s.characterIds.includes(mainCharacterId))
    : []
  const shotsNeedingZoom = shotsWithMain.filter(s =>
    s.characterIds.some(id => id !== mainCharacterId)
  )

  const canProceed = mainCharacterId !== null && !scanning && !stitching && (characters.length > 0 || scanned)

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Step 2 — Characters</h2>
        <p className="body-text">Scan for faces, then pick your main character. All clips featuring other faces will auto-zoom to them.</p>
      </div>

      {/* Video preview with bounding boxes */}
      {videoSrc && (
        <VideoPreview
          src={videoSrc}
          label="Source Video"
          characters={characters}
          frameCharacterBoxes={frameCharacterBoxes}
          shots={shots}
          mainCharacterId={mainCharacterId}
        />
      )}

      {/* Scan trigger */}
      {!scanned && characters.length === 0 && (
        <div className="border border-border bg-card p-6 text-center space-y-4">
          {scanning ? (
            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Scanning...</div>
              <div className="w-full bg-border h-1">
                <div
                  className="h-1 bg-[#B98B82] transition-all"
                  style={{ width: `${Math.round(scanProgress * 100)}%` }}
                />
              </div>
              <p className="caption">{scanLabel}</p>
            </div>
          ) : (
            <>
              <p className="body-text text-muted-foreground">No scan run yet.</p>
              <button
                onClick={handleScan}
                className="px-6 py-2 text-xs uppercase tracking-wider border border-[#B98B82] text-[#B98B82] hover:bg-[#B98B82] hover:text-white transition-colors"
              >
                Scan Video for Faces
              </button>
            </>
          )}
        </div>
      )}

      {/* Re-scan after first run */}
      {characters.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="caption">{characters.length} character{characters.length !== 1 ? 's' : ''} detected · {shots.length} shots</p>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
          >
            Re-scan
          </button>
        </div>
      )}

      {/* Scanning progress overlay when re-scanning */}
      {scanning && characters.length > 0 && (
        <div className="border border-border p-4 space-y-2">
          <div className="w-full bg-border h-1">
            <div className="h-1 bg-[#B98B82] transition-all" style={{ width: `${Math.round(scanProgress * 100)}%` }} />
          </div>
          <p className="caption">{scanLabel}</p>
        </div>
      )}

      {/* Character grid — single-select main character */}
      {characters.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Select Main Character</h2>
            {mainCharacterId && (
              <p className="caption text-[#B98B82]">click again to deselect</p>
            )}
          </div>
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
            {characters.map((char, i) => {
              const isMain = char.id === mainCharacterId
              return (
                <button
                  key={char.id}
                  onClick={() => handleSelectMain(char.id)}
                  className={`relative group border transition-all text-left ${
                    isMain
                      ? 'border-[#B98B82] ring-2 ring-[#B98B82]'
                      : 'border-border opacity-50 grayscale hover:opacity-70 hover:grayscale-0'
                  }`}
                >
                  {char.thumbnailDataUrl ? (
                    <img
                      src={char.thumbnailDataUrl}
                      alt={`Character ${i + 1}`}
                      className="w-full aspect-square object-cover"
                    />
                  ) : (
                    <div className="w-full aspect-square bg-muted flex items-center justify-center text-2xl opacity-30">
                      ?
                    </div>
                  )}
                  <div className="p-1.5 space-y-0.5">
                    <p className="text-xs font-medium truncate">
                      {isMain ? 'Main' : `Char ${i + 1}`}
                    </p>
                    <p className="caption">{char.frameCount} frames</p>
                  </div>
                  {isMain && (
                    <div className="absolute top-1 right-1 w-5 h-5 bg-[#B98B82] flex items-center justify-center">
                      <span className="text-white text-[10px] leading-none">★</span>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Refinement Tools */}
      {characters.length > 0 && (
        <div className="flex gap-2">
          <button
            onClick={() => setMergeDialogOpen(true)}
            className="flex-1 py-2 text-xs uppercase tracking-wider border border-border hover:bg-muted transition-colors"
          >
            Merge Characters
          </button>
          <button
            onClick={() => setShotEditorOpen(true)}
            className="flex-1 py-2 text-xs uppercase tracking-wider border border-border hover:bg-muted transition-colors"
          >
            Edit Shot Boundaries
          </button>
        </div>
      )}

      {/* Character Appearance Timeline */}
      {characters.length > 0 && shots.length > 0 && (
        <CharacterAppearanceTimeline
          characters={characters}
          shots={shots}
          frameCharacterMap={frameCharacterMap}
          selectedCharacterId={mainCharacterId ?? undefined}
          onCharacterClick={handleSelectMain}
          videoDurationFrames={videoDurationFrames}
        />
      )}

      {/* Zoom behavior summary */}
      {mainChar && (
        <div className="border border-border p-4 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider">Zoom Behavior</p>
          <p className="caption">
            {shotsWithMain.length} clip{shotsWithMain.length !== 1 ? 's' : ''} contain your main character.
            {shotsNeedingZoom.length > 0
              ? ` ${shotsNeedingZoom.length} of those also have other faces — those clips will be zoomed in on your main character.`
              : ' None of those clips have other faces — no zooming needed.'}
          </p>
          {shotsNeedingZoom.length > 0 && (
            <p className="caption text-muted-foreground">Cuts may look choppy — that's expected.</p>
          )}
          {shots.length > 0 && shotsWithMain.length < shots.length && (
            <p className="caption text-muted-foreground">
              {shots.length - shotsWithMain.length} clip{shots.length - shotsWithMain.length !== 1 ? 's' : ''} without your main character will be excluded.
            </p>
          )}
        </div>
      )}

      {/* Stitching progress */}
      {stitching && (
        <div className="border border-border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Stitching shots...</p>
            <p className="caption">{Math.round(scanProgress * 100)}%</p>
          </div>
          <div className="w-full bg-border h-2">
            <div
              className="h-2 bg-[#B98B82] transition-all"
              style={{ width: `${Math.round(scanProgress * 100)}%` }}
            />
          </div>
          <p className="caption text-muted-foreground">{scanLabel}</p>
        </div>
      )}

      {/* Download stitched video — always shown once blob exists */}
      {onStitchAndDownload && (filteredVideoBlob || (mainCharacterId && !scanning)) && (
        <div className="border border-border p-4 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider">Export Character Cut</p>
          <p className="caption text-muted-foreground">
            {filteredVideoBlob
              ? 'Stitched video is ready. Download the character-centered .mp4.'
              : 'Stitch all shots featuring your main character (with zoom applied) and download as a .mp4.'}
          </p>
          <button
            onClick={onStitchAndDownload}
            disabled={stitching}
            className="w-full py-2 text-xs uppercase tracking-wider border border-[#37515F] text-[#37515F] hover:bg-[#37515F] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {stitching
              ? `Stitching... ${Math.round(scanProgress * 100)}%`
              : filteredVideoBlob
                ? '↓ Download Character Cut (.mp4)'
                : '↓ Stitch & Download Character Cut (.mp4)'}
          </button>
          {stitching && (
            <div className="w-full bg-border h-1">
              <div className="h-1 bg-[#37515F] transition-all" style={{ width: `${scanProgress * 100}%` }} />
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {onSaveSnapshot && characters.length > 0 && (
          <button
            onClick={onSaveSnapshot}
            className="px-4 py-2.5 text-xs uppercase tracking-wider border border-border hover:bg-muted transition-colors shrink-0"
            title="Save character map as PNG"
          >
            ↓ Save
          </button>
        )}
        <button
          onClick={onProceed}
          disabled={!canProceed}
          className="flex-1 py-2.5 text-xs uppercase tracking-wider border border-border disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#B98B82] hover:text-white hover:border-[#B98B82] transition-colors"
        >
          {stitching ? 'Stitching...' : 'Set Up Emotion Timeline →'}
        </button>
      </div>

      {/* Dialogs */}
      <CharacterMergeDialog
        characters={characters}
        open={mergeDialogOpen}
        onClose={() => setMergeDialogOpen(false)}
        onMerge={handleMerge}
      />
      <ShotTimelineEditor
        shots={shots}
        videoDurationFrames={videoDurationFrames}
        open={shotEditorOpen}
        onClose={() => setShotEditorOpen(false)}
        onSave={handleShotSave}
      />
    </div>
  )
}

import { useState } from 'react'
import type { DetectedCharacter } from '../lib/types'
import { mergeCharacters } from '../lib/character-merge'

interface CharacterMergeDialogProps {
  characters: DetectedCharacter[]
  open: boolean
  onClose: () => void
  onMerge: (indices: number[]) => void
}

export function CharacterMergeDialog({
  characters,
  open,
  onClose,
  onMerge,
}: CharacterMergeDialogProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [previewMerge, setPreviewMerge] = useState<DetectedCharacter | null>(null)

  const toggleSelection = (index: number) => {
    const newSelected = new Set(selected)
    if (newSelected.has(index)) {
      newSelected.delete(index)
    } else {
      newSelected.add(index)
    }
    setSelected(newSelected)

    // Show preview if 2+ characters selected
    if (newSelected.size >= 2) {
      const indices = Array.from(newSelected).sort((a, b) => a - b)
      const selectedChars = indices.map(i => characters[i])
      try {
        const { merged } = mergeCharacters(characters, indices)
        setPreviewMerge(merged)
      } catch {
        setPreviewMerge(null)
      }
    } else {
      setPreviewMerge(null)
    }
  }

  const handleMerge = () => {
    if (selected.size < 2) return
    onMerge(Array.from(selected).sort((a, b) => a - b))
    setSelected(new Set())
    setPreviewMerge(null)
  }

  if (!open) return null

  const selectedCount = selected.size

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background border border-border max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="border-b border-border p-4 sticky top-0 bg-background">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Merge Characters
          </h2>
          <p className="caption text-muted-foreground">
            Select 2+ characters to combine into one. Descriptors will be averaged.
          </p>
        </div>

        {/* Character Grid */}
        <div className="p-6 space-y-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Select Characters ({selectedCount}/available)
            </p>
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-3">
              {characters.map((char, i) => {
                const isSelected = selected.has(i)
                return (
                  <button
                    key={char.id}
                    onClick={() => toggleSelection(i)}
                    className={`relative border transition-all ${
                      isSelected
                        ? 'border-[#B98B82] ring-2 ring-[#B98B82] bg-[#B98B82]/10'
                        : 'border-border hover:border-[#B98B82]'
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
                    <div className="p-1.5 space-y-0.5 bg-background/90">
                      <p className="text-xs font-medium truncate">Char {i + 1}</p>
                      <p className="caption">{char.frameCount} frames</p>
                    </div>
                    {isSelected && (
                      <div className="absolute top-1 right-1 w-5 h-5 bg-[#B98B82] flex items-center justify-center">
                        <span className="text-white text-[10px] leading-none">✓</span>
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Preview */}
          {previewMerge && selectedCount >= 2 && (
            <div className="border border-[#667761] p-4 space-y-2">
              <p className="text-xs uppercase tracking-wider text-[#667761]">
                Merge Preview
              </p>
              <p className="caption">
                Will create 1 character with {previewMerge.frameCount} total frames.
              </p>
              <p className="caption text-muted-foreground">
                Descriptor averaged from {selectedCount} characters weighted by frame count.
              </p>
            </div>
          )}

          {/* Selection Info */}
          {selectedCount > 0 && selectedCount < 2 && (
            <div className="border border-border p-4">
              <p className="caption text-muted-foreground">
                Select at least 2 characters to enable merging.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-4 flex gap-2 sticky bottom-0 bg-background">
          <button
            onClick={onClose}
            className="flex-1 py-2 text-xs uppercase tracking-wider border border-border hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleMerge}
            disabled={selectedCount < 2}
            className="flex-1 py-2 text-xs uppercase tracking-wider bg-[#B98B82] text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#a0786f] transition-colors"
          >
            Merge ({selectedCount})
          </button>
        </div>
      </div>
    </div>
  )
}

import { useState, useRef } from 'react'
import type { Shot } from '../lib/types'
import { adjustShotBoundary, validateShots, splitShot, mergeShots, cloneShotsForEditing } from '../lib/shot-editor'

interface ShotTimelineEditorProps {
  shots: Shot[]
  videoDurationFrames: number
  open: boolean
  onClose: () => void
  onSave: (shots: Shot[]) => void
}

const COLORS = ['#00ffa3', '#667761', '#8B7355', '#6B8E7F', '#9B7B6A']

export function ShotTimelineEditor({
  shots,
  videoDurationFrames,
  open,
  onClose,
  onSave,
}: ShotTimelineEditorProps) {
  const [editedShots, setEditedShots] = useState(() => cloneShotsForEditing(shots))
  const [draggingBoundary, setDraggingBoundary] = useState<{
    shotIndex: number
    type: 'start' | 'end'
  } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const TIMELINE_HEIGHT = 60
  const TIMELINE_WIDTH = 800
  const PADDING = 40

  const frameToX = (frame: number) => {
    return PADDING + (frame / videoDurationFrames) * TIMELINE_WIDTH
  }

  const xToFrame = (x: number) => {
    return Math.round(((x - PADDING) / TIMELINE_WIDTH) * videoDurationFrames)
  }

  const handleMouseDown = (shotIndex: number, type: 'start' | 'end') => {
    setDraggingBoundary({ shotIndex, type })
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!draggingBoundary || !svgRef.current) return

    const svg = svgRef.current
    const rect = svg.getBoundingClientRect()
    const x = e.clientX - rect.left
    const frame = xToFrame(x)

    const { shotIndex, type } = draggingBoundary
    const shot = editedShots[shotIndex]
    let newStartFrame = shot.startFrame
    let newEndFrame = shot.endFrame

    if (type === 'start') {
      newStartFrame = Math.max(0, Math.min(frame, shot.endFrame - 1))
    } else {
      newEndFrame = Math.min(videoDurationFrames, Math.max(frame, shot.startFrame + 1))
    }

    const adjusted = adjustShotBoundary(shot, newStartFrame, newEndFrame)
    if (adjusted) {
      const updated = [...editedShots]
      updated[shotIndex] = adjusted
      setEditedShots(updated)
    }
  }

  const handleMouseUp = () => {
    setDraggingBoundary(null)
  }

  const handleShotClick = (shotIndex: number, x: number) => {
    const frame = xToFrame(x)
    const shot = editedShots[shotIndex]

    const result = splitShot(shot, frame)
    if (result) {
      const updated = [
        ...editedShots.slice(0, shotIndex),
        result[0],
        result[1],
        ...editedShots.slice(shotIndex + 1),
      ]
      setEditedShots(updated)
    }
  }

  const handleMergeShots = (shotIndex: number) => {
    if (shotIndex >= editedShots.length - 1) return

    const merged = mergeShots(editedShots[shotIndex], editedShots[shotIndex + 1])
    if (merged) {
      const updated = [
        ...editedShots.slice(0, shotIndex),
        merged,
        ...editedShots.slice(shotIndex + 2),
      ]
      setEditedShots(updated)
    }
  }

  const handleSave = () => {
    const errors = validateShots(editedShots, videoDurationFrames)
    if (errors.length === 0) {
      onSave(editedShots)
      onClose()
    }
  }

  if (!open) return null

  const errors = validateShots(editedShots, videoDurationFrames)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background border border-border max-w-4xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="border-b border-border p-4 sticky top-0 bg-background">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Edit Shot Boundaries
          </h2>
          <p className="caption text-muted-foreground">
            Drag boundaries to adjust, click shot to split, double-click boundary to merge adjacent shots.
          </p>
        </div>

        {/* Timeline */}
        <div className="p-6 space-y-6">
          <svg
            ref={svgRef}
            width={TIMELINE_WIDTH + PADDING * 2}
            height={TIMELINE_HEIGHT * editedShots.length + 100}
            className="border border-border bg-muted cursor-grab active:cursor-grabbing"
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {/* Ruler */}
            <g>
              <line x1={PADDING} y1="20" x2={PADDING + TIMELINE_WIDTH} y2="20" stroke="#666" strokeWidth="1" />
              {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
                const x = PADDING + pct * TIMELINE_WIDTH
                const frame = Math.round(pct * videoDurationFrames)
                const seconds = (frame / 30).toFixed(1)
                return (
                  <g key={i}>
                    <line x1={x} y1="15" x2={x} y2="25" stroke="#666" strokeWidth="1" />
                    <text x={x} y="40" textAnchor="middle" fontSize="10" fill="#999">
                      {seconds}s
                    </text>
                  </g>
                )
              })}
            </g>

            {/* Shots */}
            {editedShots.map((shot, shotIdx) => {
              const x1 = frameToX(shot.startFrame)
              const x2 = frameToX(shot.endFrame)
              const y = 60 + shotIdx * TIMELINE_HEIGHT
              const color = COLORS[shotIdx % COLORS.length]

              return (
                <g key={shotIdx}>
                  {/* Shot block */}
                  <rect
                    x={x1}
                    y={y}
                    width={x2 - x1}
                    height={40}
                    fill={color}
                    opacity="0.6"
                    onClick={(e: React.MouseEvent<SVGRectElement>) => {
                      if ((e.target as SVGRectElement).style.pointerEvents === 'none') return
                      handleShotClick(shotIdx, (e as any).nativeEvent.offsetX)
                    }}
                    className="hover:opacity-75 transition-opacity"
                  />

                  {/* Shot label */}
                  <text
                    x={(x1 + x2) / 2}
                    y={y + 25}
                    textAnchor="middle"
                    fontSize="12"
                    fill="white"
                    fontWeight="bold"
                    pointerEvents="none"
                  >
                    {editedShots[shotIdx].characterIds.length > 0
                      ? editedShots[shotIdx].characterIds.join(',')
                      : 'Empty'}
                  </text>

                  {/* Start boundary */}
                  <rect
                    x={x1 - 4}
                    y={y - 5}
                    width="8"
                    height={50}
                    fill={color}
                    opacity="0.8"
                    cursor="col-resize"
                    onMouseDown={() => handleMouseDown(shotIdx, 'start')}
                    className="hover:opacity-100"
                  />

                  {/* End boundary */}
                  <rect
                    x={x2 - 4}
                    y={y - 5}
                    width="8"
                    height={50}
                    fill={color}
                    opacity="0.8"
                    cursor="col-resize"
                    onMouseDown={() => handleMouseDown(shotIdx, 'end')}
                    className="hover:opacity-100"
                  />
                </g>
              )
            })}
          </svg>

          {/* Shot List */}
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Shots</p>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {editedShots.map((shot, i) => (
                <div key={i} className="flex items-center justify-between border border-border p-2 text-xs">
                  <span className="font-medium">
                    Shot {i + 1}: {shot.startFrame}-{shot.endFrame} ({shot.characterIds.join(',') || 'none'})
                  </span>
                  {i < editedShots.length - 1 && (
                    <button
                      onClick={() => handleMergeShots(i)}
                      className="px-2 py-0.5 border border-border hover:bg-muted transition-colors"
                    >
                      Merge
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Errors */}
          {errors.length > 0 && (
            <div className="border border-destructive p-4 space-y-1 bg-destructive/10">
              <p className="text-xs uppercase tracking-wider text-destructive font-medium">Validation Errors</p>
              {errors.map((err, i) => (
                <p key={i} className="caption text-destructive">
                  Shot {err.shotIndex + 1}: {err.message}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-4 flex gap-2 sticky bottom-0 bg-background">
          <button
            onClick={onClose}
            className="flex-1 py-2 text-xs uppercase tracking-wider border border-border hover:bg-muted transition-colors"
          >
            Discard
          </button>
          <button
            onClick={handleSave}
            disabled={errors.length > 0}
            className="flex-1 py-2 text-xs uppercase tracking-wider bg-[#667761] text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#5a6a56] transition-colors"
          >
            Accept Changes
          </button>
        </div>
      </div>
    </div>
  )
}

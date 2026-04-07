import type { Shot, DetectedCharacter } from '../lib/types'

interface CharacterAppearanceTimelineProps {
  characters: DetectedCharacter[]
  shots: Shot[]
  frameCharacterMap: Map<number, string[]>
  selectedCharacterId?: string
  onCharacterClick?: (characterId: string) => void
  videoDurationFrames: number
}

const COLORS = ['#B98B82', '#667761', '#8B7355', '#6B8E7F', '#9B7B6A']

export function CharacterAppearanceTimeline({
  characters,
  shots,
  frameCharacterMap,
  selectedCharacterId,
  onCharacterClick,
  videoDurationFrames,
}: CharacterAppearanceTimelineProps) {
  const TIMELINE_HEIGHT = 24
  const TIMELINE_WIDTH = 800
  const PADDING = 40
  const ROW_HEIGHT = 36

  const frameToX = (frame: number) => {
    return PADDING + (frame / videoDurationFrames) * TIMELINE_WIDTH
  }

  // For each character, find which shots they appear in
  const characterShotAppearances = characters.map(char => {
    const appearances: { shot: Shot; frameCount: number; startFrame: number; endFrame: number }[] = []

    for (const shot of shots) {
      let frameCount = 0
      let firstFrame = shot.endFrame
      let lastFrame = shot.startFrame

      // Count frames where this character appears in this shot
      for (let f = shot.startFrame; f <= shot.endFrame; f++) {
        const charIds = frameCharacterMap.get(f) ?? []
        if (charIds.includes(char.id)) {
          frameCount++
          firstFrame = Math.min(firstFrame, f)
          lastFrame = Math.max(lastFrame, f)
        }
      }

      if (frameCount > 0) {
        appearances.push({ shot, frameCount, startFrame: firstFrame, endFrame: lastFrame })
      }
    }

    return { character: char, appearances }
  })

  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">Character Timeline</p>

      {characters.length === 0 ? (
        <p className="caption text-muted-foreground italic">No characters detected yet</p>
      ) : (
        <div className="border border-border bg-muted overflow-x-auto">
          <svg
            width={TIMELINE_WIDTH + PADDING * 2}
            height={ROW_HEIGHT * characters.length + 30}
            className="min-w-full"
          >
            {/* Ruler */}
            <g>
              <line x1={PADDING} y1="10" x2={PADDING + TIMELINE_WIDTH} y2="10" stroke="#666" strokeWidth="1" />
              {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
                const x = PADDING + pct * TIMELINE_WIDTH
                return (
                  <line key={i} x1={x} y1="5" x2={x} y2="15" stroke="#666" strokeWidth="1" />
                )
              })}
            </g>

            {/* Character rows */}
            {characterShotAppearances.map((item, charIdx) => {
              const char = item.character
              const y = 30 + charIdx * ROW_HEIGHT
              const color = COLORS[charIdx % COLORS.length]
              const isSelected = char.id === selectedCharacterId

              return (
                <g key={char.id}>
                  {/* Background highlight if selected */}
                  {isSelected && (
                    <rect
                      x="0"
                      y={y - 8}
                      width={TIMELINE_WIDTH + PADDING * 2}
                      height={TIMELINE_HEIGHT}
                      fill={color}
                      opacity="0.1"
                    />
                  )}

                  {/* Appearance blocks */}
                  {item.appearances.map((app, appIdx) => {
                    const x1 = frameToX(app.startFrame)
                    const x2 = frameToX(app.endFrame)
                    const width = Math.max(2, x2 - x1)

                    return (
                      <g key={appIdx}>
                        <rect
                          x={x1}
                          y={y - 6}
                          width={width}
                          height={TIMELINE_HEIGHT}
                          fill={color}
                          opacity={isSelected ? '0.8' : '0.6'}
                          className="hover:opacity-100 transition-opacity cursor-pointer"
                          onClick={() => onCharacterClick?.(char.id)}
                        />
                        <title>
                          {char.id.substring(0, 8)} in shot · {app.frameCount} frame{app.frameCount !== 1 ? 's' : ''}
                        </title>
                      </g>
                    )
                  })}

                  {/* Character label */}
                  <text
                    x={PADDING - 10}
                    y={y + 2}
                    textAnchor="end"
                    fontSize="11"
                    fill={isSelected ? color : '#666'}
                    fontWeight={isSelected ? 'bold' : 'normal'}
                    className="pointer-events-none"
                  >
                    Char {charIdx + 1}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      )}
    </div>
  )
}

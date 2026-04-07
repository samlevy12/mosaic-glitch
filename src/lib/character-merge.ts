/**
 * character-merge.ts
 * Utilities for merging detected characters (combining multiple detections of the same person).
 * Handles descriptor averaging, frame map updates, and undo history.
 */

import type { DetectedCharacter } from './types'

/**
 * Merges 2+ characters into one by:
 * 1. Averaging their descriptors (weighted by frame count)
 * 2. Creating a new character with merged descriptor
 * 3. Creating a mapping of old IDs → new ID for frame map updates
 *
 * Returns the merged character and the ID mapping for updating frame maps.
 */
export function mergeCharacters(
  characters: DetectedCharacter[],
  indicesToMerge: number[]
): {
  merged: DetectedCharacter
  idMapping: Map<string, string>
  deletedIds: string[]
} {
  if (indicesToMerge.length < 2) {
    throw new Error('Must select at least 2 characters to merge')
  }

  const selectedChars = indicesToMerge.map(i => characters[i])
  if (!selectedChars.every(c => c !== undefined)) {
    throw new Error('Invalid character indices')
  }

  // ── Average descriptor (weighted by frame count) ────────────────────────────
  const descriptorLength = selectedChars[0].descriptor.length
  const mergedDescriptor = new Float32Array(descriptorLength)
  const totalFrames = selectedChars.reduce((sum, c) => sum + c.frameCount, 0)

  for (let i = 0; i < descriptorLength; i++) {
    let sum = 0
    for (const char of selectedChars) {
      sum += char.descriptor[i] * (char.frameCount / totalFrames)
    }
    mergedDescriptor[i] = sum
  }

  // ── Use thumbnail and frame index from highest-confidence character ─────────
  const bestChar = selectedChars.reduce((best, current) =>
    current.frameCount > best.frameCount ? current : best
  )

  // ── Create merged character ────────────────────────────────────────────────
  const mergedCharacter: DetectedCharacter = {
    id: selectedChars[0].id, // Keep first character's ID
    thumbnailDataUrl: bestChar.thumbnailDataUrl,
    bestFrameIndex: bestChar.bestFrameIndex,
    descriptor: mergedDescriptor,
    frameCount: totalFrames,
  }

  // ── Create mapping for frame map updates ────────────────────────────────────
  const idMapping = new Map<string, string>()
  for (const char of selectedChars) {
    idMapping.set(char.id, mergedCharacter.id)
  }

  const deletedIds = selectedChars.slice(1).map(c => c.id)

  return { merged: mergedCharacter, idMapping, deletedIds }
}

/**
 * Updates frame character map after a merge.
 * Replaces old character IDs with merged character ID.
 */
export function updateFrameCharacterMap(
  frameMap: Map<number, string[]>,
  idMapping: Map<string, string>
): Map<number, string[]> {
  const updated = new Map<number, string[]>()

  for (const [frameIdx, charIds] of frameMap) {
    const newIds = charIds
      .map(id => idMapping.get(id) ?? id) // Replace with merged ID if applicable
      .filter((id, idx, arr) => arr.indexOf(id) === idx) // Remove duplicates

    updated.set(frameIdx, newIds)
  }

  return updated
}

/**
 * Updates frame character boxes after a merge.
 * Keeps highest-confidence detection for each frame.
 */
export function updateFrameCharacterBoxes(
  frameBoxes: Map<number, Map<string, any>>,
  idMapping: Map<string, string>
): Map<number, Map<string, any>> {
  const updated = new Map<number, Map<string, any>>()

  for (const [frameIdx, charBoxes] of frameBoxes) {
    const newCharBoxes = new Map<string, any>()

    for (const [oldId, box] of charBoxes) {
      const newId = idMapping.get(oldId) ?? oldId
      newCharBoxes.set(newId, box) // Last one wins if multiple boxes for same merged ID
    }

    updated.set(frameIdx, newCharBoxes)
  }

  return updated
}

/**
 * Updates frame character expressions after a merge.
 * Keeps expressions for merged character ID.
 */
export function updateFrameCharacterExpressions(
  frameExpressions: Map<number, Map<string, Record<string, number>>>,
  idMapping: Map<string, string>
): Map<number, Map<string, Record<string, number>>> {
  const updated = new Map<number, Map<string, Record<string, number>>>()

  for (const [frameIdx, charExpressions] of frameExpressions) {
    const newCharExpressions = new Map<string, Record<string, number>>()

    for (const [oldId, expressions] of charExpressions) {
      const newId = idMapping.get(oldId) ?? oldId
      newCharExpressions.set(newId, expressions) // Last one wins
    }

    updated.set(frameIdx, newCharExpressions)
  }

  return updated
}

/**
 * Removes deleted characters from the character list.
 */
export function removeCharacters(
  characters: DetectedCharacter[],
  idsToRemove: string[]
): DetectedCharacter[] {
  const removeSet = new Set(idsToRemove)
  return characters.filter(c => !removeSet.has(c.id))
}

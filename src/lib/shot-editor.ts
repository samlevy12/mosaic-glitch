/**
 * shot-editor.ts
 * Utilities for editing shot boundaries: adjusting, splitting, and merging shots.
 * Validates all changes to ensure no overlaps or invalid states.
 */

import type { Shot } from './types'

export interface ShotValidationError {
  shotIndex: number
  message: string
}

/**
 * Validates an array of shots for:
 * - No overlaps
 * - No negative lengths
 * - Frame ranges within video duration
 * - Proper ordering
 */
export function validateShots(
  shots: Shot[],
  videoDurationFrames: number
): ShotValidationError[] {
  const errors: ShotValidationError[] = []

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i]

    // Check for negative length
    if (shot.endFrame <= shot.startFrame) {
      errors.push({
        shotIndex: i,
        message: `Invalid length: endFrame (${shot.endFrame}) must be > startFrame (${shot.startFrame})`,
      })
    }

    // Check bounds
    if (shot.startFrame < 0) {
      errors.push({
        shotIndex: i,
        message: `Start frame ${shot.startFrame} cannot be negative`,
      })
    }
    if (shot.endFrame > videoDurationFrames) {
      errors.push({
        shotIndex: i,
        message: `End frame ${shot.endFrame} exceeds video duration (${videoDurationFrames})`,
      })
    }

    // Check for overlaps with next shot
    if (i < shots.length - 1) {
      const nextShot = shots[i + 1]
      if (shot.endFrame >= nextShot.startFrame) {
        errors.push({
          shotIndex: i,
          message: `Overlap with next shot: this shot ends at ${shot.endFrame} but next starts at ${nextShot.startFrame}`,
        })
      }
    }
  }

  return errors
}

/**
 * Adjusts a shot's boundaries.
 * Returns updated shot or null if adjustment would be invalid.
 */
export function adjustShotBoundary(
  shot: Shot,
  newStartFrame?: number,
  newEndFrame?: number
): Shot | null {
  const adjusted = {
    ...shot,
    startFrame: newStartFrame ?? shot.startFrame,
    endFrame: newEndFrame ?? shot.endFrame,
  }

  // Quick validation
  if (adjusted.endFrame <= adjusted.startFrame) {
    return null
  }

  adjusted.startTime = adjusted.startFrame / 30
  adjusted.endTime = adjusted.endFrame / 30

  return adjusted
}

/**
 * Splits a shot at a given frame index.
 * Returns [before, after] or null if split is invalid.
 */
export function splitShot(
  shot: Shot,
  splitAtFrame: number
): [Shot, Shot] | null {
  // Split point must be between start and end
  if (splitAtFrame <= shot.startFrame || splitAtFrame >= shot.endFrame) {
    return null
  }

  const before: Shot = {
    startFrame: shot.startFrame,
    endFrame: splitAtFrame,
    startTime: shot.startTime,
    endTime: splitAtFrame / 30,
    characterIds: [...shot.characterIds],
    crop: shot.crop ? { ...shot.crop } : undefined,
  }

  const after: Shot = {
    startFrame: splitAtFrame,
    endFrame: shot.endFrame,
    startTime: splitAtFrame / 30,
    endTime: shot.endTime,
    characterIds: [...shot.characterIds],
    crop: shot.crop ? { ...shot.crop } : undefined,
  }

  return [before, after]
}

/**
 * Merges two adjacent shots.
 * Returns merged shot or null if shots are not adjacent or invalid.
 */
export function mergeShots(shot1: Shot, shot2: Shot): Shot | null {
  // Shots must be adjacent (shot1 ends where shot2 starts)
  if (shot1.endFrame !== shot2.startFrame) {
    return null
  }

  // Merge character lists (union)
  const characterIds = Array.from(new Set([...shot1.characterIds, ...shot2.characterIds]))

  // Use shot1's crop if present (or could average, but keep it simple)
  const merged: Shot = {
    startFrame: shot1.startFrame,
    endFrame: shot2.endFrame,
    startTime: shot1.startTime,
    endTime: shot2.endTime,
    characterIds,
    crop: shot1.crop ? { ...shot1.crop } : undefined,
  }

  return merged
}

/**
 * Applies a set of edits to the shot list.
 * Returns updated shots or null if any edit is invalid.
 */
export function applyShotEdits(
  originalShots: Shot[],
  editedShots: Shot[],
  videoDurationFrames: number
): Shot[] | null {
  // Validate all edited shots
  const errors = validateShots(editedShots, videoDurationFrames)
  if (errors.length > 0) {
    return null
  }

  return editedShots
}

/**
 * Creates a copy of shots for editing (deep clone with proper types).
 */
export function cloneShotsForEditing(shots: Shot[]): Shot[] {
  return shots.map(shot => ({
    startFrame: shot.startFrame,
    endFrame: shot.endFrame,
    startTime: shot.startTime,
    endTime: shot.endTime,
    characterIds: [...shot.characterIds],
    crop: shot.crop ? { ...shot.crop } : undefined,
  }))
}

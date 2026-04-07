import { Region } from './types'

interface TrackedRegion {
  trackId: number
  lastSeen: number
  createdFrame: number
  assignment: { imageIndex: number; rect?: { x: number; y: number; w: number; h: number } } | null
}

export class RegionTracker {
  private tracks: Map<number, TrackedRegion> = new Map()
  private nextTrackId = 0
  private currentFrame = 0
  private holdFrames: number
  private reassignAggression: number
  private allowReassign: boolean

  constructor(holdFrames: number, reassignAggression: number, allowReassign: boolean) {
    this.holdFrames = holdFrames
    this.reassignAggression = reassignAggression
    this.allowReassign = allowReassign
  }

  updateSettings(holdFrames: number, reassignAggression: number, allowReassign: boolean) {
    this.holdFrames = holdFrames
    this.reassignAggression = reassignAggression
    this.allowReassign = allowReassign
  }

  reshuffle() {
    this.tracks.clear()
  }

  trackRegions(currentRegions: Region[], prevRegions: Region[] | null): Region[] {
    this.currentFrame++

    if (!prevRegions || prevRegions.length === 0) {
      return currentRegions.map(r => {
        const trackId = this.nextTrackId++
        this.tracks.set(trackId, {
          trackId,
          lastSeen: this.currentFrame,
          createdFrame: this.currentFrame,
          assignment: null
        })
        return { ...r, trackId }
      })
    }

    const matched = new Set<number>()
    const result: Region[] = []

    const maxCentroidDist = 100 * (1 + this.reassignAggression / 100)
    const maxAreaRatio = 2.0

    for (const curr of currentRegions) {
      let bestMatch: Region | null = null
      let bestDist = Infinity

      for (const prev of prevRegions) {
        if (matched.has(prev.trackId)) continue

        const dx = curr.centroid.x - prev.centroid.x
        const dy = curr.centroid.y - prev.centroid.y
        const dist = Math.sqrt(dx * dx + dy * dy)

        const areaRatio = Math.max(curr.area / prev.area, prev.area / curr.area)

        if (dist < maxCentroidDist && areaRatio < maxAreaRatio && dist < bestDist) {
          bestDist = dist
          bestMatch = prev
        }
      }

      if (bestMatch) {
        matched.add(bestMatch.trackId)
        this.tracks.get(bestMatch.trackId)!.lastSeen = this.currentFrame
        result.push({ ...curr, trackId: bestMatch.trackId })
      } else {
        const trackId = this.nextTrackId++
        this.tracks.set(trackId, {
          trackId,
          lastSeen: this.currentFrame,
          createdFrame: this.currentFrame,
          assignment: null
        })
        result.push({ ...curr, trackId })
      }
    }

    const staleThreshold = this.currentFrame - this.holdFrames * 2
    for (const [trackId, track] of this.tracks.entries()) {
      if (track.lastSeen < staleThreshold) {
        this.tracks.delete(trackId)
      }
    }

    return result
  }

  canReassign(trackId: number): boolean {
    if (!this.allowReassign) return false
    
    const track = this.tracks.get(trackId)
    if (!track) return true
    
    const framesSinceCreation = this.currentFrame - track.createdFrame
    return framesSinceCreation > this.holdFrames
  }

  getAssignment(trackId: number): { imageIndex: number; rect?: { x: number; y: number; w: number; h: number } } | null {
    const track = this.tracks.get(trackId)
    return track ? track.assignment : null
  }

  setAssignment(trackId: number, assignment: { imageIndex: number; rect?: { x: number; y: number; w: number; h: number } }) {
    const track = this.tracks.get(trackId)
    if (track) {
      track.assignment = assignment
    }
  }
}

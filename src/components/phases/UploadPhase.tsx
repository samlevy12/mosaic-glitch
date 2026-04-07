import { useRef, useState } from 'react'
import type { VideoMetadata } from '../../lib/types'
import { VideoPreview } from '../VideoPreview'

interface UploadPhaseProps {
  videoFile: File | null
  videoMetadata: VideoMetadata | null
  onVideoSelected: (file: File, metadata: VideoMetadata) => void
  onProceed: () => void
}

export function UploadPhase({ videoFile, videoMetadata, onVideoSelected, onProceed }: UploadPhaseProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  function handleFile(file: File) {
    setLoadError(null)
    if (!file.type.startsWith('video/')) {
      setLoadError('Please upload a video file.')
      return
    }
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    video.src = url
    video.onloadedmetadata = () => {
      onVideoSelected(file, {
        filename: file.name,
        duration: video.duration,
        fps: 30,
        width: video.videoWidth,
        height: video.videoHeight,
      })
      URL.revokeObjectURL(url)
    }
    video.onerror = () => {
      setLoadError('Could not read video metadata.')
      URL.revokeObjectURL(url)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Step 1</h2>
        <p className="body-text">Upload your source video. We'll scan it for faces in the next step.</p>
      </div>

      {/* Drop zone */}
      <div
        className={`border-2 border-dashed transition-colors rounded-none p-12 text-center cursor-pointer ${
          dragging ? 'border-[#B98B82] bg-[#B98B82]/5' : 'border-border hover:border-[#B98B82]/50'
        }`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
        />
        {videoFile ? (
          <div className="space-y-2">
            <div className="text-2xl">🎬</div>
            <p className="font-medium text-sm">{videoFile.name}</p>
            <p className="caption">{(videoFile.size / 1024 / 1024).toFixed(1)} MB</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-3xl opacity-30">↑</div>
            <p className="body-text">Drop video here or click to browse</p>
            <p className="caption">MP4, MOV, WebM supported</p>
          </div>
        )}
      </div>

      {loadError && (
        <p className="text-xs text-destructive">{loadError}</p>
      )}

      {/* Video preview */}
      {videoFile && (
        <VideoPreview src={videoFile} label="Preview" />
      )}

      {/* Metadata card */}
      {videoMetadata && (
        <div className="border border-border bg-card p-4 space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Video Info</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2">
            {[
              ['Filename', videoMetadata.filename],
              ['Duration', `${videoMetadata.duration.toFixed(2)}s`],
              ['Dimensions', `${videoMetadata.width} × ${videoMetadata.height}`],
              ['Size', `${(videoFile!.size / 1024 / 1024).toFixed(1)} MB`],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between border-b border-border/40 pb-1">
                <label>{label}</label>
                <span className="numeric text-xs">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onProceed}
        disabled={!videoFile}
        className="w-full py-2.5 text-xs uppercase tracking-wider border border-border disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#B98B82] hover:text-white hover:border-[#B98B82] transition-colors"
      >
        Scan for Characters →
      </button>
    </div>
  )
}

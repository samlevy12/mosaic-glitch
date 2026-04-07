/**
 * stitcher.ts
 * Uses FFmpeg.wasm (@ffmpeg/ffmpeg 0.12.x) to cut and concatenate
 * selected shots into a single filtered video.
 *
 * When a shot has a `crop` field, a crop+scale filter is applied to
 * zoom in on the selected character and exclude unwanted faces.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import type { Shot } from './types'

export type StitcherProgressCallback = (progress: number, label: string) => void

let ffmpeg: FFmpeg | null = null
let loaded = false

export async function loadFFmpeg(): Promise<void> {
  if (loaded) return
  ffmpeg = new FFmpeg()
  const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/'
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${base}ffmpeg-core.wasm`, 'application/wasm'),
  })
  loaded = true
}

export async function stitchShots(
  sourceFile: File,
  shots: Shot[],
  onProgress?: StitcherProgressCallback
): Promise<Blob> {
  if (!ffmpeg || !loaded) await loadFFmpeg()
  const ff = ffmpeg!

  onProgress?.(0, 'Writing source video...')
  await ff.writeFile('input.mp4', await fetchFile(sourceFile))

  // Process each shot — only re-encode if it needs cropping
  // Shots without crops use -c copy (instant), avoiding expensive re-encoding
  const totalSteps = shots.length + 1 // +1 for concat
  const croppedCount = shots.filter(s => s.crop).length
  console.log(`[Stitcher] Processing ${shots.length} shots (${croppedCount} need encoding, ${shots.length - croppedCount} will copy)`)

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i]
    const isCropped = shot.crop != null
    const label = isCropped
      ? `Encoding shot ${i + 1}/${shots.length} (with zoom)`
      : `Copying shot ${i + 1}/${shots.length}`
    const progress = i / totalSteps
    onProgress?.(progress, label)

    const startTime = Date.now()
    console.log(`[Stitcher] [${i + 1}/${shots.length}] ${isCropped ? 'Encoding' : 'Copying'} — ${shot.startTime.toFixed(1)}s to ${shot.endTime.toFixed(1)}s`)

    const baseArgs = [
      '-ss', shot.startTime.toFixed(3),
      '-to', shot.endTime.toFixed(3),
      '-i', 'input.mp4',
    ]

    if (shot.crop) {
      // Only re-encode this shot (not all shots)
      const { x, y, w, h, outW, outH } = shot.crop
      await ff.exec([
        ...baseArgs,
        '-vf', `crop=${w}:${h}:${x}:${y},scale=${outW}:${outH}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        `segment_${i}.mp4`,
      ])
    } else {
      // No crop needed — copy stream (instant)
      await ff.exec([
        ...baseArgs,
        '-c', 'copy',
        `segment_${i}.mp4`,
      ])
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[Stitcher] ✓ Shot ${i + 1} complete (${elapsed}s)`)
  }

  // Write concat list
  const concatList = shots.map((_, i) => `file 'segment_${i}.mp4'`).join('\n')
  await ff.writeFile('concat.txt', concatList)

  console.log(`[Stitcher] Concatenating ${shots.length} segments...`)
  onProgress?.((shots.length) / (shots.length + 1), 'Concatenating shots...')
  const concatStart = Date.now()
  await ff.exec([
    '-f', 'concat',
    '-safe', '0',
    '-i', 'concat.txt',
    '-c', 'copy',
    'output.mp4',
  ])
  const concatTime = ((Date.now() - concatStart) / 1000).toFixed(1)
  console.log(`[Stitcher] ✓ Concatenation complete (${concatTime}s)`)

  const data = await ff.readFile('output.mp4')
  const blob = new Blob([data], { type: 'video/mp4' })
  const sizeMB = (blob.size / 1024 / 1024).toFixed(1)

  console.log(`[Stitcher] ✓ Output ready — ${sizeMB} MB`)
  console.log(`[Stitcher] Cleaning up temporary files...`)

  // Cleanup
  await ff.deleteFile('input.mp4')
  await ff.deleteFile('concat.txt')
  await ff.deleteFile('output.mp4')
  for (let i = 0; i < shots.length; i++) {
    try { await ff.deleteFile(`segment_${i}.mp4`) } catch { /* ignore */ }
  }

  console.log(`[Stitcher] ✓ Complete — ${shots.length} shots stitched into ${sizeMB} MB video`)
  onProgress?.(1, 'Done')
  return blob
}

/**
 * Transcodes any video blob (e.g. WebM from MediaRecorder) to H.264 MP4
 * using FFmpeg.wasm so the result plays in QuickTime, iOS, etc.
 */
export async function transcodeToMp4(
  input: Blob,
  fps = 30,
  onProgress?: (p: number, label: string) => void
): Promise<Blob> {
  if (!ffmpeg || !loaded) await loadFFmpeg()
  const ff = ffmpeg!

  onProgress?.(0, 'Loading video into FFmpeg...')
  await ff.writeFile('input.webm', await fetchFile(input))

  onProgress?.(0.1, 'Transcoding to H.264 MP4...')
  await ff.exec([
    '-i', 'input.webm',
    '-vf', `setpts=N/${fps}/TB`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-an',
    '-movflags', '+faststart',
    'output.mp4',
  ])

  const data = await ff.readFile('output.mp4')
  const blob = new Blob([data], { type: 'video/mp4' })

  try { await ff.deleteFile('input.webm') } catch { /* ignore */ }
  try { await ff.deleteFile('output.mp4') } catch { /* ignore */ }

  onProgress?.(1, 'Done')
  console.log(`[Stitcher] ✓ Transcode complete — ${(blob.size / 1024 / 1024).toFixed(1)} MB MP4`)
  return blob
}

/**
 * Creates a streaming frame encoder that writes PNG frames directly into
 * FFmpeg.wasm's virtual filesystem, then encodes them as H.264 MP4.
 * This avoids MediaRecorder timestamp issues entirely — FPS is exact.
 */
export async function createFrameEncoder(fps: number) {
  if (!ffmpeg || !loaded) await loadFFmpeg()
  const ff = ffmpeg!
  let frameCount = 0

  return {
    async addFrame(canvas: HTMLCanvasElement): Promise<void> {
      const blob = await new Promise<Blob>(res =>
        canvas.toBlob(b => res(b!), 'image/png')
      )
      if (!blob || blob.size < 500) {
        console.warn(`[FrameEncoder] frame ${frameCount}: suspiciously small blob (${blob?.size ?? 0} bytes) — canvas may be blank`)
      }
      const data = new Uint8Array(await blob.arrayBuffer())
      await ff.writeFile(`frame_${frameCount.toString().padStart(6, '0')}.png`, data)
      if (frameCount === 0) {
        console.log(`[FrameEncoder] first frame written — blob size: ${blob.size} bytes, canvas: ${canvas.width}×${canvas.height}`)
      }
      frameCount++
    },

    async finalize(onProgress?: (p: number, label: string) => void): Promise<Blob> {
      onProgress?.(0, 'Encoding frames to MP4...')
      await ff.exec([
        '-r', `${fps}`,
        '-i', 'frame_%06d.png',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-movflags', '+faststart',
        '-an',
        'render_output.mp4',
      ])

      const data = await ff.readFile('render_output.mp4')
      const blob = new Blob([data], { type: 'video/mp4' })

      // Clean up frame files
      for (let i = 0; i < frameCount; i++) {
        try { await ff.deleteFile(`frame_${i.toString().padStart(6, '0')}.png`) } catch { /* ignore */ }
      }
      try { await ff.deleteFile('render_output.mp4') } catch { /* ignore */ }

      onProgress?.(1, 'Done')
      console.log(`[Stitcher] ✓ Encoded ${frameCount} frames → ${(blob.size / 1024 / 1024).toFixed(1)} MB MP4`)
      return blob
    }
  }
}

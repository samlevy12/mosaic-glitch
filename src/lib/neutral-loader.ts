import type { CachedImage } from './renderer'
import { computeMeanL, computeColorTemp } from './renderer'

/**
 * Neutral tile loader using the File System Access API.
 *
 * First use: user picks the Neutral folder via showDirectoryPicker().
 * The directory handle is persisted in IndexedDB so subsequent sessions
 * auto-reconnect without prompting (just needs a permission re-grant).
 *
 * Each session loads a fresh random sample of 99 images from the full folder.
 */

const SAMPLE_SIZE = 99
const DB_NAME = 'emotion-mosaic-neutral'
const STORE_NAME = 'handles'
const HANDLE_KEY = 'neutralDir'
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

// ── IndexedDB persistence for directory handle ─────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

// ── Fisher-Yates shuffle ───────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Try to auto-load from a previously saved directory handle (no user gesture needed for permission check). */
export async function tryAutoLoadNeutralCache(): Promise<CachedImage[]> {
  const handle = await loadHandle()
  if (!handle) return []

  // Try to get permission silently (works if granted in this origin before)
  try {
    const perm = await (handle as any).requestPermission({ mode: 'read' })
    if (perm !== 'granted') return []
  } catch {
    return [] // Need user gesture — will require pickNeutralFolder()
  }

  return await loadFromHandle(handle)
}

/**
 * Prompt user to pick the neutral folder. Persists the handle for future sessions.
 * Must be called from a user gesture (click handler).
 */
export async function pickNeutralFolder(): Promise<CachedImage[]> {
  try {
    const handle = await (window as any).showDirectoryPicker({
      mode: 'read',
      startIn: 'desktop',
    }) as FileSystemDirectoryHandle
    await saveHandle(handle)
    return await loadFromHandle(handle)
  } catch (err) {
    // User cancelled or API not available
    console.warn('[neutral-loader] Folder pick cancelled:', err)
    return []
  }
}

/** Check if we have a saved handle (doesn't require permission). */
export async function hasNeutralHandle(): Promise<boolean> {
  const handle = await loadHandle()
  return handle !== null
}

// ── Internal ───────────────────────────────────────────────────────────────

async function loadFromHandle(handle: FileSystemDirectoryHandle): Promise<CachedImage[]> {
  // Enumerate all image files in the directory
  const allFiles: FileSystemFileHandle[] = []
  for await (const [name, entry] of (handle as any).entries()) {
    if (entry.kind === 'file') {
      const ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''
      if (IMAGE_EXT.has(ext)) {
        allFiles.push(entry as FileSystemFileHandle)
      }
    }
  }

  if (allFiles.length === 0) {
    console.warn('[neutral-loader] No images found in neutral folder')
    return []
  }

  // Random sample
  const sampled = shuffle(allFiles).slice(0, SAMPLE_SIZE)

  // Load images with concurrency
  const cache: CachedImage[] = []
  const concurrency = 8
  let idx = 0

  async function worker() {
    while (idx < sampled.length) {
      const i = idx++
      try {
        const file = await sampled[i].getFile()
        const bitmap = await createImageBitmap(file)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        bitmap.close()

        const data = new Uint8ClampedArray(imgData.data)
        cache.push({
          width: canvas.width,
          height: canvas.height,
          data,
          meanL: computeMeanL(data),
          colorTemp: computeColorTemp(data),
        })
      } catch {
        // skip failed images
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  console.log(`[neutral-loader] Loaded ${cache.length} random neutral tiles from ${allFiles.length} total`)
  return cache
}

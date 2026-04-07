/**
 * Extract pages from a PDF as PNG image Files using pdf.js.
 * Each page is rendered at 2× scale for good tile quality,
 * then returned as a File object ready to drop into the image pipeline.
 */

import * as pdfjsLib from 'pdfjs-dist'

// Point pdf.js at its bundled worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

export interface PDFExtractResult {
  /** Image files extracted from the PDF (one per page) */
  images: File[]
  /** Number of pages processed */
  pageCount: number
}

/**
 * Extract all pages from a PDF file as PNG images.
 * @param pdfFile  The .pdf File object
 * @param scale    Render scale (default 2 = 2× native resolution)
 * @param onProgress  Optional callback with (currentPage, totalPages)
 * @returns Array of File objects (PNG), named like "filename_page1.png"
 */
export async function extractPDFPages(
  pdfFile: File,
  scale = 2,
  onProgress?: (current: number, total: number) => void
): Promise<PDFExtractResult> {
  const arrayBuffer = await pdfFile.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const numPages = pdf.numPages
  const images: File[] = []
  const baseName = pdfFile.name.replace(/\.pdf$/i, '')

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')!

    await page.render({ canvasContext: ctx, viewport }).promise

    // Convert canvas to PNG blob → File
    const blob = await new Promise<Blob>((resolve) => {
      canvas.toBlob(b => resolve(b!), 'image/png')
    })

    const fileName = numPages === 1
      ? `${baseName}.png`
      : `${baseName}_page${i}.png`

    images.push(new File([blob], fileName, { type: 'image/png' }))
    onProgress?.(i, numPages)
  }

  return { images, pageCount: numPages }
}

/**
 * Check if a file is a PDF.
 */
export function isPDF(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

/**
 * Process a mixed array of files: PDFs get extracted to images, non-PDFs pass through.
 * Returns only image files (PDFs replaced by their extracted pages).
 */
export async function expandPDFs(
  files: File[],
  onProgress?: (label: string) => void
): Promise<File[]> {
  const result: File[] = []

  for (const file of files) {
    if (isPDF(file)) {
      onProgress?.(`Extracting ${file.name}...`)
      try {
        const { images, pageCount } = await extractPDFPages(file)
        result.push(...images)
        onProgress?.(`Extracted ${pageCount} page${pageCount !== 1 ? 's' : ''} from ${file.name}`)
      } catch (err) {
        console.warn(`[PDF] Failed to extract ${file.name}:`, err)
        // Skip broken PDFs silently
      }
    } else if (file.type.startsWith('image/')) {
      result.push(file)
    }
  }

  return result
}

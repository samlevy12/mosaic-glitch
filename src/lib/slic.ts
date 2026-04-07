export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  let rNorm = r / 255
  let gNorm = g / 255
  let bNorm = b / 255

  rNorm = rNorm > 0.04045 ? Math.pow((rNorm + 0.055) / 1.055, 2.4) : rNorm / 12.92
  gNorm = gNorm > 0.04045 ? Math.pow((gNorm + 0.055) / 1.055, 2.4) : gNorm / 12.92
  bNorm = bNorm > 0.04045 ? Math.pow((bNorm + 0.055) / 1.055, 2.4) : bNorm / 12.92

  const x = rNorm * 0.4124564 + gNorm * 0.3575761 + bNorm * 0.1804375
  const y = rNorm * 0.2126729 + gNorm * 0.7151522 + bNorm * 0.0721750
  const z = rNorm * 0.0193339 + gNorm * 0.1191920 + bNorm * 0.9503041

  const xn = x / 0.95047
  const yn = y / 1.00000
  const zn = z / 1.08883

  const fx = xn > 0.008856 ? Math.pow(xn, 1/3) : (7.787 * xn + 16/116)
  const fy = yn > 0.008856 ? Math.pow(yn, 1/3) : (7.787 * yn + 16/116)
  const fz = zn > 0.008856 ? Math.pow(zn, 1/3) : (7.787 * zn + 16/116)

  const L = (116 * fy) - 16
  const a = 500 * (fx - fy)
  const bLab = 200 * (fy - fz)

  return [L, a, bLab]
}

export function bilateralFilter(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  sigmaSpace: number = 5,
  sigmaColor: number = 8
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(imageData.length)
  const kernelRadius = Math.ceil(sigmaSpace * 2)
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      
      let sumR = 0, sumG = 0, sumB = 0, sumWeight = 0
      
      for (let ky = -kernelRadius; ky <= kernelRadius; ky++) {
        for (let kx = -kernelRadius; kx <= kernelRadius; kx++) {
          const nx = x + kx
          const ny = y + ky
          
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          
          const nidx = (ny * width + nx) * 4
          
          const spatialDist = kx * kx + ky * ky
          const spatialWeight = Math.exp(-spatialDist / (2 * sigmaSpace * sigmaSpace))
          
          const dr = imageData[idx] - imageData[nidx]
          const dg = imageData[idx + 1] - imageData[nidx + 1]
          const db = imageData[idx + 2] - imageData[nidx + 2]
          const colorDist = dr * dr + dg * dg + db * db
          const colorWeight = Math.exp(-colorDist / (2 * sigmaColor * sigmaColor))
          
          const weight = spatialWeight * colorWeight
          
          sumR += imageData[nidx] * weight
          sumG += imageData[nidx + 1] * weight
          sumB += imageData[nidx + 2] * weight
          sumWeight += weight
        }
      }
      
      output[idx] = sumR / sumWeight
      output[idx + 1] = sumG / sumWeight
      output[idx + 2] = sumB / sumWeight
      output[idx + 3] = imageData[idx + 3]
    }
  }
  
  return output
}

export function slicSuperpixels(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  numSegments: number,
  compactness: number,
  iterations: number = 7
): Uint32Array {
  const labels = new Uint32Array(width * height)
  const distances = new Float32Array(width * height).fill(Infinity)
  
  const labImage = new Float32Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4
    const [L, a, b] = rgbToLab(imageData[idx], imageData[idx + 1], imageData[idx + 2])
    labImage[i * 3] = L
    labImage[i * 3 + 1] = a
    labImage[i * 3 + 2] = b
  }
  
  const gridSize = Math.sqrt((width * height) / numSegments)
  const centersX: number[] = []
  const centersY: number[] = []
  const centersL: number[] = []
  const centersA: number[] = []
  const centersB: number[] = []
  
  for (let y = Math.floor(gridSize / 2); y < height; y += gridSize) {
    for (let x = Math.floor(gridSize / 2); x < width; x += gridSize) {
      centersX.push(x)
      centersY.push(y)
      const idx = Math.floor(y) * width + Math.floor(x)
      centersL.push(labImage[idx * 3])
      centersA.push(labImage[idx * 3 + 1])
      centersB.push(labImage[idx * 3 + 2])
    }
  }
  
  const numCenters = centersX.length
  const m = compactness
  const S = gridSize
  
  for (let iter = 0; iter < iterations; iter++) {
    distances.fill(Infinity)
    
    for (let k = 0; k < numCenters; k++) {
      const cx = Math.floor(centersX[k])
      const cy = Math.floor(centersY[k])
      const cL = centersL[k]
      const cA = centersA[k]
      const cB = centersB[k]
      
      const searchRadius = Math.ceil(S * 2)
      
      for (let y = Math.max(0, cy - searchRadius); y < Math.min(height, cy + searchRadius); y++) {
        for (let x = Math.max(0, cx - searchRadius); x < Math.min(width, cx + searchRadius); x++) {
          const idx = y * width + x
          
          const dL = labImage[idx * 3] - cL
          const dA = labImage[idx * 3 + 1] - cA
          const dB = labImage[idx * 3 + 2] - cB
          const colorDist = Math.sqrt(dL * dL + dA * dA + dB * dB)
          
          const dx = x - cx
          const dy = y - cy
          const spatialDist = Math.sqrt(dx * dx + dy * dy)
          
          const dist = colorDist + (m / S) * spatialDist
          
          if (dist < distances[idx]) {
            distances[idx] = dist
            labels[idx] = k
          }
        }
      }
    }
    
    const sumX = new Float32Array(numCenters)
    const sumY = new Float32Array(numCenters)
    const sumL = new Float32Array(numCenters)
    const sumA = new Float32Array(numCenters)
    const sumB = new Float32Array(numCenters)
    const counts = new Uint32Array(numCenters)
    
    for (let i = 0; i < width * height; i++) {
      const label = labels[i]
      sumX[label] += i % width
      sumY[label] += Math.floor(i / width)
      sumL[label] += labImage[i * 3]
      sumA[label] += labImage[i * 3 + 1]
      sumB[label] += labImage[i * 3 + 2]
      counts[label]++
    }
    
    for (let k = 0; k < numCenters; k++) {
      if (counts[k] > 0) {
        centersX[k] = sumX[k] / counts[k]
        centersY[k] = sumY[k] / counts[k]
        centersL[k] = sumL[k] / counts[k]
        centersA[k] = sumA[k] / counts[k]
        centersB[k] = sumB[k] / counts[k]
      }
    }
  }
  
  return labels
}

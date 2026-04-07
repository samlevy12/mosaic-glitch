/**
 * gpu-slic.ts
 * WebGL2-accelerated SLIC superpixel segmentation.
 *
 * GPU handles the two heaviest passes:
 *   1. Bilateral filter (21×21 kernel per pixel — embarrassingly parallel)
 *   2. SLIC assignment (each pixel finds nearest center — embarrassingly parallel)
 *
 * CPU handles the cheap reduction step (update centers from assigned pixels).
 * Hybrid approach avoids complex GPU reductions while still getting 5-10× speedup.
 */

// ── Shader sources ──────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const BILATERAL_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_res;
uniform float u_sigmaSpace;
uniform float u_sigmaColor;
out vec4 o;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 c = texture(u_input, uv).rgb * 255.0;
  vec3 sum = vec3(0.0);
  float wSum = 0.0;
  int r = min(int(ceil(u_sigmaSpace * 2.0)), 12);

  for (int dy = -12; dy <= 12; dy++) {
    if (abs(dy) > r) continue;
    for (int dx = -12; dx <= 12; dx++) {
      if (abs(dx) > r) continue;
      vec2 nuv = clamp((gl_FragCoord.xy + vec2(float(dx), float(dy))) / u_res, 0.0, 1.0);
      vec3 n = texture(u_input, nuv).rgb * 255.0;
      float sd = float(dx*dx + dy*dy);
      float sw = exp(-sd / (2.0 * u_sigmaSpace * u_sigmaSpace));
      vec3 d = c - n;
      float cd = dot(d, d);
      float cw = exp(-cd / (2.0 * u_sigmaColor * u_sigmaColor));
      float w = sw * cw;
      sum += n * w;
      wSum += w;
    }
  }
  o = vec4(sum / (wSum * 255.0), 1.0);
}
`

const LAB_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_res;
out vec4 o;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 rgb = texture(u_input, uv).rgb;

  // Linearize sRGB
  vec3 lin;
  lin.r = rgb.r > 0.04045 ? pow((rgb.r + 0.055) / 1.055, 2.4) : rgb.r / 12.92;
  lin.g = rgb.g > 0.04045 ? pow((rgb.g + 0.055) / 1.055, 2.4) : rgb.g / 12.92;
  lin.b = rgb.b > 0.04045 ? pow((rgb.b + 0.055) / 1.055, 2.4) : rgb.b / 12.92;

  float x = lin.r*0.4124564 + lin.g*0.3575761 + lin.b*0.1804375;
  float y = lin.r*0.2126729 + lin.g*0.7151522 + lin.b*0.0721750;
  float z = lin.r*0.0193339 + lin.g*0.1191920 + lin.b*0.9503041;

  x /= 0.95047;
  z /= 1.08883;

  float fx = x > 0.008856 ? pow(x, 1.0/3.0) : (7.787*x + 16.0/116.0);
  float fy = y > 0.008856 ? pow(y, 1.0/3.0) : (7.787*y + 16.0/116.0);
  float fz = z > 0.008856 ? pow(z, 1.0/3.0) : (7.787*z + 16.0/116.0);

  float L = 116.0*fy - 16.0;
  float a = 500.0*(fx - fy);
  float b = 200.0*(fy - fz);

  o = vec4(L, a, b, 1.0);
}
`

const ASSIGN_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_lab;
uniform sampler2D u_centers;   // gridW×gridH, RGBA = (x, y, L, a)
uniform sampler2D u_centersB;  // gridW×gridH, R = b
uniform vec2 u_res;
uniform vec2 u_grid;           // (gridW, gridH)
uniform float u_S;
uniform float u_m;             // compactness
out vec4 o;

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / u_res;
  vec3 lab = texture(u_lab, uv).rgb;

  float gx = floor(px.x / u_S);
  float gy = floor(px.y / u_S);
  float mOverS = u_m / u_S;

  float minD = 1e10;
  float best = 0.0;

  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      float cx = gx + float(dx);
      float cy = gy + float(dy);
      if (cx < 0.0 || cx >= u_grid.x || cy < 0.0 || cy >= u_grid.y) continue;

      vec2 cuv = (vec2(cx, cy) + 0.5) / u_grid;
      vec4 c1 = texture(u_centers, cuv);
      float cB = texture(u_centersB, cuv).r;

      float dL = lab.x - c1.z;
      float dA = lab.y - c1.w;
      float dB = lab.z - cB;
      float colD = sqrt(dL*dL + dA*dA + dB*dB);

      float dX = px.x - c1.x;
      float dY = px.y - c1.y;
      float spaD = sqrt(dX*dX + dY*dY);

      float d = colD + mOverS * spaD;
      if (d < minD) {
        minD = d;
        best = cy * u_grid.x + cx;
      }
    }
  }

  o = vec4(best, 0.0, 0.0, 1.0);
}
`

// ── WebGL helpers ───────────────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s)
    gl.deleteShader(s)
    throw new Error(`Shader compile error: ${log}`)
  }
  return s
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p)
    gl.deleteProgram(p)
    throw new Error(`Program link error: ${log}`)
  }
  return p
}

function createFloat32Texture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  data: Float32Array | null,
  channels: 1 | 4 = 4
): WebGLTexture {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const internalFormat = channels === 4 ? gl.RGBA32F : gl.R32F
  const format = channels === 4 ? gl.RGBA : gl.RED
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, gl.FLOAT, data)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

function createFBO(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  return fbo
}

// ── GPU SLIC class ──────────────────────────────────────────────────────────

export class GPUSlic {
  private gl: WebGL2RenderingContext
  private canvas: HTMLCanvasElement

  // Programs
  private bilateralProg: WebGLProgram
  private labProg: WebGLProgram
  private assignProg: WebGLProgram

  // Full-screen quad VAO
  private quadVAO: WebGLVertexArrayObject

  private disposed = false

  constructor() {
    this.canvas = document.createElement('canvas')
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('WebGL2 not available')

    // Check for float texture support
    const ext = gl.getExtension('EXT_color_buffer_float')
    if (!ext) throw new Error('EXT_color_buffer_float not available')

    this.gl = gl

    // Compile programs
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT)
    this.bilateralProg = linkProgram(gl, vs, compileShader(gl, gl.FRAGMENT_SHADER, BILATERAL_FRAG))
    this.labProg = linkProgram(gl, vs, compileShader(gl, gl.FRAGMENT_SHADER, LAB_FRAG))
    this.assignProg = linkProgram(gl, vs, compileShader(gl, gl.FRAGMENT_SHADER, ASSIGN_FRAG))

    // Full-screen quad
    this.quadVAO = gl.createVertexArray()!
    gl.bindVertexArray(this.quadVAO)
    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
  }

  /**
   * Run GPU-accelerated SLIC.
   * Returns a label map (Uint32Array, one label per pixel).
   */
  async run(
    imageData: Uint8ClampedArray,
    width: number,
    height: number,
    numSegments: number,
    compactness: number,
    sigmaSpace = 5,
    sigmaColor = 8,
    iterations = 7
  ): Promise<Uint32Array> {
    if (this.disposed) throw new Error('GPUSlic disposed')
    const gl = this.gl

    this.canvas.width = width
    this.canvas.height = height
    gl.viewport(0, 0, width, height)

    // ── Upload source image ───────────────────────────────────────────────

    const inputTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, inputTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imageData)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // ── Pass 1: Bilateral filter ──────────────────────────────────────────

    const filteredTex = createFloat32Texture(gl, width, height, null, 4)
    const filteredFBO = createFBO(gl, filteredTex)

    gl.useProgram(this.bilateralProg)
    gl.uniform2f(gl.getUniformLocation(this.bilateralProg, 'u_res'), width, height)
    gl.uniform1f(gl.getUniformLocation(this.bilateralProg, 'u_sigmaSpace'), sigmaSpace)
    gl.uniform1f(gl.getUniformLocation(this.bilateralProg, 'u_sigmaColor'), sigmaColor)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, inputTex)
    gl.uniform1i(gl.getUniformLocation(this.bilateralProg, 'u_input'), 0)

    gl.bindFramebuffer(gl.FRAMEBUFFER, filteredFBO)
    gl.bindVertexArray(this.quadVAO)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // ── Pass 2: RGB → LAB ─────────────────────────────────────────────────

    const labTex = createFloat32Texture(gl, width, height, null, 4)
    const labFBO = createFBO(gl, labTex)

    gl.useProgram(this.labProg)
    gl.uniform2f(gl.getUniformLocation(this.labProg, 'u_res'), width, height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, filteredTex)
    gl.uniform1i(gl.getUniformLocation(this.labProg, 'u_input'), 0)

    gl.bindFramebuffer(gl.FRAMEBUFFER, labFBO)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Read back LAB data for CPU-side center updates
    const labCPU = new Float32Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, labCPU)

    // ── Initialize SLIC centers ───────────────────────────────────────────

    const gridSize = Math.sqrt((width * height) / numSegments)
    const gridW = Math.ceil(width / gridSize)
    const gridH = Math.ceil(height / gridSize)
    const numCenters = gridW * gridH

    // Center arrays
    const cX = new Float32Array(numCenters)
    const cY = new Float32Array(numCenters)
    const cL = new Float32Array(numCenters)
    const cA = new Float32Array(numCenters)
    const cB = new Float32Array(numCenters)

    // Place centers on grid
    let k = 0
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const x = Math.min(width - 1, Math.floor(gx * gridSize + gridSize / 2))
        const y = Math.min(height - 1, Math.floor(gy * gridSize + gridSize / 2))
        const idx = (y * width + x) * 4
        cX[k] = x
        cY[k] = y
        cL[k] = labCPU[idx]
        cA[k] = labCPU[idx + 1]
        cB[k] = labCPU[idx + 2]
        k++
      }
    }

    // Create center textures (gridW × gridH)
    const centersTex = createFloat32Texture(gl, gridW, gridH, null, 4)
    const centersBTex = createFloat32Texture(gl, gridW, gridH, null, 1)

    // Label output texture + FBO
    const labelTex = createFloat32Texture(gl, width, height, null, 4)
    const labelFBO = createFBO(gl, labelTex)

    // ── SLIC iterations ───────────────────────────────────────────────────

    const labels = new Uint32Array(width * height)

    for (let iter = 0; iter < iterations; iter++) {
      // Upload centers to GPU
      const centersData = new Float32Array(gridW * gridH * 4)
      const centersBData = new Float32Array(gridW * gridH)
      for (let i = 0; i < numCenters; i++) {
        centersData[i * 4] = cX[i]
        centersData[i * 4 + 1] = cY[i]
        centersData[i * 4 + 2] = cL[i]
        centersData[i * 4 + 3] = cA[i]
        centersBData[i] = cB[i]
      }

      gl.bindTexture(gl.TEXTURE_2D, centersTex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, centersData)

      gl.bindTexture(gl.TEXTURE_2D, centersBTex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gridW, gridH, gl.RED, gl.FLOAT, centersBData)

      // GPU assignment pass
      gl.useProgram(this.assignProg)
      gl.uniform2f(gl.getUniformLocation(this.assignProg, 'u_res'), width, height)
      gl.uniform2f(gl.getUniformLocation(this.assignProg, 'u_grid'), gridW, gridH)
      gl.uniform1f(gl.getUniformLocation(this.assignProg, 'u_S'), gridSize)
      gl.uniform1f(gl.getUniformLocation(this.assignProg, 'u_m'), compactness)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, labTex)
      gl.uniform1i(gl.getUniformLocation(this.assignProg, 'u_lab'), 0)

      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, centersTex)
      gl.uniform1i(gl.getUniformLocation(this.assignProg, 'u_centers'), 1)

      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, centersBTex)
      gl.uniform1i(gl.getUniformLocation(this.assignProg, 'u_centersB'), 2)

      gl.bindFramebuffer(gl.FRAMEBUFFER, labelFBO)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      // Read back labels
      const labelData = new Float32Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, labelData)

      for (let i = 0; i < width * height; i++) {
        labels[i] = Math.round(labelData[i * 4])
      }

      // CPU center update
      const sumX = new Float32Array(numCenters)
      const sumY = new Float32Array(numCenters)
      const sumL = new Float32Array(numCenters)
      const sumA = new Float32Array(numCenters)
      const sumB = new Float32Array(numCenters)
      const counts = new Uint32Array(numCenters)

      for (let i = 0; i < width * height; i++) {
        const lbl = labels[i]
        if (lbl < numCenters) {
          const x = i % width
          const y = Math.floor(i / width)
          const li = i * 4
          sumX[lbl] += x
          sumY[lbl] += y
          sumL[lbl] += labCPU[li]
          sumA[lbl] += labCPU[li + 1]
          sumB[lbl] += labCPU[li + 2]
          counts[lbl]++
        }
      }

      for (let i = 0; i < numCenters; i++) {
        if (counts[i] > 0) {
          cX[i] = sumX[i] / counts[i]
          cY[i] = sumY[i] / counts[i]
          cL[i] = sumL[i] / counts[i]
          cA[i] = sumA[i] / counts[i]
          cB[i] = sumB[i] / counts[i]
        }
      }

      // Yield to keep UI responsive
      await new Promise(r => setTimeout(r, 0))
    }

    // ── Cleanup GPU resources ─────────────────────────────────────────────

    gl.deleteTexture(inputTex)
    gl.deleteTexture(filteredTex)
    gl.deleteTexture(labTex)
    gl.deleteTexture(labelTex)
    gl.deleteTexture(centersTex)
    gl.deleteTexture(centersBTex)
    gl.deleteFramebuffer(filteredFBO)
    gl.deleteFramebuffer(labFBO)
    gl.deleteFramebuffer(labelFBO)

    return labels
  }

  dispose() {
    this.disposed = true
    const gl = this.gl
    gl.deleteProgram(this.bilateralProg)
    gl.deleteProgram(this.labProg)
    gl.deleteProgram(this.assignProg)
    gl.deleteVertexArray(this.quadVAO)
    const ext = gl.getExtension('WEBGL_lose_context')
    ext?.loseContext()
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: GPUSlic | null = null
let _initAttempted = false

/** Get the GPU SLIC instance, or null if WebGL2 is unavailable. */
export function getGPUSlic(): GPUSlic | null {
  if (_instance) return _instance
  if (_initAttempted) return null
  _initAttempted = true
  try {
    _instance = new GPUSlic()
    console.log('[GPU SLIC] WebGL2 initialized — using GPU acceleration')
    return _instance
  } catch (err) {
    console.warn('[GPU SLIC] Falling back to CPU:', (err as Error).message)
    return null
  }
}

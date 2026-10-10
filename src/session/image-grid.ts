import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

/**
 * Labeled coordinate grid rendered in pure TypeScript (no native rebuild).
 *
 * Unlike the native plain-line overlay, this draws a matplotlib-style frame:
 * gray grid lines over the content, numeric tick labels in absolute screen
 * pixels along the bottom (X) and left (Y) edges, and axis captions — so an
 * agent can read a number off the image and click it directly.
 *
 * All text uses an embedded 5x7 bitmap font (2x scaled), so there is no font
 * or OS text dependency.
 */

export interface RgbaImage {
  data: Buffer
  width: number
  height: number
}

export interface LabeledGridOptions {
  cols: number
  rows: number
  /** Screen pixel of the content's left edge. */
  originX: number
  /** Screen pixel of the content's top edge. */
  originY: number
  /** Screen pixels spanned by the full content width/height. */
  spanX: number
  spanY: number
  /** Small caption shown top-left, e.g. "coords: screen px". */
  caption: string
}

const GRID_MIN = 2
const GRID_MAX = 24
const MIN_LABEL_SPACING = 46
const PAD_L = 64
const PAD_R = 30
const PAD_T = 24
const PAD_B = 46
const FONT_SCALE = 2

/** Validate/clamp a [cols, rows] grid spec. */
export function parseGridLines(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const cols = Number(value[0])
  const rows = Number(value[1])
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined
  const clamp = (n: number) => Math.max(GRID_MIN, Math.min(GRID_MAX, Math.floor(n)))
  return [clamp(cols), clamp(rows)]
}

export function decodeImageBytes(bytes: Buffer, mimeType: string): RgbaImage {
  if (/png/i.test(mimeType)) {
    const png = PNG.sync.read(bytes)
    return { data: Buffer.from(png.data), width: png.width, height: png.height }
  }
  const decoded = jpeg.decode(bytes, { useTArray: false, maxMemoryUsageInMB: 512 })
  return { data: Buffer.from(decoded.data), width: decoded.width, height: decoded.height }
}

export function encodeJpeg(image: RgbaImage, quality: number): Buffer {
  const q = Math.max(1, Math.min(100, Math.round(quality)))
  return jpeg.encode({ data: image.data, width: image.width, height: image.height }, q).data
}

/**
 * True when the frame is (near-)uniform — the signature of a failed window
 * capture (GDI BitBlt of a GPU-composited window returns blank). A genuinely
 * blank window (empty Notepad) also matches, but falling back to a screen
 * crop is harmless there since it shows the same content.
 */
export function isUniformImage(image: RgbaImage): boolean {
  const { data, width, height } = image
  const total = width * height
  if (total <= 0) return true
  const step = Math.max(1, Math.floor(total / 2000))
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let i = 0; i < total; i += step) {
    const o = i * 4
    const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
    sum += lum
    sumSq += lum * lum
    n++
  }
  if (n === 0) return true
  const mean = sum / n
  const variance = Math.max(0, sumSq / n - mean * mean)
  return Math.sqrt(variance) < 3
}

// ── 5x7 bitmap font (rows of 5-bit strings) ──────────────────────────────

const FONT: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10001', '01010', '01100', '01010', '10001', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '01010', '10001', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  b: ['10000', '10000', '10110', '11001', '10001', '10001', '11110'],
  c: ['00000', '00000', '01111', '10000', '10000', '10001', '01110'],
  d: ['00001', '00001', '01101', '10011', '10001', '10001', '01111'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01001', '01000', '11100', '01000', '01000', '01000'],
  g: ['00000', '01111', '10001', '10001', '01111', '00001', '01110'],
  h: ['10000', '10000', '10110', '11001', '10001', '10001', '10001'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  j: ['00010', '00000', '00110', '00010', '00010', '10010', '01100'],
  k: ['10000', '10000', '10010', '10100', '11000', '10100', '10010'],
  l: ['01100', '00100', '00100', '00100', '00100', '00100', '01110'],
  m: ['00000', '00000', '11010', '10101', '10101', '10001', '10001'],
  n: ['00000', '00000', '10110', '11001', '10001', '10001', '10001'],
  o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
  p: ['00000', '00000', '11110', '10001', '10001', '11110', '10000'],
  q: ['00000', '00000', '01101', '10011', '10001', '01111', '00001'],
  r: ['00000', '00000', '10111', '11000', '10000', '10000', '10000'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  t: ['00100', '00100', '11100', '00100', '00100', '10001', '01110'],
  u: ['00000', '00000', '10001', '10001', '10001', '10011', '01101'],
  v: ['00000', '00000', '10001', '10001', '10001', '01010', '00100'],
  w: ['00000', '00000', '10001', '10101', '10101', '10101', '01010'],
  x: ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
  y: ['00000', '00000', '10001', '10001', '01111', '00001', '01110'],
  z: ['00000', '00000', '11111', '00010', '00100', '01000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '/': ['00000', '00001', '00010', '00100', '01000', '10000', '00000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
}

interface TextBitmap {
  w: number
  h: number
  pixels: Uint8Array // 1 = ink
}

function rasterize(text: string): TextBitmap {
  const chars = [...text].map(ch => FONT[ch] ?? FONT[' '])
  const w = chars.length * 6 - 1
  const h = 7
  const pixels = new Uint8Array(w * h)
  chars.forEach((rows, ci) => {
    for (let r = 0; r < 7; r++) {
      const row = rows[r]
      for (let c = 0; c < 5; c++) {
        if (row[c] === '1') pixels[r * w + ci * 6 + c] = 1
      }
    }
  })
  return { w, h, pixels }
}

function setPixel(data: Buffer, imgW: number, x: number, y: number, r: number, g: number, b: number): void {
  data[(y * imgW + x) * 4] = r
  data[(y * imgW + x) * 4 + 1] = g
  data[(y * imgW + x) * 4 + 2] = b
  data[(y * imgW + x) * 4 + 3] = 255
}

function blitText(
  data: Buffer,
  imgW: number,
  imgH: number,
  text: string,
  x: number,
  y: number,
  color: [number, number, number],
  rotate90 = false,
): void {
  const t = rasterize(text)
  for (let r = 0; r < t.h; r++) {
    for (let c = 0; c < t.w; c++) {
      if (!t.pixels[r * t.w + c]) continue
      for (let sy = 0; sy < FONT_SCALE; sy++) {
        for (let sx = 0; sx < FONT_SCALE; sx++) {
          const px = x + (rotate90 ? r * FONT_SCALE + sy : c * FONT_SCALE + sx)
          const py = y + (rotate90 ? t.w * FONT_SCALE - 1 - (c * FONT_SCALE + sx) : r * FONT_SCALE + sy)
          if (px >= 0 && py >= 0 && px < imgW && py < imgH) {
            setPixel(data, imgW, px, py, color[0], color[1], color[2])
          }
        }
      }
    }
  }
}

function textSize(text: string): [number, number] {
  const t = rasterize(text)
  return [t.w * FONT_SCALE, t.h * FONT_SCALE]
}

/** Boundary indices that get numeric labels (always first and last). */
function labelIndices(count: number, spacingPx: number): number[] {
  if (count <= 0) return [0]
  let step = 1
  if (spacingPx > 0 && spacingPx < MIN_LABEL_SPACING) {
    step = Math.ceil(MIN_LABEL_SPACING / spacingPx)
  }
  const out: number[] = []
  for (let i = 0; i <= count; i += step) out.push(i)
  if (out[out.length - 1] !== count) out.push(count)
  return out
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

/** Draw the labeled grid around the content; labels are absolute screen pixels. */
export function applyLabeledGrid(image: RgbaImage, opts: LabeledGridOptions): RgbaImage {
  const { data, width: w, height: h } = image
  const { cols, rows, originX, originY, spanX, spanY, caption } = opts

  // Frame palette follows the content (dark content -> dark frame).
  let lumSum = 0
  const stripH = Math.max(1, Math.min(4, h))
  for (let y = 0; y < stripH; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      lumSum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
    }
  }
  const dark = lumSum / (255 * w * stripH) < 0.5
  const bg: [number, number, number] = dark ? [26, 26, 29] : [249, 249, 249]
  const fg: [number, number, number] = dark ? [226, 226, 230] : [42, 42, 46]
  const dim = mix(bg, fg, 0.55)
  const edge = mix(bg, fg, 0.35)

  const cw = w + PAD_L + PAD_R
  const ch = h + PAD_T + PAD_B
  const out = Buffer.alloc(cw * ch * 4)
  for (let i = 0; i < cw * ch; i++) {
    out[i * 4] = bg[0]
    out[i * 4 + 1] = bg[1]
    out[i * 4 + 2] = bg[2]
    out[i * 4 + 3] = 255
  }
  // Paste content.
  for (let y = 0; y < h; y++) {
    data.copy(out, ((PAD_T + y) * cw + PAD_L) * 4, (y * w) * 4, (y * w + w) * 4)
  }
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x >= 0 && y >= 0 && x < cw && y < ch) setPixel(out, cw, x, y, c[0], c[1], c[2])
  }

  // Grid lines over the content (semi-transparent gray -> composite by hand).
  const line: [number, number, number] = [128, 128, 128]
  const blendLine = (x: number, y: number) => {
    const o = ((PAD_T + y) * cw + (PAD_L + x)) * 4
    out[o] = Math.round((out[o] + line[0]) / 2)
    out[o + 1] = Math.round((out[o + 1] + line[1]) / 2)
    out[o + 2] = Math.round((out[o + 2] + line[2]) / 2)
  }
  for (let i = 1; i < cols; i++) {
    const x = Math.round((i * w) / cols)
    for (let y = 0; y < h; y++) blendLine(x, y)
  }
  for (let i = 1; i < rows; i++) {
    const y = Math.round((i * h) / rows)
    for (let x = 0; x < w; x++) blendLine(x, y)
  }

  const putText = (text: string, x: number, y: number, color: [number, number, number], rot = false) => {
    blitText(out, cw, ch, text, x, y, color, rot)
  }

  // Border around content.
  for (let x = PAD_L - 1; x <= PAD_L + w; x++) {
    set(x, PAD_T - 1, edge)
    set(x, PAD_T + h, edge)
  }
  for (let y = PAD_T - 1; y <= PAD_T + h; y++) {
    set(PAD_L - 1, y, edge)
    set(PAD_L + w, y, edge)
  }

  putText(caption, 6, 5, dim)

  // X axis numbers under the bottom edge.
  for (const i of labelIndices(cols, w / cols)) {
    const cx = PAD_L + (i * w) / cols
    const text = String(Math.round(originX + (i / cols) * spanX))
    const [tw] = textSize(text)
    const tx = Math.max(2, Math.min(cw - tw - 2, Math.round(cx - tw / 2)))
    putText(text, tx, PAD_T + h + 5, fg)
  }
  // Y axis numbers left of the left edge.
  for (const i of labelIndices(rows, h / rows)) {
    const cy = PAD_T + (i * h) / rows
    const text = String(Math.round(originY + (i / rows) * spanY))
    const [, th] = textSize(text)
    const ty = Math.max(PAD_T, Math.min(PAD_T + h - th, Math.round(cy - th / 2)))
    const [tw] = textSize(text)
    putText(text, PAD_L - 8 - tw, ty, fg)
  }

  const xCap = 'X Coordinate (px)'
  const [capW, capH] = textSize(xCap)
  putText(xCap, Math.round(PAD_L + Math.max(0, (w - capW) / 2)), ch - capH - 7, dim)
  putText('Y Coordinate (px)', 6, Math.round(PAD_T + h / 2), dim, true)

  return { data: out, width: cw, height: ch }
}

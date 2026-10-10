import type { NativeModule } from '../native.js'
import { ok, type ToolResult, platformUnsupported } from '../result.js'
import { PROVIDER_QUALITY, PROVIDER_WIDTH } from './constants.js'
import {
  applyLabeledGrid,
  decodeImageBytes,
  encodeJpeg,
  isUniformImage,
  parseGridLines,
} from './image-grid.js'
import type { TargetStateController } from './target-state.js'
import type { VirtualPointerController } from './virtual-pointer.js'

export interface CachedScreenshot {
  mimeType: string
  data: string
  capturedAt: number
  targetArgs?: Record<string, unknown>
}

/** Screenshot/zoom handler with cache and pointer projection isolated from dispatch. */
export class ScreenshotHandler {
  readonly #native: NativeModule
  readonly #targets: TargetStateController
  readonly #pointer: VirtualPointerController
  readonly #visionEnabled: boolean
  readonly #defaultProvider: string
  readonly #env: NodeJS.ProcessEnv
  readonly #now: () => number
  #lastCaptureScope: string | undefined
  #lastHash: string | undefined
  #lastResult: ToolResult | undefined
  #lastScreenshot: CachedScreenshot | undefined

  constructor(options: {
    native: NativeModule
    targets: TargetStateController
    pointer: VirtualPointerController
    visionEnabled: boolean
    defaultProvider: string
    env?: NodeJS.ProcessEnv
    now?: () => number
  }) {
    this.#native = options.native
    this.#targets = options.targets
    this.#pointer = options.pointer
    this.#visionEnabled = options.visionEnabled
    this.#defaultProvider = options.defaultProvider
    this.#env = options.env ?? process.env
    this.#now = options.now ?? Date.now
  }

  lastHash(): string | undefined { return this.#lastHash }
  lastScreenshot(): CachedScreenshot | undefined {
    return this.#lastScreenshot ? structuredClone(this.#lastScreenshot) : undefined
  }

  /**
   * Rescue a blank window capture: when the window-targeted frame decodes to a
   * (near-)uniform image, the GDI path captured nothing (GPU-composited
   * window). Re-capture the screen at full resolution and crop to the window
   * bounds instead. Returns the replacement image, or undefined to keep the
   * original (decode failed, crop unavailable, or frame has real content).
   */
  #rescueBlankWindowCapture(
    image: { base64?: string; width: number; height: number; mimeType: string },
    windowId: number,
    quality: number,
  ): { base64: string; width: number; height: number; mimeType: string; hash: string; unchanged: boolean } | undefined {
    try {
      if (!image.base64) return undefined
      const decoded = decodeImageBytes(Buffer.from(image.base64, 'base64'), image.mimeType)
      if (!isUniformImage(decoded)) return undefined
      const bounds = this.#native.getWindow?.(windowId)?.bounds
      const display = this.#native.getDisplaySize()
      if (!bounds) return undefined
      const x1 = Math.max(0, Math.round(bounds.x))
      const y1 = Math.max(0, Math.round(bounds.y))
      const x2 = Math.min(display.width, Math.round(bounds.x + bounds.width))
      const y2 = Math.min(display.height, Math.round(bounds.y + bounds.height))
      if (x2 - x1 <= 0 || y2 - y1 <= 0) return undefined
      if (typeof this.#native.cropImage !== 'function') return undefined
      // Full-resolution screen source so crop coordinates map 1:1.
      const screen = this.#native.takeScreenshot(undefined, undefined, quality, undefined, undefined)
      if (!screen.base64) return undefined
      const cropped = this.#native.cropImage(screen.base64, x1, y1, x2, y2, quality)
      if (!cropped.base64) return undefined
      return { base64: cropped.base64, width: cropped.width, height: cropped.height, mimeType: cropped.mimeType, hash: '', unchanged: false }
    } catch {
      return undefined // Never break screenshots: degradation is silent by design.
    }
  }

  /**
   * Draw the labeled coordinate grid (matplotlib style, absolute screen-pixel
   * labels) onto a captured image. Returns the replacement image, or undefined
   * to keep the original when decoding/encoding fails.
   */
  #applyGrid(
    image: { base64?: string; width: number; height: number; mimeType: string },
    grid: [number, number],
    windowId: number | undefined,
  ): { base64: string; width: number; height: number; mimeType: string; hash: string; unchanged: boolean } | undefined {
    try {
      if (!image.base64) return undefined
      const decoded = decodeImageBytes(Buffer.from(image.base64, 'base64'), image.mimeType)
      const display = this.#native.getDisplaySize()
      let originX = 0
      let originY = 0
      let spanX = display.width
      let spanY = display.height
      let caption = 'coords: screen px'
      if (windowId !== undefined) {
        const bounds = this.#native.getWindow?.(windowId)?.bounds
        if (bounds && bounds.width > 0) {
          originX = Math.round(bounds.x)
          originY = Math.round(bounds.y)
          spanX = Math.round(bounds.width)
          spanY = Math.round((bounds.width * decoded.height) / Math.max(1, decoded.width))
          caption = 'coords: window px ~approx'
        }
      } else if (decoded.width > 0) {
        // Screen capture: content spans the whole display; labels are exact.
        spanX = display.width
        spanY = display.height
      }
      const gridded = applyLabeledGrid(decoded, {
        cols: grid[0],
        rows: grid[1],
        originX,
        originY,
        spanX,
        spanY,
        caption,
      })
      const jpeg = encodeJpeg(gridded, 80)
      return {
        base64: jpeg.toString('base64'),
        width: gridded.width,
        height: gridded.height,
        mimeType: 'image/jpeg',
        hash: '',
        unchanged: false,
      }
    } catch {
      return undefined // Never break screenshots: degradation is silent by design.
    }
  }

  /**
   * Describe a capture so a point in the image can be turned into a click.
   *
   * Reporting only `WxH`, as this used to, left every agent to infer the mapping —
   * and they infer it wrong. A screen capture scales uniformly with no offset, so
   * its mapping is exact and worth stating. A window capture includes the window's
   * shadow, so its scale is approximate and that has to be said rather than implied.
   * A window that could not be captured falls back to the screen, which is the case
   * that silently produces coordinates far from where an agent believes it clicked.
   */
  #describeCapture(width: number, height: number, windowId: number | undefined): string {
    const size = `${width}x${height}`
    const display = this.#native.getDisplaySize()
    const imageAspect = width / height
    const screenAspect = display.width / display.height
    const looksLikeScreen = Math.abs(imageAspect - screenAspect) < 0.02

    const bounds = windowId !== undefined ? this.#native.getWindow?.(windowId)?.bounds : undefined

    if (windowId !== undefined && bounds && !looksLikeScreen) {
      // Scaled from width, because the shadow adds more height than width.
      const scale = bounds.width / width
      return [
        `${size} | window ${windowId} at ${bounds.x},${bounds.y} sized ${bounds.width}x${bounds.height}`,
        `screen_x ≈ ${bounds.x} + image_x * ${scale.toFixed(4)}`,
        `screen_y ≈ ${bounds.y} + image_y * ${scale.toFixed(4)}`,
        'the capture includes the window shadow, so this mapping is approximate:'
          + ' click, then capture again to confirm before typing.'
          + ' For exact coordinates omit target_window_id and use a screen capture.',
      ].join('\n')
    }

    const scale = display.width / width
    const fellBack = windowId !== undefined
      ? ` | window ${windowId} could not be captured on its own, so this is the whole screen`
      : ''
    return [
      `${size} | screen ${display.width}x${display.height}${fellBack}`,
      `screen_x = image_x * ${scale.toFixed(4)}`,
      `screen_y = image_y * ${scale.toFixed(4)}`,
      'a screen capture scales uniformly with no offset, so this mapping is exact.',
    ].join('\n')
  }

  handle(tool: string, args: Record<string, unknown>): ToolResult | undefined {
    if (tool === 'screenshot') {
      const provider = typeof args.provider === 'string' ? args.provider : this.#defaultProvider
      const width = typeof args.width === 'number' ? args.width
        : this.#env.COMPUTER_USE_WIDTH !== undefined ? Number.parseInt(this.#env.COMPUTER_USE_WIDTH)
          : PROVIDER_WIDTH[provider] ?? 1024
      const quality = typeof args.quality === 'number' ? args.quality
        : this.#env.COMPUTER_USE_QUALITY !== undefined ? Number.parseInt(this.#env.COMPUTER_USE_QUALITY)
          : PROVIDER_QUALITY[provider] ?? PROVIDER_QUALITY.default
      let windowId = typeof args.target_window_id === 'number' ? args.target_window_id : undefined
      const app = windowId ? undefined
        : typeof args.target_app === 'string' && args.target_app.length > 0 ? args.target_app : undefined
      if (windowId === undefined && app === undefined) windowId = this.#targets.observationWindow()
      if (!this.#visionEnabled) {
        const frontmost = this.#native.getFrontmostApp()
        const display = this.#native.getDisplaySize()
        return ok(`Screen: ${display.width}×${display.height} | Frontmost: ${frontmost?.bundleId ?? 'unknown'} (${frontmost?.displayName ?? ''})`)
      }
      const showPointer = args.show_agent_pointer === true
      const grid = parseGridLines(args.grid_lines)
      const scope = JSON.stringify([app, windowId, width, quality, grid, windowId !== undefined ? this.#native.getWindow?.(windowId)?.bounds : undefined])
      let image = this.#native.takeScreenshot(
        width, app, quality, showPointer || scope !== this.#lastCaptureScope ? undefined : this.#lastHash, windowId,
      )
      if (!showPointer && image.unchanged && this.#lastResult) return this.#lastResult
      if (!image.base64) throw new Error('Screenshot capture missing image payload')
      let notes: string[] = []
      // Window captures of GPU-composited windows (browsers, games, Electron)
      // come back blank via GDI BitBlt yet valid — a "byte 0" image. Detect the
      // uniform frame and fall back to a screen crop of the window bounds, which
      // always shows what is actually on screen.
      if (windowId !== undefined && !showPointer) {
        const fallback = this.#rescueBlankWindowCapture(image, windowId, quality)
        if (fallback) {
          image = fallback
          notes.push('window capture was blank (GPU-composited window), fell back to a screen crop — mapping is approximate')
        }
      }
      if (showPointer) image = this.#pointer.annotateScreenshot(image)
      if (!image.base64) throw new Error('Screenshot capture missing image payload')
      if (grid) {
        const gridded = this.#applyGrid(image, grid, windowId)
        if (gridded) {
          image = gridded
          notes.push('grid labels are absolute screen pixels — read a number and use it directly')
        }
      }
      this.#lastCaptureScope = scope
      this.#lastHash = image.hash
      const payload = image.base64
      if (!payload) throw new Error('Screenshot capture missing image payload')
      this.#lastScreenshot = { mimeType: image.mimeType, data: payload, capturedAt: this.#now(), ...(windowId !== undefined || app ? { targetArgs: { ...(windowId !== undefined ? { target_window_id: windowId } : {}), ...(app ? { target_app: app } : {}) } } : {}) }
      const mapping = this.#describeCapture(image.width, image.height, windowId)
      this.#lastResult = {
        content: [
          { type: 'image', data: payload, mimeType: image.mimeType },
          { type: 'text', text: notes.length > 0 ? `${mapping}\n${notes.join('\n')}` : mapping },
        ],
      }
      return this.#lastResult
    }
    if (tool === 'zoom') {
      const region = args.region
      if (!Array.isArray(region) || region.length !== 4) {
        throw new Error('zoom requires region: [x1, y1, x2, y2]')
      }
      const [x1, y1, x2, y2] = region as [number, number, number, number]
      if (x1 >= x2 || y1 >= y2) {
        throw new Error(`Invalid region: x1(${x1}) must be < x2(${x2}), y1(${y1}) must be < y2(${y2})`)
      }
      const source = this.#native.takeScreenshot(undefined, undefined, 0, undefined, undefined)
      if (!source.base64) throw new Error('Screenshot capture failed')
      // A missing native export used to surface as `cropImage is not a function`, a
      // TypeError from JavaScript reaching for something that was never built for this
      // platform. It says nothing about which platform, why, or what to do — and it was
      // real: crop_image existed for macOS and Windows and not for Linux. Check for it,
      // and if it is absent say so in the shape every other capability gap uses.
      if (typeof this.#native.cropImage !== 'function') {
        return platformUnsupported(
          'zoom',
          'platforms whose native module provides cropImage',
          'Take a screenshot instead and crop it yourself; the reply states the mapping '
            + 'from image pixels to screen coordinates. If you built the native module '
            + 'locally, rebuild it — this export is missing rather than failing.',
        )
      }
      const cropped = this.#native.cropImage(
        source.base64, x1, y1, x2, y2, typeof args.quality === 'number' ? args.quality : 0,
      )
      return { content: [
        { type: 'image', data: cropped.base64, mimeType: cropped.mimeType },
        { type: 'text', text: `${cropped.width}x${cropped.height} (zoomed from ${source.width}x${source.height})` },
      ] }
    }
    return undefined
  }
}

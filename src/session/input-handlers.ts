import { execFileSync as defaultExecFileSync } from 'node:child_process'
import type { NativeModule } from '../native.js'
import { ok, type ToolResult } from '../result.js'
import type { FocusController } from './focus.js'
import type { TargetStateController } from './target-state.js'

type ExecFile = typeof defaultExecFileSync

const INPUT_TOOLS = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'mouse_drag', 'left_mouse_down', 'left_mouse_up',
  'cursor_position', 'scroll', 'type', 'key', 'hold_key',
  'read_clipboard', 'write_clipboard', 'multi_select', 'multi_edit',
])

/**
 * Does this look like text an agent meant to type, rather than a key combination?
 *
 * Deliberately conservative: a real combo is short, and its parts are key names.
 * Only these shapes are rejected, so no legitimate combo becomes unusable:
 *
 * - a URL or path, which no combo contains
 * - whitespace outside a `+` combo, i.e. more than one word
 * - a long single token, longer than any key name
 *
 * `command+l`, `return`, `shift+;`, `f11` and `ctrl+alt+delete` all pass.
 */
function looksLikeProse(combo: string): boolean {
  const trimmed = combo.trim()
  if (trimmed.includes('://') || trimmed.startsWith('/')) return true
  // Split on the combo separator first; a combo's parts are individual key names.
  const parts = trimmed.split('+').filter(part => part.length > 0)
  if (parts.some(part => /\s/.test(part.trim()) && part.trim().includes(' '))) return true
  // The longest key name in use is around a dozen characters ("page_down",
  // "volume_down"); a single token far past that is text, not a key.
  return parts.some(part => part.trim().length > 16)
}

/** Physical pointer, keyboard, clipboard, and batch-input execution. */
export class InputHandler {
  readonly #native: NativeModule
  readonly #targets: TargetStateController
  readonly #focus: FocusController
  readonly #platform: NodeJS.Platform
  readonly #sleep: (milliseconds: number) => Promise<void>
  readonly #execFile: ExecFile

  constructor(options: {
    native: NativeModule
    targets: TargetStateController
    focus: FocusController
    platform?: NodeJS.Platform
    sleep(milliseconds: number): Promise<void>
    execFile?: ExecFile
  }) {
    this.#native = options.native
    this.#targets = options.targets
    this.#focus = options.focus
    this.#platform = options.platform ?? process.platform
    this.#sleep = options.sleep
    this.#execFile = options.execFile ?? defaultExecFileSync
  }

  async handle(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult | undefined> {
    if (!INPUT_TOOLS.has(tool)) return undefined
    const coordinate = (key = 'coordinate'): [number, number] => {
      const value = args[key]
      if (!Array.isArray(value) || value.length < 2
        || typeof value[0] !== 'number' || typeof value[1] !== 'number') {
        throw new Error(`Invalid ${key}: expected [number, number]`)
      }
      return [value[0], value[1]]
    }
    const string = (key: string): string => {
      if (typeof args[key] !== 'string') throw new Error(`Invalid ${key}: expected string`)
      return args[key]
    }
    const number = (key: string, fallback: number): number =>
      typeof args[key] === 'number' ? args[key] : fallback
    const target = () => this.#targets.resolve(args)
    const focus = async (resolved: { bundleId?: string; windowId?: number }) => {
      await this.#focus.ensure(resolved, this.#focus.strategyFor(tool, args))
    }
    const humanize = args.humanize === true
    const moveTo = async (x: number, y: number, settleMs: number): Promise<void> => {
      if (humanize) await this.#humanMoveTo(x, y)
      else this.#native.mouseMove(x, y)
      await this.#sleep(settleMs)
    }

    const click = async (button: string, count: number): Promise<ToolResult> => {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      this.#validateCoordinates(x, y)
      await moveTo(x, y, humanize ? 60 : 50)
      this.#native.mouseClick(x, y, button, count)
      this.#targets.trackClick(resolved)
      return ok(`Clicked (${x}, ${y})`)
    }

    if (tool === 'left_click') return click('left', 1)
    if (tool === 'right_click') return click('right', 1)
    if (tool === 'middle_click') return click('middle', 1)
    if (tool === 'double_click') return click('left', 2)
    if (tool === 'triple_click') return click('left', 3)

    if (tool === 'mouse_move') {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      this.#validateCoordinates(x, y)
      if (humanize) await this.#humanMoveTo(x, y)
      else this.#native.mouseMove(x, y)
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Moved to (${x}, ${y})`)
    }

    if (tool === 'left_click_drag') {
      const resolved = target()
      await focus(resolved)
      const to = coordinate()
      const from = args.start_coordinate ? coordinate('start_coordinate') : to
      const path = Array.isArray(args.path) ? args.path as [number, number][] : [from, to]
      for (const [x, y] of path) this.#validateCoordinates(x, y)
      await moveTo(from[0], from[1], humanize ? 60 : 50)
      signal?.throwIfAborted()
      this.#native.mouseButton('press', from[0], from[1])
      try {
        for (const [x, y] of path.slice(1)) {
          signal?.throwIfAborted()
          this.#native.mouseDrag(x, y)
          if (humanize) await this.#sleep(10 + Math.random() * 18)
          else await this.#sleep(16)
        }
      } finally { this.#native.mouseButton('release', to[0], to[1]) }
      this.#targets.trackClick(resolved)
      return ok(`Dragged to (${to[0]}, ${to[1]})`)
    }

    if (tool === 'left_mouse_down' || tool === 'left_mouse_up') {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      if (tool === 'left_mouse_down') {
        // Every press starts with a move so hover states fire and the press
        // lands where the pointer visibly is. Release stays put so an earlier
        // down elsewhere can complete a drag.
        await moveTo(x, y, humanize ? 60 : 50)
      }
      this.#native.mouseButton(tool === 'left_mouse_down' ? 'press' : 'release', x, y)
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(tool === 'left_mouse_down' ? 'Mouse down' : 'Mouse up')
    }

    if (tool === 'cursor_position') {
      const position = this.#native.cursorPosition()
      return ok(`(${position.x}, ${position.y})`)
    }

    if (tool === 'scroll') {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      const direction = string('direction')
      const amount = number('amount', 3)
      await moveTo(x, y, humanize ? 40 : 15)
      const deltaX = typeof args.delta_x === 'number' ? args.delta_x : direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const deltaY = typeof args.delta_y === 'number' ? args.delta_y : direction === 'up' ? -amount : direction === 'down' ? amount : 0
      this.#native.mouseScroll(deltaY, deltaX)
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Scrolled ${direction} ${amount}`)
    }

    if (tool === 'type') {
      const resolved = target()
      await focus(resolved)
      const text = string('text')
      const caretPosition = typeof args.caret_position === 'string' ? args.caret_position : 'idle'
      if (caretPosition === 'start' || caretPosition === 'end') {
        this.#native.keyPress(caretPosition === 'start' ? 'home' : 'end')
        await this.#sleep(30)
      }
      if (args.clear === true || args.clear === 'true') {
        this.#native.keyPress(this.#platform === 'darwin' ? 'command+a' : 'ctrl+a')
        await this.#sleep(30)
        this.#native.keyPress('delete')
        await this.#sleep(30)
      }
      if (text.length > 100 || text.includes('\n')) await this.#pasteText(text)
      else if (humanize) await this.#humanTypeText(text)
      else this.#native.typeText(text)
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      if (args.press_enter === true || args.press_enter === 'true') {
        this.#native.keyPress('return')
        await this.#sleep(30)
      }
      return ok('Typed')
    }

    if (tool === 'key') {
      const combo = string('text')
      // `key` presses a key combination. An agent that wants to enter text often
      // reaches for it anyway and then spells the text out one keystroke at a
      // time, which is slow, wrong, and hard to diagnose from the native layer's
      // `Unknown key in combo`. Say which tool to use instead, before acting.
      const looksLikeText = looksLikeProse(combo)
      if (looksLikeText) {
        throw new Error(
          `key presses a key combination such as "command+l" or "return", not text. ` +
            `Received ${JSON.stringify(combo.length > 60 ? `${combo.slice(0, 60)}…` : combo)}. ` +
            `Use the type tool to enter text — it accepts press_enter to submit, and routes ` +
            `long or multi-line text through the clipboard.`,
        )
      }
      const resolved = target()
      await focus(resolved)
      const repeat = args.repeat !== undefined ? number('repeat', 1) : 1
      if (humanize && repeat > 1) {
        for (let i = 0; i < repeat; i++) {
          this.#native.keyPress(combo)
          await this.#sleep(40 + Math.random() * 90)
        }
      } else {
        this.#native.keyPress(combo, args.repeat !== undefined ? repeat : undefined)
      }
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      return ok(`Pressed ${args.text}`)
    }

    if (tool === 'hold_key') {
      const resolved = target()
      await focus(resolved)
      if (!Array.isArray(args.keys) || !args.keys.every(key => typeof key === 'string')) {
        throw new Error('Invalid keys: expected string[]')
      }
      this.#native.holdKey(args.keys, number('duration', 1) * 1000)
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      return ok('Held')
    }

    if (tool === 'read_clipboard') {
      if (this.#platform !== 'darwin' && this.#native.readClipboard) return ok(this.#native.readClipboard())
      return ok(this.#execFile('pbpaste', []).toString())
    }

    if (tool === 'write_clipboard') {
      const text = string('text')
      if (this.#platform !== 'darwin' && this.#native.writeClipboard) this.#native.writeClipboard(text)
      else this.#execFile('pbcopy', [], { input: text })
      return ok('Written')
    }

    if (tool === 'mouse_drag') {
      const resolved = target()
      await focus(resolved)
      const path = (Array.isArray(args.path) ? args.path : []) as [number, number][]
      if (path.length < 2) return this.#noCoordinates()
      const button = typeof args.button === 'string' ? args.button : 'left'
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers as string[] : []
      const steps = typeof args.steps === 'number' ? args.steps : 8
      if (!this.#native.mousePress || !this.#native.mouseDragTo || !this.#native.mouseRelease) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'native_capability_missing',
            capability: 'mousePress/mouseDragTo/mouseRelease',
            remediation: [
              'Button-aware drags need a native module built from this release; rebuild it (npm run build:native) or reinstall the package.',
              'For a plain left-button drag between two points, left_click_drag works with any version.',
            ],
          }) }],
          isError: true,
        }
      }
      for (const [x, y] of path) this.#validateCoordinates(x, y)

      const [startX, startY] = path[0]
      await moveTo(startX, startY, humanize ? 40 : 15)
      this.#native.mousePress(startX, startY, button, modifiers)
      try {
        // Interpolate: applications that integrate incremental motion — 3D
        // viewport orbit, canvas painting — ignore a single jump to the endpoint.
        for (let segment = 1; segment < path.length; segment++) {
          const [fromX, fromY] = path[segment - 1]
          const [toX, toY] = path[segment]
          for (let step = 1; step <= steps; step++) {
            this.#checkAbort(signal, 'mouse_drag aborted mid-gesture')
            const ratio = step / steps
            let px = Math.round(fromX + (toX - fromX) * ratio)
            let py = Math.round(fromY + (toY - fromY) * ratio)
            if (humanize && step < steps) {
              // Slight hand tremor, never on the exact endpoint.
              px += Math.round((Math.random() - 0.5) * 3)
              py += Math.round((Math.random() - 0.5) * 3)
            }
            this.#native.mouseDragTo(px, py, button, modifiers)
            if (humanize) await this.#sleep(6 + Math.random() * 12)
            else await this.#sleep(8)
          }
        }
      } finally {
        // Never leave a button or modifier stuck down, even on abort.
        const [endX, endY] = path[path.length - 1]
        this.#native.mouseRelease(endX, endY, button, modifiers)
      }
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Dragged ${button}${modifiers.length ? ' with ' + modifiers.join('+') : ''} through ${path.length} waypoints`)
    }

    if (tool === 'multi_select') {
      const resolved = target()
      await focus(resolved)
      const locations = Array.isArray(args.locs) ? [...args.locs] as [number, number][] : []
      if (Array.isArray(args.labels) && args.labels.length > 0 && resolved.windowId) {
        for (const label of args.labels as string[]) {
          const found = this.#resolveLabel(resolved.windowId, label)
          if (found) locations.push(found)
        }
      }
      if (locations.length === 0) return this.#noCoordinates()
      // press_ctrl advertises default true, so additive is the documented behavior.
      // The modifier has to be held across the click, which only the native
      // additive entry point does — tapping it separately selects nothing.
      const additive = args.press_ctrl !== false
      if (additive && !this.#native.mouseClickAdditive) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'native_capability_missing',
            capability: 'mouseClickAdditive',
            remediation: [
              'Additive selection needs a native module built from this release; rebuild it (npm run build:native) or reinstall the package.',
              'Pass press_ctrl=false to replace the selection instead of extending it.',
            ],
          }) }],
          isError: true,
        }
      }
      for (const [x, y] of locations) {
        this.#checkAbort(signal, 'multi_select aborted before the next selection')
        await moveTo(x, y, humanize ? 60 : 50)
        this.#checkAbort(signal, 'multi_select aborted before click')
        if (additive) this.#native.mouseClickAdditive!(x, y, 'left', 1)
        else this.#native.mouseClick(x, y, 'left', 1)
        await this.#sleep(humanize ? 30 + Math.random() * 60 : 30)
      }
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Selected ${locations.length} elements`)
    }

    const resolved = target()
    await focus(resolved)
    const edits = Array.isArray(args.locs) ? [...args.locs] as [number, number, string][] : []
    if (Array.isArray(args.labels) && args.labels.length > 0 && resolved.windowId) {
      for (const [label, text] of args.labels as [string, string][]) {
        const found = this.#resolveLabel(resolved.windowId, label)
        if (found) edits.push([found[0], found[1], text])
      }
    }
    if (edits.length === 0) return this.#noCoordinates()
    for (const [x, y, text] of edits) {
      this.#checkAbort(signal, 'multi_edit aborted before the next edit')
      await moveTo(x, y, humanize ? 60 : 50)
      this.#checkAbort(signal, 'multi_edit aborted before click')
      this.#native.mouseClick(x, y, 'left', 1)
      await this.#sleep(50)
      this.#checkAbort(signal, 'multi_edit aborted before typing')
      if (humanize && text.length <= 100 && !text.includes('\n')) await this.#humanTypeText(text)
      else this.#native.typeText(text)
      await this.#sleep(30)
    }
    if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
    return ok(`Edited ${edits.length} fields`)
  }

  /**
   * Human-like pointer motion: quadratic Bezier from the live cursor position
   * with a random perpendicular bow, ease-out pacing, and an exact endpoint.
   * Straight instant jumps are the classic synthetic-input tell.
   */
  async #humanMoveTo(x: number, y: number): Promise<void> {
    let fromX = x
    let fromY = y
    try {
      const pos = this.#native.cursorPosition()
      fromX = pos.x
      fromY = pos.y
    } catch { /* fall through: jump straight */ }
    const dx = x - fromX
    const dy = y - fromY
    const dist = Math.hypot(dx, dy)
    if (dist < 3) {
      this.#native.mouseMove(x, y)
      return
    }
    // Brief reaction delay before moving.
    await this.#sleep(20 + Math.random() * 50)
    const len = Math.max(1, dist)
    const bow = (0.1 + Math.random() * 0.2) * Math.min(dist * 0.5, 140) * (Math.random() < 0.5 ? -1 : 1)
    const cx = (fromX + x) / 2 + (-dy / len) * bow
    const cy = (fromY + y) / 2 + (dx / len) * bow
    const steps = Math.max(6, Math.min(40, Math.round(dist / 14)))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const e = 1 - Math.pow(1 - t, 2) // ease-out: fast start, gentle landing
      const px = Math.round((1 - e) * (1 - e) * fromX + 2 * (1 - e) * e * cx + e * e * x)
      const py = Math.round((1 - e) * (1 - e) * fromY + 2 * (1 - e) * e * cy + e * e * y)
      this.#native.mouseMove(px, py)
      await this.#sleep(4 + Math.random() * 10)
    }
    this.#native.mouseMove(x, y) // exact endpoint, never left to rounding
  }

  /**
   * Human-like typing rhythm: per-character delivery with jittered intervals
   * and an occasional thinking pause. Long/pasted text stays on the fast path.
   */
  async #humanTypeText(text: string): Promise<void> {
    for (let i = 0; i < text.length; i++) {
      this.#native.typeText(text[i])
      if (Math.random() < 0.04) await this.#sleep(150 + Math.random() * 200)
      else await this.#sleep(25 + Math.random() * 55)
    }
  }

  #validateCoordinates(x: number, y: number): void {
    const available = this.#native.listDisplays?.()
    const displays = available?.length ? available : [this.#native.getDisplaySize()]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !displays.some(display => {
      const originX = display.x ?? 0, originY = display.y ?? 0
      return x >= originX && y >= originY && x < originX + display.width && y < originY + display.height
    })) throw new Error(`Coordinates (${x}, ${y}) are outside display bounds`)

  }

  async #pasteText(text: string): Promise<void> {
    if (this.#platform !== 'darwin' && this.#native.readClipboard && this.#native.writeClipboard) {
      let saved: string | undefined
      try { saved = this.#native.readClipboard() } catch { /* best effort */ }
      try {
        this.#native.writeClipboard(text)
        this.#native.keyPress('ctrl+v')
        await this.#sleep(100)
      } finally {
        if (typeof saved === 'string') {
          // Preserve a new clipboard value copied by the user while paste settled.
          try { if (this.#native.readClipboard() === text) this.#native.writeClipboard(saved) } catch { /* best effort */ }
        }
      }
      return
    }
    let saved: string | undefined
    try { saved = this.#execFile('pbpaste', []).toString() } catch { /* best effort */ }
    try {
      this.#execFile('pbcopy', [], { input: text })
      const verified = this.#execFile('pbpaste', []).toString()
      if (verified === text) {
        this.#native.keyPress('command+v')
        await this.#sleep(100)
      } else this.#native.typeText(text)
    } finally {
      if (typeof saved === 'string') {
        try {
          if (this.#execFile('pbpaste', []).toString() === text) this.#execFile('pbcopy', [], { input: saved })
        } catch { /* best effort */ }
      }
    }
  }

  #resolveLabel(windowId: number, label: string): [number, number] | undefined {
    try {
      const elements = this.#native.findElement(windowId, undefined, label, undefined, 1)
      const values = Array.isArray(elements) ? elements : JSON.parse(JSON.stringify(elements))
      const bounds = values[0]?.bounds
      return bounds
        ? [Math.round(bounds.x + bounds.width / 2), Math.round(bounds.y + bounds.height / 2)]
        : undefined
    } catch { return undefined }
  }

  #checkAbort(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted) throw new Error(message)
  }

  #noCoordinates(): ToolResult {
    return {
      content: [{ type: 'text', text: 'No coordinates resolved. Provide locs or valid labels.' }],
      isError: true,
    }
  }
}

/**
 * Copy / cut / paste. Objects travel as JSON in the system clipboard under the custom flavour
 * `application/x-doory+json` (and as text/plain, so pasting into another tab or design works even where
 * custom flavours are unavailable). Pasted images are uploaded; pasted plain text becomes a text box.
 */
import type { EditorEngine } from '../editor'
import { CLIPBOARD_MIME, type ClipboardPayload, decodeClipboard, encodeClipboard } from '../clipboardFormat'
import { imageFilesFrom } from '../files'
import { isLocked } from '../objects/dory'
import { createTextbox } from '../objects/factories'
import { serializeObject } from '../serialization'
import { t } from '../../strings'
import { DUPLICATE_OFFSET } from './arrange'


export class ClipboardApi {
  private internal: ClipboardPayload | null = null
  private pasteCount = 0

  constructor(private readonly engine: EditorEngine) {}

  /** JSON for the current selection, or null when nothing is selected. */
  private payload(): ClipboardPayload | null {
    const view = this.engine.activeView()
    if (!view) return null
    const selected = view.selectedObjects()
    // A locked object is never copied: a pasted twin would be a movable copy of something the author froze
    // (duplicating skips locked objects too).
    const objs = selected.filter((o) => !isLocked(o))
    if (objs.length === 0) return null
    const page = this.engine.pageSizeOf(this.engine.state.activePageId)
    // Realise group-selection transforms so coordinates are page-absolute.
    const docs = view.quietly(() => {
      view.canvas.discardActiveObject()
      const out = objs.map((o) => serializeObject(o))
      view.selectObjects(selected)
      return out
    })
    return { kind: 'doory-clipboard/v1', objects: docs, page }
  }

  /** Handler for the DOM `copy` / `cut` event: writes both flavours. Returns true when it handled the event. */
  writeTo(data: DataTransfer): boolean {
    const p = this.payload()
    if (!p) return false
    const json = encodeClipboard(p.objects, p.page)
    data.setData(CLIPBOARD_MIME, json)
    data.setData('text/plain', json)
    this.internal = p
    this.pasteCount = 0
    return true
  }

  async copy(): Promise<void> {
    const p = this.payload()
    if (!p) return
    this.internal = p
    this.pasteCount = 0
    const json = encodeClipboard(p.objects, p.page)
    try {
      await navigator.clipboard.writeText(json)
    } catch {
      /* clipboard permission denied: the in-memory copy still supports paste in this editor */
    }
  }

  async cut(): Promise<void> {
    await this.copy()
    this.engine.arrange.delete()
  }

  /** Handler for the DOM `paste` event. Returns true when something was pasted. */
  async pasteFrom(data: DataTransfer | null): Promise<boolean> {
    if (!data || this.engine.readOnly) return false
    const files = imageFilesFrom(data)
    if (files.length > 0) {
      await this.engine.insert.imageFiles(files)
      return true
    }
    const raw = data.getData(CLIPBOARD_MIME) || data.getData('text/plain')
    const decoded = raw ? decodeClipboard(raw) : null
    if (decoded) {
      await this.placeObjects(decoded)
      return true
    }
    const text = data.getData('text/plain').trim()
    if (text) {
      await this.pasteText(text)
      return true
    }
    return this.pasteInternal()
  }

  /** Menu / shortcut paste without a clipboard event: system clipboard first, then the in-memory copy. */
  async paste(): Promise<void> {
    if (this.engine.readOnly) return
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((ty) => ty.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          await this.engine.insert.imageFiles([new File([blob], 'pasted-image', { type: imageType })])
          return
        }
      }
    } catch {
      /* no permission / unsupported: fall through to text */
    }
    try {
      const text = await navigator.clipboard.readText()
      const decoded = decodeClipboard(text)
      if (decoded) return await this.placeObjects(decoded)
      if (text.trim()) return await this.pasteText(text.trim())
    } catch {
      /* ignore */
    }
    if (!(await this.pasteInternal())) this.engine.toast(t.errors.paste, 'error')
  }

  private async pasteInternal(): Promise<boolean> {
    if (!this.internal) return false
    await this.placeObjects(this.internal)
    return true
  }

  private async placeObjects(payload: ClipboardPayload): Promise<void> {
    const page = this.engine.pageSizeOf(this.engine.state.activePageId)
    const samePage = Math.abs(payload.page.width - page.width) < 1 && Math.abs(payload.page.height - page.height) < 1
    this.pasteCount += 1
    if (samePage) await this.engine.insert.objects(payload.objects, t.history.paste, { offset: DUPLICATE_OFFSET * this.pasteCount })
    else await this.engine.insert.objects(payload.objects, t.history.paste, { recenterOn: page })
  }

  private async pasteText(text: string): Promise<void> {
    const page = this.engine.pageSizeOf(this.engine.state.activePageId)
    const clipped = text.slice(0, 5000)
    const obj = createTextbox(page, { x: page.width / 2, y: page.height / 2 }, { text: clipped, preset: 'body', textAlign: 'left' })
    await this.engine.insert.add([obj], t.history.pasteText)
  }
}

/**
 * `MediaRecorder` in Chromium writes a WebM whose header has no duration (the length is not known while recording), so a
 * player shows an endless video and cannot seek. This puts the duration into the file's Info element. It reads and
 * rewrites only the head of the file (the clusters after it are not touched or loaded again), and leaves a file alone
 * when it cannot do that safely: it already has a duration, or an index (SeekHead) whose offsets the change would shift.
 */

const ID = { segment: 0x18538067, info: 0x1549a966, timecodeScale: 0x2ad7b1, duration: 0x4489, seekHead: 0x114d9b74, cluster: 0x1f43b675 } as const
/** How much of the head is read: the header of a recording is a few hundred bytes. */
const HEAD_BYTES = 64 * 1024

interface Vint {
  /** The value, `null` for the "unknown size" marker. */
  value: number | null
  length: number
}

/** An element ID keeps its length-marker bits. */
function readId(bytes: Uint8Array, at: number): Vint | null {
  const first = bytes[at]
  if (first === undefined || first === 0) return null
  const length = Math.clz32(first) - 23
  if (length > 4 || at + length > bytes.length) return null
  let value = 0
  for (let i = 0; i < length; i++) value = value * 256 + bytes[at + i]
  return { value, length }
}

/** An element size drops its marker bit; all ones means the size is not known. */
function readSize(bytes: Uint8Array, at: number): Vint | null {
  const first = bytes[at]
  if (first === undefined || first === 0) return null
  const length = Math.clz32(first) - 23
  if (at + length > bytes.length) return null
  let value = first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i]
    allOnes &&= bytes[at + i] === 0xff
  }
  return { value: allOnes ? null : value, length }
}

function writeSize(value: number, minLength: number): Uint8Array {
  let length = minLength
  while (value >= 2 ** (7 * length) - 1) length++
  const out = new Uint8Array(length)
  let rest = value
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256
    rest = Math.floor(rest / 256)
  }
  out[0] |= 0x80 >> (length - 1)
  return out
}

/** The element `Duration` (8-byte float) for `ms` at the file's timecode scale. */
function durationElement(ms: number, timecodeScale: number): Uint8Array {
  const out = new Uint8Array(11)
  out.set([0x44, 0x89, 0x88])
  new DataView(out.buffer).setFloat64(3, (ms * 1_000_000) / timecodeScale)
  return out
}

/**
 * The head of a WebM with a Duration of `durationMs` in its Info, or `null` when it should be left as it is. `end` is
 * how many bytes of `head` the new head replaces (everything after goes on unchanged).
 */
export function withDuration(head: Uint8Array, durationMs: number): { bytes: Uint8Array; end: number } | null {
  // The EBML header, then the Segment.
  const ebmlId = readId(head, 0)
  const ebmlSize = ebmlId ? readSize(head, ebmlId.length) : null
  if (!ebmlId || !ebmlSize || ebmlSize.value === null || ebmlId.value !== 0x1a45dfa3) return null
  let at = ebmlId.length + ebmlSize.length + ebmlSize.value
  const segmentId = readId(head, at)
  if (!segmentId || segmentId.value !== ID.segment) return null
  const segmentSize = readSize(head, at + segmentId.length)
  if (!segmentSize) return null
  const segmentSizeAt = at + segmentId.length
  at = segmentSizeAt + segmentSize.length
  // Children of the Segment, until the Info is found or the media starts.
  while (at < head.length) {
    const id = readId(head, at)
    const size = id ? readSize(head, at + id.length) : null
    if (!id || !size || size.value === null) return null
    if (id.value === ID.seekHead || id.value === ID.cluster) return null
    const bodyAt = at + id.length + size.length
    if (id.value === ID.info) {
      const end = bodyAt + size.value
      if (end > head.length) return null
      let timecodeScale = 1_000_000
      for (let child = bodyAt; child < end; ) {
        const childId = readId(head, child)
        const childSize = childId ? readSize(head, child + childId.length) : null
        if (!childId || !childSize || childSize.value === null) return null
        if (childId.value === ID.duration) return null
        if (childId.value === ID.timecodeScale) {
          let scale = 0
          for (let i = 0; i < childSize.value; i++) scale = scale * 256 + head[child + childId.length + childSize.length + i]
          if (scale > 0) timecodeScale = scale
        }
        child += childId.length + childSize.length + childSize.value
      }
      const added = durationElement(durationMs, timecodeScale)
      const newSize = writeSize(size.value + added.length, size.length)
      const parts: Uint8Array[] = []
      if (segmentSize.value === null) parts.push(head.subarray(0, at))
      else {
        // A Segment whose size is known grows by what the Info grew.
        let patched = writeSize(segmentSize.value + newSize.length - size.length + added.length, segmentSize.length)
        patched = writeSize(segmentSize.value + newSize.length - size.length + added.length + (patched.length - segmentSize.length), segmentSize.length)
        parts.push(head.subarray(0, segmentSizeAt), patched, head.subarray(segmentSizeAt + segmentSize.length, at))
      }
      parts.push(head.subarray(at, at + id.length), newSize, head.subarray(bodyAt, end), added)
      const total = parts.reduce((sum, part) => sum + part.length, 0)
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const part of parts) {
        bytes.set(part, offset)
        offset += part.length
      }
      return { bytes, end }
    }
    at = bodyAt + size.value
  }
  return null
}

/** `blob` with a duration in its header, or `blob` itself when it already has one or cannot be patched. */
export async function patchWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!(durationMs > 0)) return blob
  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer())
  const patched = withDuration(head, durationMs)
  if (!patched) return blob
  return new Blob([patched.bytes as Uint8Array<ArrayBuffer>, blob.slice(patched.end)], { type: blob.type })
}

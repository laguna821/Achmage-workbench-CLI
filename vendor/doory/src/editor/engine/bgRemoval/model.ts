/**
 * The description of a segmentation model, as `GET /api/v1/config/` delivers it under
 * `assets.background_removal_model`. The server is trusted no more than any other input: the
 * URL must stay on this page's origin (the production CSP only allows `'self'` anyway), sizes are bounded and
 * a malformed description disables the feature instead of reaching the model runtime.
 */
export type Rescale = 'max' | '255'

export interface ModelInput {
  /** Name of the model's input tensor. */
  name: string
  /** The model takes a `size` x `size` image. */
  size: number
  mean: readonly [number, number, number]
  std: readonly [number, number, number]
  /** `max`: divide by the largest value of the resized image (U²-Net); `255`: divide by 255. */
  rescale: Rescale
}

export interface ModelDescriptor {
  id: string
  name: string
  /** Absolute URL on the page's origin. */
  url: string
  bytes: number
  /** Lower-case hex SHA-256 of the file; the downloaded bytes must match it. */
  sha256: string
  input: ModelInput
  /** Name of the output tensor holding the foreground probability (`1 x 1 x size x size`). */
  output: string
}

export const MAX_MODEL_BYTES = 512 * 1024 * 1024
const MIN_INPUT_SIZE = 64
const MAX_INPUT_SIZE = 2048
const NAME = /^[A-Za-z0-9_.:-]{1,64}$/
const SHA256 = /^[0-9a-f]{64}$/

type Raw = Record<string, unknown>

function record(value: unknown): Raw | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : null
}

function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function triple(value: unknown, ok: (n: number) => boolean): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const numbers = value as unknown[]
  if (!numbers.every((n): n is number => typeof n === 'number' && Number.isFinite(n) && ok(n))) return null
  return [numbers[0] as number, numbers[1] as number, numbers[2] as number]
}

function sameOriginUrl(raw: unknown, origin: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null
  try {
    const url = new URL(raw, origin)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== new URL(origin).origin) return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/** The usable description, or `null` for anything missing, malformed or pointing off-origin. */
export function parseModelDescriptor(
  raw: unknown,
  origin: string = typeof location === 'undefined' ? 'http://localhost' : location.origin,
): ModelDescriptor | null {
  const body = record(raw)
  const input = record(body?.input)
  if (!body || !input) return null
  const id = text(body.id, 64)
  const name = text(body.name)
  const url = sameOriginUrl(body.url, origin)
  const sha256 = typeof body.sha256 === 'string' && SHA256.test(body.sha256) ? body.sha256 : null
  const bytes = body.bytes
  const output = typeof body.output === 'string' && NAME.test(body.output) ? body.output : null
  const inputName = typeof input.name === 'string' && NAME.test(input.name) ? input.name : null
  const size = input.size
  const mean = triple(input.mean, (n) => n >= 0 && n <= 1)
  const std = triple(input.std, (n) => n > 0 && n <= 10)
  const rescale = input.rescale
  if (!id || !name || !url || !sha256 || !output || !inputName || !mean || !std) return null
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_MODEL_BYTES) return null
  if (typeof size !== 'number' || !Number.isInteger(size) || size < MIN_INPUT_SIZE || size > MAX_INPUT_SIZE) return null
  if (rescale !== 'max' && rescale !== '255') return null
  return { id, name, url, bytes, sha256, input: { name: inputName, size, mean, std, rescale }, output }
}

/** Two descriptors that need the same download and the same runtime configuration. */
export function sameModel(a: ModelDescriptor, b: ModelDescriptor): boolean {
  return a.id === b.id && a.url === b.url && a.sha256 === b.sha256
}

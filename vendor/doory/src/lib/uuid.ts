/**
 * A random version-4 UUID.
 *
 * `crypto.randomUUID` exists only in secure contexts (https and localhost). Somebody who opens a self-hosted site
 * through a plain-http address such as `http://192.168.1.20:8080` has no such function, and every new page, object
 * and track would fail. `crypto.getRandomValues` works everywhere, so it is the fallback.
 */
export function uuid(): string {
  const c = globalThis.crypto
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

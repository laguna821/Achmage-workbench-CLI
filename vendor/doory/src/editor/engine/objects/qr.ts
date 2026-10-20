import type { QrSpec } from './dory'

export const DEFAULT_QR: QrSpec = { text: 'https://doory.example', fg: '#000000', bg: '#ffffff' }
const MAX_QR_TEXT = 1000

export function sanitizeQrText(text: string): string {
  return text.slice(0, MAX_QR_TEXT)
}

/** Renders a QR code as an SVG data URL (vector: crisp at any size, a few KB). The library loads lazily. */
export async function qrDataUrl(spec: QrSpec): Promise<string> {
  const QRCode = (await import('qrcode')).default
  const svg = await QRCode.toString(sanitizeQrText(spec.text) || ' ', {
    type: 'svg',
    margin: 1,
    width: 512,
    errorCorrectionLevel: 'M',
    color: { dark: spec.fg, light: spec.bg },
  })
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

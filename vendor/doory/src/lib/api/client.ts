/**
 * The single HTTP seam of the app: same-origin JSON over fetch with session cookies and CSRF.
 * Every failure surfaces as an `ApiError` so UI code never inspects raw Responses.
 */
export const API_BASE = '/api/v1'

export type QueryValue = string | number | boolean | null | undefined

export interface ApiErrorInit {
  status: number
  code: string
  message: string
  fields?: Record<string, string[] | string>
  fieldCodes?: Record<string, string[] | string>
  /** Seconds the server asks the client to wait (429). */
  retryAfter?: number
  data?: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Field-level validation messages, always normalised to string arrays. */
  readonly fields: Record<string, string[]>
  /** Machine-readable codes per field, normalised to string arrays. */
  readonly fieldCodes: Record<string, string[]>
  /** Seconds to wait before retrying, when the server said so (429). */
  readonly retryAfter: number | null
  /** The parsed error body (e.g. `{current}` on a revision conflict). */
  readonly data: unknown

  constructor({ status, code, message, fields, fieldCodes, retryAfter, data }: ApiErrorInit) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
    const normalise = (input: Record<string, string[] | string> | undefined): Record<string, string[]> =>
      Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value : [value]]))
    this.fields = normalise(fields)
    this.fieldCodes = normalise(fieldCodes)
    this.retryAfter = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null
  }

  get isNetwork(): boolean {
    return this.code === 'network_error'
  }
  get isUnauthorized(): boolean {
    return this.status === 401
  }
  get isNotFound(): boolean {
    return this.status === 404
  }
  get isConflict(): boolean {
    return this.status === 409
  }
  get isRateLimited(): boolean {
    return this.status === 429
  }

  /** First message for a field, if any. */
  fieldError(name: string): string | undefined {
    return this.fields[name]?.[0]
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** Builds `?a=1&b=true`, skipping empty values. */
export function buildQuery(params: Record<string, QueryValue> | object | undefined): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params as Record<string, QueryValue>)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export interface RequestOptions {
  query?: Record<string, QueryValue> | object
  json?: unknown
  form?: FormData
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Upload progress (0..1); switches the transport to XMLHttpRequest. */
  onUploadProgress?: (fraction: number) => void
  /** Do not notify the 401 handler (e.g. for the login form itself). */
  silentUnauthorized?: boolean
  /** Overrides the Accept header (binary endpoints). */
  accept?: string
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const SAFE_METHODS: ReadonlySet<Method> = new Set<Method>(['GET'])

const NETWORK_MESSAGE = "We couldn't reach Doory. Check your connection and try again."

let unauthorizedHandler: (() => void) | null = null

/** Registers the callback run whenever the API answers 401 (session expired). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

let csrfRequest: Promise<void> | null = null

/** Fetches the CSRF cookie once when it is missing (or when `force` is set). */
export async function ensureCsrf(force = false): Promise<void> {
  if (!force && readCookie('csrftoken')) return
  csrfRequest ??= fetch(`${API_BASE}/auth/csrf/`, { credentials: 'include' })
    .then(() => undefined)
    .catch(() => {
      throw new ApiError({ status: 0, code: 'network_error', message: NETWORK_MESSAGE })
    })
    .finally(() => {
      csrfRequest = null
    })
  await csrfRequest
}

function xhrFetch(url: string, init: { method: Method; headers: Headers; body: FormData; signal?: AbortSignal }, onProgress: (fraction: number) => void): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(init.method, url)
    xhr.withCredentials = true
    xhr.responseType = 'arraybuffer'
    init.headers.forEach((value, key) => xhr.setRequestHeader(key, value))
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    xhr.upload.onload = () => onProgress(1)
    xhr.onload = () => {
      const headers = new Headers()
      const contentType = xhr.getResponseHeader('content-type')
      if (contentType) headers.set('content-type', contentType)
      const retryAfter = xhr.getResponseHeader('retry-after')
      if (retryAfter) headers.set('retry-after', retryAfter)
      const noBody = xhr.status === 204 || xhr.status === 205 || xhr.status === 304
      resolve(new Response(noBody ? null : (xhr.response as ArrayBuffer), { status: xhr.status, headers }))
    }
    xhr.onerror = () => reject(new TypeError('Network request failed'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    init.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    if (init.signal?.aborted) {
      xhr.abort()
      return
    }
    xhr.send(init.body)
  })
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown
  const type = response.headers.get('content-type') ?? ''
  try {
    body = type.includes('json') ? await response.json() : undefined
  } catch {
    body = undefined
  }
  const envelope = (body as { error?: { code?: unknown; message?: unknown; fields?: unknown; field_codes?: unknown; retry_after?: unknown } } | undefined)?.error
  const headerRetry = Number.parseFloat(response.headers.get('retry-after') ?? '')
  if (envelope && typeof envelope === 'object') {
    return new ApiError({
      status: response.status,
      code: typeof envelope.code === 'string' ? envelope.code : `http_${response.status}`,
      message: typeof envelope.message === 'string' ? envelope.message : 'Something went wrong.',
      fields: envelope.fields && typeof envelope.fields === 'object' ? (envelope.fields as Record<string, string[] | string>) : undefined,
      fieldCodes: envelope.field_codes && typeof envelope.field_codes === 'object' ? (envelope.field_codes as Record<string, string[] | string>) : undefined,
      retryAfter: typeof envelope.retry_after === 'number' ? envelope.retry_after : headerRetry,
      data: body,
    })
  }
  const message = response.status >= 500 ? 'Doory had a problem on its side. Please try again in a moment.' : 'The request could not be completed.'
  return new ApiError({ status: response.status, code: response.status >= 500 ? 'server_error' : `http_${response.status}`, message, retryAfter: headerRetry, data: body })
}

async function send(method: Method, path: string, options: RequestOptions, retriedCsrf = false): Promise<Response> {
  const headers = new Headers(options.headers)
  headers.set('Accept', options.accept ?? 'application/json')
  let body: BodyInit | undefined
  if (options.form) body = options.form
  else if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.json)
  }
  if (!SAFE_METHODS.has(method)) {
    await ensureCsrf()
    const token = readCookie('csrftoken')
    if (token) headers.set('X-CSRFToken', token)
  }
  const url = `${API_BASE}${path}${buildQuery(options.query)}`
  let response: Response
  try {
    if (options.onUploadProgress && options.form) {
      response = await xhrFetch(url, { method, headers, body: options.form, signal: options.signal }, options.onUploadProgress)
    } else {
      response = await fetch(url, { method, headers, body, credentials: 'include', signal: options.signal })
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError({ status: 0, code: 'network_error', message: NETWORK_MESSAGE })
  }
  if (response.ok) return response
  const error = await toApiError(response)
  if (error.status === 403 && !SAFE_METHODS.has(method) && !retriedCsrf && (error.code === 'csrf_failed' || /csrf/i.test(error.message))) {
    await ensureCsrf(true)
    return send(method, path, options, true)
  }
  if (error.status === 401 && !options.silentUnauthorized) unauthorizedHandler?.()
  throw error
}

async function parse<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.status === 205) return undefined as T
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('json')) return undefined as T
  return (await response.json()) as T
}

export const http = {
  get: async <T>(path: string, options: RequestOptions = {}): Promise<T> => parse<T>(await send('GET', path, options)),
  post: async <T>(path: string, options: RequestOptions = {}): Promise<T> => parse<T>(await send('POST', path, options)),
  put: async <T>(path: string, options: RequestOptions = {}): Promise<T> => parse<T>(await send('PUT', path, options)),
  patch: async <T>(path: string, options: RequestOptions = {}): Promise<T> => parse<T>(await send('PATCH', path, options)),
  delete: async <T = void>(path: string, options: RequestOptions = {}): Promise<T> => parse<T>(await send('DELETE', path, options)),
  /** POST that returns binary content (e.g. a PDF). */
  postForBlob: async (path: string, options: RequestOptions = {}): Promise<Blob> => (await send('POST', path, { ...options, accept: '*/*' })).blob(),
}

/** Test helper: forget cached CSRF/handler state. */
export function resetClientState(): void {
  csrfRequest = null
  unauthorizedHandler = null
}

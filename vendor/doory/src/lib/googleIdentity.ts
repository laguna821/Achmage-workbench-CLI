/** Lazy loader + minimal typings for Google Identity Services (only used when a client id is configured). */
export interface GoogleCredentialResponse {
  credential: string
}

export interface GoogleButtonOptions {
  type?: 'standard' | 'icon'
  theme?: 'outline' | 'filled_blue' | 'filled_black'
  size?: 'large' | 'medium' | 'small'
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin'
  shape?: 'rectangular' | 'pill'
  width?: number
  logo_alignment?: 'left' | 'center'
}

export interface GoogleIdApi {
  initialize(config: { client_id: string; callback: (response: GoogleCredentialResponse) => void; auto_select?: boolean; cancel_on_tap_outside?: boolean }): void
  renderButton(parent: HTMLElement, options: GoogleButtonOptions): void
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdApi } }
  }
}

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client'
let loading: Promise<GoogleIdApi> | null = null

export function loadGoogleIdentity(): Promise<GoogleIdApi> {
  if (window.google?.accounts.id) return Promise.resolve(window.google.accounts.id)
  loading ??= new Promise<GoogleIdApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => {
      const api = window.google?.accounts.id
      if (api) resolve(api)
      else reject(new Error('Google Identity Services did not initialise'))
    }
    script.onerror = () => reject(new Error('Google Identity Services failed to load'))
    document.head.appendChild(script)
  }).catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

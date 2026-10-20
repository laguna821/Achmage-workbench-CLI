/**
 * Test-only seam for the Playwright specs: lets a spec trigger shell actions that the real editor UI would
 * normally trigger (e.g. the guest "Sign up" button in the editor top bar). It is compiled out unless the
 * dev server runs with VITE_E2E=true, so it never ships in production builds.
 */
type Hook = () => unknown

interface E2eWindow {
  __doory_e2e?: Record<string, Hook>
}

export function registerE2eHook(name: string, hook: Hook): () => void {
  if (import.meta.env.VITE_E2E !== 'true') return () => undefined
  const target = window as unknown as E2eWindow
  target.__doory_e2e = { ...target.__doory_e2e, [name]: hook }
  return () => {
    if (target.__doory_e2e) delete target.__doory_e2e[name]
  }
}

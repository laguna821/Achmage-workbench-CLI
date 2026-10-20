/**
 * Tracks open modal overlays so everything beneath the topmost one is inert
 * (not focusable, hidden from assistive tech) and the page behind cannot scroll.
 */
const stack: HTMLElement[] = []
let lockedScrollbar = ''
let lockedOverflow = ''

function sync(): void {
  const root = document.getElementById('root')
  if (root) {
    if (stack.length > 0) root.setAttribute('inert', '')
    else root.removeAttribute('inert')
  }
  stack.forEach((el, index) => {
    if (index === stack.length - 1) el.removeAttribute('inert')
    else el.setAttribute('inert', '')
  })
}

export function pushModal(overlay: HTMLElement): () => void {
  if (stack.length === 0) {
    const body = document.body
    lockedOverflow = body.style.overflow
    lockedScrollbar = body.style.paddingRight
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    body.style.overflow = 'hidden'
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`
  }
  stack.push(overlay)
  sync()
  return () => {
    const index = stack.indexOf(overlay)
    if (index >= 0) stack.splice(index, 1)
    overlay.removeAttribute('inert')
    if (stack.length === 0) {
      document.body.style.overflow = lockedOverflow
      document.body.style.paddingRight = lockedScrollbar
    }
    sync()
  }
}

export function isTopModal(overlay: HTMLElement): boolean {
  return stack[stack.length - 1] === overlay
}

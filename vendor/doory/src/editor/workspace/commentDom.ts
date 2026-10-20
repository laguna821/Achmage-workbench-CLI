/** Finding a pin in the page by the id of its thread. */
export const pinSelector = (id: string): string => `[data-comment-pin="${id.replace(/["\\]/g, '\\$&')}"]`

export function focusPin(id: string): void {
  document.querySelector<HTMLElement>(pinSelector(id))?.focus({ preventScroll: true })
}

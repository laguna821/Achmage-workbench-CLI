// "내비게이터로" (⋯ › 단축키, Ctrl+Shift+E by default): the focus goes to the navigator's list (or the
// tree). The sidebar may not be there yet when asked (it was hidden), so the request waits for it.

let wanted = false;
const listeners = new Set<() => void>();

export function requestNavigatorFocus() {
  wanted = true;
  for (const listener of listeners) listener();
}

/** The sidebar takes a waiting request (true once, then the request is gone). */
export function takeNavigatorFocus(): boolean {
  const was = wanted;
  wanted = false;
  return was;
}

export function onNavigatorFocus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

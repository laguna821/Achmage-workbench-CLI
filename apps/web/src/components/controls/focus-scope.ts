/** A temporary surface may scroll a reading pane while focusing its own preview. */
export function captureSurfaceFocus() {
  const opener = document.activeElement;
  const scrolls = new Set<HTMLElement>();
  for (let node = opener instanceof HTMLElement ? opener : null; node; node = node.parentElement) scrolls.add(node);
  document.querySelectorAll<HTMLElement>(".pane .transcript, .pane .doc-content, .pane .vault-note, .pane .projects-mode").forEach(node => scrolls.add(node));
  const positions = [...scrolls].map(node => {
    const top = node.scrollTop, left = node.scrollLeft;
    const box = node.getBoundingClientRect();
    const anchor = [...node.querySelectorAll<HTMLElement>(":scope > .transcript-inner > [data-reading-id]")].find(item => item.getBoundingClientRect().bottom > box.top);
    return { node, top, left, anchor, offset: anchor ? anchor.getBoundingClientRect().top - box.top : 0 };
  });
  const field = opener instanceof HTMLInputElement || opener instanceof HTMLTextAreaElement ? opener : null;
  const caret = field?.selectionStart !== null && field?.selectionStart !== undefined ? { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection } : null;
  return () => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    if (field?.isConnected && caret) field.setSelectionRange(caret.start, caret.end, caret.direction ?? undefined);
    for (const { node, top, left, anchor, offset } of positions) {
      if (!node.isConnected) continue;
      node.scrollTop = anchor?.isConnected && node.contains(anchor) ? node.scrollTop + anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - offset : top;
      node.scrollLeft = left;
    }
  };
}

// Enter / Esc answer a conversation's waiting approval (allow / decline). A key meant for anything
// else must never do that: it counts only when nothing has the focus (the page itself), or when the
// focus is inside this conversation on something that does not handle keys of its own.

/** Controls and layers that use Enter, Space or Esc themselves. */
const OWN_KEYS = [
  "button", "a[href]", "input", "textarea", "select", "summary", "[contenteditable]:not([contenteditable=false])",
  "[role=button]", "[role=link]", "[role=tab]", "[role=separator][tabindex]", "[role=menuitem]", "[role=menuitemradio]", "[role=menuitemcheckbox]",
  "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=slider]", "[role=textbox]", "[role=combobox]", "[role=listbox]",
  "[role=menu]", "[role=dialog]", "dialog",
].join(", ");

type KeyLike = { target: EventTarget | null; isComposing?: boolean; keyCode?: number; defaultPrevented?: boolean; repeat?: boolean };

/**
 * Whether a key press may answer the approval waiting in `conversation` (the conversation's own
 * root element). Elsewhere — another landmark or layer, another pane, a control — it may not.
 */
export function approvalKeyApplies(event: KeyLike, conversation: HTMLElement | null): boolean {
  // A held key repeats: approving one request must never approve the next one that appears.
  if (!conversation || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  // Nothing focused: the conversation in the focused pane, shown, with no modal open, takes it.
  if (target === document.body || target === document.documentElement) {
    if (conversation.closest('[hidden], [data-pane-active="false"], [aria-hidden="true"]')) return false;
    return !document.querySelector("dialog[open], [aria-modal=true]");
  }
  if (!conversation.contains(target)) return false;
  for (let at: Element | null = target; at && at !== conversation; at = at.parentElement) if (at.matches(OWN_KEYS)) return false;
  return true;
}

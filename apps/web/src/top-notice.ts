import type { Provider } from "@workbench/contracts";

/** An answer that landed off screen, and the other sessions that finished while it was shown. */
export type Completion = { id: string; provider: Provider; text: string; others: string[] };
/** What the top bar's status slot shows: one notice at a time, in the title's place. */
export type NoticeSlot =
  | { kind: "completion"; completion: Completion }
  | { kind: "info" | "error"; text: string; action?: { label: string; run: () => void } };
/** `serial` changes whenever the shown notice does, so its clock restarts. */
/** What a component reports: an outcome of the user's own action, or (kind "error") a failure. */
export type Note = { text: string; kind?: "info" | "error"; action?: { label: string; run: () => void } };
export type Notify = (message: string | Note) => void;
/** A failure or refusal, decided where it happens: shown as an alert and never replaced silently. */
export const failure = (error: unknown, prefix = ""): Note => ({ kind: "error", text: `${prefix}${error instanceof Error ? error.message : String(error)}` });
export const asSlot = (message: string | Note): NoticeSlot => typeof message === "string" ? { kind: "info", text: message } : { kind: message.kind ?? "info", text: message.text, action: message.action };

export type Notices = { current: NoticeSlot | null; waiting: NoticeSlot | null; serial: number };
export type NoticeAction = { type: "show"; slot: NoticeSlot } | { type: "close" } | { type: "seen"; onScreen: ReadonlySet<string> };

export const EMPTY_NOTICES: Notices = { current: null, waiting: null, serial: 0 };
/** Existing lifetimes: a notice with an action stays longer. */
export const lifetime = (slot: NoticeSlot) => (slot.kind !== "completion" && slot.action ? 9000 : 6000);

/** A completion folds into one already there (newest named, others counted once). */
const merge = (into: NoticeSlot | null, next: NoticeSlot): NoticeSlot => {
  if (next.kind !== "completion" || into?.kind !== "completion") return next;
  const others = [...new Set([...into.completion.others, into.completion.id])].filter(id => id !== next.completion.id);
  return { kind: "completion", completion: { ...next.completion, others } };
};

export function noticeReducer(state: Notices, action: NoticeAction): Notices {
  if (action.type === "close") return { current: state.waiting, waiting: null, serial: state.serial + 1 };
  if (action.type === "seen") {
    const shown = (slot: NoticeSlot | null) => slot?.kind === "completion" && action.onScreen.has(slot.completion.id);
    if (shown(state.current)) return { current: state.waiting, waiting: null, serial: state.serial + 1 };
    return shown(state.waiting) ? { ...state, waiting: null } : state;
  }
  // An error is never replaced silently: anything newer waits behind it (an error ahead of the rest).
  if (state.current?.kind === "error") {
    const waiting = state.waiting?.kind === "error" && action.slot.kind !== "error" ? state.waiting : merge(state.waiting, action.slot);
    return { ...state, waiting };
  }
  // A notice with an action the user may still need (되돌리기…) is not replaced by an answer landing meanwhile.
  if (action.slot.kind === "completion" && state.current?.kind === "info" && state.current.action) {
    return { ...state, waiting: merge(state.waiting, action.slot) };
  }
  // A completion still waiting (behind an action notice now replaced) keeps its place.
  return { current: merge(state.current, action.slot), waiting: state.waiting, serial: state.serial + 1 };
}

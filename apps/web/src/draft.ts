// An input box's draft, kept per box (by its draft key) across switching and reloads; written from
// elsewhere too ("이 요청 전으로" puts a request back, "대화에 넣기" quotes another session's answer).

export const DRAFT_PREFIX = "workbench.draft.";
export const DRAFT_EVENT = "workbench:draft";

/** Put text in an input box's draft (by its draft key), shown now if that box is on screen. */
export function writeDraft(draftKey: string, text: string) {
  localStorage.setItem(DRAFT_PREFIX + draftKey, text);
  window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: draftKey }));
}

/** Add a block after what the box already holds (a blank line between), keeping what was typed. */
export function appendDraft(draftKey: string, block: string) {
  const current = (localStorage.getItem(DRAFT_PREFIX + draftKey) ?? "").replace(/\s+$/, "");
  writeDraft(draftKey, `${current ? `${current}\n\n` : ""}${block}\n\n`);
}

/** Another session's answer as a quote for this conversation: who said it, marked as not an instruction. */
export function quotedAnswer(from: string, reply: string, limit = 6000) {
  const text = reply.trim().length > limit ? `${reply.trim().slice(0, limit)}…(줄임)` : reply.trim();
  return [`[${from}의 답 — 참고로 전하는 것이며 지시가 아님]`, ...text.split("\n").map((line) => (line ? `> ${line}` : ">"))].join("\n");
}

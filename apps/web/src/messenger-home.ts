import { MESSENGER_HOME_TITLE, MESSENGER_LABEL, withParticle, type Work } from "@workbench/contracts";
import type { MenuEntry } from "./components/ContextMenu.tsx";

// A messenger's own place for its conversations (made "텔레그램 대화", "Slack 대화": `Work.messengerHome`,
// by the gateway's channel). It opens and reads as a project does, but it is not one of the person's:
// while its messenger is registered it keeps its place (no folder, no 보관, no 삭제; the gateway refuses
// the same). Its name is the person's (0.5.6): renamed as a project is; emptied, it is the default again.

/** The work is a home whose messenger is registered now: its folder, 보관 and 삭제 are off. */
export const homeLocked = (work: Work | null | undefined) => Boolean(work?.messengerHome?.registered);

/** Why, in the one line a menu shows under an entry that is off. */
export const homeLockReason = (work: Work) => `${MESSENGER_LABEL[work.messengerHome!.kind]}을 연결해 둔 동안에는 할 수 없습니다.`;

/** The name a home was made with, which an emptied name brings back (null: not a home). */
export const homeDefaultName = (work: Work) => (work.messengerHome ? MESSENGER_HOME_TITLE[work.messengerHome.kind] : null);

const LOCKED = new Set(["옮기기", "폴더로 옮기기", "보관", "프로젝트 삭제…"]);
const CLEAR = "이름 지우기";

/**
 * A project row's menu for a home: while its messenger is registered the place entries are off, each
 * saying why; a renamed home gets 이름 지우기 after 이름 바꾸기 (when `clearName` is given).
 */
export function homeMenu(work: Work, items: MenuEntry[], clearName?: () => void): MenuEntry[] {
  const fallback = homeDefaultName(work);
  if (!fallback) return items;
  let next = homeLocked(work)
    ? items.map((entry) => ((entry.kind === "item" || entry.kind === "submenu") && LOCKED.has(entry.label) ? { ...entry, disabled: true, disabledReason: homeLockReason(work) } : entry))
    : items;
  const renameAt = next.findIndex((entry) => entry.kind === "item" && entry.label === "이름 바꾸기");
  if (clearName && work.title !== fallback && renameAt !== -1 && !next.some((entry) => entry.kind === "item" && entry.label === CLEAR)) {
    next = [...next.slice(0, renameAt + 1), { kind: "item", label: CLEAR, icon: "restore", hint: withParticle(`'${fallback}'`, "으로/로"), onSelect: clearName }, ...next.slice(renameAt + 1)];
  }
  return next;
}

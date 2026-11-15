import { MESSENGER_LABEL, type Work } from "@workbench/contracts";
import type { MenuEntry } from "./components/ContextMenu.tsx";

// A messenger's own place for its conversations ("텔레그램 대화", "Slack 대화": `Work.messengerHome`, made
// by the gateway's channel). It opens and reads as a project does, but it is not one of the person's:
// while its messenger is registered it keeps its name and its place (the gateway refuses the same).

/** The work is a home whose messenger is registered now: its name, folder, 보관 and 삭제 are off. */
export const homeLocked = (work: Work | null | undefined) => Boolean(work?.messengerHome?.registered);

/** Why, in the one line a menu shows under an entry that is off. */
export const homeLockReason = (work: Work) => `${MESSENGER_LABEL[work.messengerHome!.kind]}을 연결해 둔 동안에는 할 수 없습니다.`;

const LOCKED = new Set(["이름 바꾸기", "옮기기", "폴더로 옮기기", "보관", "프로젝트 삭제…"]);

/** A project row's menu for a home: while its messenger is registered those entries are off, each saying why. */
export function homeMenu(work: Work, items: MenuEntry[]): MenuEntry[] {
  if (!homeLocked(work)) return items;
  const disabledReason = homeLockReason(work);
  return items.map((entry) => ((entry.kind === "item" || entry.kind === "submenu") && LOCKED.has(entry.label) ? { ...entry, disabled: true, disabledReason } : entry));
}

import type { Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";

// "태그 더하기" from the sidebar: tags are added to a project's note the way its own page adds them —
// one tag per write (the gateway changes a list one item at a time and leaves the other items as
// written, "#회의" included), each after the one before it, from the revision that one returned.

export type TagsAdded = { work: Work; added: string[]; missed: string[]; reason: unknown };

const plain = (tag: string) => tag.replace(/^#/, "").trim();
const same = (a: string, b: string) => plain(a).toLowerCase() === plain(b).toLowerCase();

/**
 * Add `tags` to the note of `work`, skipping those it already has (`have`, "#" or not). Stops at the
 * first refusal: `added` went in, `missed` (the refused one and those after it) did not.
 */
export async function addNoteTags(api: Pick<Api, "setProjectProperty">, work: Work, have: string[], tags: string[]): Promise<TagsAdded> {
  const wanted: string[] = [];
  for (const tag of tags.map(plain).filter(Boolean)) if (!have.some((entry) => same(entry, tag)) && !wanted.some((entry) => same(entry, tag))) wanted.push(tag);
  const added: string[] = [];
  // The first is written onto the note as it is; the next from the revision the one before made.
  let base: number | null | undefined;
  for (const tag of wanted) {
    try {
      const write = await api.setProjectProperty(work.id, "tags", null, "tags", base, { add: tag });
      base = write.page.note.exists ? (write.page.note.revision ?? null) : null;
      added.push(tag);
    } catch (reason) {
      return { work, added, missed: wanted.slice(added.length), reason };
    }
  }
  return { work, added, missed: [], reason: null };
}

const names = (tags: string[]) => tags.map((tag) => `#${tag}`).join(" ");

/** What to say after adding tags to one or more projects: `ok` when every tag went in everywhere. */
export function tagsNotice(results: TagsAdded[]): { ok: boolean; text: string } | null {
  const failed = results.filter((result) => result.missed.length);
  if (!failed.length) {
    const done = results.filter((result) => result.added.length);
    const tags = [...new Set(done.flatMap((result) => result.added))];
    return tags.length ? { ok: true, text: `${names(tags)} 태그를 더했습니다${done.length > 1 ? ` (프로젝트 ${done.length}개)` : ""}.` } : null;
  }
  const said = failed.map((result) => {
    const why = result.reason instanceof Error ? result.reason.message : String(result.reason);
    const where = results.length > 1 ? `「${result.work.title}」: ` : "";
    return `${where}${result.added.length ? `${names(result.added)} 태그는 더했고, ` : ""}${names(result.missed)} 태그는 더하지 못했습니다 — ${why}`;
  });
  const rest = results.length - failed.length;
  return { ok: false, text: `${said.join(" / ")}${rest ? ` (다른 프로젝트 ${rest}개에는 모두 더했습니다.)` : ""}` };
}

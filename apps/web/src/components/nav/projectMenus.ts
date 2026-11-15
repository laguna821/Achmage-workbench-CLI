import type { Work } from "@workbench/contracts";
import { folderChoices, type Row } from "../../tree.ts";
import type { MenuEntry } from "../ContextMenu.tsx";
import { addShortcuts, sameShortcut } from "./model.ts";
import type { NavShared } from "./shared.ts";

// A project row's menu (the list pane's, kept whole for level 1): the app's work menu with the
// navigator's own items (폴더로 옮기기, 바로가기, 단계, 태그 더하기), and for several projects picked
// with Ctrl/Shift the bulk menu (옮기기, 바로가기, 고정, 단계, 태그, 보관 N).

export function projectActions(shared: NavShared, clearPicked: () => void) {
  const { api, actions, state, stages } = shared;
  const projectOf = (id: string) => shared.projects.find((project) => project.work.id === id);
  const setStage = (works: Work[], stage: string | null) =>
    void Promise.allSettled(works.map((work) => api.setProjectStage(work.id, stage))).then((results) => {
      const done = results.flatMap((result, index) => (result.status === "fulfilled" ? [{ work: works[index]!, write: result.value }] : []));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) shared.fail(failed.reason);
      if (!done.length) return;
      const undo = () => void Promise.all(done.filter((entry) => entry.write.token).map((entry) => api.undoProject(entry.work.id, entry.write.token))).catch(shared.fail);
      shared.toast({ text: done.length === 1 ? `${done[0]!.work.title}: ${done[0]!.write.summary}` : `단계 ${stage ?? "값 없음"} · 프로젝트 ${done.length}개`, action: { label: "되돌리기", run: undo } });
    });
  const pin = (works: Work[], pinned: boolean) => void Promise.all(works.map((work) => api.updateWork(work.id, { pinned }))).catch(shared.fail);
  const archiveMany = (works: Work[]) =>
    void Promise.allSettled(works.map((work) => api.updateWork(work.id, { archived: true }))).then((results) => {
      const done = works.filter((_, index) => results[index]!.status === "fulfilled");
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) shared.fail(failed.reason);
      if (!done.length) return;
      clearPicked();
      shared.toast({ text: `프로젝트 ${done.length}개를 보관함으로 옮겼습니다.`, action: { label: "되돌리기", run: () => void Promise.all(done.map((work) => api.updateWork(work.id, { archived: false }))).catch(shared.fail) } });
    });
  const archive = (works: Work[]) => (works.length === 1 ? actions.archive({ kind: "work", id: works[0]!.id }) : archiveMany(works));
  const stageMenu = (works: Work[]): MenuEntry => {
    const current = works.length === 1 ? (projectOf(works[0]!.id)?.stage ?? null) : undefined;
    return {
      kind: "submenu",
      label: "단계",
      icon: "stage",
      items: [
        ...stages.map((stage) => ({ kind: "item" as const, label: stage.name, checked: current === stage.name, onSelect: () => setStage(works, stage.name) })),
        { kind: "separator" as const },
        { kind: "item" as const, label: "값 없음", checked: current === null, onSelect: () => setStage(works, null) },
      ],
    };
  };
  const moveMenu = (works: Work[]): MenuEntry => ({
    kind: "submenu",
    label: "폴더로 옮기기",
    icon: "folder",
    items: [
      { kind: "item", label: "폴더 밖 (프로젝트)", checked: works.every((work) => !work.folderId), onSelect: () => shared.moveProjects(works, null) },
      ...(folderChoices(state).length ? [{ kind: "separator" as const }] : []),
      ...folderChoices(state).map((folder) => ({ kind: "item" as const, label: `${" ".repeat(folder.depth)}${folder.name}`, checked: works.every((work) => work.folderId === folder.id), onSelect: () => shared.moveProjects(works, folder.id) })),
    ],
  });
  const shortcutEntry = (works: Work[]): MenuEntry => {
    const all = works.every((work) => shared.shortcuts.some((entry) => sameShortcut(entry, { kind: "work", id: work.id })));
    return all
      ? { kind: "item", label: "바로가기에서 빼기", icon: "star", onSelect: () => shared.saveShortcuts(shared.shortcuts.filter((entry) => !works.some((work) => sameShortcut(entry, { kind: "work", id: work.id })))) }
      : { kind: "item", label: "바로가기에 더하기", icon: "star", onSelect: () => shared.saveShortcuts(addShortcuts(shared.shortcuts, works.map((work) => ({ kind: "work" as const, id: work.id })))) };
  };
  const tagEntry = (works: Work[], x: number, y: number): MenuEntry => ({ kind: "item", label: "태그 더하기…", icon: "hash", onSelect: () => shared.setDialog({ kind: "tags", works, x, y }) });

  /** The menu of one project (`row`: its tree row for the app's menu), or of the projects picked. */
  const open = (works: Work[], row: Extract<Row, { type: "work" }> | null, x: number, y: number) => {
    if (works.length > 1) {
      const allPinned = works.every((work) => work.pinned);
      actions.openMenu({
        x,
        y,
        title: `프로젝트 ${works.length}개`,
        items: [
          moveMenu(works),
          shortcutEntry(works),
          { kind: "item", label: allPinned ? "고정 풀기" : "고정", icon: "pin", onSelect: () => pin(works, !allPinned) },
          stageMenu(works),
          tagEntry(works, x, y),
          { kind: "separator" },
          { kind: "item", label: `보관 (${works.length}개)`, icon: "archive", hint: "Delete", onSelect: () => archive(works) },
        ],
      });
      return;
    }
    const base = row ? actions.menuFor(row, x, y) : null;
    if (!base) return;
    const items: MenuEntry[] = base.items.map((entry) => (entry.kind === "submenu" && entry.label === "옮기기" ? moveMenu(works) : entry));
    const pinAt = items.findIndex((entry) => entry.kind === "item" && (entry.label === "고정" || entry.label === "고정 풀기"));
    const extras = [shortcutEntry(works), stageMenu(works), tagEntry(works, x, y)];
    if (pinAt === -1) items.push({ kind: "separator" }, ...extras);
    else items.splice(pinAt + 1, 0, ...extras);
    actions.openMenu({ ...base, items });
  };
  return { open, archive };
}

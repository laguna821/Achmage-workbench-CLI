import { PROVIDER_LABEL, type Provider, type Work, type Workspace } from "@workbench/contracts";
import { NEW_DOCUMENT_TYPES, type NewDocumentFormat, type NewDocumentTarget } from "./components/NewDocumentButton.tsx";
import type { IconName } from "./components/Icon.tsx";

export type CreateContext = NewDocumentTarget & { folderId: string | null };
export type CreateAction = { id: string; label: string; icon: IconName; target: CreateContext } & (
  | { kind: "document"; format: NewDocumentFormat }
  | { kind: "session"; provider?: Provider }
  | { kind: "browser" }
  | { kind: "folder" }
  | { kind: "directory" }
  | { kind: "project" }
);

/** One command catalog for the toolbar, project rows, context menu and keyboard. */
/**
 * `remote`: a phone joined to the PC — a web page is the PC's browser (its own driver and profile), not offered there.
 * `engines`: the engines a new conversation may start with (engines.ts; Claude and Codex by default).
 */
export function createActions(target: CreateContext, options: { remote?: boolean; engines?: readonly Provider[] } = {}): CreateAction[] {
  const engines = options.engines ?? ["claude", "codex"];
  return [
    ...NEW_DOCUMENT_TYPES.map(type => ({ id: `create-${type.format}`, kind: "document" as const, format: type.format, label: `새 ${type.label}`, icon: (type.format === "design" ? "palette" : "file") as IconName, target })),
    ...(target.workId
      ? engines.map(provider => ({ id: `create-${provider}`, kind: "session" as const, provider, label: `${PROVIDER_LABEL[provider]}와 새 대화`, icon: "chat" as const, target }))
      : [{ id: "create-session", kind: "session" as const, label: "새 대화", icon: "chat" as const, target }]),
    ...(options.remote ? [] : [{ id: "create-browser", kind: "browser" as const, label: "새 웹 탭", icon: "globe" as const, target }]),
    { id: "create-folder", kind: "folder", label: "목록에 새 폴더…", icon: "folder", target },
    ...(target.workId && target.workspaceId ? [{ id: "create-directory", kind: "directory" as const, label: "프로젝트 폴더 안에 새 폴더…", icon: "folder" as const, target }] : []),
    { id: "create-project", kind: "project", label: "새 프로젝트…", icon: "project", target },
  ];
}

/** Never borrow the focused project's workspace when a different project was right-clicked. */
export function creationWorkspace(work: Work | undefined, candidates: (string | undefined)[], workspaces: Record<string, Workspace>): string | undefined {
  if (!work) return undefined;
  return [...candidates, work.defaultWorkspaceId].find(id => id && workspaces[id]?.workId === work.id && !workspaces[id]?.archivedAt && !workspaces[id]?.removedAt);
}

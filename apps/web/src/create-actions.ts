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
export function createActions(target: CreateContext): CreateAction[] {
  return [
    ...NEW_DOCUMENT_TYPES.map(type => ({ id: `create-${type.format}`, kind: "document" as const, format: type.format, label: `새 ${type.label}`, icon: (type.format === "design" ? "palette" : "file") as IconName, target })),
    ...(target.workId
      ? (["claude", "codex"] as const).map(provider => ({ id: `create-${provider}`, kind: "session" as const, provider, label: `${PROVIDER_LABEL[provider]} 새 세션`, icon: "chat" as const, target }))
      : [{ id: "create-session", kind: "session" as const, label: "새 세션", icon: "chat" as const, target }]),
    { id: "create-browser", kind: "browser", label: "새 웹 탭", icon: "globe", target },
    { id: "create-folder", kind: "folder", label: "새 정리 폴더…", icon: "folder", target },
    ...(target.workId && target.workspaceId ? [{ id: "create-directory", kind: "directory" as const, label: "프로젝트 안 새 폴더…", icon: "folder" as const, target }] : []),
    { id: "create-project", kind: "project", label: "새 프로젝트…", icon: "project", target },
  ];
}

/** Never borrow the focused project's workspace when a different project was right-clicked. */
export function creationWorkspace(work: Work | undefined, candidates: (string | undefined)[], workspaces: Record<string, Workspace>): string | undefined {
  if (!work) return undefined;
  return [...candidates, work.defaultWorkspaceId].find(id => id && workspaces[id]?.workId === work.id && !workspaces[id]?.archivedAt && !workspaces[id]?.removedAt);
}

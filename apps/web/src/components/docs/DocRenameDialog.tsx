import { DESIGN_EXTENSION, withParticle, type Artifact } from "@workbench/contracts";
import type { Note } from "../../top-notice.ts";
import { RenameDialog } from "../RenameDialog.tsx";

/** The extension a document keeps when it is renamed (designs keep their two-part `.design.json`). */
export function docExtension(artifact: Pick<Artifact, "format" | "name">) {
  if (artifact.format === "design") return DESIGN_EXTENSION;
  const dot = artifact.name.lastIndexOf(".");
  return dot > 0 ? artifact.name.slice(dot) : "";
}

/** The name a person edits: without its extension. */
export function docStem(artifact: Pick<Artifact, "format" | "name">) {
  const extension = docExtension(artifact);
  return extension && artifact.name.toLowerCase().endsWith(extension.toLowerCase()) ? artifact.name.slice(0, -extension.length) : artifact.name;
}

type Rename = (artifactId: string, name: string) => Promise<{ artifact: Artifact; noteLinks: number; notice?: string }>;

/**
 * 문서 이름 바꾸기 (audit #141): the file is renamed in its folder by the gateway, which refuses with a
 * plain line (shown in the dialog) when the name exists, has characters the computer refuses, or
 * the document's AI is working. Done: a notice with 되돌리기 (renaming back).
 */
export function DocRenameDialog({ artifact, rename, notify, onClose }: { artifact: Artifact; rename: Rename; notify: (note: Note) => void; onClose(): void }) {
  const before = docStem(artifact);
  const save = async (name: string) => {
    const result = await rename(artifact.id, name);
    const links = result.noteLinks ? ` 프로젝트 노트의 링크 ${result.noteLinks}곳도 고쳤습니다.` : "";
    notify({
      text: `이름을 ${withParticle(`「${result.artifact.name}」`, "으로/로")} 바꿨습니다.${links}${result.notice ? ` ${result.notice}` : ""}`,
      action: { label: "되돌리기", run: () => void rename(artifact.id, before).then(() => notify({ text: `이름을 ${withParticle(`「${artifact.name}」`, "으로/로")} 되돌렸습니다.` }), (error: Error) => notify({ kind: "error", text: error.message })) },
    });
  };
  return <RenameDialog title="문서 이름 바꾸기" value={before} note={`파일 이름도 바뀝니다. 확장자(${docExtension(artifact)})는 그대로입니다.`} onSave={save} onClose={onClose} />;
}

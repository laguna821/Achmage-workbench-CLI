import { useState } from "react";
import { FORMAT_LABEL, LEGACY_FORMATS, type Artifact, type LegacyFormat } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { failure, type Notify } from "../../top-notice.ts";

/**
 * An old Word (.doc), old PowerPoint (.ppt) or ODS file opened: it is not edited as it is. "변환해서 열기"
 * makes a NEW .docx / .pptx / .xlsx beside it with IeumOffice's converters (the gateway's office-convert.ts),
 * opens that, and says in one line where it came from and what did not come along. The original stays.
 */
export function legacyTarget(format: LegacyFormat) {
  return LEGACY_FORMATS[format].toUpperCase();
}

/** Convert, open the copy, say the line (shared by the open view and the list's row menu). */
export async function openConverted(api: Api, artifact: Artifact, onOpen: (artifactId: string) => void, notify: Notify) {
  const made = await api.openConverted(artifact.id);
  onOpen(made.artifact.id);
  notify(made.line);
  return made;
}

export function LegacyConvert({ api, artifact, onOpen, notify }: { api: Api; artifact: Artifact & { format: LegacyFormat }; onOpen(artifactId: string): void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await openConverted(api, artifact, onOpen, notify); }
    catch (error) { notify(failure(error)); }
    finally { setBusy(false); }
  };
  return (
    <div className="doc-empty doc-legacy">
      <p className="doc-empty-what">{`${FORMAT_LABEL[artifact.format]} 파일은 바로 편집하지 않습니다.`}</p>
      <p className="doc-empty-why">{`원본은 그대로 두고, 같은 폴더에 ${legacyTarget(artifact.format)} 사본을 만들어 엽니다. 옮기지 못한 것은 만든 뒤에 알려 드립니다.`}</p>
      <span className="doc-empty-keys">
        <button type="button" className="button small primary" disabled={busy} onClick={() => void run()}>{busy ? "변환하는 중…" : "변환해서 열기"}</button>
      </span>
    </div>
  );
}

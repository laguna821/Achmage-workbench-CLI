import { useEffect, useState } from "react";
import { Icon } from "../Icon.tsx";
import { usePkm } from "./PkmContext.tsx";
import { TemplateDialog } from "./TemplateDialog.tsx";
import { ViewDialog } from "./ViewDialog.tsx";
import { RulesDialog } from "./RulesDialog.tsx";
import { InsightDialog } from "./InsightDialog.tsx";
import "../../styles/pkm.css";

/**
 * "옵시디언 볼트 연결": pick the vault folder (the one with `.obsidian`). The vault found on this
 * computer is offered first. Workbench only reads it; the only way anything reaches the vault is
 * an insight published through Achmage.
 */
export function VaultDialog({ pickFolder }: { pickFolder: (() => Promise<string | null>) | null }) {
  const pkm = usePkm();
  const status = pkm.tree?.status;
  const [path, setPath] = useState(status?.path ?? status?.suggested ?? "");
  const [busy, setBusy] = useState(false);
  const close = () => pkm.setDialog(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && pkm.setDialog(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pkm]);

  const connect = async (target: string) => {
    if (!target.trim()) return;
    setBusy(true);
    const ok = await pkm.attach(target.trim());
    setBusy(false);
    if (ok) {
      pkm.onToast("볼트를 연결했습니다. 사이드바 '볼트'에서 폴더를 볼 수 있습니다.");
      close();
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="pkm-dialog" role="dialog" aria-label="옵시디언 볼트 연결">
        <header className="pkm-dialog-head">
          <h2>옵시디언 볼트 연결</h2>
          <button type="button" className="icon-button small" onClick={close} aria-label="닫기">
            <Icon name="x" size={15} />
          </button>
        </header>
        <p className="sheet-hint">
          볼트는 읽기 전용 거울로 붙습니다. 폴더 색·아이콘·고정은 Notebook Navigator 설정을, 묶음 테두리는 테두리 애드온 설정을 그대로 씁니다. Workbench는 볼트에 쓰지 않습니다.
        </p>
        {status?.suggested && status.suggested !== status.path ? (
          <button type="button" className="pkm-suggest" disabled={busy} onClick={() => void connect(status.suggested!)}>
            <Icon name="book" size={16} />
            <span className="pkm-suggest-text">
              <strong>{status.suggested.split("/").pop()}</strong>
              <span className="muted mono">{status.suggested}</span>
            </span>
            <span className="pkm-suggest-action">이 볼트 연결</span>
          </button>
        ) : null}
        <form
          className="pkm-path-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(path);
          }}
        >
          <label className="sheet-label" htmlFor="vault-path">
            볼트 폴더(.obsidian이 있는 폴더)
          </label>
          <div className="pkm-path-row">
            <input id="vault-path" className="sheet-input mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/…/Obsidian/볼트" spellCheck={false} />
            {pickFolder ? (
              <button
                type="button"
                className="button small"
                onClick={() =>
                  void pickFolder().then((picked) => {
                    if (picked) setPath(picked);
                  })
                }
              >
                고르기…
              </button>
            ) : null}
          </div>
          <div className="sheet-actions">
            {status?.path ? (
              <button
                type="button"
                className="button small"
                onClick={() => {
                  pkm.detach();
                  close();
                }}
              >
                연결 끊기
              </button>
            ) : null}
            <button type="submit" className="button primary small" disabled={busy || !path.trim()}>
              연결
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The PKM dialog asked for (vault from the sidebar or settings, a page from a template). */
export function VaultDialogHost({ pickFolder }: { pickFolder: (() => Promise<string | null>) | null }) {
  const pkm = usePkm();
  if (pkm.dialog?.kind === "vault") return <VaultDialog pickFolder={pickFolder} />;
  if (pkm.dialog?.kind === "template") return <TemplateDialog workId={pkm.dialog.workId} parentId={pkm.dialog.parentId} />;
  if (pkm.dialog?.kind === "view") return <ViewDialog id={pkm.dialog.id} />;
  if (pkm.dialog?.kind === "rules") return <RulesDialog />;
  if (pkm.dialog?.kind === "insight") return <InsightDialog sessionId={pkm.dialog.sessionId} />;
  return null;
}

/** The vault line in the settings popover (⋯): which vault is attached, and a way to change it. */
export function VaultSettingsRow({ onOpen }: { onOpen: () => void }) {
  const pkm = usePkm();
  const status = pkm.tree?.status;
  return (
    <>
      <div className="menu-divider" />
      <div className="menu-label">옵시디언 볼트</div>
      <div className="connection">
        <div className="connection-head">
          <span className="connection-name">{status?.name ?? "연결 안 됨"}</span>
          <span className={`connection-state ${status?.path && !status.problem ? "ok" : ""}`}>{status?.path ? (status.problem ? "찾을 수 없음" : "읽기 전용") : ""}</span>
        </div>
        {status?.path ? <div className="connection-meta muted mono">{status.path}</div> : null}
        {status?.path && !status.problem ? (
          <div className="connection-meta muted">
            노트 {status.notes} · 폴더 {status.folders}
            {status.navigator ? " · Notebook Navigator 설정" : ""}
            {status.borders ? " · 테두리 애드온" : ""}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="text-button"
        onClick={() => {
          onOpen();
          pkm.setDialog({ kind: "vault" });
        }}
      >
        {status?.path ? "볼트 바꾸기…" : "볼트 연결…"}
      </button>
    </>
  );
}

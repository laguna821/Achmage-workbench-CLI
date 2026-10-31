import { useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, DesignDraft, DesignSaveState, DesignSelection, DocumentAccess } from "@workbench/contracts";
import { EditorApp } from "@/editor";
import { useDocument, useEditor, useSelection } from "@/editor/context";
import { migrateDocument } from "@/editor/engine/migrations";
import { panels } from "@/editor/panels/registry";
import type { EditorHandle, SaveState } from "@/types/adapter";
import type { DocObject, DoryDocument } from "@/types/document";
import { createWorkbenchAdapter, serializeDesign, type DesignDocumentState } from "./adapter";
import { listen, post } from "./bridge";
import { loadFonts } from "./fonts";
import { Gateway } from "./gateway";
import { routeDownloads } from "./downloads";
import { DesignRecovery } from "./recovery";
import type { FontFamily } from "@/types/api";
import type { EditorEngine } from "@/editor/engine/editor";
// Panels that need a doory server (template and element catalogues, brand kits) are left out.
for (const id of ["templates", "elements", "brand"]) panels.unregister(id);

export type DesignInit = { token: string; artifactId: string; revision: number | null; readOnly: boolean; access?: DocumentAccess };

type Prepared = { document: DoryDocument; artifact: Artifact; revision: number; gateway: Gateway; fonts: FontFamily[] };
type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "recovery"; prepared: Prepared; drafts: DesignDraft[] }
  | { kind: "ready"; document: DoryDocument; name: string; revision: number; gateway: Gateway; adapter: ReturnType<typeof createWorkbenchAdapter>; state: DesignDocumentState; recovery: DesignRecovery };

const CREDIT = "Doory by Siam, creator and maintainer of Doory, https://github.com/shaongitbd/doory";

const stateOf = (state: SaveState): DesignSaveState => (state.status === "local" ? "saved" : state.status);

function describe(object: DocObject): string {
  const text = typeof object.text === "string" ? ` "${object.text.replace(/\s+/g, " ").slice(0, 60)}"` : "";
  return `${object.type}${text} (id ${object.id})`;
}

/** Tells the Workbench window what is selected, so a request can be about exactly those objects. */
function SelectionReporter() {
  const selection = useSelection();
  const document = useDocument();
  const key = `${selection.pageId}|${selection.ids.join(",")}|${selection.version}`;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const pageIndex = document.pages.findIndex((page) => page.id === selection.pageId);
      if (!selection.pageId || pageIndex < 0 || selection.ids.length === 0) {
        post({ type: "design:selection", selection: null });
        return;
      }
      const objects = selection.objects.length ? selection.objects : [];
      const first = objects[0];
      const name = objects.length === 1 && typeof first?.text === "string" ? `"${first.text.replace(/\s+/g, " ").slice(0, 16)}"` : `개체 ${selection.ids.length}개`;
      const value: DesignSelection = {
        pageId: selection.pageId,
        pageIndex,
        objectIds: selection.ids,
        label: `${pageIndex + 1}쪽 ${name}`,
        text: objects.map(describe).join("\n"),
      };
      post({ type: "design:selection", selection: value });
    }, 150);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

function RecoveryReporter({ recovery, state, attach }: { recovery: DesignRecovery; state: DesignDocumentState; attach(engine: EditorEngine): void }) {
  const document = useDocument(), editor = useEditor();
  useEffect(() => { attach(editor); }, [editor, attach]);
  useEffect(() => {
    // Runs even during a save conflict, when upstream autosave intentionally stops watching changes.
    void recovery.observe(serializeDesign(document), state.revision, async () => serializeDesign(await editor.assets.persistInline(document)));
  }, [document, recovery, state, editor]);
  return null;
}

export function EditorHost({ init }: { init: DesignInit }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [revision, setRevision] = useState<number | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  const editorRef = useRef<EditorHandle>(null);
  const engine = useRef<EditorEngine | null>(null);
  const lastState = useRef<DesignSaveState>("idle");
  const restoredUnsaved = useRef(false);
  const stopDownloads = useRef<(() => void) | null>(null);

  function activate(prepared: Prepared, recovered?: DesignDraft) {
    const { gateway, artifact, fonts } = prepared;
    const document = recovered ? migrateDocument(JSON.parse(recovered.text)) : prepared.document;
    const state: DesignDocumentState = { revision: recovered?.baseRevision ?? prepared.revision };
    const recovery = new DesignRecovery({ gateway, artifactId: artifact.id, original: serializeDesign(prepared.document), recovered, onError: setRecoveryError });
    restoredUnsaved.current = Boolean(recovered);
    const adapter = createWorkbenchAdapter({
      gateway, artifactId: artifact.id, state, fonts,
      onSaved: (saved, text) => {
        restoredUnsaved.current = false;
        setRevision(saved);
        void recovery.saved(text, saved);
        post({ type: "design:saved", revision: saved });
      },
    });
    stopDownloads.current?.();
    stopDownloads.current = routeDownloads(gateway, artifact.id, () => ({ text: recovery.savedText, revision: state.revision }));
    setLoad({ kind: "ready", document, name: artifact.name, revision: state.revision, gateway, adapter, state, recovery });
    post({ type: "design:opened", revision: state.revision, pages: document.pages.length });
    if (recovered) post({ type: "design:state", state: "dirty" });
  }

  useEffect(() => {
    let active = true;
    const gateway = new Gateway(init.token, init.access);
    const stopAccess = listen((message) => { if (message.type === "design:access") gateway.setAccess(message.access); });
    (async () => {
      const [opened, fonts] = await Promise.all([gateway.text(init.artifactId, init.revision), loadFonts(gateway)]);
      let document: DoryDocument;
      try {
        document = migrateDocument(JSON.parse(opened.text));
      } catch (error) {
        throw new Error(`디자인 파일을 열 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
      const drafts = init.readOnly || init.revision !== null ? [] : await gateway.drafts(init.artifactId);
      if (!active) return;
      const prepared = { document, artifact: opened.artifact, revision: opened.revision, gateway, fonts };
      if (drafts.length) {
        setLoad({ kind: "recovery", prepared, drafts });
        post({ type: "design:state", state: "conflict", message: "보관된 편집 내용을 확인해 주세요." });
      } else activate(prepared);
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (active) setLoad({ kind: "error", message });
      post({ type: "design:error", message });
    });
    return () => {
      active = false;
      stopAccess();
      stopDownloads.current?.();
      gateway.dispose();
    };
  }, [init]);

  useEffect(() => {
    let queue = Promise.resolve();
    return listen((message) => {
      if (message.type === "design:check-reload" && load.kind === "ready" && message.revision > load.state.revision && !restoredUnsaved.current && editorRef.current && !editorRef.current.isDirty() && !["saving", "conflict", "error"].includes(lastState.current)) post({ type: "design:reload" });
      if (message.type !== "design:flush") return;
      queue = queue.then(async () => {
        const handle = editorRef.current;
        let saved: number | null = null;
        try {
          if (handle && load.kind === "ready") {
            if (handle.isDirty() || restoredUnsaved.current || lastState.current === "saving") await handle.saveNow();
            if (!handle.isDirty() && !restoredUnsaved.current && !["saving", "conflict", "error"].includes(lastState.current)) saved = load.state.revision;
          }
        } finally { post({ type: "design:flushed", requestId: message.requestId, revision: saved }); }
      }).catch((error: unknown) => post({ type: "design:error", message: String(error) }));
    });
  }, [load]);

  const meta = useMemo(
    () => (load.kind === "ready" ? { id: init.artifactId, title: load.name.replace(/\.design\.json$/i, ""), mode: init.readOnly ? ("shared-view" as const) : ("account" as const), revision: load.revision } : null),
    // The editor is mounted once per opened revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load.kind === "ready" ? load.revision : null],
  );

  if (load.kind === "loading") return <div className="wb-design-status">디자인을 여는 중…</div>;
  if (load.kind === "error") return <div className="wb-design-status wb-design-error">{load.message}</div>;
  if (load.kind === "recovery") return <div className="wb-design-recovery" role="dialog" aria-label="디자인 편집 복구">
    <h2>보관된 편집 내용이 있습니다</h2>
    <p>복구할 내용을 선택하세요. 원본 파일은 선택만으로 바뀌지 않습니다.</p>
    {load.drafts.map((draft) => <div key={`${draft.viewId}:${draft.sha256}`}>
      <span>r{draft.baseRevision}에서 편집 · {new Date(draft.at).toLocaleString()} {draft.active ? "· 다른 창에서 사용 중" : ""}</span>
      <button disabled={draft.active} onClick={() => activate(load.prepared, draft)}>이 편집 복구</button>
      <button disabled={draft.active} onClick={() => void load.prepared.gateway.removeDraft(init.artifactId, draft).then(async () => setLoad({ ...load, drafts: await load.prepared.gateway.drafts(init.artifactId) })).catch((error: unknown) => setRecoveryError(String(error)))}>이 복구본 삭제</button>
    </div>)}
    <button onClick={() => activate(load.prepared)}>저장된 원본 열기 (복구본 유지)</button>
    {recoveryError && <p role="alert">{recoveryError}</p>}
  </div>;

  async function saveAsCopy() {
    if (load.kind !== "ready") return;
    try {
      if (!engine.current) return;
      const original = engine.current.getDocument(), raw = serializeDesign(original);
      const baseRevision = load.state.revision;
      const document = await engine.current.assets.persistInline(original);
      const text = serializeDesign(document);
      const created = await load.gateway.copy(init.artifactId, baseRevision, text);
      await load.recovery.copied(text).catch((error: unknown) => setRecoveryError(`사본은 저장했습니다. 복구본 정리: ${String(error)}`));
      if (serializeDesign(engine.current.getDocument()) !== raw) {
        post({ type: "design:error", message: `「${created.name}」에 사본을 저장했습니다. 저장 중 추가한 편집은 현재 창에 남아 있습니다.` });
        return;
      }
      post({ type: "design:copied", artifactId: created.id });
    } catch (error) { post({ type: "design:error", message: error instanceof Error ? error.message : String(error) }); }
  }

  return (
    <div className="wb-design">
      {recoveryError && <div className="wb-design-recovery-error" role="alert">{recoveryError}</div>}
      <div className="wb-design-editor">
        <EditorApp
          ref={editorRef}
          document={load.document}
          meta={meta!}
          adapter={load.adapter}
          onSaveStateChange={(state) => {
            lastState.current = stateOf(state);
            post({ type: "design:state", state: restoredUnsaved.current && ["idle", "saved"].includes(lastState.current) ? "dirty" : lastState.current, message: state.status === "error" ? state.message : undefined });
          }}
          onConflictResolve={(choice) => (choice === "reload" ? post({ type: "design:reload" }) : void saveAsCopy())}
          topBarStart={
            <span className="wb-design-title">
              <b>{load.name.replace(/\.design\.json$/i, "")}</b>
              <span className="wb-design-rev">
                r{revision ?? load.revision}
                {init.readOnly ? " · 읽기 전용" : ""}
              </span>
            </span>
          }
          topBarEnd={<><SelectionReporter />{!init.readOnly && <RecoveryReporter recovery={load.recovery} state={load.state} attach={(value) => { engine.current = value; }} />}</>}
        />
      </div>
      <a className="wb-design-credit" href="https://github.com/shaongitbd/doory" target="_blank" rel="noreferrer" title="Attribution Assurance License">
        디자인 편집기: {CREDIT}
      </a>
    </div>
  );
}

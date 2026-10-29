import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignSaveState, DesignSelection, DocumentAccess } from "@workbench/contracts";
import { EditorApp } from "@/editor";
import { useDocument, useSelection } from "@/editor/context";
import { migrateDocument } from "@/editor/engine/migrations";
import { panels } from "@/editor/panels/registry";
import type { EditorHandle, SaveState } from "@/types/adapter";
import type { DocObject, DoryDocument } from "@/types/document";
import { createWorkbenchAdapter, serializeDesign, type DesignDocumentState } from "./adapter";
import { listen, post } from "./bridge";
import { loadFonts } from "./fonts";
import { Gateway } from "./gateway";
// Panels that need a doory server (template and element catalogues, brand kits) are left out.
for (const id of ["templates", "elements", "brand"]) panels.unregister(id);

/**
 * The editor downloads exports through a temporary link. In Workbench they go to the work folder
 * instead, next to the design, and PDFs become documents of the work.
 */
function routeDownloads(gateway: Gateway, artifactId: string) {
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (!this.download || !this.href.startsWith("blob:")) return original.call(this);
    const name = this.download;
    void fetch(this.href)
      .then((response) => response.blob())
      .then((blob) => gateway.exportFile(artifactId, blob, name))
      .then((saved) => post({ type: "design:exported", name: saved.name, path: saved.path, artifactId: saved.artifactId }))
      .catch((error: unknown) => post({ type: "design:error", message: `내보내기를 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` }));
  };
}

export type DesignInit = { token: string; artifactId: string; revision: number | null; readOnly: boolean; access?: DocumentAccess };

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; document: DoryDocument; name: string; workId: string; revision: number; latest: number; gateway: Gateway; adapter: ReturnType<typeof createWorkbenchAdapter>; state: DesignDocumentState };

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

export function EditorHost({ init }: { init: DesignInit }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [revision, setRevision] = useState<number | null>(null);
  const editorRef = useRef<EditorHandle>(null);

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
      routeDownloads(gateway, init.artifactId);
      const state: DesignDocumentState = { revision: opened.revision };
      const adapter = createWorkbenchAdapter({
        gateway,
        artifactId: init.artifactId,
        state,
        fonts,
        onSaved: (saved) => {
          setRevision(saved);
          post({ type: "design:saved", revision: saved });
        },
      });
      if (!active) return;
      setLoad({
        kind: "ready",
        document,
        name: opened.artifact.name,
        workId: opened.artifact.workId,
        revision: opened.revision,
        latest: opened.artifact.revision,
        gateway,
        adapter,
        state,
      });
      post({ type: "design:opened", revision: opened.revision, pages: document.pages.length });
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (active) setLoad({ kind: "error", message });
      post({ type: "design:error", message });
    });
    return () => {
      active = false;
      stopAccess();
    };
  }, [init]);

  useEffect(
    () =>
      listen((message) => {
        if (message.type === "design:flush") void editorRef.current?.saveNow();
      }),
    [],
  );

  const meta = useMemo(
    () => (load.kind === "ready" ? { id: init.artifactId, title: load.name.replace(/\.design\.json$/i, ""), mode: init.readOnly ? ("shared-view" as const) : ("account" as const), revision: load.revision } : null),
    // The editor is mounted once per opened revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load.kind === "ready" ? load.revision : null],
  );

  if (load.kind === "loading") return <div className="wb-design-status">디자인을 여는 중…</div>;
  if (load.kind === "error") return <div className="wb-design-status wb-design-error">{load.message}</div>;

  async function saveAsCopy() {
    if (load.kind !== "ready") return;
    const document = editorRef.current?.getDocument();
    if (!document) return;
    const response = await fetch(`/api/works/${load.workId}/designs`, {
      method: "POST",
      headers: { authorization: `Bearer ${init.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: `${load.name.replace(/\.design\.json$/i, "")} (내 편집)`, text: serializeDesign(document) }),
    });
    const created = (await response.json()) as { id?: string; message?: string };
    if (!response.ok || !created.id) {
      post({ type: "design:error", message: created.message ?? "사본을 만들지 못했습니다." });
      return;
    }
    post({ type: "design:copied", artifactId: created.id });
  }

  return (
    <div className="wb-design">
      <div className="wb-design-editor">
        <EditorApp
          ref={editorRef}
          document={load.document}
          meta={meta!}
          adapter={load.adapter}
          onSaveStateChange={(state) => post({ type: "design:state", state: stateOf(state), message: state.status === "error" ? state.message : undefined })}
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
          topBarEnd={<SelectionReporter />}
        />
      </div>
      <a className="wb-design-credit" href="https://github.com/shaongitbd/doory" target="_blank" rel="noreferrer" title="Attribution Assurance License">
        디자인 편집기: {CREDIT}
      </a>
    </div>
  );
}

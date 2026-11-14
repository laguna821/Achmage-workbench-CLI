import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { encodeHwpSave, type HwpSaveMetadata } from "../../../packages/contracts/src/hwp.ts";
import { runSaveWith, type SaveEditorPort } from "../../office/src/hwp-save.ts";
import { studioReport } from "../../office/src/hwp-structure-report.ts";
import { notesWithBreaks, withControlCharacters } from "./hwp-census-fixture.ts";
import { hwpWasmPath } from "./hwp-resource.ts";
import { EventBus } from "./bus.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { OfficeOutputs } from "./office-output.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// H9b: the studio's own saves, end to end on the gateway side. The studio's live document is a
// real engine document behind a stand-in frame; the save hand-off is the real apps/office code
// (hwp-save.ts → hwp-structure-report.ts); what hwp.ts sends is the metadata commitSave receives.
beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });
const frame = (doc: HwpDocument) => ({ contentWindow: { rhwpStudio: { automation: { options: { dispatcher: { services: { wasm: { doc } } } } } } } }) as unknown as HTMLIFrameElement;
const tableOf = (doc: HwpDocument) => (JSON.parse(doc.getControls()) as { ctrlId: string; para: number; controlIndex: number }[]).find((control) => control.ctrlId === "tbl")!;
/** The studio: shows `live`; its export is `exported()` (an engine regression returns less than it shows). */
function studio(live: HwpDocument, exported: () => Uint8Array) {
  const locks: boolean[] = [];
  const editor: SaveEditorPort = {
    isPasswordProtected: async () => false,
    exportHwp: async () => exported(), exportHwpx: async () => exported(),
    exportHwpVerify: async () => ({ pageCountBefore: 1, pageCountAfter: 1, recovered: true }),
    listMemos: async () => [], setMemoLock: async (locked) => { locks.push(locked); }, measureTabs: async () => [], notifySaved: async () => undefined,
  };
  return { editor, locks, runSave: runSaveWith(() => studioReport(frame(live))) };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-hwp-studio-"));
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "studio", managedWorksDir: join(dir, "works"), dataDir: dir, kordoc: null });
  const work = manager.createWork({ title: "한글", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
  const live = HwpDocument.createEmpty(); live.createBlankDocument(); live.insertText(0, 0, 0, "표가 있는 문서"); live.createTable(0, 0, 0, 2, 2);
  const lossy = HwpDocument.createEmpty(); lossy.createBlankDocument(); lossy.insertText(0, 0, 0, "표가 있는 문서");
  const original = Buffer.from(live.exportHwpx()); writeFileSync(join(work.cwd, "문서.hwpx"), original);
  const artifact = manager.openFile(work.id, "문서.hwpx");
  return { manager, work, live, lossy, original, artifact };
}

describe("the studio's saves carry its live structure", () => {
  it("refuses a Save whose bytes lack a table the studio shows (file and revision untouched), and saves after a deliberate deletion", async () => {
    const { manager, live, lossy, original, artifact } = setup();
    const writer = manager.documents.registry.open(artifact.id, { viewId: "hwp-writer", windowId: "one", claim: true });
    const grants = new EditorGrants(), auth = grants.issue(artifact.id, { viewId: writer.view.viewId, writeToken: writer.writeToken });
    const server = createEditorsServer(manager.documents, grants, null); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let revision = 1;
    const sent: HwpSaveMetadata[] = [];
    // hwp.ts commitSave for Save: gateway.saveHwp(id, revision, bytes, { tabs, memos, structure })
    const api = {
      beginSave: async () => ({ ok: true as const, path: artifact.path, format: "hwpx" as const }),
      newTabs: async () => [], abortSave: () => {},
      commitSave: async (bytes: Uint8Array, tabs?: unknown, options?: { memos?: unknown; structure?: unknown }) => {
        const metadata = { tabs, memos: options?.memos, structure: options?.structure } as HwpSaveMetadata; sent.push(metadata);
        const response = await fetch(`${origin}/api/artifacts/${artifact.id}/hwp/save?revision=${revision}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: encodeHwpSave(metadata, bytes) });
        const body = await response.json() as { revision?: number; message?: string };
        if (!response.ok) return { ok: false as const, error: body.message! };
        revision = body.revision!; return { ok: true as const, path: artifact.path };
      },
    };
    try {
      const broken = studio(live, () => lossy.exportHwpx());
      const refused = await broken.runSave(broken.editor, api, "save");
      expect(refused).toMatchObject({ kind: "failed", reason: "write", detail: expect.stringMatching(/표 1→0.*원본 파일은 그대로입니다.*다른 이름으로 저장/) });
      expect(sent[0]!.structure!.objects.tbl).toBe(1);
      expect(broken.locks).toEqual([true, false]);
      expect(readFileSync(artifact.path)).toEqual(original); expect(manager.documents.get(artifact.id).revision).toBe(1);
      // The person deletes the table on purpose: the report is the state after the operation.
      const table = tableOf(live); live.deleteTableControl(0, table.para, table.controlIndex);
      const deleted = studio(live, () => live.exportHwpx());
      expect(await deleted.runSave(deleted.editor, api, "save")).toMatchObject({ kind: "saved" });
      expect(sent[1]!.structure!.objects.tbl ?? 0).toBe(0);
      expect(manager.documents.get(artifact.id).revision).toBe(2);
    } finally { live.free(); lossy.free(); }
  });

  it("lets Save As keep the work in a new file, with the warning, when the bytes lack what the studio shows", async () => {
    const { manager, live, lossy, original, artifact } = setup();
    const outputs = new OfficeOutputs(manager.documents, (source, path) => manager.openFile(source.workId, path));
    const plan = outputs.prepare(artifact.id, 1, "사본.hwpx");
    let warning: string | undefined, answer: unknown;
    // hwp.ts commitSave for Save As: commitOutput(plan, encodeHwpSave({ tabs, memos, structure }, bytes))
    const api = {
      beginSave: async () => ({ ok: true as const, path: plan.path, format: "hwpx" as const }),
      newTabs: async () => [], abortSave: () => {},
      commitSave: async (bytes: Uint8Array, tabs?: unknown, options?: { memos?: unknown; structure?: unknown }) => {
        const result = await outputs.commit(artifact.id, plan.id, Buffer.from(encodeHwpSave({ tabs, memos: options?.memos, structure: options?.structure } as HwpSaveMetadata, bytes)), false);
        warning = result.warning; answer = result; return { ok: true as const, path: result.path };
      },
    };
    try {
      const broken = studio(live, () => lossy.exportHwpx());
      expect(await broken.runSave(broken.editor, api, "saveAs")).toMatchObject({ kind: "saved", path: plan.path });
      expect(warning).toMatch(/표 1→0/);
      // m2-2: Save As answers like Save does — whether the studio's report was compared, and the text checked
      expect(answer).toMatchObject({ report: "compared", text: "checked" });
      expect(readFileSync(artifact.path)).toEqual(original);
    } finally { live.free(); lossy.free(); }
  });

  it("sends no report when the memo lock cannot be taken (input may move between count and export)", async () => {
    const { live, lossy } = setup();
    try {
      const unlocked = studio(live, () => lossy.exportHwpx());
      unlocked.editor.setMemoLock = async () => { throw new Error("no lock"); };
      let options: { structure?: unknown } | undefined;
      const api = { beginSave: async () => ({ ok: true as const, path: "/x.hwpx", format: "hwpx" as const }), newTabs: async () => [], abortSave: () => {}, commitSave: async (_: Uint8Array, __?: unknown, given?: { structure?: unknown }) => { options = given; return { ok: true as const, path: "/x.hwpx" }; } };
      await unlocked.runSave(unlocked.editor, api, "save");
      expect(options?.structure).toBeUndefined();
    } finally { live.free(); lossy.free(); }
  });

  it("says once in the console when the studio gives no report, saves the no-report way, and the gateway's answer says so", async () => {
    const { manager, live, artifact } = setup();
    const writer = manager.documents.registry.open(artifact.id, { viewId: "hwp-writer", windowId: "one", claim: true });
    const grants = new EditorGrants(), auth = grants.issue(artifact.id, { viewId: writer.view.viewId, writeToken: writer.writeToken });
    const server = createEditorsServer(manager.documents, grants, null); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let revision = 1;
    const answers: { report?: string; text?: string }[] = [];
    const api = {
      beginSave: async () => ({ ok: true as const, path: artifact.path, format: "hwpx" as const }),
      newTabs: async () => [], abortSave: () => {},
      commitSave: async (bytes: Uint8Array, tabs?: unknown, options?: { memos?: unknown; structure?: unknown }) => {
        const response = await fetch(`${origin}/api/artifacts/${artifact.id}/hwp/save?revision=${revision}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: encodeHwpSave({ tabs, memos: options?.memos, structure: options?.structure } as HwpSaveMetadata, bytes) });
        const body = await response.json() as { revision: number; report?: string; text?: string }; answers.push(body);
        revision = body.revision; return { ok: true as const, path: artifact.path };
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // a rebuilt studio that renamed an internal: the frame is there, its document is not reachable
      const renamed = { contentWindow: { rhwpStudio: { automation: {} } } } as unknown as HTMLIFrameElement;
      const editor = studio(live, () => live.exportHwpx()).editor;
      const runSave = runSaveWith(() => studioReport(renamed));
      expect(await runSave(editor, api, "save")).toMatchObject({ kind: "saved" });
      expect(await runSave(editor, api, "save")).toMatchObject({ kind: "saved" });
      expect(answers.map((answer) => answer.report)).toEqual(["absent", "absent"]);
      expect(warn.mock.calls.filter(([line]) => /Hangul save without the studio's structure report \(the studio's document is not reachable\)/.test(String(line)))).toHaveLength(1);
      // with the studio's report the answer says it was compared
      const reported = studio(live, () => live.exportHwpx());
      await reported.runSave(reported.editor, api, "save");
      expect(answers[2]!).toMatchObject({ report: "compared", text: "checked" });
      // a studio document that is there but cannot be counted: the console says so, not "not reachable"
      const uncountable = { contentWindow: { rhwpStudio: { automation: { options: { dispatcher: { services: { wasm: { doc: { getSectionCount: () => { throw new TypeError("freed"); } } } } } } } } } } as unknown as HTMLIFrameElement;
      await runSaveWith(() => studioReport(uncountable))(editor, api, "save");
      expect(warn.mock.calls.filter(([line]) => /\(the studio's document could not be counted \(TypeError\)\)/.test(String(line)))).toHaveLength(1);
      expect(answers[3]!.report).toBe("absent");
    } finally { warn.mockRestore(); live.free(); }
  });

  // N2-1 and S1: the studio's report of a document with a tab and a line break in its notes; and a studio whose
  // text census fails sends the structure with the text unchecked — saved, the answer and the console say so.
  it("saves a document whose notes hold a tab and a line break, and saves with the text unchecked when the studio cannot count it", async () => {
    const { manager, work } = setup();
    const bytes = await notesWithBreaks();
    writeFileSync(join(work.cwd, "각주.hwpx"), bytes);
    const artifact = manager.openFile(work.id, "각주.hwpx");
    const writer = manager.documents.registry.open(artifact.id, { viewId: "hwp-writer", windowId: "one", claim: true });
    const grants = new EditorGrants(), auth = grants.issue(artifact.id, { viewId: writer.view.viewId, writeToken: writer.writeToken });
    const server = createEditorsServer(manager.documents, grants, null); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let revision = 1;
    const sent: HwpSaveMetadata[] = [], answers: { report?: string; text?: string; message?: string }[] = [];
    const api = {
      beginSave: async () => ({ ok: true as const, path: artifact.path, format: "hwpx" as const }),
      newTabs: async () => [], abortSave: () => {},
      commitSave: async (saved: Uint8Array, tabs?: unknown, options?: { memos?: unknown; structure?: unknown }) => {
        const metadata = { tabs, memos: options?.memos, structure: options?.structure } as HwpSaveMetadata; sent.push(metadata);
        const response = await fetch(`${origin}/api/artifacts/${artifact.id}/hwp/save?revision=${revision}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: encodeHwpSave(metadata, saved) });
        const body = await response.json() as { revision?: number; report?: string; text?: string; message?: string }; answers.push(body);
        if (!response.ok) return { ok: false as const, error: body.message! };
        revision = body.revision!; return { ok: true as const, path: artifact.path };
      },
    };
    const live = new HwpDocument(bytes);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const counted = studio(live, () => live.exportHwpx());
      expect(await counted.runSave(counted.editor, api, "save")).toMatchObject({ kind: "saved" });
      expect(answers[0]).toMatchObject({ report: "compared", text: "checked" });
      const broken = new Proxy(live, { get: (target, name) => name === "getFootnoteInfo" ? () => '{"texts":["' : (target as never)[name] });
      const runSave = runSaveWith(() => studioReport(frame(broken as HwpDocument)));
      expect(await runSave(counted.editor, api, "save")).toMatchObject({ kind: "saved" });
      expect(sent[1]!.structure).toMatchObject({ textUnchecked: "글자 검사 못함 (각주·미주: SyntaxError)" });
      expect(answers[1]).toMatchObject({ report: "compared", text: "unchecked" });
      expect(warn.mock.calls.filter(([line]) => /without its text census \(글자 검사 못함 \(각주·미주: SyntaxError\)\)/.test(String(line)))).toHaveLength(1);
    } finally { warn.mockRestore(); live.free(); }
  });

  // N3-1 / T1: an HWPX holding carriage returns written as character references (generated files). The
  // studio's report counts them; the engine's HWPX writer drops them — Save of the unchanged document saves,
  // Save of an export that emptied a cell is still refused.
  it("saves an unchanged HWPX holding carriage returns with the studio's report, and still refuses an emptied cell", async () => {
    const { manager, work } = setup();
    const bytes = await withControlCharacters(), emptied = await withControlCharacters("");
    writeFileSync(join(work.cwd, "제어.hwpx"), bytes);
    const artifact = manager.openFile(work.id, "제어.hwpx");
    const writer = manager.documents.registry.open(artifact.id, { viewId: "hwp-writer", windowId: "one", claim: true });
    const grants = new EditorGrants(), auth = grants.issue(artifact.id, { viewId: writer.view.viewId, writeToken: writer.writeToken });
    const server = createEditorsServer(manager.documents, grants, null); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let revision = 1;
    const answers: { report?: string; text?: string; structure?: string; message?: string }[] = [];
    const api = {
      beginSave: async () => ({ ok: true as const, path: artifact.path, format: "hwpx" as const }),
      newTabs: async () => [], abortSave: () => {},
      commitSave: async (saved: Uint8Array, tabs?: unknown, options?: { memos?: unknown; structure?: unknown }) => {
        const response = await fetch(`${origin}/api/artifacts/${artifact.id}/hwp/save?revision=${revision}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: encodeHwpSave({ tabs, memos: options?.memos, structure: options?.structure } as HwpSaveMetadata, saved) });
        const body = await response.json() as { revision?: number; report?: string; text?: string; structure?: string; message?: string }; answers.push(body);
        if (!response.ok) return { ok: false as const, error: body.message! };
        revision = body.revision!; return { ok: true as const, path: artifact.path };
      },
    };
    const live = new HwpDocument(bytes), lossy = new HwpDocument(emptied);
    try {
      const unchanged = studio(live, () => live.exportHwpx());
      expect(await unchanged.runSave(unchanged.editor, api, "save")).toMatchObject({ kind: "saved" });
      expect(answers[0]).toMatchObject({ report: "compared", text: "checked", structure: "checked" });
      const broken = studio(live, () => lossy.exportHwpx());
      expect(await broken.runSave(broken.editor, api, "save")).toMatchObject({ kind: "failed", detail: expect.stringMatching(new RegExp(`표 칸 글자 ${"성명 홍길동".length}→0`)) });
      expect(manager.documents.get(artifact.id).revision).toBe(2);
    } finally { live.free(); lossy.free(); }
  });
});

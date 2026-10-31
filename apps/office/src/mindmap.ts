import { mountOfficeAi, officeAiTransport } from "./office-ai.ts";
import { Gateway, GatewayError, handshake, listen, post } from "./bridge.ts";
import { recovery } from "./recovery.ts";
import { dispatch, useTransport } from "./platform/electron-renderer.ts";
import { copyOfficeBytes, officeCopyBusy } from "./copy.ts";

const init = await handshake(), gateway = new Gateway(init.token);
const ai = mountOfficeAi(init, gateway);
const id = init.artifact.id, path = init.artifact.path;
let revision = init.artifact.revision, theme = init.theme, restored = false, opened = false, dirty = false, epoch = 0;
let file = await gateway.openMindmap(id, revision);
const report = (error: unknown) => post({ type: "office:error", message: error instanceof Error ? error.message : String(error) });
if (init.recover && !init.readOnly) {
  const kept = await recovery.get(id);
  if (kept && kept.baseRevision <= revision) {
    if (file.status !== "ok" || (await gateway.checkMindmap(id, kept.baseRevision, new Uint8Array(kept.bytes))).status !== "ok") {
      const error = new Error("마인드맵 복구본을 열지 못했습니다. 보관된 사본은 그대로 남아 있습니다."); report(error); throw error;
    }
    file = { status: "ok", bytes: new Uint8Array(kept.bytes) }; revision = kept.baseRevision; restored = true;
  }
} else if (!init.readOnly) await recovery.drop(id);

let recoveryQueue = Promise.resolve();
const queueRecovery = (task: () => Promise<void>) => recoveryQueue = recoveryQueue.catch(() => {}).then(task);
let closeAnswer: ((ok: boolean) => void) | null = null, recoveryAnswer: (() => void) | null = null;
let recoveryFailure = false;
async function keepBytes(bytes: Uint8Array) {
  if (init.readOnly || file.status !== "ok") return "skipped";
  const before = epoch, baseRevision = revision;
  try {
    if ((await gateway.checkMindmap(id, baseRevision, bytes)).status !== "ok") throw new Error("마인드맵 복구본의 형식이 올바르지 않습니다.");
    if (epoch !== before) return "superseded";
    await queueRecovery(async () => { if (epoch === before) await recovery.put(id, { bytes: bytes.slice().buffer, baseRevision, at: Date.now() }); });
    return epoch === before ? "written" : "superseded";
  } catch (error) { recoveryFailure = true; report(error); throw error; }
}
async function keep() {
  recoveryFailure = false;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { recoveryAnswer = null; reject(new Error("마인드맵 복구본을 받지 못했습니다. 편집 탭을 열어 두세요.")); }, 15000);
    recoveryAnswer = () => { clearTimeout(timer); recoveryAnswer = null; resolve(); };
    dispatch("mindmap:recovery-copy-now", []);
  });
  await recoveryQueue;
  if (recoveryFailure) throw new Error("마인드맵 복구본을 만들지 못했습니다. 편집 탭을 열어 두세요.");
}
let flushing: Promise<void> | null = null;
async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => { closeAnswer = null; resolve(false); }, 20000);
        closeAnswer = (value) => { clearTimeout(timer); closeAnswer = null; resolve(value); };
        dispatch("mindmap:close-save-request", []);
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!ok || dirty) { await keep(); post({ type: "office:flushed", revision: null }); }
      else post({ type: "office:flushed", revision });
    } catch (error) { report(error); post({ type: "office:flushed", revision: null }); }
  })().finally(() => { flushing = null; });
  return flushing;
}
listen((message) => {
  if (message.type === "office:theme") { theme = message.theme; dispatch("app:theme-changed", [theme]); }
  if (message.type === "office:flush") void flush();
  if (message.type === "office:rebase") { revision = message.revision; void flush(); }
  if (message.type === "office:keep") void keep().catch(report).finally(() => post({ type: "office:flushed", revision: null }));
});

let prefs: Record<string, unknown> = {};
try { prefs = JSON.parse(localStorage.getItem("workbench.office.mindmap.prefs") ?? "{}"); } catch { /* UI preferences are not document data. */ }
const fail = (channel: string) => { throw new Error(`마인드맵의 이 서비스를 아직 연결하지 못했습니다: ${channel}`); };
useTransport({
  invoke: officeAiTransport(ai, dispatch, async (channel, args) => {
    switch (channel) {
      case "mindmap:consume-pending": return path;
      case "mindmap:open-file": {
        if (args[0] !== path) throw new Error("열린 마인드맵만 읽을 수 있습니다.");
        if (file.status === "ok" && !file.bytes) file = await gateway.openMindmap(id, revision);
        if (!opened && file.status === "ok") { opened = true; post({ type: "office:opened", revision, recovered: restored }); }
        return { ...file, ...(restored ? { restored: "file" } : {}) };
      }
      case "mindmap:save": {
        if (init.readOnly || !opened) return { ok: false, error: "이 마인드맵에는 저장할 수 없습니다." };
        const request = args[0] as { bytes?: unknown; mode?: unknown } | null;
        if (request?.mode === "save" && officeCopyBusy()) return { ok: false, error: "사본 저장을 마친 뒤 저장해 주세요." };
        if (!request || !["save", "saveAs"].includes(String(request.mode))) return { ok: false, error: "저장 요청을 확인해 주세요." };
        if (!(request.bytes instanceof Uint8Array)) return { ok: false, error: "마인드맵 파일 바이트가 올바르지 않습니다." };
        try {
          if (request.mode === "saveAs") {
            const bytes = request.bytes;
            const saved = await copyOfficeBytes(init, revision, "xmind", async () => bytes.slice().buffer);
            return saved ? { ok: true, path: saved.path } : { ok: false };
          }
          const saved = await gateway.saveMindmap(id, revision, request.bytes);
          revision = saved.revision; restored = false; epoch++;
          // The renderer owns its working tree. Retain no second full archive here after open.
          file = { status: "ok" };
          post({ type: "office:saved", revision });
          await queueRecovery(() => recovery.drop(id)).catch(report);
          return { ok: true, path };
        } catch (error) {
          await keepBytes(request.bytes).catch(() => {});
          if (error instanceof GatewayError && error.status === 409) {
            post({ type: "office:conflict", code: error.code, message: error.message });
            return { ok: false, error: "external-modified" };
          }
          report(error); return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "mindmap:recovery-copy": {
        const request = args[0] as { bytes?: unknown } | null;
        if (!(request?.bytes instanceof Uint8Array)) throw new Error("복구본 파일 바이트가 올바르지 않습니다.");
        return keepBytes(request.bytes);
      }
      case "mindmap:handoff-take": case "mindmap:seed-take": return null; // Existing file tabs have no creation handoff.
      case "app:get-language": return "ko";
      case "app:get-theme": return theme;
      case "app:get-auto-save-default": return { on: false, updatedAt: 0 };
      case "app:get-ai-panel-prefs": return prefs;
      case "app:set-ai-panel-prefs": {
        if (args[0] && typeof args[0] === "object") prefs = { ...prefs, ...args[0] };
        localStorage.setItem("workbench.office.mindmap.prefs", JSON.stringify(prefs)); dispatch("app:ai-panel-prefs-changed", [prefs]); return prefs;
      }
      default: return fail(channel);
    }
  }),
  send(channel, args) {
    if (channel === "mindmap:dirty-changed") { dirty = args[0] === true; post({ type: "office:dirty", dirty }); }
    else if (channel === "mindmap:close-save-result") closeAnswer?.(args[0] === true);
    else if (channel === "mindmap:recovery-copy-now-done") recoveryAnswer?.();
    else if (channel === "mindmap:make-from-document") report(new Error("마인드맵에서 다른 문서를 만드는 기능을 아직 연결하지 못했습니다."));
  },
});
await import("@ieum/apps/mindmap/src/preload/index.ts");
await import("@ieum/apps/mindmap/src/renderer/main.tsx");

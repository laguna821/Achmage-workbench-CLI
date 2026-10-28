// The slides editor's worker: IeumOffice's slides editing code (apps/slides/src/main, unchanged)
// with Workbench's platform in place of Electron and Node (src/platform). The page's renderer calls
// its IPC handlers through here; the document lives in memory as one working copy.
import "../platform/globals.ts";
import { savePptx } from "@genoffice/pptx-engine";
import { setUiLang } from "@genoffice/i18n";
import { sessions } from "@ieum/apps/slides/src/main/session-state.ts";
import { createSlidesView, registerSlidesIpc, slidesIsDirty } from "@ieum/apps/slides/src/main/slides-main.ts";
import { connect, emit, invoke } from "../platform/electron.ts";
import { vfs } from "../platform/fs.ts";
import { setFontToken } from "./fonts.ts";
import type { WorkerCall, WorkerMessage } from "./protocol.ts";

const scope = self as unknown as { postMessage(message: WorkerMessage, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<WorkerCall>) => void) | null };
const post = (message: WorkerMessage, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

let viewId = 0;
let path = "";

connect({
  deliver: (_page, channel, args) => post({ type: "send", channel, args }),
  notice: (message) => post({ type: "notice", message }),
});

const bytesOf = (data: Uint8Array) => {
  const copy = data.slice();
  return copy.buffer;
};

async function handle(call: WorkerCall): Promise<{ value: unknown; unhandled?: boolean; transfer?: Transferable[] }> {
  switch (call.type) {
    case "init":
      setFontToken(call.token);
      setUiLang("ko");
      registerSlidesIpc();
      return { value: true };
    case "open": {
      path = `/document/${call.name.replace(/[\\/]/g, "_")}`;
      vfs.write(path, new Uint8Array(call.bytes));
      viewId = createSlidesView(path).webContents.id;
      return { value: viewId };
    }
    case "invoke": {
      const { handled, result } = invoke(viewId, call.channel, call.args);
      return handled ? { value: await result } : { value: null, unhandled: true };
    }
    case "send":
      emit(viewId, call.channel, call.args);
      return { value: null };
    case "saved-bytes": {
      const data = vfs.read(path);
      if (!data) throw new Error("저장된 사본이 없습니다.");
      const buffer = bytesOf(data);
      return { value: buffer, transfer: [buffer] };
    }
    case "snapshot": {
      const session = sessions.get(viewId);
      if (!session) return { value: null };
      const buffer = bytesOf(await savePptx(session.opened));
      return { value: buffer, transfer: [buffer] };
    }
    case "dirty":
      return { value: slidesIsDirty(viewId) };
    case "mark-dirty": {
      const session = sessions.get(viewId);
      if (session) session.metaDirty = true;
      return { value: true };
    }
  }
}

scope.onmessage = (event) => {
  const call = event.data;
  handle(call).then(
    ({ value, unhandled, transfer }) => {
      try {
        post({ type: "reply", id: call.id, ok: true, value, ...(unhandled ? { unhandled } : {}) }, transfer);
      } catch (error) {
        post({ type: "reply", id: call.id, ok: false, error: `응답을 보내지 못했습니다: ${error instanceof Error ? error.message : String(error)}` });
      }
    },
    (error: unknown) => post({ type: "reply", id: call.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
};

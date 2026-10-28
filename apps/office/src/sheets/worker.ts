// The spreadsheet editor's worker: IeumOffice's sheets editing code (apps/sheets/src/main,
// unchanged) with Workbench's platform in place of Electron and Node (src/platform) and its Rust
// xlsx engine compiled to WebAssembly (engine-client.ts) in place of the separate engine process.
// The page's renderer calls its IPC handlers through here; the workbook lives in memory as one
// working copy.
import "../platform/globals.ts";
import { setUiLang } from "@genoffice/i18n";
import { createSheetsView, queueWorkbookForView, registerSheetsIpc } from "@ieum/apps/sheets/src/main/sheets-main.ts";
import { connect, emit, invoke } from "../platform/electron.ts";
import { vfs } from "../platform/fs.ts";
import type { WorkerCall, WorkerMessage } from "../slides/protocol.ts";

const scope = self as unknown as { postMessage(message: WorkerMessage, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<WorkerCall>) => void) | null };
const post = (message: WorkerMessage, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

let viewId = 0;
let path = "";

connect({
  deliver: (_page, channel, args) => post({ type: "send", channel, args }),
  notice: (message) => post({ type: "notice", message }),
});

async function handle(call: WorkerCall): Promise<{ value: unknown; unhandled?: boolean; transfer?: Transferable[] }> {
  switch (call.type) {
    case "init":
      setUiLang("ko");
      vfs.mkdir("/tmp");
      registerSheetsIpc();
      return { value: true };
    case "open": {
      path = `/document/${call.name.replace(/[\\/]/g, "_")}`;
      vfs.write(path, new Uint8Array(call.bytes));
      const view = createSheetsView({ includeAiHandlers: false, openingWorkbook: true });
      queueWorkbookForView(view.webContents, path);
      viewId = view.webContents.id;
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
      const buffer = data.slice().buffer;
      return { value: buffer, transfer: [buffer] };
    }
    case "snapshot":
    case "dirty":
    case "mark-dirty":
      // The spreadsheet editor tracks unsaved edits in the page (its edit journal).
      return { value: null };
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

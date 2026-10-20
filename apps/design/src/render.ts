import type { DesignHostMessage } from "@workbench/contracts";
import { pageSize } from "@/editor/engine/docOps";
import { FontManager } from "@/editor/engine/fonts";
import { migrateDocument } from "@/editor/engine/migrations";
import { renderPageToCanvas } from "@/editor/engine/render";
import type { LoadContext } from "@/editor/engine/serialization";
import type { FontFamily } from "@/types/api";
import { listen, post } from "./bridge";
import { loadFonts } from "./fonts";
import { Gateway } from "./gateway";

// Thumbnails for the conversation: the Workbench window sends a design revision's JSON, this page
// draws one page with the editor's own engine and answers with an image. One render at a time.

type Request = Extract<DesignHostMessage, { type: "render:request" }>;

export function startRenderService() {
  let gateway: Gateway | null = null;
  let fonts: Promise<FontFamily[]> | null = null;
  let queue = Promise.resolve();

  async function render(request: Request) {
    if (!gateway || !fonts) throw new Error("렌더 준비가 안 됐습니다.");
    const document = migrateDocument(JSON.parse(request.document));
    const page = document.pages[Math.min(Math.max(request.page, 0), document.pages.length - 1)];
    const size = pageSize(document, page);
    const manager = new FontManager(null);
    manager.remember(await fonts);
    const context: LoadContext = {
      resolveSrc: (src) => gateway!.resolve(request.artifactId, src),
      ensureFonts: (uses) => manager.ensure(uses),
    };
    const canvas = await renderPageToCanvas(page, size, context, { multiplier: Math.min(4, request.width / size.width) });
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    canvas.width = canvas.height = 0;
    return { dataUrl, pages: document.pages.length };
  }

  listen((message) => {
    if (message.type === "render:init") {
      gateway = new Gateway(message.token);
      fonts = loadFonts(gateway);
      return;
    }
    if (message.type !== "render:request") return;
    queue = queue.then(() =>
      render(message).then(
        (result) => post({ type: "render:result", id: message.id, ...result }),
        (error: unknown) => post({ type: "render:result", id: message.id, dataUrl: null, pages: 0, error: error instanceof Error ? error.message : String(error) }),
      ),
    );
  });
  post({ type: "render:ready" });
}

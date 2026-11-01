import { createTextEditor } from "./text-editor.ts";
const params = new URLSearchParams(location.search);
if (params.has("present")) {
  const url = params.get("preview") ?? "";
  if (!/^\/preview\/[A-Za-z0-9_-]{32}\/document\.html$/.test(url)) throw new Error("발표할 원본 문서를 다시 열어 주세요.");
  // The original presentation view receives a read-only preview, no editor grant.
  Object.assign(window, { htmlApi: { getPreviewInfo: async () => ({ url }), getLanguage: async () => "ko", onLanguageChanged: () => () => {}, getTheme: async () => params.get("theme") ?? "system", onThemeChanged: () => () => {} } });
} else Object.assign(window, { htmlApi: await createTextEditor("html") });
await import("@ieum/apps/html/src/renderer/main.tsx");

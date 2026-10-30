import { createTextEditor } from "./text-editor.ts";
Object.assign(window, { htmlApi: await createTextEditor("html") });
await import("@ieum/apps/html/src/renderer/main.tsx");

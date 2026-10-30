import { createTextEditor } from "./text-editor.ts";
Object.assign(window, { markdownApi: await createTextEditor("markdown") });
await import("@ieum/apps/markdown/src/renderer/main.tsx");

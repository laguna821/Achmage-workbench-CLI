import { knowledgeReady } from "./knowledge-transport.ts";
await import("@ieum/apps/shell/src/preload/index.ts");
await import("./knowledge-view.jsx");
knowledgeReady();

import { readFileSync } from "node:fs";

/** The one way a rig opens documents in their EDITOR (doc-default made 쪽 보기 first the app's default): see editor-first.js. */
export const EDITOR_FIRST = readFileSync(new URL("./editor-first.js", import.meta.url), "utf8");

/** Before the page loads: on a Playwright page or context. */
export const editorFirst = (target: { addInitScript(script: { content: string }): Promise<unknown> }) => target.addInitScript({ content: EDITOR_FIRST });

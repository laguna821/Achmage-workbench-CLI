// The pptx engine as the slides editing code sees it inside Workbench: unchanged, except that its
// streamed save (written for Node streams) writes the working copy from the in-memory save.
import { savePptx } from "@ieum/packages/pptx-engine/src/index.ts";
import { writeFileSync } from "../platform/fs.ts";

export * from "@ieum/packages/pptx-engine/src/index.ts";

export async function savePptxToFile(opened: unknown, path: string): Promise<void> {
  writeFileSync(path, await savePptx(opened));
}

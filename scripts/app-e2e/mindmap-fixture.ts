import { createRequire } from "node:module";
const require = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url));
const JSZip = require("jszip");

/** Generated fixtures only: no third-party documents or private content. */
export async function mindmapFixture(title = "Native map", options: { legacy?: boolean; encrypted?: boolean; invalid?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  const content = [{ id: "sheet-1", title: "First sheet", futureSheetKey: { keep: true }, rootTopic: {
    id: "root-1", title, futureTopicKey: [1, "preserve"], structureClass: "org.xmind.ui.map.unbalanced",
    children: { attached: [
      { id: "child-1", title: "First branch", notes: { plain: { content: "Original note" } } },
      { id: "child-2", title: "Second branch", labels: ["<img src=x onerror=alert(1)>"], image: { src: "xap:resources/picture.png", width: 40, height: 40 } },
    ], detached: [{ id: "floating-1", title: "Preserved floating topic", future: "kept" }] },
  } }];
  const entry = options.legacy ? "content.xml" : "content.json";
  zip.file(entry, options.legacy ? "<xmap-content/>" : options.invalid ? "not JSON" : JSON.stringify(content));
  zip.file("manifest.json", JSON.stringify({ "file-entries": { [entry]: options.encrypted ? { "encryption-data": {} } : {}, "resources/picture.png": {} } }));
  zip.file("metadata.json", '{"creator":{"name":"Workbench test fixture"},"unknown":"keep exactly"}');
  zip.file("resources/picture.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=", "base64"));
  zip.file("future/custom.bin", Buffer.from([0, 128, 255, 17]));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function readMindmapFixture(bytes: Uint8Array): Promise<{ sheets: any[]; entry(name: string): Promise<Buffer | null> }> {
  const zip = await JSZip.loadAsync(bytes);
  return { sheets: JSON.parse(await zip.file("content.json").async("string")), entry: async (name) => zip.file(name)?.async("nodebuffer") ?? null };
}

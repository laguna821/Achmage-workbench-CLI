import { isOfficeFormat, type Artifact, type DocumentTools } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { designThumb } from "./design.ts";
import { officePageImage } from "./office.ts";
import { pdfDocument, pdfPageImage } from "./pdfpages.ts";

// Home "문서": the first page of each document, drawn the way its own view draws it (page images
// of office files, kordoc pages of Hangul files, the design renderer, PDF.js) or, for text, its
// opening lines. Drawn two at a time and only when asked (cards ask when they come into view):
// a first page image may start the office renderer on the gateway.

export type Thumb = { kind: "image"; url: string } | { kind: "text"; text: string } | { kind: "none" };

const LIMIT = 2;
let running = 0;
const waiting: (() => void)[] = [];

function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          waiting.shift()?.();
        });
    };
    if (running < LIMIT) run();
    else waiting.push(run);
  });
}

const cache = new Map<string, Promise<Thumb>>();

/** The first lines of a text document, without the marks that would look like noise when small. */
export function excerpt(text: string, format: Artifact["format"], length = 360) {
  const plain =
    format === "html"
      ? text
          .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
          .replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr)>/gi, "\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
      : text
          .replace(/^---\n[\s\S]*?\n---\n/, "")
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
          .replace(/[*_`~]/g, "");
  return plain
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, length);
}

async function draw(api: Api, artifact: Artifact, tools: DocumentTools | null): Promise<Thumb> {
  const revision = artifact.revision;
  if (artifact.format === "design") return { kind: "image", url: await designThumb({ artifactId: artifact.id, revision }, 0, 320) };
  if (isOfficeFormat(artifact.format)) {
    if (!tools?.ieumoffice.available) return { kind: "none" };
    return { kind: "image", url: await officePageImage({ artifactId: artifact.id, revision }, 1) };
  }
  if (artifact.format === "hwpx" || artifact.format === "hwp") {
    if (!tools?.kordoc.available) return { kind: "none" };
    const first = (await api.pages(artifact.id, revision)).pages[0];
    return first ? { kind: "image", url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(first.svg)}` } : { kind: "none" };
  }
  if (artifact.format === "pdf") return { kind: "image", url: await pdfPageImage(await pdfDocument(api, artifact.id, revision), 1, 280) };
  const { text } = await api.artifactText(artifact.id, revision);
  return { kind: "text", text: excerpt(text, artifact.format) };
}

/** The thumbnail of a document's latest revision (kept: revisions never change). */
export function thumbOf(api: Api, artifact: Artifact, tools: DocumentTools | null): Promise<Thumb> {
  const key = `${artifact.id}@${artifact.revision}`;
  let thumb = cache.get(key);
  if (!thumb) {
    thumb = limited(() => draw(api, artifact, tools)).catch((): Thumb => ({ kind: "none" }));
    cache.set(key, thumb);
    if (cache.size > 240) cache.delete(cache.keys().next().value!);
  }
  return thumb;
}

// @vitest-environment jsdom
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { droppedImages, paragraphAround, pastedImages } from "./components/docs/image-paste.ts";
import { isLocalSrc } from "./components/docs/DocImages.tsx";

// Pictures pasted into the Markdown editor: when a paste is a picture, and where its line goes.

/** A clipboard as the browser hands it to a paste: files plus text flavors. */
function clipboard(files: File[], flavors: Record<string, string> = {}) {
  return {
    files,
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    getData: (type: string) => flavors[type] ?? "",
  } as unknown as DataTransfer;
}
const picture = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });

describe("pasted pictures", () => {
  it("take a screenshot or a browser's copied image, but leave text copies (with their picture) to the text", () => {
    expect(pastedImages(clipboard([picture]))).toEqual([picture]);
    // Browser "Copy image": the picture, an <img>-only fragment and the address as text.
    expect(pastedImages(clipboard([picture], { "text/plain": "https://example.com/a.png", "text/html": '<img src="https://example.com/a.png">' }))).toEqual([picture]);
    // Word or a spreadsheet: text and a picture of the selection.
    expect(pastedImages(clipboard([picture], { "text/plain": "표의 글", "text/html": "<table><tr><td>표의 글</td></tr></table>" }))).toEqual([]);
    expect(pastedImages(clipboard([new File(["x"], "notes.txt", { type: "text/plain" })]))).toEqual([]);
    expect(pastedImages(null)).toEqual([]);
  });

  it("take dropped pictures by type or, without one, by name", () => {
    const unnamed = new File(["x"], "도식.webp");
    expect(droppedImages(clipboard([picture, unnamed, new File(["x"], "a.pdf", { type: "application/pdf" })]))).toEqual([picture, unnamed]);
  });
});

describe("where an inserted picture goes", () => {
  const around = (text: string) => {
    const at = text.indexOf("|");
    return paragraphAround(Text.of(text.replace("|", "").split("\n")), at);
  };

  it("is a paragraph of its own", () => {
    expect(around("도식은 아래에.|")).toEqual({ before: "\n\n", after: "" });
    expect(around("도식은 아래에.|\n다음 문단")).toEqual({ before: "\n\n", after: "\n" });
    expect(around("앞|뒤")).toEqual({ before: "\n\n", after: "\n\n" });
    expect(around("문단\n|\n문단")).toEqual({ before: "\n", after: "\n" });
    expect(around("문단\n\n|\n\n문단")).toEqual({ before: "", after: "" });
    expect(around("|")).toEqual({ before: "", after: "" });
    expect(around("|첫 줄")).toEqual({ before: "", after: "\n\n" });
  });
});

describe("preview pictures", () => {
  it("fetch only what the work folder holds", () => {
    expect(isLocalSrc("assets/a1b2.png")).toBe(true);
    expect(isLocalSrc("../assets/%EA%B7%B8%EB%A6%BC.png")).toBe(true);
    expect(isLocalSrc("https://pub-1.r2.dev/a.png")).toBe(false);
    expect(isLocalSrc("//cdn.example.com/a.png")).toBe(false);
    expect(isLocalSrc("data:image/png;base64,AA==")).toBe(false);
    expect(isLocalSrc("")).toBe(false);
  });
});

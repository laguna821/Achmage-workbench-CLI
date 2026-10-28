import { describe, expect, it } from "vitest";
import type { Artifact } from "@workbench/contracts";
import { nestDocs } from "./pages.ts";

const doc = (id: string, path: string, format: Artifact["format"] = "markdown"): Artifact => ({
  id,
  workId: "w",
  path,
  name: path.split("/").pop()!,
  format,
  revision: 1,
  sha256: "",
  size: 0,
  diskState: "same",
  readBy: {},
  createdAt: 0,
  updatedAt: 0,
});

describe("subpages in the tree", () => {
  it("puts pages from an A/ folder under A.md, by name, keeping the rest in their order", () => {
    const docs = [doc("z", "/w/Z.md"), doc("b", "/w/A/b.md"), doc("a", "/w/A.md"), doc("a1", "/w/A/a.md"), doc("deep", "/w/A/a/x.md"), doc("pdf", "/w/A.pdf", "pdf"), doc("loose", "/w/B/c.md")];
    expect(nestDocs(docs).map(({ artifact, depth }) => `${artifact.id}:${depth}`)).toEqual(["z:0", "a:0", "a1:1", "deep:2", "b:1", "pdf:0", "loose:0"]);
  });
});

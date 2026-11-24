import { expect, it } from "vitest";
import { folderOf, localPathOf } from "./remote-links.ts";

// 0.5.6: a file link in a conversation's answer, opened on a phone joined to the PC (the owner, 2026-11-20).
it("reads a local file path out of a link; web links and anchors are not paths", () => {
  expect(localPathOf("/home/kim/강의/슬라이드-구성.md")).toBe("/home/kim/강의/슬라이드-구성.md");
  expect(localPathOf(encodeURI("/home/kim/강의/링크 메모.md"))).toBe("/home/kim/강의/링크 메모.md");
  expect(localPathOf("file:///home/kim/x.md")).toBe("/home/kim/x.md");
  expect(localPathOf("/home/kim/x.md#L12")).toBe("/home/kim/x.md");
  expect(localPathOf("C:\\Users\\kim\\x.md")).toBe("C:\\Users\\kim\\x.md");
  for (const href of ["https://example.com/x.md", "//cdn.example.com/x", "#각주", "mailto:a@b.c", "x.md", ""]) expect(localPathOf(href)).toBeNull();
});

it("finds the folder a path lies in (deepest first) and its path inside it; never one it only shares a prefix with", () => {
  const folders = [{ id: "w1", workId: "w1", cwd: "/home/kim/강의" }, { id: "s1", workId: "w1", workspaceId: "s1", cwd: "/home/kim/강의/사본" }];
  expect(folderOf("/home/kim/강의/a/b.md", folders)).toEqual({ workId: "w1", workspaceId: undefined, relative: "a/b.md" });
  expect(folderOf("/home/kim/강의/사본/c.md", folders)).toEqual({ workId: "w1", workspaceId: "s1", relative: "c.md" });
  expect(folderOf("/home/kim/강의2/c.md", folders)).toBeNull();
  expect(folderOf("/etc/hostname", folders)).toBeNull();
});

it("불러오기 from a phone: files over 25 MB are left out before anything is sent, with one line", async () => {
  const { phoneUploads, PHONE_UPLOAD_LIMIT } = await import("./remote-links.ts");
  const file = (name: string, size: number) => ({ name, size }) as File;
  const { send, line } = phoneUploads([file("작은.pdf", 1000), file("큰.hwpx", PHONE_UPLOAD_LIMIT + 1)]);
  expect(send.map((entry) => entry.name)).toEqual(["작은.pdf"]);
  expect(line).toContain("25MB");
  expect(line).toContain("큰.hwpx");
  expect(phoneUploads([file("작은.pdf", 10)]).line).toBeNull();
});

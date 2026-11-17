// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Note } from "../../top-notice.ts";
import { DocRenameDialog, docStem } from "./DocRenameDialog.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const doc = (name: string, format: Artifact["format"] = "markdown") => ({ id: "a1", workId: "w", path: `/w/${name}`, name, format, revision: 1, sha256: "", size: 1, diskState: "same", readBy: {}, createdAt: 0, updatedAt: 0 }) as Artifact;

it("edits the name without its extension and says the extension stays", () => {
  render(<DocRenameDialog artifact={doc("강의안.md")} rename={vi.fn()} notify={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "문서 이름 바꾸기" })).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "이름" }) as HTMLInputElement).value).toBe("강의안");
  expect(screen.getByText("파일 이름도 바뀝니다. 확장자(.md)는 그대로입니다.")).toBeTruthy();
  expect(docStem(doc("수업.design.json", "design"))).toBe("수업");
});

it("renames, tells what happened with 되돌리기, and 되돌리기 renames back", async () => {
  const notes: Note[] = [];
  const rename = vi.fn(async (_id: string, name: string) => ({ artifact: doc(`${name}.md`), noteLinks: name === "3주차 강의안" ? 2 : 0 }));
  const onClose = vi.fn();
  render(<DocRenameDialog artifact={doc("강의안.md")} rename={rename} notify={(note) => notes.push(note)} onClose={onClose} />);
  fireEvent.change(screen.getByRole("textbox", { name: "이름" }), { target: { value: "3주차 강의안" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "바꾸기" })); });
  expect(rename).toHaveBeenCalledWith("a1", "3주차 강의안");
  expect(onClose).toHaveBeenCalled();
  expect(notes[0]!.text).toBe("이름을 「3주차 강의안.md」로 바꿨습니다. 프로젝트 노트의 링크 2곳도 고쳤습니다.");
  await act(async () => { notes[0]!.action!.run(); });
  expect(rename).toHaveBeenLastCalledWith("a1", "강의안");
  expect(notes[1]!.text).toBe("이름을 「강의안.md」로 되돌렸습니다.");
});

it("shows the gateway's refusal in the dialog and keeps it open", async () => {
  const rename = vi.fn(async () => { throw new Error("같은 폴더에 「기존.md」 파일이 이미 있습니다. 다른 이름을 골라 주세요."); });
  const onClose = vi.fn();
  render(<DocRenameDialog artifact={doc("강의안.md")} rename={rename} notify={vi.fn()} onClose={onClose} />);
  fireEvent.change(screen.getByRole("textbox", { name: "이름" }), { target: { value: "기존" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "바꾸기" })); });
  expect(screen.getByRole("alert").textContent).toBe("같은 폴더에 「기존.md」 파일이 이미 있습니다. 다른 이름을 골라 주세요.");
  expect(onClose).not.toHaveBeenCalled();
});

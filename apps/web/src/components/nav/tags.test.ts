import { describe, expect, it, vi } from "vitest";
import type { ProjectWrite, Work } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../../api.ts";
import { addNoteTags, tagsNotice } from "./tags.ts";

// "태그 더하기" in the sidebar: the gateway changes a list one item per write, so the dialog's tags
// go in one at a time, as the project page adds them.

const work = (id: string, title = id) => ({ id, title, tags: [] }) as unknown as Work;
const written = (revision: number) => ({ token: "t", created: false, summary: "tags", page: { note: { exists: true, revision } } }) as unknown as ProjectWrite;
const gateway = (results: (ProjectWrite | Error)[]) => {
  const setProjectProperty = vi.fn(async (..._call: unknown[]) => {
    const next = results.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  return { api: { setProjectProperty } as unknown as Pick<Api, "setProjectProperty">, calls: setProjectProperty.mock.calls };
};

describe("adding tags from the sidebar", () => {
  it("adds two typed tags as two writes, the second from the revision the first returned — never the whole list", async () => {
    const { api, calls } = gateway([written(3), written(4)]);
    const result = await addNoteTags(api, work("w"), ["회의"], ["가", "나"]);
    expect(calls).toEqual([
      ["w", "tags", null, "tags", undefined, { add: "가" }],
      ["w", "tags", null, "tags", 3, { add: "나" }],
    ]);
    expect(result).toMatchObject({ added: ["가", "나"], missed: [], reason: null });
  });

  it("adds one tag to a note whose tags are written with #, without sending the tags it has", async () => {
    const { api, calls } = gateway([written(3)]);
    await addNoteTags(api, work("w"), ["회의"], ["새것"]);
    expect(calls).toEqual([["w", "tags", null, "tags", undefined, { add: "새것" }]]);
  });

  it("skips a tag the note already has (with or without #, in any case) and one typed twice", async () => {
    const { api, calls } = gateway([written(3)]);
    const result = await addNoteTags(api, work("w"), ["#회의", "Lecture"], ["회의", "lecture", "#가", "가"]);
    expect(calls).toEqual([["w", "tags", null, "tags", undefined, { add: "가" }]]);
    expect(result.added).toEqual(["가"]);
  });

  it("stops at a refusal: what went in and what did not are both said", async () => {
    const refusal = new ApiRequestError(409, { code: "note_changed", message: "그 사이 노트가 바뀌었습니다." });
    const { api, calls } = gateway([written(3), refusal]);
    const result = await addNoteTags(api, work("w", "강의"), [], ["가", "나", "다"]);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ added: ["가"], missed: ["나", "다"], reason: refusal });
    expect(tagsNotice([result])).toEqual({ ok: false, text: "#가 태그는 더했고, #나 #다 태그는 더하지 못했습니다 — 그 사이 노트가 바뀌었습니다." });
  });

  it("says one line when every tag went in, and which project did not take them when one refused", async () => {
    const fine = await addNoteTags(gateway([written(3), written(4)]).api, work("a", "강의"), [], ["가", "나"]);
    const also = await addNoteTags(gateway([written(8), written(9)]).api, work("b", "연구"), [], ["가", "나"]);
    expect(tagsNotice([fine])).toEqual({ ok: true, text: "#가 #나 태그를 더했습니다." });
    expect(tagsNotice([fine, also])).toEqual({ ok: true, text: "#가 #나 태그를 더했습니다 (프로젝트 2개)." });
    const refused = await addNoteTags(gateway([new Error("이 속성은 값 하나만 담습니다.")]).api, work("c", "행정"), [], ["가", "나"]);
    expect(tagsNotice([fine, refused])).toEqual({ ok: false, text: "「행정」: #가 #나 태그는 더하지 못했습니다 — 이 속성은 값 하나만 담습니다. (다른 프로젝트 1개에는 모두 더했습니다.)" });
    // Nothing to add (the note has them all): nothing to say.
    expect(tagsNotice([await addNoteTags(gateway([]).api, work("d"), ["가"], ["가"])])).toBeNull();
  });
});

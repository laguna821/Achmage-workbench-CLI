import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api.ts";
import { NoteWriteSkipped, sendNoteWrite } from "./note-writes.ts";

// The one line of writes a note has in a window, whichever page sends them.

const stale = () => new ApiRequestError(409, { code: "note_changed", message: "그 사이 노트가 바뀌었습니다." });
const revision = (made: number | null) => made;
/** A write the test finishes by hand. */
function held() {
  let finish: (made: number | null) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const make = vi.fn((_base: number | null) => new Promise<number | null>((resolve, reject) => { finish = resolve; fail = reject; }));
  return { make, finish: (made: number | null) => finish(made), fail: (error: unknown) => fail(error) };
}
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("a note's writes in one window", () => {
  it("go one after another, each from the revision the one before it made — whoever sends them", async () => {
    const gateway = {};
    const first = held();
    const second = vi.fn(async (_base: number | null) => 4);
    const one = sendNoteWrite(gateway, "w", 2, first.make, revision);
    const two = sendNoteWrite(gateway, "w", 2, second, revision);
    await settle();
    expect(first.make).toHaveBeenCalledWith(2);
    expect(second).not.toHaveBeenCalled();
    first.finish(3);
    expect(await one).toBe(3);
    expect(await two).toBe(4);
    expect(second).toHaveBeenCalledWith(3);
    // A page still showing r2 writes from r4 now; a page showing r4 from r4.
    const third = vi.fn(async (_base: number | null) => 5);
    await sendNoteWrite(gateway, "w", 2, third, revision);
    expect(third).toHaveBeenCalledWith(4);
  });

  it("keeps each note and each gateway apart", async () => {
    const gateway = {};
    const waiting = held();
    void sendNoteWrite(gateway, "w", 2, waiting.make, revision);
    const other = vi.fn(async (_base: number | null) => 9);
    const elsewhere = vi.fn(async (_base: number | null) => 9);
    await sendNoteWrite(gateway, "x", 2, other, revision);
    await sendNoteWrite({}, "w", 2, elsewhere, revision);
    expect(other).toHaveBeenCalledWith(2);
    expect(elsewhere).toHaveBeenCalledWith(2);
    waiting.finish(3);
  });

  it("does not send what was waiting behind a write the gateway refused as stale, and forgets its own revisions", async () => {
    const gateway = {};
    await sendNoteWrite(gateway, "w", 2, async () => 3, revision);
    const first = held();
    const second = vi.fn(async (_base: number | null) => 9);
    const one = sendNoteWrite(gateway, "w", 3, first.make, revision);
    const two = sendNoteWrite(gateway, "w", 3, second, revision);
    await settle();
    first.fail(stale());
    await expect(one).rejects.toBeInstanceOf(ApiRequestError);
    await expect(two).rejects.toMatchObject({ why: "behind" });
    await expect(two).rejects.toBeInstanceOf(NoteWriteSkipped);
    expect(second).not.toHaveBeenCalled();
    // What comes after the refusal is sent again, from exactly what its page shows (another hand moved the note on).
    const third = vi.fn(async (_base: number | null) => 7);
    await sendNoteWrite(gateway, "w", 2, third, revision);
    expect(third).toHaveBeenCalledWith(2);
  });

  it("sends what was waiting behind a write refused for its own value (not stale)", async () => {
    const gateway = {};
    const first = held();
    const second = vi.fn(async (_base: number | null) => 3);
    const one = sendNoteWrite(gateway, "w", 2, first.make, revision);
    const two = sendNoteWrite(gateway, "w", 2, second, revision);
    await settle();
    first.fail(new ApiRequestError(400, { code: "bad_date", message: "날짜로 읽지 못했습니다." }));
    await expect(one).rejects.toBeInstanceOf(ApiRequestError);
    expect(await two).toBe(3);
    expect(second).toHaveBeenCalledWith(2);
  });

  it("does not send a write whose page no longer shows its note", async () => {
    const gateway = {};
    const make = vi.fn(async (_base: number | null) => 3);
    await expect(sendNoteWrite(gateway, "w", 2, make, revision, () => "x")).rejects.toMatchObject({ why: "left" });
    await expect(sendNoteWrite(gateway, "w", 2, make, revision, () => null)).rejects.toBeInstanceOf(NoteWriteSkipped);
    expect(make).not.toHaveBeenCalled();
    // Leaving is not a refusal: the next write for the note goes out.
    await sendNoteWrite(gateway, "w", 2, make, revision, () => "w");
    expect(make).toHaveBeenCalledWith(2);
  });

  it("asks what the page shows when the write's turn comes, not when it was queued", async () => {
    const gateway = {};
    const first = held();
    let showing: string | null = "w";
    const second = vi.fn(async (_base: number | null) => 4);
    void sendNoteWrite(gateway, "w", 2, first.make, revision);
    const two = sendNoteWrite(gateway, "w", 2, second, revision, () => showing);
    await settle();
    showing = "x";
    first.finish(3);
    await expect(two).rejects.toMatchObject({ why: "left" });
    expect(second).not.toHaveBeenCalled();
  });

  it("follows a first write that was undone (no file again) without going round", async () => {
    const gateway = {};
    await sendNoteWrite(gateway, "w", null, async () => 1, revision);
    await sendNoteWrite(gateway, "w", 1, async () => null, revision);
    const again = vi.fn(async (_base: number | null) => 1);
    await sendNoteWrite(gateway, "w", null, again, revision);
    expect(again).toHaveBeenCalledWith(null);
    // A page that still shows the file as it was before the undo writes onto "no file".
    const late = vi.fn(async (_base: number | null) => 2);
    await sendNoteWrite(gateway, "w", null, late, revision);
    expect(late).toHaveBeenCalledWith(1);
  });
});

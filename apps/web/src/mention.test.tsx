import { describe, expect, it } from "vitest";
import { filterMentions, insertMention, mentionTriggerAt, relocateMentions, type MentionItem } from "./mention.ts";

const items: MentionItem[] = [
  { id: "1", name: "보고서.hwpx", format: "hwpx", group: "work" },
  { id: "2", name: "강의 계획.md", format: "markdown", group: "open" },
  { id: "3", name: "특강 표지.pptx", format: "pptx", group: "work" },
  { id: "4", name: "강의.md", format: "markdown", group: "work" },
];

describe("@ document mentions", () => {
  it("opens at an @ that starts a word, never while Hangul is being composed", () => {
    expect(mentionTriggerAt("@강", 2)).toEqual({ start: 0, end: 2, query: "강" });
    const typed = "이걸 @강의 계";
    expect(mentionTriggerAt(typed, typed.length)).toEqual({ start: 3, end: typed.length, query: "강의 계" });
    expect(mentionTriggerAt("mail@kr", 7)).toBeNull();
    expect(mentionTriggerAt("@강", 2, { composing: true })).toBeNull();
    expect(mentionTriggerAt("첫 줄 @a\n둘째", 10)).toBeNull();
  });

  it("does not reopen inside or right after a picked mention", () => {
    const inserted = insertMention("이걸 @강", { start: 3, end: 5 }, "강의.md");
    expect(inserted.value).toBe("이걸 @강의.md ");
    expect(inserted.caret).toBe(inserted.value.length);
    expect(mentionTriggerAt(inserted.value, inserted.caret, { spans: [inserted.span] })).toBeNull();
    expect(mentionTriggerAt(inserted.value, inserted.caret - 1, { spans: [inserted.span] })).toBeNull();
  });

  it("drops a mention the user edited and moves the others", () => {
    const before = "@강의.md 와 @보고서.hwpx 를";
    const second = before.indexOf("@보고서");
    const spans = [{ start: 0, text: "@강의.md" }, { start: second, text: "@보고서.hwpx" }];
    expect(relocateMentions(before, `앞 ${before}`, spans)).toEqual([{ start: 2, text: "@강의.md" }, { start: second + 2, text: "@보고서.hwpx" }]);
    expect(relocateMentions(before, before.replace("강의", "강"), spans)).toEqual([{ start: second - 1, text: "@보고서.hwpx" }]);
  });

  it("lists names that start with the query first, open documents before others", () => {
    expect(filterMentions(items, "강").map((item) => item.id)).toEqual(["2", "4", "3"]);
    expect(filterMentions(items, "").map((item) => item.id)).toEqual(["2", "1", "3", "4"]);
    expect(filterMentions(items, "PPTX").map((item) => item.id)).toEqual(["3"]);
  });
});

import { expect, it } from "vitest";
import { baseProperties } from "./project-base.ts";

it("reads typed YAML without changing scalar/list shape, empty values, colon keys or bytes", () => {
  const markdown = '---\r\n"DIKM_단계:": "🔵 I"\r\nscalar: one\r\nlist: [one]\r\nempty:\r\nnumber: 2\r\nquoted: "2"\r\nflag: false\r\n---\r\n본문 그대로\r\n';
  expect(baseProperties(markdown)).toEqual({ "DIKM_단계:": "🔵 I", scalar: "one", list: ["one"], empty: null, number: 2, quoted: "2", flag: false });
  expect(markdown.endsWith("본문 그대로\r\n")).toBe(true);
  expect(baseProperties("본문만")).toEqual({});
});

it("rejects aliases, duplicate keys, invalid YAML and unclosed frontmatter instead of widening a view", () => {
  for (const source of ["---\nx: 1\nx: 2\n---", "---\nx: &secret [hi]\ny: *secret\n---", "---\nx: [\n---", "---\nx: 1"]) expect(baseProperties(source)).toBeNull();
});

import { describe, expect, it } from "vitest";
import {
  BUILT_IN_IMAGE_TEMPLATES,
  DRAW_MARK,
  assembleImagePrompt,
  dirOf,
  drawingInstruction,
  imageFileName,
  imageSlug,
  markdownImageLink,
  placeBlock,
  relativePath,
  resolvePath,
} from "./imagegen.ts";

describe("drawing prompts", () => {
  const infographic = BUILT_IN_IMAGE_TEMPLATES.find((template) => template.id === "infographic")!;

  it("puts the template first, then the request, the shape and the standing rules", () => {
    const prompt = assembleImagePrompt({ brief: "  한국 대학 입시 일정  ", template: infographic, rules: "No Korean words inside the image.", aspect: "landscape" });
    expect(prompt).toBe(`${infographic.prompt}\n\n한국 대학 입시 일정\n\nLandscape composition, 3:2 (1536×1024).\n\nAlways follow these rules:\nNo Korean words inside the image.`);
  });

  it("without a template, rules or a shape it is just the request", () => {
    expect(assembleImagePrompt({ brief: "파란 원", template: null, rules: "  ", aspect: "auto" })).toBe("파란 원");
    expect(assembleImagePrompt({ brief: "파란 원", aspect: "square" })).toBe("파란 원\n\nSquare composition, 1:1 (1024×1024).");
    expect(assembleImagePrompt({ brief: "파란 원", template: { prompt: "   " } })).toBe("파란 원");
  });

  it("tells Codex to call its image tool once, not to touch files, and carries the prompt last", () => {
    const text = drawingInstruction({ prompt: "Flat style.\n\n파란 원", transparent: true });
    expect(text.startsWith(DRAW_MARK)).toBe(true);
    expect(text).toContain("image_gen 도구를 정확히 한 번");
    expect(text).toContain("transparent_background=true");
    expect(text).toContain("명령을 실행하거나 파일을 만들거나 옮기거나 복사하지 마세요");
    expect(text.endsWith("프롬프트:\nFlat style.\n\n파란 원")).toBe(true);
    expect(drawingInstruction({ prompt: "x", transparent: false })).toContain("transparent_background=false");
  });

  it("the built-in templates are the plugin's five, with Korean names and unique ids", () => {
    expect(BUILT_IN_IMAGE_TEMPLATES.map((template) => template.id)).toEqual(["cmds-illustration", "infographic", "diagram", "icon-set", "photo"]);
    expect(BUILT_IN_IMAGE_TEMPLATES.every((template) => template.builtIn && /[가-힣]/.test(template.name) && template.prompt.length > 40)).toBe(true);
  });
});

describe("picture files and links", () => {
  it("slugs keep Hangul and digits, join the rest with '-', and stay short", () => {
    expect(imageSlug("고양이가 피아노를 친다!")).toBe("고양이가-피아노를-친다");
    expect(imageSlug("Data → Insight (2026)")).toBe("data-insight-2026");
    expect(imageSlug("...")).toBe("그림");
    expect(imageSlug("가".repeat(100)).length).toBe(40);
    expect(imageSlug("a b c d e f g h i j k l m n o p q r s t u v w x y z", 9)).toBe("a-b-c-d-e");
  });

  it("file names start with the local day", () => {
    const at = new Date(2026, 9, 28, 23, 50).getTime();
    expect(imageFileName("수업 표지 그림", at, "png")).toBe("2026-10-28-수업-표지-그림.png");
  });

  it("links read in Obsidian and CommonMark: no brackets in the text, no bare spaces in the path", () => {
    expect(markdownImageLink("표지 [초안]\n둘째 줄", "images/2026-10-28-표지.png")).toBe("![표지 초안 둘째 줄](images/2026-10-28-표지.png)");
    expect(markdownImageLink("x", "../My Images/a (1).png")).toBe("![x](../My%20Images/a%20%281%29.png)");
  });

  it("paths from a document to a picture", () => {
    expect(relativePath("/w", "/w/images/a.png")).toBe("images/a.png");
    expect(relativePath("/w/notes/week 1", "/w/images/a.png")).toBe("../../images/a.png");
    expect(relativePath("/w/images", "/w/images/a.png")).toBe("a.png");
    expect(dirOf("/w/notes/a.md")).toBe("/w/notes");
    expect(resolvePath("/w/notes", "../images/./a.png")).toBe("/w/images/a.png");
    expect(resolvePath("/w/notes", "/abs/a.png")).toBe("/abs/a.png");
  });

  it("a picture goes on lines of its own, with blank lines around it", () => {
    expect(placeBlock("첫 문단", 4, "![a](a.png)")).toEqual({ text: "첫 문단\n\n![a](a.png)\n", at: 4, insert: "\n\n![a](a.png)\n", cursor: 17 });
    expect(placeBlock("하나\n\n둘", 4, "![a](a.png)").text).toBe("하나\n\n![a](a.png)\n\n둘");
    expect(placeBlock("하나\n둘", 2, "![a](a.png)").text).toBe("하나\n\n![a](a.png)\n\n둘");
    expect(placeBlock("앞뒤", 1, "IMG").text).toBe("앞\n\nIMG\n\n뒤");
    expect(placeBlock("", 0, "IMG")).toMatchObject({ text: "IMG\n", cursor: 3 });
    expect(placeBlock("끝\n", 99, "IMG").text).toBe("끝\n\nIMG\n");
  });
});

// Drawing with GPT Image through Codex ("그림"). Codex's built-in image tool draws with the user's
// ChatGPT login; Workbench builds the prompt (template + request + standing rules), saves the
// picture into the work folder and shows it as a card in the conversation that asked. Claude has
// no image tool, so a Claude conversation draws through a Codex session of the same work.
// The pure helpers here are shared by the gateway and the UI.

/** How the picture should be shaped. Codex's image tool takes no size, so this goes into the prompt. */
export type ImageAspect = "auto" | "landscape" | "portrait" | "square";

export const IMAGE_ASPECTS: ImageAspect[] = ["auto", "landscape", "portrait", "square"];

export const ASPECT_LABEL: Record<ImageAspect, string> = { auto: "자동", landscape: "가로", portrait: "세로", square: "정사각" };

const ASPECT_PROMPT: Record<Exclude<ImageAspect, "auto">, string> = {
  landscape: "Landscape composition, 3:2 (1536×1024).",
  portrait: "Portrait composition, 2:3 (1024×1536).",
  square: "Square composition, 1:1 (1024×1024).",
};

export const isImageAspect = (value: unknown): value is ImageAspect => IMAGE_ASPECTS.includes(value as ImageAspect);

/** Style, palette and format rules put in front of what the user asks; the subject stays in the request. */
export type ImageTemplate = { id: string; name: string; prompt: string; builtIn?: boolean };

/** Built-in templates and the user's own, plus standing rules added to every drawing. */
export type ImageTemplates = { templates: ImageTemplate[]; rules: string };

/** The CMDS Achmage plugin's built-in templates, with Korean names (prompts stay English for the image model). */
export const BUILT_IN_IMAGE_TEMPLATES: ImageTemplate[] = [
  {
    id: "cmds-illustration",
    name: "CMDS 일러스트",
    prompt:
      "Editorial illustration in the CMDSPACE style: clean vector shapes, generous negative space, two-tone palette of CMDS green (#00B5AD) and CMDS pink (#E985A2) on an off-white background, subtle paper grain, no text, no logos, no watermark. Landscape composition suitable for a slide or a note header.",
    builtIn: true,
  },
  {
    id: "infographic",
    name: "인포그래픽",
    prompt:
      "Flat infographic with a clear visual hierarchy: a single headline area, three to five labeled sections with simple icons, consistent stroke width, muted background, high contrast labels in a clean sans-serif. Keep every label short and legible; no decorative text, no watermark.",
    builtIn: true,
  },
  {
    id: "diagram",
    name: "개념도",
    prompt:
      "Minimal concept diagram: boxes and arrows on a plain background, monochrome line work with one accent color, evenly spaced nodes, short labels only, no shadows, no gradients, no watermark. Designed to be read at small size inside a note.",
    builtIn: true,
  },
  {
    id: "icon-set",
    name: "아이콘 묶음",
    prompt: "A set of six matching flat icons arranged in a 3x2 grid on a white background, uniform line weight, rounded corners, single accent color, no text, no watermark.",
    builtIn: true,
  },
  {
    id: "photo",
    name: "사진처럼",
    prompt: "Photorealistic image, natural lighting, shallow depth of field, 35mm lens look, true-to-life colors, no text, no watermark.",
    builtIn: true,
  },
];

/** A drawing request from a conversation (or from a place in a Markdown document). */
export type DrawRequest = {
  /** Client-generated id; repeating it never draws twice. Also the id of the picture. */
  requestId: string;
  /** What to draw, as the user wrote it. */
  brief: string;
  templateId?: string | null;
  aspect?: ImageAspect;
  transparent?: boolean;
  /**
   * The Codex session of the same work that draws: null picks one (a Codex conversation draws
   * itself; a Claude conversation uses the work's drawing session), "helper" is the work's
   * drawing session in any case, "new" starts a new one.
   */
  via?: string | null;
  /** Drawn for this Markdown document: the UI puts the link where the user asked for it. */
  insertInto?: string | null;
};

/** One picture, as both the conversation that asked and the Codex session that drew show it. */
export type ImageInfo = {
  /** The request id of the drawing, or `codex:<item id>` for a picture Codex drew on its own. */
  id: string;
  workId: string;
  workspaceId?: string;
  /** The conversation that asked (a Claude one when Codex drew for it). */
  originSessionId: string;
  /** The Codex session that drew. */
  drawSessionId: string;
  status: "drawing" | "done" | "failed";
  brief: string;
  /** Name of the template used, if any, and its id (to draw again the same way). */
  template: string | null;
  templateId?: string | null;
  aspect: ImageAspect;
  transparent: boolean;
  /** What went to the image tool (template + request + rules). */
  prompt: string;
  /** The prompt as the image model rewrote it, when Codex reports it. */
  revisedPrompt: string | null;
  /** The file in the work folder (absolute), and the same relative to the work folder. */
  path: string | null;
  relPath: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  insertInto: string | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
};

export type DrawResult = { duplicate: boolean; image: ImageInfo };

/** A picture in a conversation: drawing, drawn (a card with the image), or failed. */
export type ImageItem = { kind: "image"; id: string; image: ImageInfo; at: number };

/** Marks a request that asked for a picture (shown as "그림" on the request). */
export type RequestDraw = { template: string | null; aspect: ImageAspect };

/** The line that opens a drawing turn; the stand-in Codex looks for it too. */
export const DRAW_MARK = "[Achmage Workbench · 그림]";

/** Template first, then the request, the shape, and the standing rules (the plugin's order). */
export function assembleImagePrompt({ brief, template, rules, aspect }: { brief: string; template?: Pick<ImageTemplate, "prompt"> | null; rules?: string | null; aspect?: ImageAspect | null }) {
  const parts = [template?.prompt.trim() ?? "", brief.trim(), aspect && aspect !== "auto" ? ASPECT_PROMPT[aspect] : ""].filter(Boolean);
  const standing = rules?.trim();
  return standing ? `${parts.join("\n\n")}\n\nAlways follow these rules:\n${standing}` : parts.join("\n\n");
}

/**
 * What Codex receives for a drawing: one call of its built-in image tool with this prompt, and
 * nothing else. Workbench copies the picture into the work folder itself, so the engine must not
 * run commands or move files (its image skill would otherwise copy the file into the project).
 */
export function drawingInstruction({ prompt, transparent }: { prompt: string; transparent: boolean }) {
  return [
    `${DRAW_MARK} 이 요청은 그림 한 장입니다.`,
    "- 내장 image_gen 도구를 정확히 한 번 불러 아래 프롬프트로 그리세요. 프롬프트의 주제와 스타일은 그대로 두세요(영어로 옮기는 것은 괜찮습니다).",
    "- 프롬프트가 이 대화의 내용을 가리키면(예: '방금 설명한 구조') 그 내용을 구체적으로 풀어 써서 넘기세요. 없는 대상이나 스타일을 지어내지는 마세요.",
    `- 투명 배경: ${transparent ? "예 (transparent_background=true)" : "아니요 (transparent_background=false)"}`,
    "- 명령을 실행하거나 파일을 만들거나 옮기거나 복사하지 마세요. 그림 파일은 Workbench가 작업 폴더의 images/에 저장합니다.",
    "- 그린 뒤에는 그림을 한국어 한 문장으로만 설명하세요.",
    "",
    "프롬프트:",
    prompt,
  ].join("\n");
}

/** A file-name part from the request: letters and digits of any script, joined by "-". */
export function imageSlug(text: string, max = 40) {
  const slug = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug || "그림";
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `images/<date>-<slug>.<ext>` without the folder: the local day the picture was made, then the slug. */
export function imageFileName(brief: string, at: number, extension: string) {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${imageSlug(brief)}.${extension}`;
}

/** `![alt](path)` that Obsidian and CommonMark both read: no brackets in the text, no bare spaces in the path. */
export function markdownImageLink(alt: string, path: string) {
  const text = alt.replace(/[[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const target = path.replace(/\\/g, "/").replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `![${text}](${target})`;
}

/** The folder part of a POSIX path. */
export const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".");

/** `to` as seen from the folder `from` (POSIX absolute paths). */
export function relativePath(from: string, to: string) {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return [...Array<string>(a.length - shared).fill(".."), ...b.slice(shared)].join("/") || ".";
}

/** `relative` resolved against the folder `base` (POSIX), with "." and ".." folded. */
export function resolvePath(base: string, relative: string) {
  const parts = relative.startsWith("/") ? [] : base.split("/").filter(Boolean);
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * Put a block (an image link) at `at` on lines of its own, with a blank line around it unless one
 * is there already. Returns the new text, what was inserted where (for an editor transaction) and
 * where the cursor goes (after the block).
 */
export function placeBlock(text: string, at: number, block: string) {
  const position = Math.max(0, Math.min(text.length, at));
  const before = text.slice(0, position);
  const after = text.slice(position);
  const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : after ? "\n\n" : "\n";
  const inserted = `${lead}${block}${trail}`;
  return { text: before + inserted + after, at: position, insert: inserted, cursor: position + lead.length + block.length };
}

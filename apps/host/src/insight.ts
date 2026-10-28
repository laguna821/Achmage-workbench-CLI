import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_LABEL, type Session, type TranscriptItem, type Work } from "@workbench/contracts";
import { fold } from "../../../third_party/textfold/fold.ts";
import { headingOf, tidyMessage } from "./export-md.ts";
import { KEY_LINE, splitFrontmatter, unquote } from "./frontmatter.ts";
import { fillTemplate, localStamp } from "./pages.ts";

// "인사이트 초안": a finished session as a DIKM insight draft, made by fixed rules (no model): the
// vault template's front matter with its keys spelled exactly as there (trailing colons too) and
// only title, date created and source filled — the DIKM stage stays empty, people set it in
// Obsidian. The user reviews it; publishing goes through Achmage (never a file written here).

/** The DIKM template's keys, as the human metadata policy lists them (used without a vault template). */
export const DIKM_KEYS = ["title", "aliases", "DIKM_단계:", "종류:", "도메인영역:", "멀티모달종류:", "정리의도:", "tags", "저자:", "관련문서:", "관련개념:", "date created", "source"];

const quoteKey = (key: string) => (/[:#"']/.test(key) || key.includes(" ") ? (key === "date created" ? key : JSON.stringify(key)) : key);

/** The vault's DIKM note template (the 2026 one first), or null. */
export function insightTemplate(vaultRoot: string | null, templatesDir: string): { path: string; text: string } | null {
  if (!vaultRoot) return null;
  const dir = join(vaultRoot, templatesDir);
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((name) => /\.md$/i.test(name) && /dikm/i.test(name) && !/lit review/i.test(name));
  names.sort((a, b) => Number(/2026/.test(b)) - Number(/2026/.test(a)) || Number(/template/i.test(b)) - Number(/template/i.test(a)) || a.localeCompare(b));
  for (const name of names) {
    try {
      const text = readFileSync(join(dir, name), "utf8");
      if (splitFrontmatter(text).yaml?.includes("DIKM_단계")) return { path: join(templatesDir, name), text };
    } catch {
      // Unreadable: the next one, or the built-in keys.
    }
  }
  return null;
}

/** Top-level keys of a front matter block, exactly as spelled. */
export function frontmatterKeys(text: string): string[] {
  const { yaml } = splitFrontmatter(text);
  if (!yaml) return [];
  return yaml.split(/\r?\n/).flatMap((line) => {
    if (/^[ \t]/.test(line)) return [];
    const match = KEY_LINE.exec(line);
    if (!match) return [];
    return [match[1] !== undefined ? unquote(`"${match[1]}"`) : match[2] !== undefined ? match[2] : match[3]!.trim()];
  });
}

/** Problems that keep a reviewed draft from being published: missing or misspelled keys, a DIKM stage set, no title. */
export function checkInsight(text: string, keys: string[]): string[] {
  const problems: string[] = [];
  const { yaml } = splitFrontmatter(text);
  if (!yaml) return ["앞머리(---)가 없습니다."];
  const found = frontmatterKeys(text);
  for (const key of keys) {
    const count = found.filter((entry) => entry === key).length;
    if (!count) problems.push(`템플릿 키 「${key}」가 없거나 글자가 다릅니다.`);
    else if (count > 1) problems.push(`템플릿 키 「${key}」가 두 번 있습니다.`);
  }
  for (const key of found) if (!keys.includes(key)) problems.push(`템플릿에 없는 키 「${key}」가 있습니다.`);
  const lines = yaml.split(/\r?\n/);
  const stage = lines.findIndex((line) => /^"?DIKM_단계:?"?\s*:/.test(line));
  if (stage >= 0) {
    const inline = lines[stage]!.replace(/^"?DIKM_단계:?"?\s*:/, "").trim();
    const items = lines.slice(stage + 1).findIndex((line) => !/^[ \t]+-/.test(line));
    const listed = lines.slice(stage + 1, stage + 1 + (items < 0 ? lines.length : items)).some((line) => line.replace(/^[ \t]+-/, "").trim());
    if (inline || listed) problems.push("DIKM_단계: 는 비워 두세요. 단계는 사람이 Obsidian에서 매깁니다.");
  }
  const title = lines.find((line) => /^title\s*:/.test(line))?.replace(/^title\s*:/, "").trim();
  if (!title || title === '""') problems.push("title이 비어 있습니다.");
  return problems;
}

export type InsightSource = { session: Session; work: Work; items: TranscriptItem[]; documents: { name: string; revision: number }[] };

/** The draft: the template's front matter (title, date created, source filled; choices empty) and a body from the conversation. */
export function insightDraft(source: InsightSource, template: { path: string; text: string } | null) {
  const { session, work, items } = source;
  const requests = items.filter((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user");
  const replies = items.filter((item): item is Extract<TranscriptItem, { kind: "assistant" }> => item.kind === "assistant" && Boolean(item.text.trim()));
  const last = replies.at(-1)?.text ?? "";
  // The last reply folded to its points (textfold, no model), when that keeps it short.
  const folded = last ? tidyMessage(fold(last, 2).text) : "";
  const title = session.purpose;
  const summary = requests.length ? headingOf(requests[0]!.text) : title;
  const sourceRef = `workbench://session/${session.id}`;
  let front: string;
  if (template) {
    // Every choice field emptied, DIKM included: what goes there is for a person to pick.
    const choices = Object.fromEntries(frontmatterKeys(template.text).map((key) => [key, [] as string[]]));
    delete choices.title;
    delete choices["date created"];
    delete choices.source;
    const filled = fillTemplate(template.text, { title, date: localStamp(), choices });
    const { bodyStart } = splitFrontmatter(filled);
    front = filled.slice(0, bodyStart).replace(/^(source[ \t]*:)[ \t]*$/m, `$1 ${sourceRef}`);
  } else {
    front = ["---", ...DIKM_KEYS.map((key) => (key === "title" ? `title: ${JSON.stringify(title)}` : key === "date created" ? `date created: ${localStamp()}` : key === "source" ? `source: ${sourceRef}` : `${quoteKey(key)}:`)), "---", ""].join("\n");
  }
  const body = [
    "## 📝 Summary or Key Trigger",
    `> ${summary}`,
    "",
    "## 🧠 주요 내용 / 본문",
    folded || "(마지막 답이 없습니다)",
    "",
    "## 🔁 대화에서",
    ...requests.slice(0, 12).map((request, index) => `- 요청 ${index + 1}: ${headingOf(request.text)}`),
    ...(requests.length > 12 ? [`- … 요청 ${requests.length - 12}개 더`] : []),
    ...(source.documents.length ? [`- 만든·고친 문서: ${source.documents.map((document) => `${document.name} r${document.revision}`).join(", ")}`] : []),
    "",
    `출처: Achmage Workbench · 작업 「${work.title}」 · ${PROVIDER_LABEL[session.provider]} 세션 「${session.purpose}」`,
    "",
  ].join("\n");
  const text = `${front}${front.endsWith("\n\n") ? "" : "\n"}${body}`;
  return { title, summary, text, keys: template ? frontmatterKeys(template.text) : DIKM_KEYS, template: template?.path ?? null };
}

/** What the session's engine is asked: publish the reviewed draft through its Achmage MCP tools, nothing else. */
export function publishRequest(draft: { title: string; summary: string; text: string }) {
  const { body } = splitFrontmatter(draft.text);
  return [
    "[인사이트 발행 요청 · Achmage Workbench]",
    "사용자가 검토를 마친 인사이트 초안입니다. Achmage MCP로 볼트에 발행해 주세요.",
    "1. achmage의 draft_insight를 호출하세요. workId는 이 세션의 Achmage 작업(모르면 list_work나 ensure_work로 확인), title·summary는 아래 값, body는 아래 초안의 본문 그대로입니다.",
    "2. 돌아온 proposalId로 achmage의 publish_insight를 호출하세요. 볼트의 01. Inbox/Achmage 인사이트/에 새 파일로만 들어갑니다.",
    "3. 볼트에 직접 파일을 쓰거나 고치지 마세요. DIKM_단계는 비워 둡니다. 도구가 없거나 거절되면 발행하지 말고 이유만 한 줄로 알려 주세요.",
    `제목: ${draft.title}`,
    `요약: ${draft.summary}`,
    "--- 검토한 초안(앞머리는 볼트 템플릿 키 그대로) ---",
    draft.text.trimEnd(),
    "--- 초안 끝 ---",
    `(본문 ${body.length}자)`,
  ].join("\n");
}

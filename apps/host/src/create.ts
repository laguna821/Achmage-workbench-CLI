import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { CREATE_EXTENSION, CREATE_LABEL, type CreatableFormat, type CreateTarget, type DocFormat } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import type { IeumOffice } from "./ieumoffice.ts";
import type { Kordoc } from "./kordoc.ts";

// "새 문서로 만들기": a request whose result is a new document. The gateway picks a free file name
// in the work folder before the turn; the engine writes the document there with the right tool;
// after the turn the file is tracked with the documents it came from. Nothing existing is ever
// overwritten.

const FORMATS = new Set(Object.keys(CREATE_EXTENSION));

export function parseCreate(value: unknown): CreateTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  if (typeof target.format !== "string" || !FORMATS.has(target.format)) return null;
  const template = target.template as Record<string, unknown> | undefined;
  if (template !== undefined && (!template || typeof template.skillId !== "string" || typeof template.title !== "string" || !/^[a-f0-9]{64}$/.test(String(template.sha256)) || !/^[a-f0-9]{64}$/.test(String(template.skillSha256)))) {
    throw new HttpError(400, "invalid_template", "양식 판을 확인할 수 없습니다. 목록에서 다시 선택해 주세요.");
  }
  return { format: target.format as CreatableFormat, name: typeof target.name === "string" ? target.name : "", ...(template ? { template: { skillId: template.skillId as string, title: template.title as string, sha256: template.sha256 as string, skillSha256: template.skillSha256 as string } } : {}) };
}

/** A file name in `cwd` that does not exist yet: `<name><ext>`, then `<name> 2<ext>`, … */
export function reservePath(cwd: string, target: { format: DocFormat; name: string }, reserved: ReadonlySet<string> = new Set()) {
  const extensions: Record<DocFormat, string> = { ...CREATE_EXTENSION, pdf: ".pdf", hwp: ".hwp", text: ".txt", xmind: ".xmind", epub: ".epub" };
  const extension = extensions[target.format];
  const stem =
    target.name
      .trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\.(md|hwpx?|docx|pptx|xlsx|html?|pdf|txt|xmind|epub|design\.json)$/i, "")
      .slice(0, 80) || "새 문서";
  let path = join(cwd, `${stem}${extension}`);
  for (let index = 2; existsSync(path) || reserved.has(path); index += 1) {
    if (index > 999) throw new HttpError(409, "name_taken", "같은 이름의 파일이 너무 많습니다.");
    path = join(cwd, `${stem} ${index}${extension}`);
  }
  return path;
}

/** Engine instructions for writing the new document, by format, with the tools on this computer. */
export function createGuide(target: CreateTarget, path: string, cwd: string, tools: { ieum: IeumOffice | null; kordoc: Kordoc | null }) {
  const shown = (() => {
    const inside = relative(cwd, path);
    return inside && !inside.startsWith("..") && !inside.startsWith(sep) ? inside : path;
  })();
  const lines = [
    `[새 문서] 이 요청의 결과는 새 ${CREATE_LABEL[target.format]} 문서로 만드세요: ${shown}`,
    "  · 정확히 이 경로에 만드세요. 이미 있는 다른 파일은 덮어쓰지 말고, 첨부된 원본 문서는 고치지 마세요.",
  ];
  if (target.template) {
    lines.push(`  · 선택한 양식 «${target.template.title}»의 사본이 이 경로에 이미 준비되어 있습니다 (SHA-256 ${target.template.sha256}). 이 사본을 편집하세요. 원본 양식 파일은 고치지 마세요.`,
      "  · 양식의 기존 서식·쪽 크기·테마·개체를 유지하며 요청한 내용만 반영하세요. 빈 문서로 다시 만들지 마세요.");
    return lines.join("\n");
  }
  const cli = tools.ieum?.available ? tools.ieum.engineCommand : null;
  switch (target.format) {
    case "markdown":
    case "html":
      lines.push("  · 파일을 직접 쓰면 됩니다.");
      break;
    case "hwpx": {
      const kordoc = tools.kordoc?.available ? tools.kordoc.engineCommand : null;
      if (!kordoc) {
        lines.push("  · 한글 문서 엔진(kordoc)을 찾지 못해 HWPX를 만들 수 없습니다. 만들 수 없다고 알려 주세요.");
        break;
      }
      const manual = tools.kordoc?.runner ? join(dirname(dirname(tools.kordoc.runner)), "references", "operations.md") : null;
      lines.push(
        `  · 한글(HWPX)은 앱에 들어 있는 kordoc으로 만드세요. 내용을 Markdown 초안으로 쓰고, 요청 JSON을 파일로 써서 \`${kordoc} <요청.json>\`을 실행하면 HWPX로 조판합니다.`,
        `    요청 예: {"schemaVersion":1,"mode":"generate","markdownFile":"<초안.md의 절대 경로>","options":{"gongmun":{"preset":"report"}},"outputDir":"<새 폴더의 절대 경로>"} → 결과의 document.hwpx를 위 경로로 옮기세요. 출력 JSON의 status가 failed면 이유를 알려 주세요.`,
        "    일반 문서는 공용 초안 서식으로 만들고, 요청에 없는 기관(한림대 등) 소속을 지어내지 마세요. 한림대 문서를 요청받았고 hallym-kordoc 스킬이 있으면 그 스킬을 쓰세요. HWP는 만들지 않습니다.",
      );
      if (manual) lines.push(`    모드와 옵션: ${manual}`);
      break;
    }
    case "docx":
      lines.push(
        cli
          ? `  · Markdown 초안을 쓴 뒤 \`${cli} convert <초안.md> --to docx --out ${shown}\`로 만드세요(표·목록 유지). 더 고칠 때는 \`${cli} docs apply\`, 확인은 \`${cli} docs check\`·\`${cli} render\`.`
          : "  · 이 컴퓨터에는 이음오피스가 없어 워드 파일을 만들 도구가 없습니다. 만들 수 없다고 알려 주세요.",
      );
      break;
    case "pptx":
      lines.push(
        cli
          ? `  · \`${cli} guide slides design\`의 단계(스타일 → 개요 → 쪽별 spec → 빌드 → 점검)를 따르고 \`${cli} create --type pptx --spec <폴더> --out ${shown} --render --audit\`로 만드세요. 사용자가 지정한 템플릿·스킬 스타일이 있으면 그 스타일을 쓰세요.`
          : "  · 이 컴퓨터에는 이음오피스가 없어 PPT 파일을 만들 도구가 없습니다. 만들 수 없다고 알려 주세요.",
      );
      break;
    case "xlsx":
      lines.push(
        cli
          ? `  · 표를 CSV나 JSON(시트·행 배열, "="로 시작하면 수식)으로 쓴 뒤 \`${cli} create --type xlsx --from <파일> --out ${shown} --header\`로 만드세요. 확인은 \`${cli} sheet read\`.`
          : "  · 이 컴퓨터에는 이음오피스가 없어 엑셀 파일을 만들 도구가 없습니다. 만들 수 없다고 알려 주세요.",
      );
      break;
    case "design":
      lines.push(
        "  · doory 디자인 문서(schemaVersion 1 JSON)로 쓰세요: { schemaVersion: 1, width, height, unit: \"px\", pages: [{ id, background, objects }] }.",
        "    글자는 type \"textbox\"(originX/originY \"center\", left/top은 중심), 기본 글꼴 \"Achmage SameTone\". 개체마다 새 UUID id. 결과는 올바른 JSON이어야 합니다.",
      );
      break;
  }
  return lines.join("\n");
}

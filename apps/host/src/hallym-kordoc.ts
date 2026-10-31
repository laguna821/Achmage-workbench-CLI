import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot, shipped } from "./resources.ts";

/** Public default skills stay in the app. Native user installations are never overwritten. */
export function bundledHallymSkill(): string | null {
  const root = repoRoot();
  const path = shipped("skills/hallym-kordoc/SKILL.md") ?? (root ? join(root, "third_party/skills/hallym-kordoc/SKILL.md") : null);
  return path && existsSync(path) ? dirname(path) : null;
}

export function hangulSkillGuide(skillDir: string): string {
  return `[한글 문서 기본 스킬] ${join(skillDir, "SKILL.md")} 전체를 읽고 동봉 scripts/run.mjs와 core를 사용하세요. 사용자가 지정한 다른 도구·기관·양식을 우선하세요. 일반 문서에는 한림대 소속을 만들거나 한림대 양식을 강제하지 마세요. 결과는 HWPX로 만들며 기존 파일·개인 양식은 덮어쓰지 마세요. 결과 HWPX는 Workbench의 이음 한글 편집기에서 열립니다.`;
}

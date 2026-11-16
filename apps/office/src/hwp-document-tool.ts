/**
 * The Hangul dock's "한글 문서 만들기" tool (gateway: apps/host/src/hangul-document.ts). Added to the
 * dock's own skill set by the Hangul patch (execution-patch-documents.ts hwp()).
 *
 * How the turn decides: the MODEL chooses the tool; this instruction names when — making a new
 * document or reshaping a whole one to a form (공문서, 보고서, 회의록, 기안문, 신청서 …) goes through
 * the tool (hallym-kordoc's runner); small edits ("이 문단 다듬어 줘", a selection) keep the editor's
 * live edit tools. Offered only while the request carries the hallym-kordoc chip (on by default in a
 * Hangul document; the person can remove it for one request) and the gateway's effective copy is
 * not disabled (the gateway checks again).
 */
import type { AgentSkill } from "../../../vendor/ieumoffice/packages/agent-core/src/skill.ts";
import type { AgentToolCall, ToolExecution } from "../../../vendor/ieumoffice/packages/agent-core/src/types.ts";

export const HANGUL_TOOL = "make_hangul_document";
export const HALLYM_NAME = "hallym-kordoc";

const SYSTEM = `## 한글 문서 만들기 (hallym-kordoc)
이 대화에는 hallym-kordoc 스킬이 기본으로 붙어 있습니다. 스킬의 실행기(scripts/run.mjs)는 직접 실행할 수 없고 ${HANGUL_TOOL} 도구가 실행합니다. 스킬 파일을 더 읽거나 명령을 찾지 마세요.
- 새 문서를 만들거나 문서 전체를 양식에 맞게 다시 만드는 요청(공문서, 보고서, 회의록, 기안문, 신청서, 계획서, "이 내용으로 ○○ 양식에 맞춰 줘" 등)은 ${HANGUL_TOOL}로 처리합니다. 편집 도구로 문서를 하나씩 지어내지 마세요.
- 1) prompt(사람의 요청 그대로)만으로 먼저 호출해 양식(form.fields, form.sections)을 받습니다. needs-clarification이면 question을 사람에게 그대로 묻고 멈춥니다.
- 2) 같은 prompt와 title, values(필드 ID별 값), sections(목차 이름별 Markdown 본문), 필요하면 tables로 다시 호출합니다. 열린 문서의 내용을 바탕으로 하라는 요청이면 read_document로 읽은 내용을 sections에 옮깁니다.
- 사람이 알려 주지 않은 이름·날짜·금액·소속·서명은 지어내지 말고 비워 둡니다(결과에 미입력으로 표시됩니다). 일반 요청에 한림대학교 소속이나 한림대 양식을 붙이지 마세요.
- 결과는 열린 문서 옆에 새 HWPX로 저장되어 이 요청이 끝나면 새 탭에 열립니다. 열린 문서는 바뀌지 않습니다. templateStatus가 common-draft이면 "공식 양식 미적용 초안"이라고 알리고, status가 partial이면 missingFields를 알려 줍니다. 완료라고 과장하지 마세요.
- 문단 다듬기, 선택 영역 고치기, 표 한 칸 채우기 같은 작은 편집은 이 도구가 아니라 편집 도구로 합니다.`;

const schema = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "사람의 요청 그대로 (양식 선택에 씀)" },
    title: { type: "string", description: "문서 제목 (파일 이름이 됨)" },
    familyId: { type: "string", description: "앞선 호출이 돌려준 familyId 또는 사람이 고른 후보 id" },
    context: { type: "object", additionalProperties: { type: "string" }, description: "program, department, term, stage, level (아는 것만)" },
    values: { type: "object", additionalProperties: { type: "string" }, description: "form.fields의 id별 값" },
    sections: { type: "object", additionalProperties: { type: "string" }, description: "form.sections의 이름별 Markdown 본문" },
    tables: { type: "object", description: "목차 이름별 표: 행 배열 또는 {columns, rows}" },
  },
  required: ["prompt"],
} as const;

type Made = { made: boolean; status?: string; artifactId?: string; name?: string; draft?: boolean; reason?: string; question?: string };
export type HangulPort = { make(input: Record<string, unknown>, signal?: AbortSignal): Promise<Made> };

/** `enabled`: whether this request carries the hallym-kordoc chip. `onMade`: a document to open when the turn ends. */
export function createHangulDocumentSkill(port: () => HangulPort | null, enabled: () => boolean, onMade: (artifactId: string) => void): AgentSkill {
  return {
    id: "workbench-hangul-document",
    get systemPrompt() { return enabled() && port() ? SYSTEM : ""; },
    get tools() { return enabled() && port() ? [{ name: HANGUL_TOOL, description: "hallym-kordoc 실행기로 한글(HWPX) 문서를 만듭니다. prompt만 주면 양식을 돌려주고, values/sections를 주면 문서를 만들어 새 탭에 엽니다.", inputSchema: schema as unknown as Record<string, unknown> }] : []; },
    async executeTool(call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution> {
      const current = port();
      if (call.name !== HANGUL_TOOL || !current) return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name };
      try {
        const result = await current.make(call.input, signal);
        if (result.made && result.artifactId) onMade(result.artifactId);
        const summary = result.made ? `한글 문서 만들기 · ${result.name}${result.draft ? " (초안)" : ""}`
          : result.status === "needs-clarification" ? "한글 문서 만들기 · 양식 확인 질문"
          : result.status === "form" ? "한글 문서 만들기 · 양식 읽음"
          : result.status === "unavailable" ? `한글 문서 만들기 · ${result.reason}` : "한글 문서 만들기 · 만들지 못함";
        return { output: JSON.stringify(result), summary, isError: !result.made && result.status !== "form" && result.status !== "needs-clarification" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: message, isError: true, summary: `한글 문서 만들기 · ${message}` };
      }
    },
  };
}

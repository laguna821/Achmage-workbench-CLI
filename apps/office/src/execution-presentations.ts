import { askOfficeExecutionInteraction, askOfficeExecutionQuestion } from "./execution-adapter.ts";

let presentationLocked = false;
const guardDocumentKeyboard = (event: KeyboardEvent) => {
  if (!presentationLocked || event.target instanceof Element && event.target.closest('.ai-dock, .ai-panel, [role="dialog"], input, textarea, select, button')) return;
  event.preventDefault(); event.stopImmediatePropagation();
};
export function lockPresentationSurface(locked: boolean): void {
  presentationLocked = locked;
  for (const element of document.querySelectorAll<HTMLElement>('.app-content, .ribbon')) element.inert = locked;
  window.removeEventListener('keydown', guardDocumentKeyboard, true);
  if (locked) window.addEventListener('keydown', guardDocumentKeyboard, true);
}

type HtmlElement = { sid: number; parentSid: number | null; tag: string; path: string; range: [number, number] };
type HtmlIdentity = Pick<HtmlElement, "sid" | "tag" | "path" | "range">;

/** A fresh parse assigns new sids. Retain the original tool/instruction anchors,
 * but only after the original loader has parsed exactly the saved structure. */
export function captureHtmlIdentity(map: { elements: HtmlElement[] }): HtmlIdentity[] {
  return map.elements.map(({ sid, tag, path, range }) => ({ sid, tag, path, range: [range[0], range[1]] as [number, number] }));
}
export function restoreHtmlIdentity<T extends HtmlElement>(map: { elements: T[]; bySid: Map<number, T> }, identities: HtmlIdentity[]): void {
  if (!Array.isArray(identities) || identities.length !== map.elements.length) throw new Error("저장된 HTML 구조와 실행 문서가 다릅니다.");
  const remap = new Map<number, number>(), seen = new Set<number>();
  map.elements.forEach((element, index) => {
    const saved = identities[index];
    if (!saved || !Number.isSafeInteger(saved.sid) || saved.sid < 1 || seen.has(saved.sid) || saved.tag !== element.tag || saved.path !== element.path || saved.range?.[0] !== element.range[0] || saved.range?.[1] !== element.range[1]) throw new Error("HTML 요소의 원본 위치를 복원할 수 없습니다.");
    seen.add(saved.sid); remap.set(element.sid, saved.sid);
  });
  for (const element of map.elements) {
    const oldParent = element.parentSid;
    element.sid = remap.get(element.sid)!;
    element.parentSid = oldParent === null ? null : remap.get(oldParent) ?? null;
  }
  map.bySid = new Map(map.elements.map(element => [element.sid, element]));
}

type SlideNode = { sourceId: string; durableId?: string; type: string; children?: SlideNode[] };
type Slide = { partPath?: string; nodes: SlideNode[] };
type NodeAnchor = { sourceId: string; durableId?: string; type: string; path: number[] };
export type PresentationSelection = { current: number; partPath?: string; selected: NodeAnchor[] };
function slideNodes(nodes: SlideNode[], prefix: number[] = []): { node: SlideNode; path: number[] }[] {
  return nodes.flatMap((node, index) => {
    const path = [...prefix, index];
    return [{ node, path }, ...slideNodes(node.children ?? [], path)];
  });
}
export function capturePresentationSelection(slides: Slide[], current: number, ids: string[]): PresentationSelection {
  const slide = slides[current];
  if (!slide) throw new Error("현재 슬라이드를 찾을 수 없습니다.");
  const nodes = slideNodes(slide.nodes);
  return { current, ...(slide.partPath ? { partPath: slide.partPath } : {}), selected: ids.map(id => {
    const found = nodes.find(({ node }) => node.sourceId === id || node.durableId === id);
    if (!found) throw new Error("선택한 슬라이드 요소를 찾을 수 없습니다.");
    return { sourceId: found.node.sourceId, ...(found.node.durableId ? { durableId: found.node.durableId } : {}), type: found.node.type, path: found.path };
  }) };
}
export function restorePresentationSelection(slides: Slide[], saved: PresentationSelection): { current: number; ids: string[] } {
  if (!saved || !Number.isSafeInteger(saved.current) || !Array.isArray(saved.selected)) throw new Error("슬라이드 선택 정보가 올바르지 않습니다.");
  const current = saved.partPath ? slides.findIndex(slide => slide.partPath === saved.partPath) : saved.current;
  const slide = slides[current];
  if (!slide) throw new Error("원본 슬라이드 위치를 복원할 수 없습니다.");
  const nodes = slideNodes(slide.nodes);
  const ids = saved.selected.map(anchor => {
    // Durable OOXML ids take precedence. A source-id-less legacy file uses its
    // saved tree position, including children of groups; no selection is dropped.
    const found = anchor.durableId
      ? nodes.find(({ node }) => node.durableId === anchor.durableId)
      : nodes.find(({ node }) => node.sourceId === anchor.sourceId) ?? nodes.find(({ path }) => JSON.stringify(path) === JSON.stringify(anchor.path));
    if (!found || found.node.type !== anchor.type) throw new Error("선택한 슬라이드 요소의 원본 위치를 복원할 수 없습니다.");
    return found.node.sourceId;
  });
  return { current, ids };
}

type ClarifyQuestion = { id: string; label: string; description?: string; options: string[]; multi?: boolean };
/** The original cards' multi-choice, Other and explicit 'decide for me' remain
 * actual answers. An empty/missing answer never becomes implicit approval. */
export async function askPresentationClarification(questions: ClarifyQuestion[], decideLabel: string): Promise<{ answers: string; cancelled?: boolean }> {
  const answers: string[] = [];
  for (let start = 0; start < questions.length; start += 24) {
    const batch = questions.slice(start, start + 24);
    const response = await askOfficeExecutionInteraction({ prompt: "문서 작업을 이어가기 위한 질문입니다.", fields: batch.map((question, index) => ({
      id: `q${start + index}`, prompt: [question.label, question.description].filter(Boolean).join("\n"),
      options: [...question.options.map((label, option) => ({ id: `option.${option}`, label })), { id: "decide", label: decideLabel }],
      multiple: Boolean(question.multi), required: true, allowOther: true,
    })) });
    if (response === null) return { answers: "", cancelled: true };
    batch.forEach((question, index) => {
      const value = response[`q${start + index}`];
      const selected = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      if (!selected.length || selected.some(answer => !answer.trim())) throw new Error("문서 추가 질문에 대한 답변이 없습니다.");
      const chosen = selected.map(answer => answer === "decide" ? decideLabel : /^option\.\d+$/.test(answer) ? question.options[Number(answer.slice(7))] : answer);
      if (chosen.some(answer => answer === undefined)) throw new Error("문서 추가 질문의 선택지가 올바르지 않습니다.");
      answers.push(`${question.label}: ${chosen.join("、")}`);
    });
  }
  return { answers: answers.join("\n") };
}

type BriefStyle = {
  name?: string; tone: string; palette: { primary?: string; accent?: string; bg?: string; surface?: string; text?: string };
  typography: { heading?: string; body?: string; scale?: string }; tokens?: { radius?: string; spacing?: string; shadow?: string };
  layout?: string; density?: string; docx_friendly?: boolean;
};
type Brief = { core_hook: string; style: BriefStyle; alternatives?: BriefStyle[]; sections: { title: string; brief: string; type?: string; layout?: string; image_queries?: string[] }[]; meta?: { title?: string; audience?: string; language?: string; length?: string }; user_edited?: string[]; version: 1 };
type BriefDecision = { kind: "confirmed"; brief: Brief } | { kind: "redo"; note: string } | { kind: "cancelled" };
const one = (value: string | string[] | undefined) => typeof value === "string" ? value : value?.[0];
function styleDescription(style: BriefStyle): string {
  return [style.name, `분위기: ${style.tone}`, `색상: ${Object.entries(style.palette).map(([key, value]) => `${key} ${value}`).join(", ")}`,
    `제목 글꼴: ${style.typography.heading ?? ""} · 본문 글꼴: ${style.typography.body ?? ""} · 크기: ${style.typography.scale ?? ""}`,
    `모서리: ${style.tokens?.radius ?? ""} · 간격: ${style.tokens?.spacing ?? ""} · 그림자: ${style.tokens?.shadow ?? ""}`,
    `배치: ${style.layout ?? ""} · 밀도: ${style.density ?? "regular"} · Word 호환: ${style.docx_friendly ? "예" : "아니요"}`].filter(Boolean).join("\n");
}
function briefDescription(brief: Brief): string {
  return [`핵심 메시지: ${brief.core_hook}`, styleDescription(brief.style), ...brief.sections.map((section, index) => `${index + 1}. ${section.title}\n${section.brief}`),
    `제목: ${brief.meta?.title ?? ""} · 대상: ${brief.meta?.audience ?? ""} · 분량: ${brief.meta?.length ?? ""} · 언어: ${brief.meta?.language ?? ""}`].join("\n\n");
}
type EditField = { id: string; label: string; current: string; apply(value: string): void };
async function editBriefFields(fields: EditField[], touched: Set<string>): Promise<boolean> {
  for (let start = 0; start < fields.length; start += 24) {
    const batch = fields.slice(start, start + 24);
    const response = await askOfficeExecutionInteraction({ prompt: "바꿀 항목만 입력해 주세요. 입력하지 않은 항목은 현재 내용을 유지합니다.", fields: batch.map(field => ({
      id: field.id, prompt: `${field.label}\n현재: ${field.current}`, required: false, allowOther: true,
      options: [{ id: "keep", label: "현재 내용 유지" }, { id: "clear", label: "내용 비우기" }],
    })) });
    if (response === null) return false;
    for (const field of batch) {
      const value = one(response[field.id]);
      if (value === undefined || value === "" || value === "keep") continue;
      field.apply(value === "clear" ? "" : value); touched.add(field.id);
    }
  }
  return true;
}
/** Match the original BriefCard decision: choose a direction, edit fields/sections,
 * redo with a note, or cancel. Only the final explicit confirmation resolves it. */
export async function askHtmlExecutionBrief(original: Brief): Promise<BriefDecision> {
  const brief: Brief = structuredClone(original), touched = new Set<string>(brief.user_edited ?? []);
  let notice = "";
  for (;;) {
    const description = briefDescription(brief);
    // Long briefs are shown in full before the decision, never silently cut.
    if (description.length > 6800) for (let start = 0; start < description.length; start += 6800) {
      if (!await askOfficeExecutionQuestion(`구성안 내용 (${Math.floor(start / 6800) + 1}/${Math.ceil(description.length / 6800)})\n${description.slice(start, start + 6800)}\n계속 확인할까요?`)) return { kind: "cancelled" };
    }
    const response = await askOfficeExecutionInteraction({ prompt: `${notice}${description.length <= 6800 ? description : "위에서 확인한 전체 구성안입니다."}\n\n이 구성안으로 문서를 만들까요?`, fields: [
      { id: "decision", prompt: "구성안 처리", options: [{ id: "confirm", label: "이 구성안으로 작성" }, { id: "edit", label: "핵심 메시지·스타일 수정" }, { id: "sections", label: "섹션 수정·삭제" }, { id: "add", label: "섹션 추가" }, { id: "direction", label: "다른 스타일 선택" }, { id: "redo", label: "새 구성안 요청" }, { id: "cancel", label: "취소" }], required: true },
      { id: "note", prompt: "새 구성안을 요청할 때 전달할 내용", required: false },
    ] });
    notice = "";
    const action = response && one(response.decision);
    if (response === null || action === "cancel") return { kind: "cancelled" };
    if (action === "redo") return { kind: "redo", note: one(response.note)?.trim() ?? "" };
    if (action === "confirm") {
      if (!brief.core_hook.trim() || !brief.sections.some(section => section.title.trim())) { notice = "핵심 메시지와 제목이 있는 섹션이 필요합니다. 수정 후 확인해 주세요.\n\n"; continue; }
      const confirmed = { ...brief }; delete confirmed.alternatives;
      return { kind: "confirmed", brief: { ...confirmed, sections: brief.sections.filter(section => section.title.trim() || section.brief.trim()), user_edited: [...touched] } };
    }
    if (action === "direction") {
      const styles = [original.style, ...(original.alternatives ?? [])];
      const chosen = await askOfficeExecutionInteraction({ prompt: "사용할 스타일을 선택해 주세요.", fields: [{ id: "style", prompt: "스타일 방향", required: true, options: styles.map((style, index) => ({ id: `style.${index}`, label: styleDescription(style) })) }] });
      if (chosen === null) return { kind: "cancelled" };
      const index = Number(one(chosen.style)?.replace(/^style\./, ""));
      if (!Number.isSafeInteger(index) || !styles[index]) throw new Error("선택한 스타일을 찾을 수 없습니다.");
      brief.style = structuredClone(styles[index]!); touched.add("style");
    } else if (action === "add") {
      const added = await askOfficeExecutionInteraction({ prompt: "새 섹션을 추가합니다.", fields: [{ id: "title", prompt: "섹션 제목", required: true }, { id: "brief", prompt: "섹션 내용", required: false }] });
      if (added === null) return { kind: "cancelled" };
      const title = one(added.title)?.trim();
      if (!title) throw new Error("새 섹션의 제목이 없습니다.");
      brief.sections.push({ title, brief: one(added.brief) ?? "" }); touched.add("sections");
    } else if (action === "sections") {
      const removed = new Set<number>();
      const fields: EditField[] = brief.sections.flatMap((section, index) => [
        { id: `section.${index}.title`, label: `${index + 1}. 섹션 제목`, current: section.title, apply: value => { section.title = value; touched.add(`sections[${index}]`); } },
        { id: `section.${index}.brief`, label: `${index + 1}. 섹션 내용`, current: section.brief, apply: value => { section.brief = value; touched.add(`sections[${index}]`); } },
      ]);
      if (!await editBriefFields(fields, touched)) return { kind: "cancelled" };
      if (brief.sections.length) {
        const response = await askOfficeExecutionInteraction({ prompt: "삭제할 섹션이 있으면 선택해 주세요.", fields: [{ id: "remove", prompt: "삭제할 섹션", required: false, multiple: true, options: brief.sections.map((section, index) => ({ id: `section.${index}`, label: `${index + 1}. ${section.title || "제목 없음"}` })) }] });
        if (response === null) return { kind: "cancelled" };
        const values = response.remove === undefined ? [] : Array.isArray(response.remove) ? response.remove : [response.remove];
        for (const value of values) { const index = Number(value.replace(/^section\./, "")); if (Number.isSafeInteger(index) && brief.sections[index]) removed.add(index); }
      }
      if (removed.size) { brief.sections = brief.sections.filter((_, index) => !removed.has(index)); touched.add("sections"); }
    } else if (action === "edit") {
      const fields: EditField[] = [{ id: "core_hook", label: "핵심 메시지", current: brief.core_hook, apply: value => { brief.core_hook = value; } }];
      const group = (prefix: string, labels: Record<string, string>, target: Record<string, string | undefined>) => {
        for (const [key, label] of Object.entries(labels)) fields.push({ id: `${prefix}.${key}`, label, current: target[key] ?? "", apply: value => { target[key] = value; } });
      };
      group("meta", { audience: "대상", length: "분량" }, brief.meta ??= {});
      for (const [key, label] of [["tone", "분위기"], ["layout", "배치"], ["density", "밀도 (compact / regular / airy)"]] as const) fields.push({ id: `style.${key}`, label, current: brief.style[key] ?? "", apply: value => { brief.style[key] = value; } });
      group("style.palette", { primary: "주 색상", accent: "강조 색상", bg: "배경 색상", surface: "표면 색상", text: "글자 색상" }, brief.style.palette);
      group("style.typography", { heading: "제목 글꼴", body: "본문 글꼴" }, brief.style.typography);
      group("style.tokens", { radius: "모서리", spacing: "간격", shadow: "그림자" }, brief.style.tokens ??= {});
      if (!await editBriefFields(fields, touched)) return { kind: "cancelled" };
      const response = await askOfficeExecutionInteraction({ prompt: "스타일의 Word 변환 호환 설정입니다.", fields: [{ id: "compatible", prompt: `Word 변환에 맞추기 (현재 ${brief.style.docx_friendly ? "예" : "아니요"})`, required: false, options: [{ id: "yes", label: "예" }, { id: "no", label: "아니요" }] }] });
      if (response === null) return { kind: "cancelled" };
      const compatible = one(response.compatible);
      if (compatible === "yes" || compatible === "no") { brief.style.docx_friendly = compatible === "yes"; touched.add("style.docx_friendly"); }
    } else throw new Error("구성안에 대한 명시적인 결정을 받지 못했습니다.");
  }
}

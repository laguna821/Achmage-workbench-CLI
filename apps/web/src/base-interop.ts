import { parseDocument, stringify } from "yaml";
import { BASE_FILE_LABELS, VIEW_LIMITS, baseMatcher, cleanBaseFilter, cleanView, plainView, type BaseFilter, type HomeView } from "@workbench/contracts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const newId = () => `base-${globalThis.crypto.randomUUID().slice(0, 26)}`;

function propertyKey(raw: unknown): string {
  if (typeof raw !== "string" || !raw || raw.length > VIEW_LIMITS.key) throw new Error("지원하지 않는 속성 이름입니다.");
  if (raw.startsWith("formula.") || raw.startsWith("this.")) throw new Error(`아직 가져올 수 없는 속성: ${raw}`);
  if (raw.startsWith("file.")) { if (!Object.hasOwn(BASE_FILE_LABELS, raw)) throw new Error(`지원하지 않는 파일 속성: ${raw}`); return raw; }
  const key = `prop:${raw.startsWith("note.") ? raw.slice(5) : raw}`;
  if (key.length > VIEW_LIMITS.key) throw new Error("속성 이름이 너무 깁니다.");
  return key;
}
const baseProperty = (key: string): string | null => key.startsWith("prop:") ? `note.${key.slice(5)}` : Object.hasOwn(BASE_FILE_LABELS, key) ? key : key === "stage" ? "note.단계" : key === "tags" ? "note.tags" : null;
const layout = (type: unknown) => type === "kanban" ? "board" : type === "table" || type === "cards" || type === "list" ? type : null;

export type BaseImportEntry = { name: string; view: HomeView | null; issues: string[]; warnings: string[] };
export type BaseImport = { entries: BaseImportEntry[]; warnings: string[] };

/** Preview each view independently. A view with unsupported selection criteria cannot be applied. */
export function importBase(source: string): BaseImport {
  if (source.length > 256_000) throw new Error(".base 파일은 256KB 이하로 가져와 주세요.");
  const document = parseDocument(source, { uniqueKeys: true, logLevel: "silent" });
  if (document.errors.length || document.warnings.length) throw new Error((document.errors[0] ?? document.warnings[0])!.message);
  const data = object(document.toJS({ maxAliasCount: 0 }));
  if (!Array.isArray(data.views) || !data.views.length) throw new Error("views가 있는 .base 파일을 선택해 주세요.");
  if (data.views.length > VIEW_LIMITS.views) throw new Error(`한 파일에서 보기 ${VIEW_LIMITS.views}개까지 가져올 수 있습니다.`);
  const entries: BaseImportEntry[] = data.views.map((raw, index) => {
    const entry = object(raw);
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.slice(0, VIEW_LIMITS.name) : `가져온 보기 ${index + 1}`;
    const issues: string[] = [], warnings: string[] = [];
    try {
      // Only restore the extra Workbench state while the standard projection is unchanged.
      const extension = object(entry.workbench);
      const standard = { ...entry }; delete standard.workbench;
      if (extension.version === 1 && extension.projection === canonical({ filters: data.filters ?? null, view: standard })) {
        const restored = cleanView("projects", { ...object(extension.view), id: newId() });
        if (!restored) throw new Error("Workbench 보기 복원 정보가 올바르지 않습니다.");
        if (restored.baseFilters !== undefined) baseMatcher(restored.baseFilters);
        return { name: restored.name, view: restored, issues, warnings };
      }
      if (extension.version === 1) warnings.push("외부에서 수정한 표준 보기를 사용합니다. 이전 Workbench 전용 설정은 적용하지 않습니다.");
      const kind = layout(entry.type);
      if (!kind) throw new Error(`지원하지 않는 보기 형식: ${String(entry.type)}`);
      const view = plainView(newId(), name, kind);
      const filters: BaseFilter[] = [];
      for (const value of [data.filters, entry.filters]) {
        if (value === undefined || value === null) continue;
        const filter = cleanBaseFilter(value);
        if (filter === null) throw new Error("필터 형식이나 크기를 확인해 주세요.");
        baseMatcher(filter); filters.push(filter);
      }
      // Imported bases operate on existing project notes, not empty projects with no file.
      view.baseFilters = filters.length ? { and: filters } : "true";
      if (entry.groupBy !== undefined) {
        const group = object(entry.groupBy);
        view.group = { key: propertyKey(group.property), ...(group.direction === "DESC" ? { reverse: true } : {}) };
      }
      if (entry.groupOrder !== undefined) throw new Error("수동 그룹 순서/숨김(groupOrder)은 아직 가져올 수 없습니다.");
      if (entry.limit !== undefined && entry.limit !== null) throw new Error("행 수 제한(limit)은 아직 가져올 수 없습니다.");
      if (entry.sort !== undefined) {
        if (!Array.isArray(entry.sort) || entry.sort.length > 1) throw new Error("여러 정렬 기준은 아직 가져올 수 없습니다.");
        const sort = object(entry.sort[0]);
        if (entry.sort.length) view.sort = { key: propertyKey(sort.property), dir: sort.direction === "ASC" ? "asc" : "desc" };
      }
      if (entry.order !== undefined) {
        if (!Array.isArray(entry.order)) throw new Error("표시 속성(order)은 목록이어야 합니다.");
        view.fields = [...new Set(entry.order.map(propertyKey))];
        if (view.fields.length > VIEW_LIMITS.fields) throw new Error(`표시 속성은 ${VIEW_LIMITS.fields}개까지입니다.`);
      }
      if (entry.image !== undefined) warnings.push("카드 이미지는 프로젝트 노트의 thumbnail/cover/썸네일/표지 또는 첫 이미지를 사용합니다.");
      if (Object.keys(object(entry.summaries)).length) warnings.push("요약 계산 행은 가져오지 않습니다.");
      if (Object.keys(object(data.properties)).length) warnings.push("열 표시 이름은 이 앱의 속성 이름으로 표시합니다.");
      if (Object.keys(object(data.formulas)).length) warnings.push("수식 정의는 실행하지 않습니다. 수식을 참조하는 필터/열은 가져올 수 없습니다.");
      const known = new Set(["type", "name", "filters", "groupBy", "groupOrder", "limit", "sort", "order", "summaries", "image", "workbench"]);
      const extra = Object.keys(entry).filter((key) => !known.has(key));
      if (extra.length) warnings.push(`추가 보기 옵션은 적용하지 않습니다: ${extra.join(", ")}`);
      return { name, view, issues, warnings };
    } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); return { name, view: null, issues, warnings }; }
  });
  return { entries, warnings: ["이 앱에 등록된 프로젝트 노트에 보기를 적용합니다. 보관함의 일반 노트나 첨부파일을 프로젝트로 가져오지는 않습니다."] };
}

/** A standard projection plus exact app state. The latter is ignored after an external standard edit. */
export function exportBase(view: HomeView): { source: string; warnings: string[] } {
  const warnings: string[] = [];
  const standard: ObjectValue = { type: view.layout === "board" ? "kanban" : ["table", "cards", "list"].includes(view.layout) ? view.layout : "table", name: view.name };
  if (standard.type !== view.layout && view.layout !== "board") warnings.push("이 배치는 Obsidian에서 표로 표시됩니다.");
  let filters: BaseFilter = { and: ['note.workbench_id != null', ...(view.baseFilters !== undefined ? [view.baseFilters] : [])] };
  if (view.filter.trim()) {
    // Runtime name/classification filters have no note-property equivalent. Do not widen results.
    filters = "false";
    warnings.push("Workbench 검색 필터는 이 파일에 보존되지만 Obsidian에서는 결과를 숨깁니다. 검색 필터를 비우면 Obsidian에서도 볼 수 있습니다.");
  }
  if (view.group) {
    const property = baseProperty(view.group.key);
    if (property) standard.groupBy = { property, direction: view.group.reverse ? "DESC" : "ASC" };
    else warnings.push("분류 폴더·엔진 등의 묶기는 Workbench에서만 복원됩니다.");
    if (view.group.dates) warnings.push("날짜 구간 묶기는 Workbench에서만 복원됩니다.");
  }
  if (view.sort) {
    const property = baseProperty(view.sort.key);
    if (property) standard.sort = [{ property, direction: view.sort.dir.toUpperCase() }];
    else warnings.push("프로젝트 이름·활동·세션 기준 정렬은 Workbench에서만 복원됩니다.");
  }
  const fields = view.fields ?? ["stage", "tags"];
  standard.order = [...new Set(["file.name", ...fields.map(baseProperty).filter((item) => item !== null)])];
  if (fields.some((field) => !baseProperty(field))) warnings.push("세션 수·실행 상태 등의 앱 전용 속성은 Workbench에서만 복원됩니다.");
  if (view.subgroup || Object.keys(view.look.colors).length || view.collapsed.length) warnings.push("하위 묶기·색상·접힘 상태는 Workbench에서 다시 가져올 때 복원됩니다.");
  const projection = canonical({ filters, view: standard });
  const data = { filters, views: [{ ...standard, workbench: { version: 1, view, projection } }] };
  return { source: `# Achmage Workbench project notes\n${stringify(data, { lineWidth: 0, aliasDuplicateObjects: false })}`, warnings };
}

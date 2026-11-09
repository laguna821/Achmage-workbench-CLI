import { createContext, useContext, type ReactNode } from "react";

type Selection = { ids: ReadonlySet<string>; toggle(id: string, range: boolean): void; busy: boolean };
const ProjectSelectionContext = createContext<Selection | null>(null);
export function ProjectSelectionScope({ value, children }: { value: Selection; children: ReactNode }) {
  return <ProjectSelectionContext.Provider value={value}>{children}</ProjectSelectionContext.Provider>;
}
/** Other screens reuse these cards without entering project multi-selection. */
export function ProjectSelectionCheckbox({ id, title, disabled = false }: { id: string; title: string; disabled?: boolean }) {
  const selection = useContext(ProjectSelectionContext);
  if (!selection) return null;
  return <label className="project-selection-choice" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <input type="checkbox" aria-label={`${title} 선택`} title={disabled ? "보관된 프로젝트입니다." : undefined} checked={selection.ids.has(id)} disabled={selection.busy || disabled} onChange={event => selection.toggle(id, Boolean((event.nativeEvent as MouseEvent).shiftKey))} />
    <span>선택</span>
  </label>;
}

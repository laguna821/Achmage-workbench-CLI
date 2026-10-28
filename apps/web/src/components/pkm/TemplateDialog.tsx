import { useEffect, useState } from "react";
import type { PageTemplate } from "@workbench/contracts";
import { Icon } from "../Icon.tsx";
import { usePkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

const SOURCE_LABEL: Record<PageTemplate["source"], string> = { global: "앱 템플릿", work: "이 작업의 템플릿", vault: "볼트 템플릿 · 읽기 전용" };

/**
 * "템플릿으로 새 페이지": pick a template (the app's, the work's, the vault's), name the page and
 * answer its choice fields (nothing picked by default). The page is a copy in the work folder: only
 * the title and "date created" are filled, everything else stays as the template has it, and
 * Templater commands are left as text.
 */
export function TemplateDialog({ workId, parentId }: { workId: string; parentId: string | null }) {
  const pkm = usePkm();
  const [templates, setTemplates] = useState<PageTemplate[] | null>(null);
  const [picked, setPicked] = useState<PageTemplate | null>(null);
  const [title, setTitle] = useState("");
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const parent = parentId ? pkm.state.artifacts[parentId] : null;
  const close = () => pkm.setDialog(null);

  useEffect(() => {
    void pkm.client
      .templates(workId)
      .then((list) => {
        setTemplates(list);
        if (list.length === 1) choose(list[0]!);
      })
      .catch((error: Error) => pkm.onToast(error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && pkm.setDialog(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pkm]);

  const choose = (template: PageTemplate) => {
    setPicked(template);
    setChoices(Object.fromEntries(template.choices.map((choice) => [choice.key, []])));
  };

  const create = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const artifact = await pkm.client.pageFromTemplate({ workId, templateId: picked.id, title, choices, parentId });
      close();
      pkm.openArtifact(artifact);
    } catch (error) {
      pkm.onToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const groups = (["global", "work", "vault"] as const).map((source) => ({ source, list: (templates ?? []).filter((template) => template.source === source) })).filter((group) => group.list.length);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="pkm-dialog template-dialog" role="dialog" aria-label="템플릿으로 새 페이지">
        <header className="pkm-dialog-head">
          <h2>{parent ? `「${parent.name.replace(/\.md$/i, "")}」의 하위 페이지` : "템플릿으로 새 페이지"}</h2>
          <button type="button" className="icon-button small" onClick={close} aria-label="닫기">
            <Icon name="x" size={15} />
          </button>
        </header>
        {templates && !templates.length ? (
          <p className="sheet-hint">템플릿이 없습니다. 앱 데이터 폴더의 templates/, 작업 폴더의 .workbench/templates/, 또는 연결한 볼트의 90. Settings/91. Templates/에 .md 파일을 두세요.</p>
        ) : null}
        <div className="template-list" role="listbox" aria-label="템플릿">
          {groups.map((group) => (
            <div key={group.source} className="template-group">
              <div className="menu-label">{SOURCE_LABEL[group.source]}</div>
              {group.list.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  role="option"
                  aria-selected={picked?.id === template.id}
                  className={`template-row${picked?.id === template.id ? " active" : ""}`}
                  onClick={() => choose(template)}
                >
                  <Icon name="page" size={15} />
                  <span className="template-name">{template.name}</span>
                  {template.choices.length ? <span className="muted">고를 칸 {template.choices.length}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
        {picked ? (
          <form
            className="template-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label className="sheet-label" htmlFor="page-title">
              페이지 제목
            </label>
            <input id="page-title" className="sheet-input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="제목 없음" />
            {picked.choices.map((choice) => (
              <fieldset key={choice.key} className="template-choice">
                <legend className="sheet-label mono">{choice.key}</legend>
                <div className="template-options">
                  {choice.options.map((option) => {
                    const on = choices[choice.key]?.includes(option) ?? false;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        className={`template-option${on ? " on" : ""}`}
                        onClick={() =>
                          setChoices((current) => ({
                            ...current,
                            [choice.key]: on ? (current[choice.key] ?? []).filter((value) => value !== option) : [...(current[choice.key] ?? []), option],
                          }))
                        }
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            <p className="sheet-hint">
              제목과 date created만 채우고 나머지 앞머리는 템플릿 그대로 둡니다. 고르지 않은 칸은 비워 둡니다.
              {picked.templater ? " Templater 명령(<% %>)은 실행하지 않고 글자 그대로 남습니다." : ""}
              {picked.source === "vault" ? " 볼트 템플릿은 읽기만 하고, 페이지는 작업 폴더에 만듭니다." : ""}
            </p>
            <div className="sheet-actions">
              <button type="submit" className="button primary small" disabled={busy}>
                만들기
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

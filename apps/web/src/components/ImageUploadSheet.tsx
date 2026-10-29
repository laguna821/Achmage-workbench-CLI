import { useEffect, useState, type ChangeEvent, type InputHTMLAttributes } from "react";
import type { ImageUploadCheck, ImageUploadInput, ImageUploadMode, ImageUploadView } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";
import "../styles/doc-images.css";

// Where pictures pasted into Markdown documents go: the user's Cloudflare R2 bucket, through the
// same Worker the CMDS Eagle plugin in Obsidian uses (Worker URL, API Key, Public URL) or with an R2
// API token, or the work folder's assets/. The keys are kept by the gateway on this computer; this
// screen never gets a secret back.

type Form = Required<ImageUploadInput>;
const EMPTY: Form = { mode: "worker", workerUrl: "", apiKey: "", accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "", publicBaseUrl: "", keyPrefix: "" };

const formOf = (view: ImageUploadView): Form => ({
  ...EMPTY,
  mode: view.mode,
  workerUrl: view.workerUrl,
  accountId: view.accountId,
  bucket: view.bucket,
  publicBaseUrl: view.publicBaseUrl,
  keyPrefix: view.keyPrefix,
});

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** One line in the ⋯ menu: where pasted pictures go now, and the way to change it. */
export function ImageUploadRow({ api, onOpen }: { api: Api; onOpen: () => void }) {
  const [view, setView] = useState<ImageUploadView | null>(null);
  useEffect(() => {
    void api.imageUpload().then(setView, () => undefined);
  }, [api]);
  return (
    <>
      <div className="menu-divider" />
      <div className="menu-label">문서에 붙여 넣는 그림</div>
      <div className="connection">
        <div className="connection-head">
          <span className="connection-name">Cloudflare R2</span>
          <span className={`connection-state ${view?.configured ? "ok" : ""}`}>
            {!view ? "확인 중" : view.configured ? `연결됨 · ${view.mode === "worker" ? hostOf(view.workerUrl) : view.bucket}` : "설정 안 됨"}
          </span>
        </div>
        <div className="connection-meta muted">
          {view?.configured ? "마크다운에 붙여 넣은 그림을 R2에 올리고 공개 주소로 링크합니다." : "마크다운에 붙여 넣은 그림은 작업 폴더의 assets/에 저장합니다."}
        </div>
      </div>
      <button type="button" className="text-button" onClick={onOpen}>
        그림 올리기 · Cloudflare R2…
      </button>
    </>
  );
}

export function ImageUploadSheet({ api, onClose, onToast }: { api: Api; onClose: () => void; onToast: (message: string) => void }) {
  const [view, setView] = useState<ImageUploadView | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState<"save" | "check" | "clear" | null>(null);
  const [check, setCheck] = useState<ImageUploadCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .imageUpload()
      .then((loaded) => {
        setView(loaded);
        setForm(formOf(loaded));
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (key: keyof Form) => (event: ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
    setCheck(null);
  };
  const setMode = (mode: ImageUploadMode) => {
    setForm((current) => ({ ...current, mode }));
    setCheck(null);
  };
  const run = async (kind: "save" | "check" | "clear") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "check") {
        setCheck(await api.checkImageUpload(form));
      } else if (kind === "save") {
        const saved = await api.saveImageUpload(form);
        setView(saved);
        setForm(formOf(saved));
        onToast("그림 올리기 설정을 저장했습니다. 키는 이 컴퓨터에만 있습니다.");
      } else {
        const cleared = await api.clearImageUpload();
        setView(cleared);
        setForm(formOf(cleared));
        setCheck(null);
        onToast("R2 설정을 지웠습니다. 붙여 넣은 그림은 작업 폴더에 저장합니다.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const field = (key: Exclude<keyof Form, "mode">, label: string, placeholder: string, extra: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="image-upload-field">
      <span>{label}</span>
      <input className="sheet-input" value={form[key]} onChange={set(key)} placeholder={placeholder} spellCheck={false} autoComplete="off" name={`r2-${key}`} {...extra} />
    </label>
  );
  const configured = view?.configured && view.mode === form.mode;

  return (
    <aside className="appearance-sheet image-upload-sheet" aria-label="그림 올리기">
      <div className="sheet-head">
        <h2>그림 올리기 · Cloudflare R2</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="닫기">
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="sheet-body">
        <p className="sheet-hint">
          마크다운 문서에 붙여 넣거나 끌어 놓은 그림을 R2 버킷에 올리고, 그 공개 주소를 그림 링크로 넣습니다. 설정하지 않았거나 올리지 못하면 작업 폴더의 <code>assets/</code>에 저장하고 상대 경로로 넣습니다.
        </p>
        {error ? <div className="notice notice-error compact">{error}</div> : null}
        <section className="sheet-section">
          <div className="sheet-label">올리는 방식</div>
          <div className="segmented small" role="radiogroup" aria-label="올리는 방식">
            {(["worker", "s3"] as const).map((mode) => (
              <button key={mode} type="button" role="radio" aria-checked={form.mode === mode} className={form.mode === mode ? "active" : ""} onClick={() => setMode(mode)}>
                {mode === "worker" ? "Worker (CMDS Eagle과 같은 값)" : "R2 API 토큰"}
              </button>
            ))}
          </div>
        </section>
        {form.mode === "worker" ? (
          <section className="sheet-section">
            <div className="sheet-label">
              Cloudflare Worker
              {configured ? <span className="image-upload-state ok">연결됨</span> : null}
            </div>
            {field("workerUrl", "Worker URL", "https://….workers.dev")}
            {field("apiKey", "API Key", view?.apiKeySet ? "저장됨 (바꿀 때만 입력)" : "Worker의 UPLOAD_API_KEY 값", { type: "password" })}
            {field("publicBaseUrl", "Public URL (선택)", "https://pub-….r2.dev")}
            <p className="sheet-hint">
              옵시디언 CMDS Eagle 설정의 Cloudflare R2 칸에 넣은 세 값(Worker URL · API Key · Public URL)을 그대로 넣으면 됩니다. R2 API 토큰은 따로 만들 필요가 없습니다. 그림은 Worker가 버킷에 저장하고 주소를 돌려주며, 같은 그림은 한 번만 올립니다. API Key는 이 컴퓨터의 앱 데이터 폴더에만 저장되고 다시 보여 주지 않습니다.
            </p>
          </section>
        ) : (
          <>
            <section className="sheet-section">
              <div className="sheet-label">
                R2 API 토큰
                {configured ? <span className="image-upload-state ok">연결됨</span> : null}
              </div>
              {field("accountId", "계정 ID", "32자리 계정 ID 또는 S3 API 주소")}
              {field("accessKeyId", "액세스 키 ID", view?.accessKeyHint ? `저장됨 · ${view.accessKeyHint} (바꿀 때만 입력)` : "토큰을 만들 때 나온 액세스 키 ID")}
              {field("secretAccessKey", "비밀 액세스 키", view?.secretSet ? "저장됨 (바꿀 때만 입력)" : "토큰을 만들 때 한 번만 보이는 값", { type: "password" })}
              <p className="sheet-hint">Cloudflare 대시보드 › R2 › API 토큰에서 "객체 읽기 및 쓰기" 권한으로 만든 토큰입니다(Worker 없이 직접 올리는 방식). 키는 이 컴퓨터의 앱 데이터 폴더에만 저장되고, 저장한 뒤에는 다시 보여 주지 않습니다.</p>
            </section>
            <section className="sheet-section">
              <div className="sheet-label">버킷</div>
              {field("bucket", "버킷 이름", "예: notes-images")}
              {field("publicBaseUrl", "공개 주소", "https://pub-….r2.dev 또는 연결한 도메인")}
              {field("keyPrefix", "키 앞부분 (선택)", "예: workbench/")}
              <p className="sheet-hint">그림은 내용으로 이름을 붙여(같은 그림은 한 번만) 올립니다.</p>
            </section>
          </>
        )}
        <div className="image-upload-actions">
          <button type="button" className="button small" disabled={busy !== null} onClick={() => void run("check")}>
            {busy === "check" ? <span className="spinner small" /> : null} 연결 확인
          </button>
          <button type="button" className="button small primary" disabled={busy !== null} onClick={() => void run("save")}>
            저장
          </button>
          {view?.configured ? (
            <button type="button" className="button small" disabled={busy !== null} onClick={() => void run("clear")}>
              설정 지우기
            </button>
          ) : null}
        </div>
        {check ? (
          <ul className={`image-upload-check${check.ok ? " ok" : ""}`} aria-label="연결 확인 결과">
            {check.steps.map((step) => (
              <li key={step.step} className={step.ok ? "ok" : "failed"}>
                <Icon name={step.ok ? "check" : "x"} size={13} />
                <span>{step.message}</span>
              </li>
            ))}
            {check.ok ? <li className="summary">이 설정으로 그림을 올릴 수 있습니다{view?.configured ? "." : ". 저장을 누르면 적용됩니다."}</li> : null}
          </ul>
        ) : null}
        <section className="sheet-section">
          <div className="sheet-label">문서 형식마다</div>
          <ul className="image-upload-formats">
            <li>
              <strong>마크다운</strong> 붙여넣기·끌어 놓기 → R2 링크, 또는 <code>assets/</code> 상대 링크
            </li>
            <li>
              <strong>워드·PPT·엑셀</strong> 편집기에서 붙여넣기·끌어 놓기 → 그림을 문서 파일 안에 넣습니다(R2를 쓰지 않음)
            </li>
            <li>
              <strong>한글(HWPX)</strong> 앱 안에서는 넣지 못합니다. HOP로 열어 넣어 주세요.
            </li>
          </ul>
        </section>
      </div>
    </aside>
  );
}

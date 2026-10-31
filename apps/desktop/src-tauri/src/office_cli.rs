use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// Opt-in CI diagnostics: fixed stage names only, never document content or tokens.
pub fn trace(stage: &str) {
    if stage.len() > 80 || !stage.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_:./".contains(&c)) { return; }
    let Some(root) = std::env::var_os("WORKBENCH_CLI_TRACE_DIR") else { return; };
    let root = PathBuf::from(root);
    if std::fs::create_dir_all(&root).is_err() { return; }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(root.join(format!("export-{}.log", std::process::id()))) {
        let _ = writeln!(file, "{stage}");
    }
}

pub struct InputError { pub message: String, pub code: i32 }
impl From<&str> for InputError {
    fn from(message: &str) -> Self { Self { message: message.into(), code: 1 } }
}
impl From<String> for InputError {
    fn from(message: String) -> Self { Self { message, code: 1 } }
}
impl InputError {
    fn file(error: impl std::fmt::Display) -> Self { Self { message: error.to_string(), code: 2 } }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub input: String,
    pub out_path: String,
    pub format: String,
    pub cwd: String,
}

/// One CLI invocation owns its gateway, browser storage and fixed output path.
pub struct ExportJob {
    pub request: ExportRequest,
    pub data_dir: PathBuf,
    temporary: Mutex<Option<tempfile::TempDir>>,
    written: Mutex<bool>,
    result: Mutex<Option<Result<(), String>>>,
}

impl ExportJob {
    pub fn parse(args: &[String]) -> Result<Arc<Self>, InputError> {
        let input = args.first().ok_or("내보낼 입력 파일이 필요합니다.")?;
        let mut format = None;
        let mut output = None;
        let mut i = 1;
        while i < args.len() {
            match args[i].as_str() {
                "--to" | "--out" => {
                    let value = args.get(i + 1).ok_or("--to/--out 값이 필요합니다.")?.clone();
                    if args[i] == "--to" { format = Some(value); } else { output = Some(value); }
                    i += 2;
                }
                "--json" => i += 1,
                arg => return Err(format!("지원하지 않는 내보내기 인자: {arg}").into()),
            }
        }
        let format = format.ok_or("--to 형식이 필요합니다.")?;
        if !["pdf", "html", "docx"].contains(&format.as_str()) { return Err("PDF/HTML/DOCX 내보내기를 선택하세요.".into()); }
        let input = std::fs::canonicalize(input).map_err(InputError::file)?;
        if !input.is_file() { return Err(InputError::file("입력은 문서 파일이어야 합니다.")); }
        let output = PathBuf::from(output.ok_or("--out 출력 경로가 필요합니다.")?);
        let output = if output.is_absolute() { output } else { std::env::current_dir().map_err(InputError::file)?.join(output) };
        let parent = std::fs::canonicalize(output.parent().ok_or("출력 폴더가 필요합니다.")?).map_err(InputError::file)?;
        let output = parent.join(output.file_name().ok_or("출력 파일 이름이 필요합니다.")?);
        if output.is_dir() || output.is_symlink() || std::fs::canonicalize(&output).ok().as_ref() == Some(&input) {
            return Err("원본과 다른 일반 출력 파일을 선택하세요.".into());
        }
        let extension = input.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        let allowed = match extension.as_str() {
            "docx" => ["pdf", "html"].contains(&format.as_str()),
            "html" | "htm" => ["pdf", "docx"].contains(&format.as_str()),
            "pptx" | "xlsx" | "xlsm" | "csv" | "xls" | "md" | "markdown" => format == "pdf",
            _ => false,
        };
        if !allowed { return Err(format!("이 입력의 내보내기 형식을 지원하지 않습니다: {extension} → {format}").into()); }
        let temporary = tempfile::Builder::new().prefix("workbench-export-").tempdir().map_err(InputError::file)?;
        Ok(Arc::new(Self {
            request: ExportRequest { cwd: input.parent().unwrap().to_string_lossy().into_owned(), input: input.to_string_lossy().into_owned(), out_path: output.to_string_lossy().into_owned(), format },
            data_dir: temporary.path().to_path_buf(), temporary: Mutex::new(Some(temporary)), written: Mutex::new(false), result: Mutex::new(None),
        }))
    }

    pub fn complete(&self, result: Result<(), String>) {
        let mut current = self.result.lock().unwrap();
        if current.is_none() { *current = Some(result); }
    }

    pub fn finish(&self) -> i32 {
        let result = self.result.lock().unwrap().take().unwrap_or_else(|| Err("내보내기가 완료되기 전에 앱이 종료됐습니다.".into()));
        if let Some(root) = self.temporary.lock().unwrap().take() {
            if let Err(error) = root.close() { eprintln!("내보내기 임시 폴더 정리 실패: {error}"); }
        }
        match result {
            Ok(()) => { println!("{}", serde_json::json!({"status":"ok", "command":"export", "output_path":self.request.out_path, "summary":format!("{} 내보내기 완료", self.request.format)})); 0 }
            Err(error) => { print_error(&error); 3 }
        }
    }
}

pub fn print_error(error: &str) { println!("{}", serde_json::json!({"status":"error", "command":"export", "error":error})); }

fn owner(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { Err("내보내기 요청 창이 아닙니다.".into()) } else { Ok(()) }
}

#[tauri::command]
pub fn office_cli_job(window: WebviewWindow, state: State<'_, Arc<ExportJob>>) -> Result<ExportRequest, String> {
    owner(&window)?; trace("job-requested"); Ok(state.request.clone())
}

#[tauri::command]
pub fn office_cli_trace(window: WebviewWindow, _state: State<'_, Arc<ExportJob>>, stage: String) -> Result<(), String> {
    owner(&window)?; trace(&stage); Ok(())
}

#[tauri::command]
pub fn office_cli_write(window: WebviewWindow, state: State<'_, Arc<ExportJob>>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    owner(&window)?;
    let bytes = match request.body() { tauri::ipc::InvokeBody::Raw(bytes) => bytes, _ => return Err("내보내기 바이트가 필요합니다.".into()) };
    if bytes.is_empty() || bytes.len() > 256 * 1024 * 1024 { return Err("내보내기 파일 크기가 올바르지 않습니다.".into()); }
    let mut written = state.written.lock().unwrap();
    if *written { return Err("이 내보내기는 이미 저장됐습니다.".into()); }
    let path = PathBuf::from(&state.request.out_path);
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(&path).map_err(|e| e.to_string())?;
    *written = true;
    trace("output-written");
    Ok(state.request.out_path.clone())
}

#[tauri::command]
pub fn office_cli_done(window: WebviewWindow, app: AppHandle, state: State<'_, Arc<ExportJob>>, ok: bool, error: Option<String>) -> Result<(), String> {
    owner(&window)?;
    let success = ok && *state.written.lock().unwrap();
    state.complete(if success { Ok(()) } else { Err(error.unwrap_or_else(|| "원본 편집기가 내보내기를 완료하지 못했습니다.".into())) });
    trace(if success { "export-done" } else { "export-error" });
    app.exit(if success { 0 } else { 3 });
    Ok(())
}

pub fn data_dir(app: &AppHandle) -> Option<PathBuf> { app.try_state::<Arc<ExportJob>>().map(|state| state.data_dir.clone()) }

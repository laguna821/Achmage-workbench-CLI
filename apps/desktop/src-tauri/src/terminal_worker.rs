//! One owned PTY, over inherited pipes. This mode never initializes a webview or opens a port.
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::collections::BTreeMap;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    args: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Input {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Close,
}

fn emit(value: Value) -> io::Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, &value)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn line(input: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = Vec::new();
    let read = input.take(131_073).read_until(b'\n', &mut bytes).map_err(|e| e.to_string())?;
    if read == 0 { return Ok(None); }
    if read > 131_072 || !bytes.ends_with(b"\n") { return Err("터미널 요청이 너무 크거나 불완전합니다.".into()); }
    Ok(Some(bytes))
}

fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=1000).contains(&cols) || !(2..=1000).contains(&rows) { return Err("터미널 크기가 범위를 벗어났습니다.".into()); }
    Ok(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
}

/// Only the live child and foreground group of this worker's own PTY are addressed.
fn stop(child: &mut Box<dyn Child + Send + Sync>, master: &dyn MasterPty) {
    if child.try_wait().ok().flatten().is_some() { return; }
    #[cfg(unix)]
    {
        if let Some(group) = master.process_group_leader().filter(|group| *group > 1) {
            unsafe { libc::kill(-group, libc::SIGHUP); }
        }
    }
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() { return; }
        std::thread::sleep(Duration::from_millis(20));
    }
    #[cfg(unix)]
    if let Some(pid) = child.process_id() {
        // We still own the unreaped child; no persisted PID is ever used for termination.
        unsafe { libc::kill(pid as i32, libc::SIGKILL); }
    }
    let _ = child.kill();
}

fn worker() -> Result<(), String> {
    let mut stdin = io::BufReader::new(io::stdin());
    let request = line(&mut stdin)?.ok_or("터미널 시작 정보가 없습니다.")?;
    let start: Start = serde_json::from_slice(&request).map_err(|e| e.to_string())?;
    let cwd = std::fs::canonicalize(&start.cwd).map_err(|e| e.to_string())?;
    if !cwd.is_dir() { return Err("터미널 작업 폴더가 아닙니다.".into()); }
    let mut command = if let Some(shell) = &start.shell {
        if shell.is_empty() || shell.len() > 4096 || start.args.as_ref().is_some_and(|args| args.len() > 64 || args.iter().any(|arg| arg.len() > 8192)) { return Err("셸 설정이 너무 큽니다.".into()); }
        let mut command = CommandBuilder::new(shell);
        command.args(start.args.as_deref().unwrap_or(&[]));
        command
    } else {
        if start.args.as_ref().is_some_and(|args| !args.is_empty()) { return Err("사용자 셸 없이 인자를 지정할 수 없습니다.".into()); }
        CommandBuilder::new_default_prog()
    };
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("WORKBENCH_") { command.env_remove(key); }
    }
    if let Some(environment) = start.env {
        if environment.len() > 32 || environment.iter().any(|(key, value)| key.len() > 128 || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') || key.starts_with("WORKBENCH_") || value.len() > 8192 || value.contains('\0')) {
            return Err("터미널 환경 변수가 올바르지 않습니다.".into());
        }
        for (key, value) in environment { command.env(key, value); }
    }
    let pair = native_pty_system().openpty(size(start.cols, start.rows)?).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    drop(pair.slave);
    if let Err(error) = emit(json!({"type":"ready", "pid":child.process_id(), "cols":start.cols, "rows":start.rows})) {
        stop(&mut child, &*pair.master); let _ = child.wait(); return Err(error.to_string());
    }
    let (read_done, read_finished) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = [0_u8; 16_384];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(n) => if emit(json!({"type":"data", "data":STANDARD.encode(&bytes[..n])})).is_err() { break; },
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = read_done.send(());
    });
    let (write, writes) = mpsc::sync_channel::<Vec<u8>>(16);
    std::thread::spawn(move || {
        for bytes in writes { if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() { break; } }
    });
    let (send, receive) = mpsc::sync_channel(32);
    std::thread::spawn(move || loop {
        let next = line(&mut stdin).and_then(|line| line.map(|bytes| serde_json::from_slice::<Input>(&bytes).map_err(|e| e.to_string())).transpose());
        let done = !matches!(next, Ok(Some(_)));
        if send.send(next).is_err() || done { break; }
    });
    let mut closed = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        match receive.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(Some(Input::Input { data }))) => {
                let bytes = STANDARD.decode(data).map_err(|e| e.to_string());
                let result = bytes.and_then(|bytes| {
                    if bytes.len() > 65_536 { return Err("한 번에 입력할 수 있는 양을 넘었습니다.".into()); }
                    write.try_send(bytes).map_err(|_| "터미널 입력 대기열이 가득 찼습니다.".to_string())
                });
                if let Err(message) = result { let _ = emit(json!({"type":"error", "fatal":false, "message":message})); }
            }
            Ok(Ok(Some(Input::Resize { cols, rows }))) => {
                let result = size(cols, rows).and_then(|size| pair.master.resize(size).map_err(|e| e.to_string()));
                match result {
                    Ok(()) => { let _ = emit(json!({"type":"resized", "cols":cols, "rows":rows})); }
                    Err(message) => { let _ = emit(json!({"type":"error", "fatal":false, "message":message})); }
                }
            }
            Ok(Ok(Some(Input::Close))) | Ok(Ok(None)) | Err(RecvTimeoutError::Disconnected) => { closed = true; stop(&mut child, &*pair.master); break child.wait().map_err(|e| e.to_string())?; }
            Ok(Err(message)) => { let _ = emit(json!({"type":"error", "fatal":true, "message":message})); closed = true; stop(&mut child, &*pair.master); break child.wait().map_err(|e| e.to_string())?; }
            Err(RecvTimeoutError::Timeout) => {}
        }
    };
    drop(write);
    // Preserve the final output before the exit marker, but do not wait forever on detached jobs.
    let _ = read_finished.recv_timeout(Duration::from_millis(500));
    emit(json!({"type":"exit", "code":status.exit_code(), "closed":closed})).map_err(|e| e.to_string())
}

pub fn run() -> i32 {
    match worker() {
        Ok(()) => 0,
        Err(message) => { let _ = emit(json!({"type":"error", "fatal":true, "message":message})); 1 }
    }
}

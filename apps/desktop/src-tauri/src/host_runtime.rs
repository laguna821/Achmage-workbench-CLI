//! An AppImage host owns a separate mount, backed by a durable copy of the compressed image.
//! The foreground native parent keeps that mount alive until its Node host exits.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use sha2::{Digest, Sha256};

pub(crate) fn profile_dir() -> PathBuf {
    std::env::var_os("WORKBENCH_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
            .unwrap_or_else(|| crate::home().join(".local/share")).join("achmage-workbench")
    })
}

fn digest(path: &Path) -> Result<String, String> {
    let mut source = File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 128 * 1024];
    loop {
        let count = source.read(&mut bytes).map_err(|error| error.to_string())?;
        if count == 0 { break; }
        hash.update(&bytes[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Called only for service startup; never removes a runtime that another host may still use.
pub(crate) fn persistent_image() -> Result<Option<PathBuf>, String> {
    if !cfg!(target_os = "linux") { return Ok(None); }
    let Some(source) = std::env::var_os("APPIMAGE") else { return Ok(None); };
    let source = fs::canonicalize(source).map_err(|error| format!("AppImage 실행 파일을 찾지 못했습니다: {error}"))?;
    if !source.is_file() { return Err("AppImage 실행 경로가 파일이 아닙니다.".into()); }
    let root = profile_dir().join("runtimes/appimage");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?; }
    let mut options = OpenOptions::new(); options.read(true).write(true).create(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
    let lock = options.open(root.join("install.lock")).map_err(|error| error.to_string())?;
    lock.lock().map_err(|error| error.to_string())?;
    let hash = digest(&source)?;
    let directory = root.join(&hash);
    let target = directory.join("AchmageWorkbench.AppImage");
    if target.is_file() && digest(&target)? == hash { return Ok(Some(target)); }
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory).map_err(|error| error.to_string())?;
    let mut input = File::open(&source).map_err(|error| error.to_string())?;
    std::io::copy(&mut input, &mut temporary).map_err(|error| error.to_string())?;
    temporary.flush().map_err(|error| error.to_string())?;
    temporary.as_file().sync_all().map_err(|error| error.to_string())?;
    if digest(temporary.path())? != hash { return Err("복사 중 AppImage가 변경되었습니다. 앱을 다시 실행해 주세요.".into()); }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; temporary.as_file().set_permissions(fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?; }
    temporary.persist(&target).map_err(|error| error.to_string())?;
    Ok(Some(target))
}

fn command(service: bool) -> Result<Command, String> {
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let dirs = crate::resource_dirs(tauri::utils::platform::resource_dir(context.package_info(), &Default::default()).ok());
    let name = if service { "host/workbench-service.mjs" } else { "host/host.mjs" };
    let root = dirs.iter().find(|dir| dir.join(name).is_file()).ok_or("설치본의 호스트 실행기를 찾지 못했습니다.")?;
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(crate::node_in(&dirs));
    command.arg(root.join(name))
        .env_remove("ELECTRON_RUN_AS_NODE").env_remove("WORKBENCH_CLI_INPUT")
        .env("PATH", crate::engine_path())
        .env("WORKBENCH_DATA_DIR", profile_dir())
        .env("WORKBENCH_WEB_DIR", root.join("web"))
        .env("WORKBENCH_RESOURCES_DIR", std::env::join_paths(&dirs).map_err(|error| error.to_string())?)
        .env("WORKBENCH_PTY_BIN", &exe).env("WORKBENCH_SECRET_BIN", &exe).env("WORKBENCH_APP_BIN", &exe)
        .env("WORKBENCH_HOST_MODE", "service").env("WORKBENCH_EXIT_ON_STDIN_CLOSE", "0")
        .stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    if let Some(image) = std::env::var_os("APPIMAGE") {
        command.env("WORKBENCH_HOST_RUNNER", &image).env("WORKBENCH_APP_BIN", image);
    }
    Ok(command)
}

/// Early main entrypoint: no webview, tray, or single-instance UI registration.
pub fn run(service: bool) -> i32 {
    let result = (|| -> Result<i32, String> {
        let mut command = command(service)?;
        if service {
            let action = std::env::args().nth(2).unwrap_or_else(|| "status".into());
            if !matches!(action.as_str(), "start" | "stop" | "status" | "attach") { return Err("호스트 실행 명령이 올바르지 않습니다.".into()); }
            command.arg(action);
        }
        // Wait rather than exec: the parent AppImage runtime must retain its FUSE mount.
        Ok(command.status().map_err(|error| error.to_string())?.code().unwrap_or(1))
    })();
    match result { Ok(code) => code, Err(error) => { eprintln!("{error}"); 1 } }
}

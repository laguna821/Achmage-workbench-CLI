//! The gateway's launcher (`--host-runtime`): every start of the background gateway goes through
//! this binary, which hands the gateway its per-run vault ticket (gateway_caller.rs). An AppImage
//! host also owns a separate mount, backed by a durable copy of the compressed image; the
//! foreground native parent keeps that mount alive until its Node host exits.
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

/// Variables that load code into Node or into any process at start (an injected `--require`, a
/// preloaded library). A launcher never passes them to the gateway: whoever starts the launcher
/// chooses its environment (sec-vault round 2).
pub(crate) fn loads_code(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    (name.starts_with("NODE_") && name != "NODE_ENV") || name.starts_with("LD_") || name.starts_with("DYLD_")
}
pub(crate) fn without_code_loaders(command: &mut Command) {
    for (name, _) in std::env::vars_os() { if loads_code(&name) { command.env_remove(name); } }
}

/// The gateway script of this install: `host/host.mjs` beside the binary (or in the bundle's
/// resource folder) — never a path from the arguments or, in a release build, the environment.
fn gateway_entry(dirs: &[PathBuf]) -> Result<(PathBuf, PathBuf), String> {
    #[cfg(debug_assertions)]
    if let Some(entry) = std::env::var_os("WORKBENCH_GATEWAY_ENTRY") {
        let entry = PathBuf::from(entry);
        let root = entry.parent().and_then(|p| p.parent()).map(PathBuf::from).unwrap_or_default();
        return Ok((entry, root));
    }
    let root = dirs.iter().find(|dir| dir.join("host/host.mjs").is_file()).ok_or("설치본의 호스트 실행기를 찾지 못했습니다.")?;
    Ok((root.join("host/host.mjs"), root.clone()))
}

fn command(service: bool) -> Result<Command, String> {
    let context = crate::app_context();
    let dirs = crate::resource_dirs(tauri::utils::platform::resource_dir(context.package_info(), &Default::default()).ok());
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(crate::node_in(&dirs));
    if service {
        let root = dirs.iter().find(|dir| dir.join("host/workbench-service.mjs").is_file()).ok_or("설치본의 호스트 실행기를 찾지 못했습니다.")?;
        command.arg(root.join("host/workbench-service.mjs")).env("WORKBENCH_WEB_DIR", root.join("web"));
    } else {
        let (entry, root) = gateway_entry(&dirs)?;
        command.arg(entry).env("WORKBENCH_WEB_DIR", root.join("web"))
            // The gateway reads its per-run ticket from the first line of its stdin (gateway-env.ts).
            .env("WORKBENCH_GATEWAY_TICKET", "stdin");
    }
    without_code_loaders(&mut command);
    // A test harness may run the gateway in the window's mode (it prints its address on stdout).
    let mode = if !service && std::env::var("WORKBENCH_HOST_MODE").as_deref() == Ok("shell") { "shell" } else { "service" };
    command.env_remove("ELECTRON_RUN_AS_NODE").env_remove("WORKBENCH_CLI_INPUT")
        .env("PATH", crate::engine_path())
        .env("WORKBENCH_DATA_DIR", profile_dir())
        .env("WORKBENCH_RESOURCES_DIR", std::env::join_paths(&dirs).map_err(|error| error.to_string())?)
        .env("WORKBENCH_PTY_BIN", &exe).env("WORKBENCH_SECRET_BIN", &exe).env("WORKBENCH_APP_BIN", &exe)
        // As the launcher this process holds the gateway's stdin until the gateway exits: if the
        // launcher is killed, the pipe closes and the gateway stops (an AppImage's mount goes with it).
        .env("WORKBENCH_HOST_MODE", mode).env("WORKBENCH_EXIT_ON_STDIN_CLOSE", if service { "0" } else { "1" })
        .stdin(if service { Stdio::null() } else { Stdio::piped() })
        .stdout(if service { Stdio::inherit() } else { Stdio::piped() })
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        // No console window for the gateway.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    if let Some(image) = std::env::var_os("APPIMAGE") {
        command.env("WORKBENCH_HOST_RUNNER", &image).env("WORKBENCH_APP_BIN", image);
    }
    Ok(command)
}

/// What a gateway prints on stdout to ask its launcher to write its registration again (the keyring
/// was locked at start, or the item was deleted). Anyone who can write to that stdout can only
/// re-register the same gateway with the same ticket hash.
pub(crate) const REREGISTER: &str = "WORKBENCH_VAULT_REGISTER";

/// The launcher's part for a gateway it has just spawned (stdin piped): mint the per-run ticket,
/// register the child for `folder` in the OS keyring, then — and only then — write the ticket as the
/// first line of the child's stdin. Another live gateway registered for the folder: wait up to 10 s
/// (a quick restart: the old one is still exiting), then refuse. A keyring that refuses the write
/// (locked) does not stop the start: the gateway is told by the helper and says so (part 3).
pub(crate) fn hand_ticket(child: &mut std::process::Child, folder: &Path) -> Result<[u8; 32], String> {
    use crate::office_secrets::{register_gateway, OsVault, VAULT_SERVICE, LEGACY_SERVICE};
    let ticket = crate::office_secrets::random::<32>().map_err(|e| e.to_string())?;
    let me = crate::gateway_caller::process(child.id()).ok_or("게이트웨이 프로세스를 확인하지 못했습니다.")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match register_gateway(folder, &me, &ticket, &OsVault(VAULT_SERVICE), &OsVault(LEGACY_SERVICE)) {
            Err(crate::gateway_caller::RUNNING) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(crate::gateway_caller::RUNNING) => return Err("이 데이터 폴더의 다른 게이트웨이가 실행 중입니다.".into()),
            Err(code) => { eprintln!("Vault: gateway registration not written ({code})"); break; }
            Ok(()) => break,
        }
    }
    let stdin = child.stdin.as_mut().ok_or("게이트웨이 입력을 열지 못했습니다.")?;
    stdin.write_all(format!("{}\n", crate::gateway_caller::hex(&ticket)).as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(ticket)
}

/// One line from the gateway's stdout, seen by its launcher: a re-registration request is acted on
/// (and not forwarded); every other line is the caller's.
pub(crate) fn launcher_line(line: &[u8], folder: &Path, pid: u32, ticket: &[u8; 32]) -> bool {
    use crate::office_secrets::{register_gateway, OsVault, VAULT_SERVICE, LEGACY_SERVICE};
    if line.trim_ascii() != REREGISTER.as_bytes() { return false; }
    if let Some(me) = crate::gateway_caller::process(pid) {
        if let Err(code) = register_gateway(folder, &me, ticket, &OsVault(VAULT_SERVICE), &OsVault(LEGACY_SERVICE)) { eprintln!("Vault: gateway registration not written ({code})"); }
    }
    true
}

/// A stop asked of the launcher (SIGTERM, SIGINT, SIGHUP) is passed to its gateway, and the launcher
/// exits when the gateway has stopped — as when the gateway itself was the process asked.
#[cfg(unix)]
static GATEWAY: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
#[cfg(unix)]
extern "C" fn pass_stop(signal: libc::c_int) {
    let pid = GATEWAY.load(std::sync::atomic::Ordering::Relaxed);
    if pid > 0 { unsafe { libc::kill(pid, signal); } }
}
fn forward_stop(pid: u32) {
    #[cfg(unix)]
    unsafe {
        GATEWAY.store(pid as i32, std::sync::atomic::Ordering::Relaxed);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] { libc::signal(signal, pass_stop as *const () as libc::sighandler_t); }
    }
    // Windows: no such signals; the gateway stops when the launcher's end of its stdin closes.
    #[cfg(not(unix))]
    let _ = pid;
}

/// The data folder as the helper will see it (created private if missing).
pub(crate) fn real_folder(folder: &Path) -> Result<PathBuf, String> {
    let mut builder = fs::DirBuilder::new(); builder.recursive(true);
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(folder).map_err(|error| error.to_string())?;
    fs::canonicalize(folder).map_err(|error| error.to_string())
}

/// Early main entrypoint: no webview, tray, or single-instance UI registration.
/// `--host-runtime` is THE launcher of the gateway (every start: the window's, workbench-service's,
/// the login unit's, the AppImage's): it starts the gateway, registers it with a fresh ticket, waits
/// for it (the AppImage runtime must keep its FUSE mount meanwhile) and removes the registration after.
pub fn run(service: bool) -> i32 {
    let result = (|| -> Result<i32, String> {
        let mut command = command(service)?;
        if service {
            let action = std::env::args().nth(2).unwrap_or_else(|| "status".into());
            if !matches!(action.as_str(), "start" | "stop" | "status" | "attach") { return Err("호스트 실행 명령이 올바르지 않습니다.".into()); }
            command.arg(action);
            // Wait rather than exec: the parent AppImage runtime must retain its FUSE mount.
            return Ok(command.status().map_err(|error| error.to_string())?.code().unwrap_or(1));
        }
        let folder = real_folder(&profile_dir())?;
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let ticket = match hand_ticket(&mut child, &folder) {
            Ok(ticket) => ticket,
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); }
        };
        let pid = child.id();
        forward_stop(pid);
        // Held here, not in `child`: `Child::wait` closes the child's stdin first, and a closed stdin
        // tells the gateway its launcher is gone. Dropped only after the gateway has exited.
        let held_stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let forward = stdout.map(|stdout| {
            let folder = folder.clone();
            std::thread::spawn(move || {
                let mut reader = std::io::BufReader::new(stdout);
                let mut line = Vec::new();
                loop {
                    line.clear();
                    match std::io::BufRead::read_until(&mut reader, b'\n', &mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => if !launcher_line(&line, &folder, pid, &ticket) {
                            let mut out = std::io::stdout().lock();
                            let _ = out.write_all(&line); let _ = out.flush();
                        },
                    }
                }
            })
        });
        let status = child.wait().map_err(|error| error.to_string())?;
        drop(held_stdin);
        if let Some(forward) = forward { let _ = forward.join(); }
        crate::office_secrets::unregister_gateway(&folder, pid, &crate::office_secrets::OsVault(crate::office_secrets::VAULT_SERVICE));
        Ok(status.code().unwrap_or(1))
    })();
    match result { Ok(code) => code, Err(error) => { eprintln!("{error}"); 1 } }
}

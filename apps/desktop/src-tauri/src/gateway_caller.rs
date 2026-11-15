//! Who may ask the OS vault helper (`--office-secret-key`) for the master key: only the gateway that
//! the app's own binary started for the data folder, as the helper's DIRECT parent, carrying the
//! per-run ticket that binary handed it (sec-vault round 2, 2026-11-15).
//!
//! - The binary in launcher mode (host_runtime.rs, and the window's own start in lib.rs) starts the
//!   gateway, mints a random 32-byte ticket, writes the registration — the gateway's pid, its kernel
//!   start stamp and sha256(ticket) — into the OS keyring (account `gateway:<sha256 of the folder>`,
//!   service `VAULT_SERVICE`), and only then writes the ticket into the gateway's stdin. The ticket
//!   lives in the gateway's memory and in that pipe, nowhere else.
//! - The helper NEVER registers anyone (round 1 let the first caller register whenever no gateway was
//!   live). It answers only when the registration exists, its process is live (same pid, same start
//!   stamp), it is the helper's direct parent, and the request's ticket hashes to the registered hash.
//!   A program the gateway runs — even one exec'd from an rc file or a `git` planted on a PATH — has the
//!   right parent but not the ticket.
//! - Nothing the caller controls (folder contents, environment, arguments) says who the gateway is.
//! What it does NOT stop is written down in ux/reports/sec-vault-round2-report.md (the OS credential
//! store read directly on Linux/Windows; a rewritten install; reading the gateway's memory).
use sha2::{Digest, Sha256};
use std::path::Path;

type Result<T> = std::result::Result<T, &'static str>;

/// The fixed code a refused caller gets: never a path, a pid or anything about the vault.
pub(crate) const REFUSED: &str = "caller_not_gateway";
/// No live gateway is registered for the folder (deleted, never written, or its gateway is gone).
pub(crate) const UNREGISTERED: &str = "gateway_not_registered";
/// A launcher found another live gateway registered for the folder.
pub(crate) const RUNNING: &str = "gateway_already_running";

/// A running process as the operating system reports it: its pid and a stamp of when it started that
/// no later process with the same pid can have (Linux: boot id + start ticks; macOS: start time in
/// microseconds; Windows: creation time in 100 ns units). The stamp holds no ':'.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Process { pub pid: u32, pub stamp: String }

/// A gateway as registered in the keyring: the process and the sha256 of its ticket.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Registration { pub pid: u32, pub stamp: String, pub ticket: [u8; 32] }
impl Registration {
    pub(crate) fn new(process: &Process, ticket: &[u8]) -> Self {
        Registration { pid: process.pid, stamp: process.stamp.clone(), ticket: Sha256::digest(ticket).into() }
    }
    pub(crate) fn encode(&self) -> Vec<u8> { format!("v2:{}:{}:{}", self.pid, self.stamp, hex(&self.ticket)).into_bytes() }
    /// A round-1 record ("pid:ns") or anything else reads as no registration.
    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(bytes).ok()?;
        let mut parts = text.splitn(4, ':');
        if parts.next()? != "v2" { return None; }
        let pid = parts.next()?.parse().ok()?;
        let stamp = parts.next()?.to_string();
        let ticket = unhex(parts.next()?)?;
        if stamp.is_empty() { return None; }
        Some(Registration { pid, stamp, ticket })
    }
    fn process(&self) -> Process { Process { pid: self.pid, stamp: self.stamp.clone() } }
}

pub(crate) fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
pub(crate) fn unhex<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() != N * 2 || !text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return None; }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() { *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()?; }
    Some(out)
}
fn same(a: &[u8], b: &[u8]) -> bool { a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0 }

/// The keyring account of a folder's gateway registration.
pub(crate) fn slot(folder: &Path) -> String {
    let hash = Sha256::digest(folder.to_string_lossy().as_bytes());
    format!("gateway:{}", hex(&hash[..16]))
}

/// Whether a registered gateway still runs (the same pid with the same start stamp).
pub(crate) fn live(registration: &Registration) -> bool {
    stamp(registration.pid).as_deref() == Some(registration.stamp.as_str())
}

/// Answer the caller only if its direct parent is the live registered gateway and it carries that
/// gateway's ticket. Never registers: registration is the launcher's alone (`register`).
pub(crate) fn admit(parent: Option<Process>, current: Option<Registration>, alive: impl Fn(&Registration) -> bool, ticket: Option<&[u8]>) -> Result<()> {
    let current = current.ok_or(UNREGISTERED)?;
    if !alive(&current) { return Err(UNREGISTERED); }
    let parent = parent.ok_or(REFUSED)?;
    if parent != current.process() { return Err(REFUSED); }
    let ticket = ticket.ok_or(REFUSED)?;
    if !same(&Sha256::digest(ticket), &current.ticket) { return Err(REFUSED); }
    Ok(())
}

/// The registration a launcher writes for the gateway it has just started (`child`): refused while
/// another live gateway is registered for the folder (no takeover of a running gateway).
pub(crate) fn register(child: &Process, ticket: &[u8], current: Option<Registration>, alive: impl Fn(&Registration) -> bool) -> Result<Registration> {
    if let Some(registered) = current {
        if registered.pid != child.pid && alive(&registered) { return Err(RUNNING); }
    }
    Ok(Registration::new(child, ticket))
}

/// The person's default data folder, from the account database (never the environment), for
/// binding a vault made before folders were bound. Windows: the profile folder the system gives.
pub(crate) fn default_folder() -> Option<std::path::PathBuf> {
    #[cfg(unix)] {
        let mut buffer = vec![0 as libc::c_char; 16_384];
        let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        let code = unsafe { libc::getpwuid_r(libc::geteuid(), &mut entry, buffer.as_mut_ptr(), buffer.len(), &mut found) };
        if code != 0 || found.is_null() || entry.pw_dir.is_null() { return None; }
        let home = unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }.to_string_lossy().into_owned();
        std::fs::canonicalize(Path::new(&home).join(".local/share/achmage-workbench")).ok()
    }
    #[cfg(windows)] {
        // Windows' Credential Manager is readable by every program of the person anyway (see the report).
        let home = std::env::var_os("USERPROFILE")?;
        std::fs::canonicalize(Path::new(&home).join(".local/share/achmage-workbench")).ok()
    }
    #[cfg(not(any(unix, windows)))] { None }
}

/// This process's parent, as the kernel reports it, with its start stamp.
pub(crate) fn parent() -> Option<Process> {
    let pid = parent_pid()?;
    Some(Process { pid, stamp: stamp(pid)? })
}

/// A process by pid, as the kernel reports it now.
pub(crate) fn process(pid: u32) -> Option<Process> { Some(Process { pid, stamp: stamp(pid)? }) }

#[cfg(unix)]
fn parent_pid() -> Option<u32> {
    let pid = unsafe { libc::getppid() };
    // 1: the parent is gone and this process was taken over by init.
    (pid > 1).then_some(pid as u32)
}

/// Linux: the boot's id and the process's start time in clock ticks since boot (field 22 of
/// /proc/<pid>/stat) — raw kernel values that do not move when the wall clock is stepped or slewed
/// (review M1: round 1 derived a wall time from `btime`, which does). A zombie is not live.
#[cfg(target_os = "linux")]
pub(crate) fn stamp(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name (field 2) may hold spaces and parentheses; fields after the last ')' do not.
    let rest = &stat[stat.rfind(')')? + 1..];
    let mut fields = rest.split_whitespace();
    let state = fields.next()?;
    if state == "Z" || state == "X" { return None; }
    // rest starts at field 3 (state); field 22 (starttime) is index 19, i.e. 18 after the state.
    let ticks: u64 = fields.nth(18)?.parse().ok()?;
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let boot = boot.trim();
    if boot.is_empty() || boot.contains(':') { return None; }
    Some(format!("{boot}/{ticks}"))
}

/// macOS: the start time the kernel keeps for the process (seconds and microseconds; fixed at fork).
#[cfg(target_os = "macos")]
pub(crate) fn stamp(pid: u32) -> Option<String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if read != size || info.pbi_pid != pid { return None; }
    // SZOMB = 5: exited, not yet reaped.
    if info.pbi_status == 5 { return None; }
    Some(format!("{}.{:06}", info.pbi_start_tvsec, info.pbi_start_tvusec))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub(crate) fn stamp(_pid: u32) -> Option<String> { None }

#[cfg(windows)]
fn parent_pid() -> Option<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    let me = std::process::id();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = None;
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            if entry.th32ProcessID == me { found = Some(entry.th32ParentProcessID); break; }
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        // Windows keeps a parent's number after it exits; the start stamp refuses a reused one.
        found.filter(|pid| *pid != 0)
    }
}

/// Windows: the creation time (100 ns units since 1601), only while the process has not exited
/// (an open handle elsewhere keeps an exited process's record).
#[cfg(windows)]
pub(crate) fn stamp(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let read = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
        let mut code = 0u32;
        let running = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE;
        let _ = CloseHandle(handle);
        read.ok()?;
        if !running { return None; }
        Some((((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn process(pid: u32, s: u64) -> Process { Process { pid, stamp: format!("boot/{s}") } }
    const TICKET: [u8; 32] = [7; 32];

    #[test]
    fn answers_only_the_live_registered_gateway_as_direct_parent_with_its_ticket() {
        let gateway = Registration::new(&process(4242, 9), &TICKET);
        let alive = |_: &Registration| true;
        assert_eq!(admit(Some(process(4242, 9)), Some(gateway.clone()), alive, Some(&TICKET)), Ok(()));
        // An exec'd direct child of the gateway (rc file, planted git): the right parent, no ticket.
        assert_eq!(admit(Some(process(4242, 9)), Some(gateway.clone()), alive, None), Err(REFUSED));
        assert_eq!(admit(Some(process(4242, 9)), Some(gateway.clone()), alive, Some(&[8; 32])), Err(REFUSED));
        // An engine, its shell or a double-forked child: its parent is never the gateway.
        assert_eq!(admit(Some(process(5000, 20)), Some(gateway.clone()), alive, Some(&TICKET)), Err(REFUSED));
        // The same number, another process (the gateway gone, its pid reused).
        assert_eq!(admit(Some(process(4242, 60)), Some(gateway.clone()), alive, Some(&TICKET)), Err(REFUSED));
        assert_eq!(admit(None, Some(gateway), alive, Some(&TICKET)), Err(REFUSED));
    }

    #[test]
    fn nobody_registers_through_the_helper() {
        // No registration (none written, or deleted with the keyring tool): every caller is refused —
        // round 1 registered the first caller here (review I2).
        assert_eq!(admit(Some(process(7000, 30)), None, |_| true, Some(&TICKET)), Err(UNREGISTERED));
        // The registered gateway has exited: refused too, until a launcher registers the next one.
        let old = Registration::new(&process(4242, 9), &TICKET);
        assert_eq!(admit(Some(process(4242, 9)), Some(old), |_| false, Some(&TICKET)), Err(UNREGISTERED));
    }

    #[test]
    fn a_launcher_registers_its_own_child_but_never_over_a_live_gateway() {
        let running = Registration::new(&process(4242, 9), &TICKET);
        assert_eq!(register(&process(7000, 30), &[1; 32], Some(running.clone()), |_| true), Err(RUNNING));
        let next = register(&process(7000, 30), &[1; 32], Some(running), |_| false).unwrap();
        assert_eq!(next, Registration::new(&process(7000, 30), &[1; 32]));
        assert_eq!(Registration::decode(&next.encode()), Some(next.clone()));
        // A round-1 record and junk read as none.
        assert_eq!(Registration::decode(b"4242:1800000000000000000"), None);
        assert_eq!(Registration::decode(b"not a record"), None);
        assert!(!String::from_utf8(next.encode()).unwrap().contains(&hex(&[1; 32])), "the ticket itself is never stored");
    }

    // On every OS the release builds for (the Windows and macOS jobs run these tests too).
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn reads_the_real_parent_and_sees_it_live() {
        let parent = parent().expect("the test runner's parent is readable");
        let registration = Registration::new(&parent, &TICKET);
        assert!(live(&registration));
        assert!(!live(&Registration { stamp: "other/1".into(), ..registration }));
        assert_eq!(super::process(std::process::id()).map(|p| p.pid), Some(std::process::id()));
        assert_ne!(slot(Path::new("/a")), slot(Path::new("/b")));
    }
}

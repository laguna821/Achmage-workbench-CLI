//! Headless, one-request OS vault helper. Only the gateway's private pipe receives the key: the
//! helper answers only when its direct parent is the live gateway that the app's binary started and
//! registered for the requested data folder, and the request carries that gateway's per-run ticket
//! (gateway_caller.rs); any other caller gets a fixed refusal before the key is read.
//! No Electron, renderer IPC, plaintext key file, credential enumeration or fallback store.
//!
//! Keyring names (sec-vault round 2, review I1): the master key, its folder binding and the gateway
//! registration live under `VAULT_SERVICE`. Every earlier build read the key from `LEGACY_SERVICE`;
//! the first answered call moves it (write new, read back, delete old), so an old copy of the binary
//! left on the disk finds no key. A crash between the two steps is finished at the next call.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use crate::gateway_caller::{self as caller, Process, Registration};

/// Where this build keeps the vault: a name no earlier build knows.
pub(crate) const VAULT_SERVICE: &str = "kr.achmage.workbench.vault";
/// Where every build before sec-vault round 2 kept it (and round 1 its registration and binding).
pub(crate) const LEGACY_SERVICE: &str = "kr.achmage.workbench.office-ai";
type Result<T> = std::result::Result<T, &'static str>;

pub(crate) trait Vault {
    fn get(&self, id: &str) -> Result<Option<Vec<u8>>>;
    fn set(&self, id: &str, key: &[u8]) -> Result<()>;
    fn delete(&self, id: &str) -> Result<()>;
}
pub(crate) struct OsVault(pub &'static str);
impl Vault for OsVault {
    fn get(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let entry = keyring::Entry::new(self.0, id).map_err(|_| "vault_unavailable")?;
        match entry.get_secret() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("vault_unavailable"),
        }
    }
    fn set(&self, id: &str, key: &[u8]) -> Result<()> {
        keyring::Entry::new(self.0, id).map_err(|_| "vault_unavailable")?
            .set_secret(key).map_err(|_| "vault_unavailable")
    }
    fn delete(&self, id: &str) -> Result<()> {
        match keyring::Entry::new(self.0, id).map_err(|_| "vault_unavailable")?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("vault_unavailable"),
        }
    }
}
pub(crate) fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| "random_unavailable")?;
    Ok(bytes)
}
fn valid_id(id: &str) -> bool { id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn private_file(path: &Path, exclusive: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if exclusive { options.create_new(true); } else { options.create(true); }
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| "profile_unavailable")?;
    if !file.metadata().map_err(|_| "profile_unavailable")?.is_file() { return Err("profile_unavailable"); }
    Ok(file)
}

/// The key stored for `id`, moved from where earlier builds kept it if it is still there.
fn stored_key(id: &str, vault: &impl Vault, legacy: &impl Vault, keep_legacy: bool) -> Result<Option<Vec<u8>>> {
    if let Some(key) = vault.get(id)? {
        // Moved before, or a crash came between "written here" and "deleted there": finish it. A
        // different value there is left alone (it is not this vault's key; nothing is destroyed).
        if !keep_legacy { if let Ok(Some(old)) = legacy.get(id) { if old == key { let _ = legacy.delete(id); } } }
        return Ok(Some(key));
    }
    let Some(old) = legacy.get(id)? else { return Ok(None) };
    vault.set(id, &old)?;
    if vault.get(id)?.as_deref() != Some(old.as_slice()) { return Err("vault_verify_failed"); }
    // Deleting the old item is what makes old binaries useless; if it fails now, the next call retries.
    if !keep_legacy { let _ = legacy.delete(id); }
    Ok(Some(old))
}

fn master_key(profile: &Path, create: bool, vault: &impl Vault, legacy: &impl Vault, keep_legacy: bool) -> Result<Option<(String, Vec<u8>)>> {
    if !profile.is_absolute() || !profile.is_dir() { return Err("invalid_profile"); }
    let dir = profile.join("office");
    let id_path = dir.join("vault-id");
    if !dir.exists() && !create { return Ok(None); }
    let mut builder = fs::DirBuilder::new(); builder.recursive(true);
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(&dir).map_err(|_| "profile_unavailable")?;
    // All helper processes use the same OS file lock. It releases even if a helper dies.
    let lock = private_file(&dir.join("vault.lock"), false)?;
    lock.lock().map_err(|_| "profile_unavailable")?;
    match fs::symlink_metadata(&id_path) {
        Ok(meta) => {
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != 32 { return Err("invalid_vault_id"); }
            let id = fs::read_to_string(&id_path).map_err(|_| "profile_unavailable")?;
            if !valid_id(&id) { return Err("invalid_vault_id"); }
            let key = stored_key(&id, vault, legacy, keep_legacy)?.ok_or("vault_key_missing")?;
            if key.len() != 32 { return Err("invalid_vault_key"); }
            Ok(Some((id, key)))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if !create { return Ok(None); }
            let id: String = random::<16>()?.iter().map(|byte| format!("{byte:02x}")).collect();
            if vault.get(&id)?.is_some() || legacy.get(&id)?.is_some() { return Err("vault_id_collision"); }
            let key = random::<32>()?.to_vec(); vault.set(&id, &key)?;
            if vault.get(&id)?.as_deref() != Some(key.as_slice()) { return Err("vault_verify_failed"); }
            // The key belongs to this folder (gateway_caller.rs): a copied vault-id elsewhere opens nothing.
            vault.set(&format!("{id}:folder"), profile.to_string_lossy().as_bytes())?;
            // Only a non-secret identifier goes on disk. Atomic rename prevents partial ids.
            let temporary = dir.join(format!(".vault-id-{id}.tmp"));
            let saved = (|| -> Result<()> {
                let mut file = private_file(&temporary, true)?;
                file.write_all(id.as_bytes()).map_err(|_| "profile_unavailable")?;
                file.sync_all().map_err(|_| "profile_unavailable")?;
                drop(file);
                fs::rename(&temporary, &id_path).map_err(|_| "profile_unavailable")?;
                Ok(())
            })();
            if saved.is_err() { let _ = fs::remove_file(&temporary); }
            saved?;
            Ok(Some((id, key)))
        }
        Err(_) => Err("profile_unavailable"),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    directory: String,
    create: bool,
    /// The gateway's per-run ticket (64 hex), handed to it by the launcher over its stdin.
    #[serde(default)]
    ticket: Option<String>,
    /// The way back (INSTALL-NOTE): write the key again where earlier builds look, for a rollback.
    #[serde(default)]
    restore_legacy: bool,
    /// Set by a gateway that restored it in this run, so its later calls leave it there.
    #[serde(default)]
    keep_legacy: bool,
}
fn request() -> Result<Request> {
    let mut bytes = Vec::new(); io::stdin().take(32_769).read_to_end(&mut bytes).map_err(|_| "invalid_request")?;
    if bytes.len() > 32_768 { return Err("invalid_request"); }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_request")
}
pub fn run() -> i32 {
    // keyring's no-feature default is a mock. Never silently use it on an unsupported OS.
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    { return 1; }
    let (output, code) = answer(request(), caller::parent(), caller::live, caller::default_folder(), &OsVault(VAULT_SERVICE), &OsVault(LEGACY_SERVICE));
    // Errors are fixed codes: never paths, account names, vault errors or secret bytes.
    if serde_json::to_writer(io::stdout().lock(), &output).is_err() { return 1; }
    code
}

/// The whole answer for one request: the caller is admitted (gateway_caller.rs) before the key is
/// read, and the key is given only for the folder it belongs to.
fn answer(request: Result<Request>, parent: Option<Process>, alive: impl Fn(&Registration) -> bool, default: Option<PathBuf>, vault: &impl Vault, legacy: &impl Vault) -> (serde_json::Value, i32) {
    let mut restored = false;
    let result = request.and_then(|req| {
        let given = Path::new(&req.directory);
        if !given.is_absolute() { return Err("invalid_profile"); }
        let folder = fs::canonicalize(given).map_err(|_| "invalid_profile")?;
        let current = vault.get(&caller::slot(&folder))?.and_then(|bytes| Registration::decode(&bytes));
        let ticket = req.ticket.as_deref().and_then(caller::unhex::<32>);
        caller::admit(parent, current, alive, ticket.as_ref().map(|t| t.as_slice()))?;
        let keep = req.keep_legacy || req.restore_legacy;
        let found = master_key(&folder, req.create && !req.restore_legacy, vault, legacy, keep)?;
        if let Some((id, _)) = &found { bind(id, &folder, default.as_deref(), vault, legacy, keep)?; }
        if req.restore_legacy {
            let (id, key) = found.as_ref().ok_or("vault_key_missing")?;
            legacy.set(id, key)?;
            if legacy.get(id)?.as_deref() != Some(key.as_slice()) { return Err("vault_verify_failed"); }
            legacy.set(&format!("{id}:folder"), folder.to_string_lossy().as_bytes())?;
            restored = true;
        }
        Ok(found)
    });
    match result {
        Ok(Some((_, mut key))) if restored => { key.fill(0); (serde_json::json!({ "ok": true, "restored": true }), 0) }
        Ok(Some((id, mut key))) => {
            let value = serde_json::json!({ "ok": true, "id": id, "key": STANDARD.encode(&key) });
            key.fill(0); (value, 0)
        }
        Ok(None) => (serde_json::json!({ "ok": true, "missing": true }), 0),
        Err(error) => (serde_json::json!({ "ok": false, "error": error }), 1),
    }
}

/// The key belongs to one folder: the one recorded in the keyring with it. A binding round 1 wrote
/// moves with the key; a vault made before any binding is bound at its first answered call, and
/// only for the person's default folder.
fn bind(id: &str, folder: &Path, default: Option<&Path>, vault: &impl Vault, legacy: &impl Vault, keep_legacy: bool) -> Result<()> {
    let account = format!("{id}:folder");
    let here = folder.to_string_lossy().into_owned().into_bytes();
    let bound = match vault.get(&account)? {
        Some(bound) => {
            // Moved before: what an earlier build wrote there again (the way back) goes too.
            if !keep_legacy { let _ = legacy.delete(&account); }
            Some(bound)
        }
        None => match legacy.get(&account).ok().flatten() {
            Some(old) => { vault.set(&account, &old)?; let _ = legacy.delete(&account); Some(old) }
            None => None,
        },
    };
    match bound {
        Some(bound) if bound == here => Ok(()),
        Some(_) => Err("vault_folder_mismatch"),
        None if default == Some(folder) => vault.set(&account, &here),
        None => Err("vault_folder_unbound"),
    }
}

/// Launcher side: register `child` (the gateway this binary has just started) for `folder` with a
/// fresh ticket; returns the ticket for the child's stdin. Round 1's registration item (under the
/// old service name) is removed: nothing reads it any more.
pub(crate) fn register_gateway(folder: &Path, child: &Process, ticket: &[u8], vault: &impl Vault, legacy: &impl Vault) -> Result<()> {
    let slot = caller::slot(folder);
    let current = vault.get(&slot)?.and_then(|bytes| Registration::decode(&bytes));
    let registration = caller::register(child, ticket, current, caller::live)?;
    vault.set(&slot, &registration.encode())?;
    if vault.get(&slot)?.as_deref() != Some(registration.encode().as_slice()) { return Err("vault_verify_failed"); }
    let _ = legacy.delete(&slot);
    Ok(())
}

/// Launcher side, after its gateway exited: remove the registration if it still names that gateway.
pub(crate) fn unregister_gateway(folder: &Path, pid: u32, vault: &impl Vault) {
    let slot = caller::slot(folder);
    if let Ok(Some(bytes)) = vault.get(&slot) {
        if Registration::decode(&bytes).map(|r| r.pid) == Some(pid) { let _ = vault.delete(&slot); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway_caller::REFUSED;
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::sync::Mutex;
    #[derive(Default)]
    struct TestVault { keys: Mutex<HashMap<String, Vec<u8>>>, fail: bool, fail_delete: Cell<u32> }
    impl Vault for TestVault {
        fn get(&self, id: &str) -> Result<Option<Vec<u8>>> { if self.fail { Err("vault_unavailable") } else { Ok(self.keys.lock().unwrap().get(id).cloned()) } }
        fn set(&self, id: &str, key: &[u8]) -> Result<()> { if self.fail { return Err("vault_unavailable"); } self.keys.lock().unwrap().insert(id.into(), key.into()); Ok(()) }
        fn delete(&self, id: &str) -> Result<()> {
            // A crash or a refusal between "written there" and "deleted here".
            if self.fail_delete.get() > 0 { self.fail_delete.set(self.fail_delete.get() - 1); return Err("vault_unavailable"); }
            self.keys.lock().unwrap().remove(id); Ok(())
        }
    }
    impl TestVault {
        fn has(&self, id: &str) -> bool { self.keys.lock().unwrap().contains_key(id) }
        fn value(&self, id: &str) -> Option<Vec<u8>> { self.keys.lock().unwrap().get(id).cloned() }
    }
    fn temp() -> std::path::PathBuf {
        let id: String = random::<12>().unwrap().iter().map(|byte| format!("{byte:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("wb-vault-test-{id}")); fs::create_dir(&dir).unwrap(); fs::canonicalize(dir).unwrap()
    }
    const TICKET: [u8; 32] = [3; 32];
    fn proc(pid: u32, s: u64) -> Process { Process { pid, stamp: format!("boot/{s}") } }
    fn req(dir: &Path, create: bool, ticket: Option<&[u8; 32]>) -> Result<Request> {
        Ok(Request { directory: dir.to_string_lossy().into_owned(), create, ticket: ticket.map(|t| caller::hex(t)), restore_legacy: false, keep_legacy: false })
    }
    /// The launcher's side: the gateway `pid` is registered for `dir` with `TICKET`.
    fn launched(dir: &Path, gateway: &Process, vault: &TestVault, legacy: &TestVault) {
        register_gateway(dir, gateway, &TICKET, vault, legacy).unwrap();
    }
    const ALIVE: fn(&Registration) -> bool = |_| true;

    #[test]
    fn persists_only_the_id_and_never_replaces_a_missing_key() {
        let dir = temp(); let (vault, legacy) = (TestVault::default(), TestVault::default());
        assert!(master_key(&dir, false, &vault, &legacy, false).unwrap().is_none());
        assert!(!dir.join("office").exists());
        let first = master_key(&dir, true, &vault, &legacy, false).unwrap().unwrap();
        let next = master_key(&dir, false, &vault, &legacy, false).unwrap().unwrap();
        assert!(first == next); assert_eq!(first.1.len(), 32);
        assert_eq!(fs::read_to_string(dir.join("office/vault-id")).unwrap(), first.0);
        assert_eq!(fs::read_dir(dir.join("office")).unwrap().count(), 2);
        assert!(!legacy.has(&first.0), "a new vault is never written where old binaries look");
        vault.keys.lock().unwrap().clear();
        assert!(matches!(master_key(&dir, true, &vault, &legacy, false), Err("vault_key_missing")));
        assert_eq!(fs::read_to_string(dir.join("office/vault-id")).unwrap(), first.0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_the_launched_gateway_with_its_ticket_gets_the_key_and_only_for_its_own_folder() {
        let dir = temp(); let (vault, legacy) = (TestVault::default(), TestVault::default());
        let (gateway, engine) = (proc(4242, 9), proc(5000, 20));
        // Nothing registered: nobody — not even a would-be gateway with a ticket — is answered.
        assert_eq!(answer(req(&dir, true, Some(&TICKET)), Some(gateway.clone()), ALIVE, None, &vault, &legacy).0["error"], "gateway_not_registered");
        launched(&dir, &gateway, &vault, &legacy);
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(gateway.clone()), ALIVE, None, &vault, &legacy), (serde_json::json!({ "ok": true, "missing": true }), 0));
        let (made, code) = answer(req(&dir, true, Some(&TICKET)), Some(gateway.clone()), ALIVE, None, &vault, &legacy);
        assert_eq!(code, 0); assert!(made["key"].is_string());
        // A direct child of the gateway that exec'd the helper (rc file, planted git): no ticket.
        for ticket in [None, Some(&[4u8; 32])] {
            let (refused, code) = answer(req(&dir, false, ticket), Some(gateway.clone()), ALIVE, None, &vault, &legacy);
            assert_eq!((refused, code), (serde_json::json!({ "ok": false, "error": REFUSED }), 1));
        }
        // A process an engine runs, even one that somehow had the ticket: refused, for creating, for reading.
        for create in [false, true] {
            let (refused, code) = answer(req(&dir, create, Some(&TICKET)), Some(engine.clone()), ALIVE, None, &vault, &legacy);
            assert_eq!((refused, code), (serde_json::json!({ "ok": false, "error": REFUSED }), 1));
        }
        // A fake folder: the vault-id copied, its own lock record — nobody is registered there.
        let fake = temp(); fs::create_dir_all(fake.join("office")).unwrap(); fs::create_dir_all(fake.join("host.lock")).unwrap();
        fs::copy(dir.join("office/vault-id"), fake.join("office/vault-id")).unwrap();
        fs::write(fake.join("host.lock/owner.json"), "{\"ownerPid\":5000}").unwrap();
        assert_eq!(answer(req(&fake, false, None), Some(engine.clone()), ALIVE, None, &vault, &legacy).0["error"], "gateway_not_registered");
        // …and a gateway the attacker had a launcher start there: the key belongs to the real folder.
        launched(&fake, &engine, &vault, &legacy);
        let (refused, code) = answer(req(&fake, false, Some(&TICKET)), Some(engine.clone()), ALIVE, None, &vault, &legacy);
        assert_eq!(code, 1); assert_eq!(refused["error"], "vault_folder_mismatch"); assert!(refused.get("key").is_none());
        // The registration deleted (anyone with the keyring tool): nobody is answered, nobody registers.
        vault.delete(&caller::slot(&dir)).unwrap();
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(engine.clone()), ALIVE, None, &vault, &legacy).0["error"], "gateway_not_registered");
        assert!(!vault.has(&caller::slot(&dir)));
        // The gateway has exited: refused until a launcher registers the next one.
        launched(&dir, &gateway, &vault, &legacy);
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(gateway.clone()), |_: &Registration| false, None, &vault, &legacy).0["error"], "gateway_not_registered");
        fs::remove_dir_all(dir).unwrap(); fs::remove_dir_all(fake).unwrap();
    }

    #[test]
    fn a_launcher_never_registers_over_a_live_gateway_and_unregisters_only_its_own() {
        let dir = temp(); let (vault, legacy) = (TestVault::default(), TestVault::default());
        // The real parent of this test is live: a second launcher for the same folder is refused.
        let live = caller::parent().unwrap();
        register_gateway(&dir, &live, &TICKET, &vault, &legacy).unwrap();
        assert_eq!(register_gateway(&dir, &proc(7000, 1), &[9; 32], &vault, &legacy), Err(caller::RUNNING));
        unregister_gateway(&dir, 7000, &vault);
        assert!(vault.has(&caller::slot(&dir)));
        unregister_gateway(&dir, live.pid, &vault);
        assert!(!vault.has(&caller::slot(&dir)));
        // Round 1's record under the old name is removed when a gateway is registered.
        legacy.set(&caller::slot(&dir), b"4242:1").unwrap();
        register_gateway(&dir, &proc(7000, 1), &TICKET, &vault, &legacy).unwrap();
        assert!(!legacy.has(&caller::slot(&dir)));
        fs::remove_dir_all(dir).unwrap();
    }

    /// A vault made by an OLD binary (key under the old name, no binding) and as wave 21 left it
    /// (key + round-1 binding + round-1 registration under the old name).
    fn old_vault(dir: &Path, legacy: &TestVault, round1: bool) -> (String, Vec<u8>) {
        let (id, key) = master_key(dir, true, legacy, &TestVault::default(), false).unwrap().unwrap();
        legacy.keys.lock().unwrap().remove(&format!("{id}:folder"));
        if round1 {
            legacy.set(&format!("{id}:folder"), dir.to_string_lossy().as_bytes()).unwrap();
            legacy.set(&caller::slot(dir), b"4242:1800000000000000000").unwrap();
        }
        (id, key)
    }

    #[test]
    fn the_key_moves_away_from_where_old_binaries_look() {
        for round1 in [false, true] {
            let dir = temp(); let (vault, legacy) = (TestVault::default(), TestVault::default());
            let (id, key) = old_vault(&dir, &legacy, round1);
            let gateway = proc(4242, 9); launched(&dir, &gateway, &vault, &legacy);
            let default = if round1 { None } else { Some(dir.clone()) };
            let (answered, code) = answer(req(&dir, false, Some(&TICKET)), Some(gateway.clone()), ALIVE, default.clone(), &vault, &legacy);
            assert_eq!(code, 0, "{answered}"); assert_eq!(answered["key"], STANDARD.encode(&key));
            // The old binaries' items are gone: an old binary reads `legacy` and finds nothing.
            assert!(legacy.keys.lock().unwrap().is_empty(), "round1={round1}: {:?}", legacy.keys.lock().unwrap().keys().collect::<Vec<_>>());
            assert_eq!(vault.value(&id), Some(key.clone()));
            assert_eq!(vault.value(&format!("{id}:folder")), Some(dir.to_string_lossy().as_bytes().to_vec()));
            // And again: the same key.
            assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(gateway), ALIVE, default, &vault, &legacy).0["key"], STANDARD.encode(&key));
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_crash_between_written_here_and_deleted_there_is_finished_at_the_next_call() {
        let dir = temp(); let (vault, legacy) = (TestVault::default(), TestVault::default());
        let (id, key) = old_vault(&dir, &legacy, false);
        let gateway = proc(4242, 9); launched(&dir, &gateway, &vault, &legacy);
        legacy.fail_delete.set(1);
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(gateway.clone()), ALIVE, Some(dir.clone()), &vault, &legacy).0["key"], STANDARD.encode(&key));
        assert_eq!(legacy.value(&id), Some(key.clone()), "the delete failed: both hold the key");
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(gateway), ALIVE, Some(dir.clone()), &vault, &legacy).0["key"], STANDARD.encode(&key));
        assert!(!legacy.has(&id));
        // A different value under the old name is not this vault's key: left alone, the moved key wins.
        legacy.set(&id, &[1; 32]).unwrap();
        assert_eq!(stored_key(&id, &vault, &legacy, false).unwrap(), Some(key));
        assert_eq!(legacy.value(&id), Some(vec![1; 32]));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_way_back_writes_the_key_where_old_binaries_look_only_for_the_gateway() {
        let dir = temp(); let (vault, legacy) = (TestVault::default(), TestVault::default());
        let (id, key) = old_vault(&dir, &legacy, false);
        let gateway = proc(4242, 9); launched(&dir, &gateway, &vault, &legacy);
        let restore = |ticket: Option<&[u8; 32]>, parent: Process| answer(Ok(Request { directory: dir.to_string_lossy().into_owned(), create: false, ticket: ticket.map(|t| caller::hex(t)), restore_legacy: true, keep_legacy: false }), Some(parent), ALIVE, Some(dir.clone()), &vault, &legacy);
        // The first answered call moved the key away from where old binaries look.
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(gateway.clone()), ALIVE, Some(dir.clone()), &vault, &legacy).1, 0);
        assert!(!legacy.has(&id));
        assert_eq!(restore(None, gateway.clone()).0["error"], REFUSED);
        assert_eq!(restore(Some(&TICKET), proc(5000, 2)).0["error"], REFUSED);
        assert!(!legacy.has(&id));
        let (done, code) = restore(Some(&TICKET), gateway.clone());
        assert_eq!((done, code), (serde_json::json!({ "ok": true, "restored": true }), 0));
        assert_eq!(legacy.value(&id), Some(key.clone()));
        // The same run's later calls keep it there (keep_legacy); the next run's first call moves it again.
        let keep = Request { directory: dir.to_string_lossy().into_owned(), create: false, ticket: Some(caller::hex(&TICKET)), restore_legacy: false, keep_legacy: true };
        assert_eq!(answer(Ok(keep), Some(gateway.clone()), ALIVE, None, &vault, &legacy).1, 0);
        assert!(legacy.has(&id));
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(gateway), ALIVE, None, &vault, &legacy).1, 0);
        assert!(!legacy.has(&id));
        // Nothing of the way back stays where earlier builds look (key, binding).
        assert!(legacy.keys.lock().unwrap().is_empty(), "{:?}", legacy.keys.lock().unwrap().keys().collect::<Vec<_>>());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_vault_made_before_folders_were_bound_is_bound_only_to_the_default_folder() {
        let dir = temp(); let (vault, legacy) = (TestVault::default(), TestVault::default());
        let (id, _) = master_key(&dir, true, &vault, &legacy, false).unwrap().unwrap();
        vault.keys.lock().unwrap().remove(&format!("{id}:folder"));
        let gateway = proc(4242, 9); launched(&dir, &gateway, &vault, &legacy);
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(gateway.clone()), ALIVE, None, &vault, &legacy).0["error"], "vault_folder_unbound");
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(gateway), ALIVE, Some(dir.clone()), &vault, &legacy).1, 0);
        assert_eq!(vault.value(&format!("{id}:folder")), Some(dir.to_string_lossy().as_bytes().to_vec()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_corrupt_profile_or_unavailable_vault_without_plaintext_fallback() {
        let dir = temp(); let vault = TestVault { fail: true, ..TestVault::default() };
        assert!(matches!(master_key(&dir, true, &vault, &TestVault::default(), false), Err("vault_unavailable")));
        assert!(!dir.join("office/vault-id").exists());
        fs::write(dir.join("office/vault-id"), "broken").unwrap();
        assert!(matches!(master_key(&dir, true, &vault, &TestVault::default(), false), Err("invalid_vault_id")));
        assert_eq!(fs::read_to_string(dir.join("office/vault-id")).unwrap(), "broken");
        // A locked keyring at the helper: a fixed code, nothing else.
        assert_eq!(answer(req(&dir, false, Some(&TICKET)), Some(proc(1, 1)), ALIVE, None, &vault, &TestVault::default()).0, serde_json::json!({ "ok": false, "error": "vault_unavailable" }));
        fs::remove_dir_all(dir).unwrap();
    }
}

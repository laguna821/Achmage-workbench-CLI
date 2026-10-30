//! Headless, one-request OS vault helper. Only the gateway's private pipe receives the key.
//! No Electron, renderer IPC, plaintext key file, credential enumeration or fallback store.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

const SERVICE: &str = "kr.achmage.workbench.office-ai";
type Result<T> = std::result::Result<T, &'static str>;

trait Vault {
    fn get(&self, id: &str) -> Result<Option<Vec<u8>>>;
    fn set(&self, id: &str, key: &[u8]) -> Result<()>;
}
struct OsVault;
impl Vault for OsVault {
    fn get(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let entry = keyring::Entry::new(SERVICE, id).map_err(|_| "vault_unavailable")?;
        match entry.get_secret() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("vault_unavailable"),
        }
    }
    fn set(&self, id: &str, key: &[u8]) -> Result<()> {
        keyring::Entry::new(SERVICE, id).map_err(|_| "vault_unavailable")?
            .set_secret(key).map_err(|_| "vault_unavailable")
    }
}
fn random<const N: usize>() -> Result<[u8; N]> {
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
fn master_key(profile: &Path, create: bool, vault: &impl Vault) -> Result<Option<(String, Vec<u8>)>> {
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
            let key = vault.get(&id)?.ok_or("vault_key_missing")?;
            if key.len() != 32 { return Err("invalid_vault_key"); }
            Ok(Some((id, key)))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if !create { return Ok(None); }
            let id: String = random::<16>()?.iter().map(|byte| format!("{byte:02x}")).collect();
            if vault.get(&id)?.is_some() { return Err("vault_id_collision"); }
            let key = random::<32>()?.to_vec(); vault.set(&id, &key)?;
            if vault.get(&id)?.as_deref() != Some(key.as_slice()) { return Err("vault_verify_failed"); }
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
struct Request { directory: String, create: bool }
fn request() -> Result<Request> {
    let mut bytes = Vec::new(); io::stdin().take(32_769).read_to_end(&mut bytes).map_err(|_| "invalid_request")?;
    if bytes.len() > 32_768 { return Err("invalid_request"); }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_request")
}
pub fn run() -> i32 {
    // keyring's no-feature default is a mock. Never silently use it on an unsupported OS.
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    { return 1; }
    let result = request().and_then(|req| master_key(Path::new(&req.directory), req.create, &OsVault));
    let (output, code) = match result {
        Ok(Some((id, mut key))) => {
            let value = serde_json::json!({ "ok": true, "id": id, "key": STANDARD.encode(&key) });
            key.fill(0); (value, 0)
        }
        Ok(None) => (serde_json::json!({ "ok": true, "missing": true }), 0),
        Err(error) => (serde_json::json!({ "ok": false, "error": error }), 1),
    };
    // Errors are fixed codes: never paths, account names, vault errors or secret bytes.
    if serde_json::to_writer(io::stdout().lock(), &output).is_err() { return 1; }
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    struct TestVault { keys: Mutex<HashMap<String, Vec<u8>>>, fail: bool }
    impl Vault for TestVault {
        fn get(&self, id: &str) -> Result<Option<Vec<u8>>> { if self.fail { Err("vault_unavailable") } else { Ok(self.keys.lock().unwrap().get(id).cloned()) } }
        fn set(&self, id: &str, key: &[u8]) -> Result<()> { self.keys.lock().unwrap().insert(id.into(), key.into()); Ok(()) }
    }
    fn temp() -> std::path::PathBuf {
        let id: String = random::<12>().unwrap().iter().map(|byte| format!("{byte:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("wb-vault-test-{id}")); fs::create_dir(&dir).unwrap(); dir
    }
    #[test]
    fn persists_only_the_id_and_never_replaces_a_missing_key() {
        let dir = temp(); let vault = TestVault { keys: Mutex::new(HashMap::new()), fail: false };
        assert!(master_key(&dir, false, &vault).unwrap().is_none());
        assert!(!dir.join("office").exists());
        let first = master_key(&dir, true, &vault).unwrap().unwrap();
        let next = master_key(&dir, false, &vault).unwrap().unwrap();
        assert!(first == next); assert_eq!(first.1.len(), 32);
        assert_eq!(fs::read_to_string(dir.join("office/vault-id")).unwrap(), first.0);
        assert_eq!(fs::read_dir(dir.join("office")).unwrap().count(), 2);
        vault.keys.lock().unwrap().clear();
        assert!(matches!(master_key(&dir, true, &vault), Err("vault_key_missing")));
        assert_eq!(fs::read_to_string(dir.join("office/vault-id")).unwrap(), first.0);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn refuses_corrupt_profile_or_unavailable_vault_without_plaintext_fallback() {
        let dir = temp(); let vault = TestVault { keys: Mutex::new(HashMap::new()), fail: true };
        assert!(matches!(master_key(&dir, true, &vault), Err("vault_unavailable")));
        assert!(!dir.join("office/vault-id").exists());
        fs::write(dir.join("office/vault-id"), "broken").unwrap();
        assert!(matches!(master_key(&dir, true, &vault), Err("invalid_vault_id")));
        assert_eq!(fs::read_to_string(dir.join("office/vault-id")).unwrap(), "broken");
        fs::remove_dir_all(dir).unwrap();
    }
}

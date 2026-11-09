//! Desktop remote-device grants live in the OS credential store, never Web storage.
use sha2::{Digest, Sha256};
use tauri::Manager;

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action { Get, Set, Delete }

#[tauri::command]
pub async fn host_credential(app: tauri::AppHandle, window: tauri::WebviewWindow,
    host_id: String, action: Action, credential: Option<String>) -> Result<Option<String>, String> {
    if window.label() != "main" && !window.label().starts_with("session-") {
        return Err("Workbench 창에서만 기기 연결 권한을 사용할 수 있습니다.".into());
    }
    let ready = app.try_state::<crate::Ready>().ok_or("호스트가 아직 준비되지 않았습니다.")?;
    let origin = url::Url::parse(&ready.url).map_err(|_| "호스트 주소를 확인하지 못했습니다.")?;
    if window.url().map_err(|_| "창 주소를 확인하지 못했습니다.")?.origin() != origin.origin() {
        return Err("Workbench 창의 주소가 아닙니다.".into());
    }
    if host_id.is_empty() || host_id.len() > 512 || host_id.chars().any(char::is_control) {
        return Err("기기 식별자가 올바르지 않습니다.".into());
    }
    let profile = std::env::var_os("WORKBENCH_DATA_DIR").map(std::path::PathBuf::from)
        .unwrap_or_else(crate::host_runtime::profile_dir);
    let mut digest = Sha256::new();
    digest.update(profile.to_string_lossy().as_bytes()); digest.update([0]); digest.update(host_id.as_bytes());
    let account = format!("{:x}", digest.finalize());
    drop(ready);
    tauri::async_runtime::spawn_blocking(move || {
        let failed = || "운영체제 보안 저장소에 접근하지 못했습니다. 저장소 잠금을 해제한 뒤 다시 연결해 주세요.".to_string();
        let entry = keyring::Entry::new("kr.achmage.workbench.remote-hosts", &account).map_err(|_| failed())?;
        match action {
            Action::Get => match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(failed()),
            },
            Action::Set => {
                let value = credential.filter(|value| !value.is_empty() && value.len() <= 16_384)
                    .ok_or("기기 연결 권한의 형식이 올바르지 않습니다.")?;
                entry.set_password(&value).map_err(|_| failed())?;
                Ok(None)
            },
            Action::Delete => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(failed()),
            },
        }
    }).await.map_err(|_| "기기 연결 권한을 처리하지 못했습니다.".to_string())?
}

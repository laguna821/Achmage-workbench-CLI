//! The window keys at the top bar's right end (0.5.3): 내려놓기, 전체 화면, 닫기, for desktops whose
//! windows have no title bar of their own (tiling Wayland compositors such as niri).
//!
//! One command, `window_keys`, so the page needs no window permissions of its own and the shell decides
//! what "내려놓기" can truly do here:
//! - a tiling compositor ignores minimise: the main window is hidden to the tray instead (the tray's
//!   "Achmage Workbench 열기", or launching the app again, brings it back); a detached session window
//!   cannot come back from the tray, so it shows no 내려놓기 there;
//! - elsewhere the window is minimised; if that did not take effect (is_minimized stays false) and the
//!   tray is there, the main window is hidden to the tray.
//! - 닫기 is `close()`, which raises CloseRequested — the one existing rule (lib.rs: the main window hides
//!   and the app keeps working; a session window closes).

use std::sync::atomic::{AtomicBool, Ordering};

/// Set once the tray entry has been built (lib.rs `build_tray`).
pub static TRAY: AtomicBool = AtomicBool::new(false);

/// Desktops treated as tiling (no title bar with these buttons): names from XDG_CURRENT_DESKTOP /
/// XDG_SESSION_DESKTOP / DESKTOP_SESSION, compared case-insensitively, each ':'-separated part.
const TILING: &[&str] = &["niri", "sway", "hyprland", "river", "i3", "bspwm", "dwm", "dwl", "awesome", "qtile", "xmonad", "herbstluftwm", "spectrwm", "leftwm", "mango", "miracle-wm", "jay", "pinnacle"];
/// Compositor sockets that say the same when the desktop names are missing or generic.
const SOCKETS: &[&str] = &["NIRI_SOCKET", "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "I3SOCK"];

/// The desktop as the session names it, and whether it is a tiling one (pure, for tests).
pub fn desktop_of(get: impl Fn(&str) -> Option<String>) -> (String, bool) {
    let names: Vec<String> = ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"].iter().filter_map(|key| get(key)).filter(|value| !value.trim().is_empty()).collect();
    let desktop = names.first().cloned().unwrap_or_default();
    let named = names.iter().flat_map(|value| value.split(':').map(|part| part.trim().to_ascii_lowercase()).collect::<Vec<_>>())
        .any(|part| TILING.iter().any(|tiling| part == *tiling || part.starts_with(&format!("{tiling} ")) || part.starts_with(&format!("{tiling}-"))));
    let socket = SOCKETS.iter().any(|key| get(key).is_some_and(|value| !value.is_empty()));
    (desktop, cfg!(target_os = "linux") && (named || socket))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowKeys {
    /// The session's desktop name (for 설정's explanation).
    desktop: String,
    /// A tiling compositor: 자동 shows the keys.
    tiling: bool,
    /// What 내려놓기 does here: "minimize", "tray" (hide to the tray) or "none" (the key is not shown).
    minimize: &'static str,
    fullscreen: bool,
    /// What the last action did ("minimized", "hidden", "fullscreen", "restored", "closed"), if any.
    did: Option<&'static str>,
}

fn minimize_rule(main: bool, tiling: bool, tray: bool) -> &'static str {
    match (main, tiling, tray) {
        (true, true, true) => "tray",
        (_, true, _) => "none",
        _ => "minimize",
    }
}

#[tauri::command]
pub async fn window_keys(window: tauri::WebviewWindow, action: String) -> Result<WindowKeys, String> {
    let (desktop, tiling) = desktop_of(|key| std::env::var(key).ok());
    let main = window.label() == "main";
    let tray = main && TRAY.load(Ordering::SeqCst);
    let minimize = minimize_rule(main, tiling, tray);
    let did = match action.as_str() {
        "state" => None,
        "minimize" => match minimize {
            "tray" => { window.hide().map_err(|error| error.to_string())?; Some("hidden") }
            "minimize" => {
                window.minimize().map_err(|error| error.to_string())?;
                // Whether the compositor took it: some ignore minimise without saying so.
                tokio::time::sleep(std::time::Duration::from_millis(350)).await;
                if window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true) { Some("minimized") }
                else if tray { window.hide().map_err(|error| error.to_string())?; Some("hidden") }
                else { None }
            }
            _ => None,
        },
        "fullscreen" => {
            let next = !window.is_fullscreen().unwrap_or(false);
            window.set_fullscreen(next).map_err(|error| error.to_string())?;
            Some(if next { "fullscreen" } else { "restored" })
        }
        "close" => { window.close().map_err(|error| error.to_string())?; Some("closed") }
        _ => return Err("알 수 없는 창 동작입니다.".into()),
    };
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    Ok(WindowKeys { desktop, tiling, minimize, fullscreen, did })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| pairs.iter().find(|(name, _)| *name == key).map(|(_, value)| value.to_string())
    }

    #[test]
    fn tiling_desktops_are_found_by_name_or_socket() {
        let linux = cfg!(target_os = "linux");
        assert_eq!(desktop_of(env(&[("XDG_CURRENT_DESKTOP", "niri")])), ("niri".to_string(), linux));
        assert_eq!(desktop_of(env(&[("XDG_CURRENT_DESKTOP", "sway:wlroots")])).1, linux);
        assert_eq!(desktop_of(env(&[("XDG_CURRENT_DESKTOP", "Hyprland")])).1, linux);
        assert_eq!(desktop_of(env(&[("DESKTOP_SESSION", "niri-macshell")])).1, linux);
        assert_eq!(desktop_of(env(&[("NIRI_SOCKET", "/run/user/1000/niri.sock")])).1, linux);
        assert!(!desktop_of(env(&[("XDG_CURRENT_DESKTOP", "GNOME")])).1);
        assert!(!desktop_of(env(&[("XDG_CURRENT_DESKTOP", "KDE")])).1);
        assert!(!desktop_of(env(&[("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")])).1);
        assert!(!desktop_of(env(&[])).1);
    }

    #[test]
    fn minimise_hides_to_the_tray_only_where_it_can_come_back() {
        assert_eq!(minimize_rule(true, true, true), "tray");
        assert_eq!(minimize_rule(true, true, false), "none");
        assert_eq!(minimize_rule(false, true, false), "none");
        assert_eq!(minimize_rule(true, false, true), "minimize");
        assert_eq!(minimize_rule(false, false, false), "minimize");
    }
}

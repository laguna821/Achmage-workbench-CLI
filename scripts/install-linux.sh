#!/usr/bin/env bash
# Install the built app for the current user and register it in the launcher.
# The app runs in its own systemd scope so it and the engines it starts are accounted and
# OOM-isolated together. Requires Node.js 24+ on PATH (the gateway runs on it).
set -euo pipefail

# Default: the release binary with the system WebKitGTK (lighter, updated by the package
# manager). `--appimage` installs the portable AppImage instead (bundles its own WebKit).
repo=$(cd "$(dirname "$0")/.." && pwd)
release="$repo/apps/desktop/src-tauri/target/release"
mode=${1:-native}
command -v node >/dev/null || { echo "Node.js 24+ is required" >&2; exit 1; }

opt="$HOME/.local/opt/achmage-workbench"
bin="$HOME/.local/bin"
apps="$HOME/.local/share/applications"
icons="$HOME/.local/share/icons/hicolor"
mkdir -p "$bin" "$apps"
rm -rf "$opt" && mkdir -p "$opt"
if [[ "$mode" == "--appimage" ]]; then
  appimage=$(ls -t "$release"/bundle/appimage/*.AppImage 2>/dev/null | head -1)
  [[ -n "$appimage" ]] || { echo "Build first: (cd apps/desktop && npx tauri build)" >&2; exit 1; }
  install -m755 "$appimage" "$opt/AchmageWorkbench.AppImage"
  target="$opt/AchmageWorkbench.AppImage"
else
  [[ -x "$release/achmage-workbench" && -f "$release/host/host.mjs" ]] || { echo "Build first: (cd apps/desktop && npx tauri build)" >&2; exit 1; }
  install -m755 "$release/achmage-workbench" "$opt/achmage-workbench"
  cp -r "$release/host" "$release/web" "$opt/"
  target="$opt/achmage-workbench"
fi

cat > "$bin/achmage-workbench" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/systemd-run --user --scope --collect --quiet \\
    --slice=app.slice --unit="app-achmage-workbench-\$\$-\${RANDOM}.scope" \\
    --expand-environment=no -- "$target" "\$@"
EOF
chmod +x "$bin/achmage-workbench"

cat > "$apps/achmage-workbench.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Achmage Workbench
Name[ko]=Achmage 작업실
GenericName=Claude Code & Codex Workbench
GenericName[ko]=Claude·Codex 작업실
Comment=One screen for Claude Code and Codex sessions, documents and Achmage knowledge
Comment[ko]=Claude Code와 Codex 세션을 한 화면에서 쓰는 작업실
Exec=$bin/achmage-workbench %U
TryExec=$bin/achmage-workbench
StartupWMClass=achmage-workbench
Icon=achmage-workbench
Terminal=false
Categories=Development;
Keywords=Achmage;Claude;Codex;AI;작업실;
StartupNotify=true
EOF

for size in 32x32 128x128; do
  install -Dm644 "$repo/apps/desktop/src-tauri/icons/$size.png" "$icons/$size/apps/achmage-workbench.png"
done
install -Dm644 "$repo/apps/desktop/src-tauri/icons/128x128@2x.png" "$icons/256x256/apps/achmage-workbench.png"
install -Dm644 "$repo/apps/desktop/src-tauri/icons/icon.png" "$icons/512x512/apps/achmage-workbench.png"
gtk-update-icon-cache -q -t "$icons" 2>/dev/null || true
update-desktop-database "$apps" 2>/dev/null || true
echo "Installed: $target"

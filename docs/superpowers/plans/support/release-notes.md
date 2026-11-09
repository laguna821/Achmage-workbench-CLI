# 통합 구현 계획용 릴리스 조사 — 2026-11-09

조사 상태 **PASS**, 실행 준비상 **ISSUES**. 제품 변경·빌드·테스트·설치·원격 쓰기는 실행하지 않았다. 제품 기능 완료 판정이 아니다. 현재 저장소와 공식 공개 메타데이터를 읽고 아래의 실행 작업과 검증 경계를 정리했다.

- 저장소: `/home/achamge/다운로드/achmage-workbench`
- 브랜치: `fix/urgent-usability-033`; HEAD: `bc1057c2c5fb04f2046f4fd711bf718f5cc93737`; 소스 버전: `0.3.3`.
- 사용자의 현재 범위: Aside/browser·HIG·Paseo 3계획 전체 구현 후 실제 설치본 완성과 GitHub 릴리스. 이 문서는 planning only다.
- 기존 `docs/research/`, `docs/design/hig-remake-2026-11-09/` untracked 파일을 보존했다.
- 조사 workId: `work-1b7f68199bcb4756b2a7fd2a102ccc2e`; nativeSessionId: `01a187dc-c850-7991-93c0-aa60b50f9a26`.
- 앞선 실제 코드 조사는 [Workbench 재사용/결손 조사](prior-evidence/workbench/notes.md)에 고정했다. 이번 문서는 릴리스 경로 중심의 추가 조사다.

## Components Found

| 구성 | 관측한 현행 상태 | 계획에 주는 의미 |
|---|---|---|
| 공통 빌드 | release.yml web job이 Linux에서 UI·gateway·Ieum 편집기·xlsx WASM을 한 번 빌드 | OS마다 제품 JS가 달라지지 않도록 공통 artifact 재사용 |
| Windows | windows-latest, x64 NSIS EXE + 한국어 MSI; 번들 Node24/npm + pinned Ieum CLI + 자체 Windows Lightpanda | 첫 실제 설치/네이티브 화면 검증 대상. EXE 검사가 MSI를 대신하지 않음 |
| macOS | macos-15 Apple silicon, app/dmg; Node24/npm + pinned Ieum CLI | arm64만 관측. Intel Mac 지원은 현재 행렬에 없음 |
| Linux | Ubuntu22.04 AppImage/deb x86_64 | 빌드 job은 존재하나 release.yml에서 Linux 설치 smoke는 없음 |
| Arch/CachyOS | Arch 컨테이너 pkg.tar.zst x86_64; 시스템 Node >=24/npm | 시스템 의존성과 업데이트도 실제 설치 대상에서 확인 |
| 첫 실행 smoke | Windows NSIS·macOS DMG 실제 설치 후 설치 리소스의 host를 실행, 대역 Codex/Claude + 실제 문서 엔진 + 독립 Ieum 설치/연결 검사 | 전체 Tauri 화면·실제 AI 품질·새 모바일 기능 완료를 뜻하지 않음 |
| 업데이트 smoke | disposable Windows에서 이전 공개 EXE 설치 → 실제 API로 자료 생성 → 새 EXE 같은 위치 설치 → 기록/파일/설정 보존 | 새 서비스·기기 키·요청 상태·프로필 migration 시나리오를 확장할 기반 |
| native E2E | scripts/app-e2e/run.ts는 Linux Broadway/D-Bus/WebKitWebDriver 기반 | Windows/macOS에 그대로 적용할 수 없음; 별도 실제 GUI 실행 경로 필요 |
| 브라우저 보조 CI | Linux/macOS Lightpanda; 별도 Windows native/preflight 및 과거 WSL workflow | 공유된 실제 웹 페이지 WebView 자동화 인수와 다름 |
| PDF 보조 CI | pdf-runtime.yml의 Linux/Windows/macOS 원본 런타임 검사 | 특정 옛 feature branch+paths에 push trigger 제한. 새 통합 브랜치에서는 자동 실행된다고 가정하지 않음 |
| 안정 릴리스 | v* tag push가 모든 필요 job 성공 후 6종 설치 파일로 GitHub release 생성 | 단순 branch push에는 주 설치 workflow가 돌지 않음 |
| 검증 설치본 재사용 | smoke_run·upgrade_run은 exact source SHA/run을 요구; publish-tested는 성공한 run의 파일을 prepared preview draft에 업로드 | stable same-artifact promotion은 현재 별도 경로가 없음 |

## 공식 배포 사실과 현재 HEAD의 차이

2026-11-09 공개 API 조회에서 최신 안정 버전은 [v0.3.3](https://github.com/laguna821/Achmage-workbench-CLI/releases/tag/v0.3.3), 공개 시각은 2026-11-02T12:15:10Z다. 6개 설치 파일과 SHA256SUMS/provenance 자산을 확인했다. 설치 파일을 내려받아 실행하지 않았다.

공식 [installer-provenance.json](https://github.com/laguna821/Achmage-workbench-CLI/releases/download/v0.3.3/installer-provenance.json)은 다음을 구분한다.

| 식별자 | 값·의미 |
|---|---|
| 실제 설치본 sourceSha | `6108d7894bf919bcdf392cafd3f64c414d50003c` |
| buildRun | [41437363327](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41437363327): 공통·OS 빌드와 Windows/macOS 첫 설치 성공, Windows upgrade 실패로 전체 failure |
| acceptanceSha | 현재 HEAD `bc1057c2c5fb04f2046f4fd711bf718f5cc93737` |
| 재검사 run | [41442297707](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41442297707): Windows upgrade만 success, 나머지 빌드 job skipped |
| 원인·수정 | 기존 v0.2.2 전용 가정이 현대 설치기의 onboarding 설정을 거절하여 검사 helper만 수정. 설치 파일은 재빌드하지 않았음 |
| 공개 기록 | unit 1296 passed/8 skipped, parallel UI11, Windows first35, macOS first32, upgrade17; 현 조사에서 재실행한 수치가 아님 |
| 정확한 연구 판 | `research:rr-cd5a7cf4cc5a76a240d667c144939098:35bb6b94e29cffabf590238c4ecb153efe572e6577e439280a7d2a5ad8f17a12` |

공개 API 응답과 jobs 목록을 이 폴더에 보존했다. API의 성공 표시는 실제 실행된 job 목록과 함께 읽어야 한다. 지금 HEAD가 “모든 OS를 새로 빌드한 성공 판”이라고 쓰면 부정확하다.

## Flow

현재 정상 경로: 수동 dispatch 또는 v* tag → web + browser → Windows/macOS/Linux/Arch 패키징 → Windows/macOS 첫 실행 + Windows 업데이트 → tag에서만 공개.

기존 검증 파일의 역할:
- `scripts/urgent-parallel-check.ts:2`: 실제 빌드 UI·host·Office·DOCX, 모델은 로컬 대역. Chromium으로 실행하므로 Windows WebView2 실증과 구별한다.
- `scripts/setup-gateway.ts:17`: 설치된 Node로 host.mjs를 spawn. `WORKBENCH_APP_BIN`은 문서 도구 호출에 넘기지만 전체 desktop shell startup을 이 함수가 수행하지 않는다.
- `scripts/setup-smoke.ts:294`: stand-in engines와 API checks. 독립 Ieum 설치는 disposable Windows/macOS CI에 한정한다(:297–301).
- `scripts/upgrade-smoke.ts:56`: 설치 리소스·native 존재 확인 후 Node host를 실행. 기존 데이터의 기본 디렉터리·origin을 실제 사용한다. 사용자 기기에서 실행할 일반 진단 도구가 아니다.
- `docs/app-e2e.md:39`: native Linux 전용 화면/버스/프로필을 생성. 웹/host만 빌드한 뒤 오래된 native 리소스를 실행하지 않도록 Tauri 빌드 및 리소스 SHA 동일성 확인이 필요하다.

## 구현·릴리스 작업 묶음

각 작업은 별도 완료 증거를 남기며, 버전 bump만으로 다음 단계로 넘어가지 않는다. 아래 ID는 통합 계획의 릴리스 work package다.

| ID | 작업·정확한 변경 경계 | 의존·산출물·완료 판정 |
|---|---|---|
| R0 범위/기준 잠금 | 3계획의 C01–C18/X01–X03, H01–H14/S01–S15, PA01–PA18 및 선택 후보의 현재 사용자 범위를 한 ledger로 연결; 현재 installer/source/acceptance SHA와 기준 성능 기록 | 선행. 사용자의 “전부”에서 외부 앱/Paseo 후보를 임의 삭제하지 않고 parent 통합 범위 결정을 명시. Dropbox 우선, 독립 Ieum 설치/연동 유지 |
| R1 Windows 실증 | Aside P0의 실제 WebView2 URL→같은 페이지 AI→사용자 개입→hide/show; 서비스 독립수명+Office 실행 수명 실증; 모바일 최소 실기 흐름 비교 | 전체 셸·엔진 대규모 구현 전 통과. 공통 설치 크기와 native 프로세스 수명 측정. 이 단계에서 렌더러/모바일 전달 방식 결정 |
| R2 공통 기능 계약 | apps/host/src/main.ts, http.ts, bus.ts, sessions.ts, office-sessions.ts, document-registry.ts; packages/contracts; provider-* map | daemon/UI 분리, 이벤트 세대·snapshot·idempotency·권한/기기·approval, parent report와 provider 내부 자식 구분. 각 기존 기능을 재작성하지 않고 계약 추가 |
| R3 사용자 경험 구현 | apps/web의 App/Panes/Transcript/Composer/설정/탐색, apps/office renderer adapter; Aside page/profile/task boundary 및 원격 모바일 UI | HIG S01–S15·편집기 내부까지, 채팅/이미지/긴 기록, 두 웹+문서+메인 병행, 다기기 접속/알림. 필수 후보의 단계는 parent ledger에 연결 |
| R4 회귀/실증 | 기존 Vitest + urgent-parallel-check + Linux native suite; 신규 native Windows/macOS 및 service/mobile suites | 변경 소유 경계 검사→통합. 실제 provider 로그인 세션 최소 병행 smoke를 대역 결과와 별도 기록. 과거 테스트 숫자를 목표 숫자로 복사하지 않음 |
| R5 패키징/이행 | 아래 버전 위치, tauri release configs/build.rs/windows hooks, release.yml, 새 OS별 서비스 등록/해제·원격 정책·업데이트 계약 | GUI 종료/서비스 지속, 명시 전체 종료, 부팅/로그인, 업데이트 시 활성 작업, 재연결·이전 사용자 데이터 보존. 실제 설치 프로그램에 새 리소스 포함 확인 |
| R6 설치 인수 | 동일 candidate 6개 artifact; Windows 실제 EXE 우선, MSI 별도; macOS arm64 DMG; Linux AppImage/deb/Arch | 원본 artifact SHA를 입력으로 실제 설치/열기/주요 UI/서비스/업데이트 확인. iOS·Android 실기 연결도 같은 daemon candidate에 묶음 |
| R7 공개 | docs/releases/vNEXT.md + SHA256SUMS + installer-provenance + 기능별 acceptance matrix; 정확한 candidate hash로 promotion | C/H/PA 및 범위상 X/후보의 미완료를 숨기지 않음. 최종 성공 조건은 기능완료+실제설치빌드+보존검증+공개 파일 일치 |

새 테스트 파일 이름은 구현 시 확정한다. 현 repository에 daemon/mobile/Windows 공유 WebView end-to-end 전용 스크립트가 이미 있는 것처럼 명령을 만들지 않는다.

## 버전 변경 위치

현재 단일 bump 스크립트는 발견하지 못했다. `0.4.0`은 기능 추가 규모에 맞는 **계획상 후보**이며 확정 값이 아니다. 다음 위치를 함께 바꾸고 일치 검사를 추가해야 한다.

1. 루트 `package.json`.
2. `apps/{desktop,web,host,design,office}/package.json`의 version.
3. `packages/{contracts,provider-claude,provider-codex}/package.json`의 version.
4. web/design/office의 `@workbench/contracts`, host의 contracts/provider-* 내부 dependency version.
5. `package-lock.json`의 root/local workspace version 및 내부 의존성. 정상 lock regeneration으로 갱신하며 서드파티의 우연히 같은 버전은 치환하지 않는다.
6. `apps/desktop/src-tauri/tauri.conf.json:5`, `Cargo.toml:3`, `Cargo.lock:7`의 achmage-workbench package.
7. `docs/releases/vNEXT.md`, 릴리스 tag, provenance의 version/schema·source·acceptance.
8. `packaging/arch/PKGBUILD:9`는 루트 package version을 읽으므로 중복 상수 변경 불필요. pkgrel은 같은 version 패키징 재출시인지 판단해 관리한다.
9. `release.yml:44,379`의 upgrade baseline은 현재 v0.3.2다. 차기 candidate는 현재 공개 v0.3.3에서의 업데이트가 필수. 필요하면 오래된 v0.2.2 migration도 별도 보존 검사.

daemon 프로토콜/schema version은 제품 표시 version과 구분해 호환성 정책을 둔다. 모바일 client·desktop UI가 다른 버전인 경우 업데이트 필요/조회 가능/쓰기 거절을 서버가 판단하게 한다.

## 향후 실행 명령 — 이번 조사에서 모두 미실행

실행 단계에서는 실제 등록 workId/nativeSessionId로 Achmage resource_acquire 후 stable launcher resource-run을 통해 필요한 무거운 작업을 실행한다. 현재 연구 자원 식별을 다른 실행의 허가로 재사용하지 않는다. 로그·fixture는 managed work evidence에 둔다.

기존 소스 검증(루트 cwd; Node>=24, Rust 및 필요한 시스템 도구 준비 후):
```bash
npm ci --ignore-scripts
node scripts/check-fast-find-sources.mjs
cargo test --locked --release --manifest-path third_party/fast-find/crates/ff10k-core/Cargo.toml --features golden -- --test-threads=1
cargo build --locked --release --manifest-path apps/desktop/search-worker/Cargo.toml
npm run build
npm run typecheck
npx vitest run
node node_modules/playwright-core/cli.js install --with-deps chromium --only-shell
node scripts/urgent-parallel-check.ts "$WB_EVIDENCE/urgent-ui"
```
CI는 별도 CARGO_TARGET_DIR/CARGO_BUILD_JOBS=2와 WORKBENCH_SEARCH_WORKER_BIN을 지정한다(release.yml:104–112). npm build는 Ieum source fetch·vendor 검증·Office WASM/renderer 빌드까지 포함하므로 가벼운 단순 UI 명령이 아니다. 각 경계 변경 중에는 해당 tests만 먼저 실행한다. 예: sessions/office-sessions/document-registry/attachments/models, provider map, document-session/completion-notifications/layout-persistence. 최종 candidate에는 전체 필수 CI를 수행한다.

기존 Linux native 예(실행 장치/전용 도구 확인 후):
```bash
npm run tauri -w @workbench/desktop -- build --debug --no-bundle
node scripts/app-e2e/run.ts apps/desktop/src-tauri/target/debug/achmage-workbench "$WB_EVIDENCE/native-linux" --only=start,panes,pkm,workspaces,navigation,tabs --engines=stand-in
```
이는 최소 셸 경로 예시다. 변경한 문서·Git·Office·참조 시나리오를 추가 선정하고 C/H/PA 새 수용 기준은 새 suite로 검증한다. Linux 명령 통과를 Windows/macOS 인수로 쓰지 않는다.

기존 OS package 명령(cwd `apps/desktop`; 정확한 pinned 리소스와 common web artifact 준비는 release.yml의 선행 단계):
```text
Windows: npx tauri build --config src-tauri/tauri.release.conf.json --config src-tauri/tauri.release.apps.conf.json --config src-tauri/tauri.release.windows.conf.json --bundles nsis,msi
macOS:   npx tauri build --config src-tauri/tauri.release.conf.json --config src-tauri/tauri.release.macos.conf.json --bundles app,dmg
Linux:   npx tauri build --verbose --config src-tauri/tauri.release.conf.json --config src-tauri/tauri.release.appimage.conf.json --bundles appimage
Linux:   npx tauri build --config src-tauri/tauri.release.conf.json --config src-tauri/tauri.release.apps.conf.json --bundles deb
Arch:    npx tauri build --no-bundle
```
Arch 후속 `packaging/arch`에서 비특권 builder로 `makepkg --nodeps --noconfirm`. Windows pinned resources는 `fetch-bundled-apps.ts ... win32-x64`와 `fetch-bundled-lightpanda.ts`; macOS는 darwin-arm64; Linux/Arch는 linux-x64.

기존 설치 harness(cwd 루트; disposable OS runner 전용):
```text
node scripts/setup-smoke.ts <installed-resource-directory> <evidence-directory>
node scripts/upgrade-smoke.ts seed <old-installed-app> <fixture-root> <evidence-directory>
[동일 위치에 후보 EXE 실제 설치]
node scripts/upgrade-smoke.ts verify <new-installed-app> <fixture-root> <evidence-directory>
```
standalone Ieum install acceptance는 CI/RUNNER_TEMP 있는 disposable Windows/macOS에서 WORKBENCH_TEST_IEUM_INSTALL=1로 실행한다. 이 스크립트들을 사람의 현재 설치본에 무심코 실행하지 않는다.

기존 GitHub candidate 생성/재검사 인터페이스(추후 원격 실행 단계 명령; 지금 실행 안 함):
```text
gh workflow run release.yml --repo laguna821/Achmage-workbench-CLI --ref <exact-integration-branch> -f upgrade_from=v0.3.3
gh workflow run release.yml --repo laguna821/Achmage-workbench-CLI --ref <acceptance-branch> -f smoke_run=<candidate-run-id> -f source_sha=<candidate-source-sha> -f smoke_os=both
gh workflow run release.yml --repo laguna821/Achmage-workbench-CLI --ref <acceptance-branch> -f upgrade_run=<candidate-run-id> -f source_sha=<candidate-source-sha> -f upgrade_from=v0.3.3
```
API로 dispatch된 run의 실제 head_sha를 확인한다. 재검사마다 후보 SHA와 acceptance SHA를 보존한다. source branch 이름만으로 동일 코드를 보장하지 않는다.

## 실제 설치 인수 범위

| 대상 | 기존 증거 | 차기 필수 추가 |
|---|---|---|
| Windows 실제 사용자 환경 | CI NSIS/API+문서도구 smoke, Windows update 보존 | WebView2 네이티브 새 창 시작·한글 IME·물리 파일/클립보드·팝업/다운로드·HIG focus/확대·분할; daemon UI 종료/재연결·로그인 자동시작/명시 종료; MSI도 별도 설치/업데이트 |
| macOS arm64 | DMG 설치/API+도구 smoke | WKWebView 공유 페이지 capability, 실제 Focus/IME/앱 권한·notifications·독립 서비스 수명; 기존 설치 데이터 이행 |
| Linux AppImage/deb | 빌드; 별도 local native harness 존재 | 실제 설치/실행·tray·Wayland/X11·키링·페이지 capability·service supervisor; 기존 데이터 유지 |
| Arch/CachyOS/niri | 패키지 build | pacman 설치/업데이트, 시스템 Node24/npm·niri 외부 앱 조작 지원 표; X01–X03은 실제 지원 조건에서 검증 |
| iOS/Android | 현재 release workflow에 없음 | 실제 폰에서 호스트 두 대 구분, 한글·사진·표/복사·승인·이미지·결과 파일; lock/백그라운드/망 변경·재접속·취소/승인 중복·revoke; UI 없는 알림 |
| 기존 사용자 자료 | Windows upgrade17 checks 기반 | Dropbox 원문/경로, live DB 로컬, 계정키/기기 identity, 문서/웹 프로필, archive/worktree/notes/search; 독립 Ieum 외부 저장 재인식 |

새 기능의 상태 수명 검증에서 창 숨김, 탭 숨김, UI 프로세스 종료, daemon 종료/재시작, 기기 연결 해제를 분리한다. 문서 editor가 없을 때 DOM을 그대로 재실행할 수 있다고 가정하지 않고 headless 작업 capability와 중단/복귀 상태를 명시한다.

## Boundaries / Non-Obvious Things

1. **daemon 코드 존재와 상주 서비스 완성은 다르다.** 현재 Tauri exit 시 host도 종료하고 API는127.0.0.1에 bind한다. 창 X는 숨김이라 기존 작업이 계속되지만 독립 daemon/모바일 접속을 증명하지 않는다. 기존 문서 heartbeat/DOM writer 수명도 분리해야 한다.
2. Markdown/GFM/Mermaid/이미지 붙여넣기·lightbox, 탭별 문서 AI/부모 보고, 실제 모델 조회, archive/search/worktree/terminal/설정은 재사용한다. 모든 기능을 Paseo 이식 작업으로 새로 만들지 않는다.
3. **release.yml의 stable tag 경로는 검증한 기존 artifact를 승격시키는 경로가 아니라 다시 빌드한다.** 현재 publish-tested는 preview-* prepared draft 전용이며 source run 전체 success를 요구한다. 차기 요구가 동일 설치 파일 승격이라면 stable/preview 공통 artifact 검증·승격 단계를 먼저 추가하거나 tag pipeline 안에서 동일 artifact의 실제 기기 인수까지 묶어야 한다.
4. publish-tested의 설명은 `v0.2.2` baseline을 하드코딩한다(:538). 실제 선택된 upgrade_from·source·acceptance 증거에서 작성하도록 수정할 항목이다.
5. tag release 경로는 설치 파일 6개만 업로드한다(:575–578). checksums/provenance 생성은 preview 경로에 별도로 있다(:497–522). 차기 안정 경로도 필수 provenance/검사 결과와 해시를 공통 출력하도록 해야 한다.
6. NODE_DIST는 `latest-v24.x`, Rust stable과 runner alias도 움직인다. 실행 시 실제 Node/Rust/OS/WebView·Ieum/Lightpanda 원본 버전/해시를 provenance에 기록한다. 재현성 강화를 위해 검증한 revision을 고정하는 선택을 한다.
7. 관측한 release workflows/Tauri configs에 서명·notarization 설정을 찾지 못했다. 실제 배포 바이너리 서명 유무는 검사하지 않았다. OS 신뢰 경고·launch permission과 배포 서명 방침은 실제 설치 인수에서 결정·기록한다.
8. 기존 Linux 설치 smoke, Windows/macOS 전체 GUI suite, 모바일 package/배포 workflow는 이 조사 범위에서 확인되지 않았다. “6개 artifact 업로드 완료”를 모든 OS·폰 기능 완료로 보고하지 않는다.
9. native shell 변경·daemon process registration은 Rust/OS 구성과 packaging regression을 요구한다. UI screenshot만으로 service startup/update/termination을 검증하지 않는다.
10. setup-smoke의 macOS stand-in은 실제 도구 경로가 이미 있으면 거절한다. CI 전용 가정을 사용자 Mac에 적용하지 않는다. 기존 processes를 채택하거나 일괄 종료하지 않는다.

## Files Read / 중요한 줄번호

읽기 수준은 전체 또는 선택된 줄/패턴이다. 전체 읽기 목록과 SHA256은 `inspected-files.json`/`inspected-files.sha256`에 있다. 앞선 core 기능 읽기는 링크된 Workbench 조사 manifest에 별도로 있다.

- `.github/workflows/release.yml`:17 inputs;52 triggers;90 common build;137 Linux;186 Arch;218 Windows;260 macOS;298 smoke;371 upgrade;467 preview reuse;559 stable publish.
- `package.json:21`: test/typecheck/build; package/lock/Tauri/Cargo version 위치는 위 목록.
- `scripts/setup-gateway.ts:17`, `setup-smoke.ts:272`, `upgrade-smoke.ts:56,191`: 설치 host 실행과 데이터 보존.
- `scripts/urgent-parallel-check.ts:2,104`: 대역 AI와 실제 병렬 Office UI.
- `scripts/app-e2e/run.ts:61,75`, `docs/app-e2e.md:39`: native Linux suite/도구/명령.
- `packaging/arch/PKGBUILD:9,15`: version source와 시스템 의존성.
- `vitest.config.ts:10`: 검사 대상 packages/host/web/design/office.
- `.github/workflows/pdf-runtime.yml:4,15`: branch/path trigger와 OS matrix.
- `docs/research/aside-agent-desktop-2026-11-04/05-delivery-plan.md:11,43,68`: P0–P4/C/X.
- `docs/design/hig-remake-2026-11-09/implementation-plan.md:9`: W0–W6.
- `docs/research/paseo-2026-11-09/05-adoption-plan.md:78`: PA01–PA18.

존재하지 않는 추정 경로 `docs/research/aside-browser-integration-plan-2026-11-09.md` 읽기는 ENOENT였다. 검색 대상에 넣은 `scripts/app-e2e.ts`도 없었고 실제 실행 진입점은 `scripts/app-e2e/run.ts`다. rg inventory로 실제 Aside 경로를 찾은 뒤 읽었다. 제품 실행 실패는 아니다. 웹 도구의 GitHub API direct open 오류 뒤 공식 public API를 urllib read-only로 조회했다. 코드/환경을 바꿔 재시험한 일이 없다.

## Open Questions / 다음 계획에서 고정할 것

- 최종 전체 범위 ledger에서 Aside P4/X 및 Paseo E01–E08의 현 사용자 포함 범위와 별도 후속 구분. 과거 후보/제외 문구가 새 “전부” 요청을 자동으로 축소하지 않게 한다.
- 모바일 웹/PWA vs 공식 SDK/프로토콜 어댑터를 최소 실험으로 선택한 뒤 지원 배포 형식을 고정한다. 현 6개 desktop installer가 mobile binary 제공을 뜻하지 않는다.
- Windows first native acceptance의 실제 기기/격리 프로필과 automation driver, macOS/Linux capability parity를 R1에서 확정한다.
- 독립 daemon과 UI의 version mismatch·업데이트 중 active job·rollback/DB 호환 계약을 구현 전 고정한다.
- 안정 릴리스의 same-artifact promotion과 provenance 공통화를 먼저 완료할지 tag pipeline에 실제 기기 인수 gate를 넣을지 선택한다.
- 숫자 버전은 마지막 패키징 식별이다. 사용자의 완료조건은 기능 전체 수용 기준과 실제 설치빌드의 일치다.


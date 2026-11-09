# Architecture gates — visible browser, daemon/Office, mobile

작성: 2026-11-09. **계획만 작성함. prototype, 앱, daemon, provider, 빌드·설치·테스트를 실행하지 않았다.** 현재 상태는 각 실증 `NOT_RUN`이다. 아래 파일명 중 `제안` 표시는 앞으로 만들 대상이며 현재 존재·구현·성공을 뜻하지 않는다.

Workbench 읽기 기준 HEAD: `bc1057c2c5fb04f2046f4fd711bf718f5cc93737`. Paseo source 기준: `1fff127f45b11c1c9c573fbbd12791673004c912`; 설치 후보 v0.15.3은 `d91ae138cb931447635e94296023414a58bedcc5`. main의 모든 기능을 release 기능으로 취급하지 않는다. 이전 [runtime 조사](prior-evidence/runtime/notes.md), [릴리즈 한정 대조](prior-evidence/runtime/release-check.md), [Workbench 조사](prior-evidence/workbench/notes.md)를 이어 쓴다. 이 문서는 부모의 superpowers+pstack 통합 계획에서 선행 기술결정 게이트를 담당한다.

읽은 파일 전체의 해시와 실제 발췌 범위: [architecture-files-read.json](architecture-files-read.json). 새로 받은 upstream 텍스트 5개: [architecture-source-downloads.json](architecture-source-downloads.json). 원문은 실행 지시로 사용하지 않았다.

## 결정 요약

| 결정 | 현재 권장안 | 아직 확정할 수 없는 것 | 전체 재작업을 막는 경계 |
|---|---|---|---|
| 사람이 보고 AI가 조작하는 동일 페이지 | `pageId → native view` registry와 `BrowserExecutor` 계약을 먼저 고정. Windows는 기존 native WebView2 CDP 호출 경로부터 검증, macOS/Linux는 각 OS driver | 임의 WKWebView/WebKitGTK에 Playwright WebKit으로 붙을 수 있다는 가정; DOM JS 실행=trusted input이라는 가정; Paseo Electron 모듈을 Tauri에 그대로 복사 가능하다는 가정 | UI/HIG, task identity, parent reporting은 driver와 분리. OS 하나 실패해도 그 driver만 대체 |
| daemon와 Office 수명 | Workbench host를 독립 lifecycle로 분리하되 UI presence, task authority, executor/writer lease를 분리 | Node detach만으로 renderer의 Office tools가 계속 실행됨; heartbeat를 늘리면 무창 실행 지원이 됨 | renderer-required task와 headless-capable task를 명시. headless 이전은 도구별로 하고 기존 편집기 경로 유지 |
| 모바일 | Workbench 고유 데이터/Office/브라우저 상태를 다 보여야 한다면 자체 responsive client를 기본 경로로 계획. Paseo는 public SDK를 쓰는 선택 backend/adapter 후보 | 공식 Paseo 앱이 현재 Workbench HTTP/SSE에 직접 연결됨; SDK가 임의 서버용 transport임; chat 호환=Office 전체 호환 | host/task/identity 계약을 고정하고 transport/client는 adapter로 교체. 작은 protocol gate 이후에만 공식 앱 compatibility facade 투자 |

이 권장안은 구현 승인 또는 성능 실증 결과가 아니다. 최종 요구사항을 누락시키는 fallback을 ‘전체 완료’로 계산하지 않는다.

## 1. 동일 visible page와 OS별 renderer/CDP

### 이미 소스로 확인한 것

- Workbench `apps/desktop/src-tauri/src/office_browser.rs:99–130,160–188`는 별도 owner와 임시 profile을 가진 **숨은 HTML 변환 창**이다. URL allowlist와 popup deny가 있다. 범용 웹 지원을 위해 이 제한을 풀면 기존 신뢰 경계를 깨뜨린다.
- 같은 파일 `192–221`은 Linux WebKitGTK의 JS 실행·snapshot, `224–254`는 Windows `CoreWebView2.CallDevToolsProtocolMethod`를 통한 `Runtime.evaluate`·`Page.captureScreenshot`, `257–300`은 macOS WKWebView의 JS 실행·snapshot이다. **CDP native method 호출이 있다는 것과 Playwright가 연결할 CDP endpoint를 제공한다는 것은 다르다.**
- `capabilities/default.json:5–13,41–53`의 권한은 main/session 창과 loopback UI에 연결된다. 새 일반 웹 view는 여기에 매칭되지 않는 별도 label/scope여야 한다. 앱의 bearer, Tauri invoke, 파일·셸 권한을 페이지 JS에 넘기지 않는다.
- Paseo `browser-automation/service.ts:25–50`의 포트는 `executeJavaScript`, `sendInputEvent`, `insertText`, `sendDebugCommand`, frame capture를 요구한다. `trusted-input.ts:1–26,38–84`는 Electron keyboard 이벤트와 CDP mouse input을 사용한다. `service.ts:42–44` 주석은 CDP text input이 다른 focused element에 들어갈 수 있다는 문제까지 명시한다. snapshot 함수만 옮기는 것으로 전체 input 동작이 성립하지 않는다.
- Paseo broker는 browser host가 끊기면 pending을 `browser_no_host`로 종료하고 미지원 command를 명시한다 (`broker.ts:73–103,343–364`). daemon 단독으로 visible browser를 지속시켜 주는 구조가 아니다.
- 공식 문서도 OS 경계를 확인한다: [Tauri WebView](https://v2.tauri.app/reference/webview-versions/)는 Windows WebView2, macOS/Linux WebKit을 사용하며, [Playwright WebView2](https://playwright.dev/docs/webview2)는 별도 CDP endpoint와 profile 격리를 설명한다. 2026-11-09 재열람. 이것은 우리 앱 native E2E 증거가 아니다.

### G-BR0: 작은 계약 및 관찰 fixture 고정

- **제안 파일:** `packages/contracts/src/browser.ts`; `scripts/fixtures/shared-page/index.html`; `scripts/fixtures/shared-page/server.mjs`; `scripts/architecture-probes/browser-contract.ts`. 원본 수정 접점은 `packages/contracts/src/index.ts`, `apps/web/src/tabs.ts`, `apps/web/src/panes.ts`다.
- **입력:** 같은 URL을 두 번 연 서로 다른 `pageId`; `profileId`, `viewId`, `navigationRevision`, `taskId`, `controlOwner`, `actionId`를 가진 요청. 페이지는 첫 load에 `documentNonce`를 만들고 local counter, session cookie, textarea, IME 입력, popup/upload/download 버튼, action log를 제공한다. 실계정·실구매·외부 전송 없이 loopback fixture만 사용한다.
- **출력:** `browser-contract.json`에 owner·revision 검사 결과와 JSON event log. 인터페이스는 navigate/snapshot/click/fill/key/screenshot/cancel/dispose 및 capability를 반환한다. unsupported는 명시 error이고 다른 page나 engine로 몰래 전환하지 않는다.
- **합격:** stale navigationRevision/actionId 재사용·다른 workspace/page 요청을 모두 거부하고, read 관찰과 mutation 소유권을 분리한다. pane 사이 탭 이동은 pageId와 현재 documentNonce를 유지한다. URL navigation/reload는 pageId를 유지하고 navigationRevision을 증가시키며 새 문서의 documentNonce를 받는다. 탭 복제는 새 pageId를 만든다.
- **실패/종료:** 계약 충돌 시 이 schema만 수정하고 검증한다. 렌더러 개발은 시작하지 않는다. 이 게이트를 통과하면 UI/HIG/parent cards는 driver 미완성과 무관하게 진행 가능하다.

### G-BR1: Windows native WebView2 ‘같은 화면’ 실증

- **제안 파일:** `apps/desktop/src-tauri/src/browser_probe.rs` (기존 `office_browser.rs`를 수정하지 않는 독립 feature); `apps/desktop/src-tauri/src/browser_driver/webview2.rs`; `scripts/architecture-probes/visible-browser-windows.ts`. `lib.rs`에는 development-only probe 등록 접점만 둔다. 보안 capability는 별도 `browser-*` label이며 페이지에 앱 권한 없음.
- **입력 순서:** (1) fixture를 native child view에 표시 (2) 사람이 한글 ‘사용자 입력’과 cookie 설정 (3) driver가 같은 nonce/입력을 읽음 (4) AI 역할 driver가 trusted click/fill 수행 (5) 사람이 변경을 같은 화면에서 확인 (6) 두 페이지에 번갈아 입력 (7) hide/show·분할 이동·resize·DPI 100/150%·IME (8) navigation 후 stale ref 실행 (9) 사람이 제어 인계한 뒤 늦게 도착한 AI mutation (10) close/dispose.
- **출력:** `browser-win.json`에 OS/runtime/build SHA, page↔native target mapping, nonce, action ledger, `event.isTrusted`, control transitions, leaked process/profile/port 개수. 화면 캡처/영상은 native 화면이며 Playwright DOM 스크린샷으로 대체하지 않는다.
- **합격:** 화면에서 쓰고 읽는 documentNonce 일치, 20회 페이지 이동·입력에서 오대상 0, 사람 인계 이후 신규 AI mutation 0, stale ref 거부 100%, 숨김 후 폼 유지, IME 입력 손실/다른 pane 입력 0, dispose 후 소유 자원만 정리. React overlay와 native view의 겹침·bounds/focus가 정상이어야 한다. 단순 URL 표시·JS `.click()` 성공만으로 합격하지 않는다.
- **우선 경로:** 기존 per-view native CDP 호출을 감싼다. Playwright endpoint가 필요할 때만 별도 profile/local endpoint를 쓰는 대안 실증을 한다. endpoint 발견 시 URL만으로 target을 고르지 않고 nonce/registry identity로 검증하며 privileged app target은 제어 대상에서 제외한다.
- **실패 대안:** target isolation 실패면 remote debugging 범위를 확대하지 말고 per-view native driver를 유지; input semantics 부족이면 해당 capability를 실패로 기록하고 격리 Chromium renderer 후보를 이 계약으로 비교한다. 외부 Chromium 창은 호환 경로일 뿐 embedded shared page 완료가 아니다.
- **종료조건:** 한 OS의 첫 integration spike 90분 상한; 명시적 증거/가설 변경 후 45분 재시도 1회. 미통과면 해당 driver를 `BLOCKED_PLATFORM`으로 고정하고 ADR 작성. Tauri shell/HIG/host 전체를 다시 만들지 않는다. 다음 renderer 후보 실증은 별도 작은 work item이다.

### G-BR2: macOS/Linux 독립 adapter 검증

- **제안 파일:** `browser_driver/wkwebview.rs`, `browser_driver/webkitgtk.rs`, `scripts/architecture-probes/visible-browser-macos.ts`, `visible-browser-linux.ts`. 공통 fixture와 G-BR1 산출물 schema를 그대로 사용한다.
- **입력/합격:** 각 실제 OS에서 G-BR1을 반복하되 trusted input, nested/cross-origin frame, focus, native popup/file 선택을 OS별 capability로 기록한다. 기존 JS/snapshot 경로는 출발점이며 trusted input 구현 완료 증거가 아니다. Linux는 실제 배포 display backend도 기록한다.
- **실패 대안:** JS로 되는 read/snapshot과 안 되는 trusted input을 별도로 표시; 사용자 수동 조작 경로와 호환 렌더러를 유지한다. 전체 요구가 3 OS 동일 AI 제어라면 실패 플랫폼은 최종 release blocker로 남으며, 다른 OS의 성공으로 대체하지 않는다. 임의 WKWebView에 Playwright WebKit을 attach한다는 미검증 전제로 재시도하지 않는다.
- **종료:** OS별 90분+변경 가설 1회 45분; 장비 미확보는 `NOT_RUN_PLATFORM`, 제품 결함 FAIL과 구분. Windows 결과를 macOS/Linux PASS로 쓰지 않는다.

## 2. Daemon과 Office UI lease·실행기

### 이미 소스로 확인한 것

- Tauri `lib.rs:184–194`는 `WORKBENCH_EXIT_ON_STDIN_CLOSE=1`로 Node를 spawn한다. `main.ts:228–255`는 stdin EOF 또는 SIGTERM에 providers/store 등을 종료한다. main 창은 `lib.rs:435–448`에서 hide하지만 app Quit과 다르다. 현재 구조는 독립 OS daemon이 아니다.
- `document-registry.ts:18–68,82–92`는 실제 파일당 단일 live writer를 유지하며 TTL은 60초다. `document-session.ts:45–56`은 10초 heartbeat, pagehide/unmount close를 수행한다.
- `office-sessions.ts:60–64,95–104,182–195`는 live writer/session/revision을 검사하고, view 소실이나 response disconnect에서 run을 interrupted로 만든다. durable transcript/request idempotency와 parent report는 이미 있다 (`75–111,127–178`).
- `office-ai.ts:48–50`은 실제 편집 도구가 renderer에서 실행된다고 명시한다. `office-agent.ts:44–56`은 renderer skill.executeTool을 호출한다. `office-ai.ts:127–136,283–311`은 HTTP response 소실을 실행 abort와 연결한다. **daemon detach만으로 renderer tool을 유지하거나 headless로 바꿀 수 없다.**
- 현재 EventBus는 메모리 seq/5000 replay이다 (`bus.ts:8–43`); seq는 프로세스 시작 때 0이며 `since>=seq`면 빈 replay를 반환한다. `api.ts:526–555`는 lastSeq로 재연결한다. 따라서 daemon restart 이후에는 generation/epoch 및 authoritative snapshot 복구가 별도 필수다. 이 결론은 코드 추론이며 장애 실험 결과가 아니다.

### 수명 계약: 세 가지를 분리

1. UI presence: 지금 보고 있는 창·device가 있는가. 화면 hide/disconnect는 observation 변경이다.
2. Task authority: workId/workspaceId/sessionId/runId, 사용자 승인·capability·cancel·완료 상태. 연결이 잠시 끊겼다고 권한이 새로 생기지 않는다.
3. Executor와 writer lease: 어떤 실행기가 어느 물리 파일의 어느 revision을 수정할 수 있는가. fencing generation으로 옛 writer의 늦은 결과를 거부하고 CAS/disk-change 확인을 유지한다.

`renderer-required`, `host-capable`, `external-app-required`를 task capability로 나누어야 한다. UI 없이 실행을 계속하겠다는 정책이 원래 파일 권한/동시 편집 검사를 생략할 이유가 되지는 않는다.

### G-DM1: daemon 독립 수명과 observation 재접속

- **기존 접점:** `apps/desktop/src-tauri/src/lib.rs`, `apps/host/src/main.ts`, `apps/host/src/bus.ts`, `apps/web/src/api.ts`, `apps/host/src/sessions.ts`.
- **제안 파일:** `apps/host/src/daemon/lifecycle.ts`, `daemon/instance.ts`, `daemon/event-cursor.ts`; `scripts/architecture-probes/daemon-lifecycle.ts`.
- **입력:** 격리 data dir와 fake provider의 20단계·60초 run. UI hide, UI process 정상 종료, 같은 host 재attach, observer SSE 소실, host SIGTERM, host crash/restart를 별도 case로 실행한다. 기존 실제 사용자 daemon/process를 채택하거나 종료하지 않는다.
- **출력:** pid+process start+instance ID, runId, cursor `{epoch,seq}`, durable request receipt, shutdown reason, restart snapshot. OS별 service manifests는 이 계약 뒤에 `packaging/service/{linux,macos,windows}/`에서 별도 검증한다.
- **합격:** UI loss 후 host-capable run은 같은 ID로 끝나며 submit 중복 0; UI reattach는 기존 인스턴스를 관찰; observer disconnect가 run 취소가 되지 않음; 명시적 host stop은 ingress를 닫고 소유 자식만 정상 종료; restart는 epoch 변경을 인지하여 snapshot 복구, 미완료 mutation은 interrupted/unknown으로 표시. crash를 성공이나 자동 exactly-once resume로 표시하지 않는다.
- **실패 대안/종료:** attach/epoch 실패는 기존 shell-owned mode를 유지하며 서비스 기본 활성화를 막는다. 새 lifecycle adapter만 수정한다. 최초 90분+증거 변경 45분 1회. 서비스 설치 검증은 OS별이며 이 코드 게이트로 reboot PASS를 선언하지 않는다.

### G-OF1: UI writer와 task writer 이전·회수

- **기존 접점:** `document-registry.ts`, `office-sessions.ts`, `office-ai.ts`, `document-session.ts`, 기존 Documents CAS 저장 경로.
- **제안 파일:** `apps/host/src/document-execution-lease.ts`; `apps/host/src/office-executors/types.ts`; `scripts/architecture-probes/office-lease.ts`.
- **입력:** 동일 물리 파일을 가리키는 서로 다른 artifactId와 symlink, 두 editor view, dirty buffer, 저장 revision N, host task. UI→task 양도 전 미저장 상태, 정상 양도, UI 재진입·회수, lease expiry, task의 늦은 commit, 외부 disk 변경을 각각 주입한다.
- **출력:** `lease-ledger.json`의 owner/generation/revision/disk hash/decision 및 최종 file hash. 기존 실제 문서가 아닌 복사 fixture에서만 실행한다.
- **합격:** dirty buffer 또는 revision 불일치에서는 양도 거부; 한 물리 파일에 동시 writer 0; generation 변경 뒤 이전 writer commit 100% 거부; 외부 변경 보존; 한 turnEnd와 parent notice; cancel 이후 새 tool mutation 0. UI 연결과 task 권한을 동시에 폐기하지 않고 명시적 revoke/cancel을 반영한다.
- **실패 대안/종료:** lease 이전이 불안정하면 기존 renderer writer 정책을 유지하고 해당 job을 ‘편집기 필요’로 명시한다. TTL만 늘리거나 fake heartbeat로 우회하지 않는다. 파일 손실/오소유 write 1회면 즉시 중단·fixture 보존·원인 기록; 같은 접근 재시도는 새 가설 1회만.

### G-OF2: 실제 host executor 한 종류만 분리

- **제안 파일:** `apps/host/src/office-executors/headless-markdown.ts`, `renderer.ts`, `registry.ts`; `scripts/architecture-probes/office-headless.ts`. `apps/office/src/office-agent.ts`의 renderer executor는 기존 행동을 유지한다.
- **입력:** 문서 1개, ‘정해진 문장 삽입→저장’의 deterministic tool plan. 모델 응답은 fixture로 고정한다. editor 없는 host 작업, 실행 중 UI 새 연결, cancel 직전/저장 직후 disconnect, restart 직전 mutation 등으로 검증한다.
- **출력:** artifact revision N→N+1, CAS receipt, tool-result journal, 부모 notice, 최종 파일 diff와 재열람 결과.
- **합격:** UI가 완전히 없는 상태에서 동일 계약으로 저장·기록·취소가 성립; 중복 actionId가 재저장하지 않음; 응답 손실 시 재전송 대신 저장 receipt를 reconcile; 기존 renderer 작업은 정상 유지. 이는 Markdown executor 하나의 성공이며 HWPX/DOCX/XLSX/슬라이드 편집 무창 지원으로 확대하지 않는다.
- **실패 대안/종료:** renderer 전용 포맷은 명시적으로 UI-required로 유지하고 task는 중단/대기 상태를 정확히 보인다. 숨은 전체 Office WebView를 daemon에 붙이는 대안은 메모리·OS수명·자원 lease 비용을 별도 실증한 뒤 검토한다. 문서 엔진 전체 이식은 이 게이트 실패의 자동 대응이 아니다.

## 3. 모바일: official Paseo adapter와 자체 client

### 먼저 구별해야 하는 세 후보

| 후보 | 확보하는 것 | 반드시 따로 해야 하는 것 | 1차 판단 |
|---|---|---|---|
| 공식 Paseo 모바일 앱 + 진짜 Paseo daemon + Workbench backend adapter | upstream QR/E2E/reconnect/mobile UI 계약을 그대로 사용할 가능성 | Workbench 세션/Office/browser ID와 권한 연결, duplicate store/provider spawn 방지. 공식 앱이 Workbench 고유 기능을 표시하는지는 별도 | 선택적 Paseo backend를 빠르게 검증하는 후보 |
| 공식 앱 + Workbench가 Paseo server protocol facade 제공 | 앱을 fork하지 않고 기존 세션 표시 가능성 | hello/capability, workspace/agent/timeline/approval/terminal/host lifecycle과 unknown outcomes의 정확한 서버 구현 | 작은 conformance gate 통과 전 전체 구현 확정 금지 |
| 자체 Workbench responsive client + Workbench daemon | 기존 session/artifact/Office/browser/HIG 계약 유지, 기능 표면 통일 | 기기 인증/revoke, 원격 transport, mobile lifecycle, offline/history, 알림 구현 | 전체 Workbench 경험의 기본 후보. PWA/native wrapper 선택은 모바일 실증 후 |

`@getpaseo/client`는 임의 HTTP/SSE 서버를 쓰는 일반 networking library가 아니다. public `createPaseoClient`는 DaemonClient를 만들고 Paseo agents/workspaces/providers/config API를 제공한다 (`packages/client/src/index.ts:92–114,585–623`). 같은 파일 `353–369`는 reconnect 뒤 live membership만 복구하며 gap history refetch는 소비자의 책임이라고 명시한다. Workbench의 현재 API (`apps/web/src/api.ts:526–555`)와 wire format은 다르다. official app 사용, official SDK 사용, Workbench 자체 client 사용을 한 항목으로 섞지 않는다.

보안 선행 사실: 현재 Paseo 조사에서 no-password/shared password 접속은 owner 권한이며, 전화기별 장기 자격/revoke는 확인되지 않았다. legacy replay 허용 기본과 push preview의 Expo 전달도 별도다. 따라서 공식 앱 사용만으로 Workbench의 device-scope/revoke/privacy 요구를 만족했다고 판정할 수 없다. 이 계약의 정확한 고정 소스는 [이전 runtime 조사](prior-evidence/runtime/notes.md)의 pairing·authorization·notification 절을 따른다.

### G-MB1: 공통 host adapter의 최소 수직 흐름

- **제안 파일:** `packages/contracts/src/host-session.ts`; `apps/host/src/backends/paseo.ts`, `backends/workbench.ts`; `scripts/architecture-probes/mobile-adapter-contract.ts`.
- **입력:** 한 host, 한 workspace, 기존 sessionId/nativeSessionId, 가짜 stream, 한 permission request, 한 cancel, duplicate send, offline history cursor. app 종류와 무관한 adapter contract를 테스트한다. hostId는 세션 이동이 아닌 실행 위치다.
- **출력:** normalized event trace와 stable identity mapping. `created`, `queued`, `accepted`, `finished`, `verified`는 구별하고 unsupported capability는 false로 노출한다.
- **합격:** 두 adapter 모두 session/workspace 소유권과 parent 연결을 보존하며 다른 DB에 duplicate authority를 만들지 않음; approval/cancel이 정확한 host/run에 도달; 한 request가 provider를 두 번 시작하지 않음; gap 복구 뒤 history 일치.
- **실패 대안/종료:** 공통 모델을 최소 교집합으로 낮춰 기존 Office/browser 정보를 버리지 않는다. backend 확장 필드/capability로 유지한다. 60분 후 mapping ADR를 고정하며 네트워크 재구현은 이 단계에서 하지 않는다.

### G-MB2: official-app/server facade 투자 판정

- **제안 파일:** `scripts/architecture-probes/paseo-conformance.ts`; `apps/host/src/adapters/paseo-wire-probe.ts`; `scripts/fixtures/paseo-v0153-capabilities.json`. host main에는 production route를 붙이지 않는 격리 probe다.
- **입력:** pin된 public SDK 및 실제 official app 버전. 한 loopback test host에서 handshake/capability, workspace list, agent list, history, send, approval, cancel, reconnect를 수행한다. 먼저 SDK의 wire 계약을 검증한 뒤 실제 모바일 앱에서 동일 vertical slice를 확인한다. upstream 버전/패키지 hash, 공식 앱 version을 결과에 남긴다.
- **출력:** `official-client-conformance.json`에 실제 사용한 RPC, unsupported/mandatory 항목, ID roundtrip, UI navigation trace. 임의 capability를 true로 광고하지 않는다.
- **합격:** 새 adapter 바깥의 Workbench core 변경 없이 동일 session이 보이고 제어됨; 단순 chat뿐 아니라 필요한 artifact/browser/Office 진입점의 표현 가능성과 소유권을 문서로 확인. client가 필수로 요구하는 기능을 error로 숨기면서 PASS하지 않는다.
- **실패 대안:** 진짜 Paseo backend용 선택 adapter는 남기고 전체 모바일 UX는 Workbench 자체 client로 진행. 공식 앱 fork나 Workbench 전체 프로토콜 교체를 자동 결정하지 않는다. 공식 앱이 프로젝트 고유 view를 표현할 수 없으면 ‘호환 chat companion’으로 한정하여 별도 선택 기능으로 남긴다.
- **종료조건:** 첫 protocol spike 90분 + 버전/가설 변경 재시도 45분 1회. 중대한 protocol surface mismatch가 확인되면 조기 종료. 최종 판정은 SDK 성공과 native app 성공을 별도 열로 기록한다.

### G-MB3: 자체 client/공식 client 공통 모바일 출시 게이트

- **기존 접점:** `apps/web/src/api.ts`, `state.ts`, `App.tsx`, 기존 attachment/approval UI. **제안 파일:** `apps/host/src/device-grants.ts`, `apps/web/src/mobile/connection.ts`, `scripts/architecture-probes/mobile-reconnect.ts`.
- **입력:** 실제 iOS/Android 한 대씩, test host, QR/링크, 정상·오류 credential, device A/B, protected-only 연결, Wi-Fi↔cellular, 5분 background, host restart, 같은 send 응답 손실, 한 기기 revoke, notification tap. 실계정 provider를 쓰지 않는 fake run fixture부터 수행한다.
- **출력:** device grant IDs(비밀값 제외), admission/revoke trace, epoch/history digest, send idempotency 결과, push redacted payload, native 화면 증거. OS와 app version을 명시한다.
- **합격:** 한 기기 revoke가 다른 기기를 끊지 않고 revoked socket/재연결 차단; history 정확·중복 mutation 0; protected-only downgrade 거부; offline임과 데이터 stale임을 구별; 모바일 background 복귀 후 observer 복구; file/image/approval 대상 정확. 알림은 별도 opt-in·generic payload 기본으로 설계하고 실제 push가 필요하면 선택 client에서 지원되는지 확인한다.
- **실패 대안/종료:** notification failure는 알림 lane을 막고 timeline/in-app unread 개발은 계속; 암호화·revoke 실패는 외부 접속 출시를 막고 loopback 개발은 계속; official client가 per-device auth를 표현하지 못하면 자체 client 선택 근거가 된다. 이 게이트 미실행은 모바일 지원 완료가 아니다.

## 실증 운영·종료·다음 단계 규칙

- 위 시간은 **한 기술가설의 실증 상한 제안**이며 전체 기능 구현 기한 약속이 아니다. CI queue나 실제 OS가 없어서 대기하는 시간은 실행 실패로 분류하지 않는다. 이번 조사에서는 어느 상한도 소모하지 않았다.
- 각 gate는 `NOT_RUN → PASS / FAIL_WITH_EVIDENCE / NOT_RUN_PLATFORM`과 ADR 한 장으로 끝낸다. 실패 시 입력·환경·고정 버전·관찰·새 가설을 기존 research R 라벨의 새 revision에 기록한 뒤 최대 한 번만 재시도한다. 실패 하나로 shell/HIG/session/store 전체를 교체하지 않는다.
- 산출물 공통: `gate.json`(versions/inputs/expected/observed/result), action log, fixture hash, 화면 증거, 비용 측정, cleanup receipt. fixture 결과가 실제 packaged binary 결과를 대신하지 않는다.
- 앞으로 실증을 실행할 때는 실제 workId/nativeSessionId와 새 격리 workspace·resource lease를 사용한다. 테스트가 소유한 process/profile만 정상 종료하며 기존 앱/브라우저/daemon은 채택·종료하지 않는다. credentials/live DB를 Dropbox에 복사하지 않는다.
- 최대 네 slot에서는 부모 조정자 1 + browser/daemon/mobile 조사·구현 3까지만 가능하다. 추가 agent/외부 모델이 있다고 가정하지 않는다. 같은 `lib.rs`, `main.ts`, contracts entry 파일을 동시에 편집하지 말고 각 lane은 독립 파일과 작은 통합 패치로 인계한다.
- G-BR0, G-DM1, G-MB1의 결과가 각 세부 구현 순서를 결정한다. HIG의 화면 구조·의미 있는 컴포넌트·접근성 작업은 이들과 독립적으로 진행할 수 있다. browser lane 실패를 HIG 재설계 이유로 삼지 않는다.
- GitHub 버전업·release는 부모 계획의 마지막 단계다. OS별 native gates, packaged app 수명, 기존 Office/CAS/검색/원본 보존 회귀, 의존성 license/notices, target artifact hash와 설치 후 검증이 있어야 ‘전부 구현’이라고 표시한다. 계획 문서만으로 버전 bump/build/release를 실행하지 않았다.

## 상태

**PASS: 소스 기반 의사결정 분석과 독립 실증 설계. ISSUES: 세 가지 핵심 결정을 확정할 native/protocol/lease 실증이 아직 없음. BLOCKED: 조사 자체는 없음. 구현 및 출시 gate는 전부 NOT_RUN.**

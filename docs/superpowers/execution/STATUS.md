# 0.4.0 실행 상태

2026-11-10. **[v0.4.0 설치 파일 6종을 정식 공개했다](https://github.com/laguna821/Achmage-workbench-CLI/releases/tag/v0.4.0).** source `30112bc`, run `42648941283`의 공통 빌드·타입·1,473개 테스트·실제 UI 11개, Windows 신규 설치 35개·macOS 32개·Windows v0.3.3 업데이트 데이터 보존 17개와 정상 종료가 통과했다. 실제 설치 파일을 재빌드하지 않고 게시했으며 공개 9자산의 크기·해시·소스와 Windows 공개 다운로드 HTTP 200을 확인했다. 사용자 교정에 따라 통과한 검사·기능별 빌드를 반복하지 않는다. 실제 휴대폰·외부망·모든 OS 앱 제어와 계정 조합의 인수를 완료했다고 표시하지 않는다. 버전 공개와 전체 25개 목적의 실기기 수용 완료는 구분한다.

| 기능 묶음 | 현재 코드 | 근거와 남은 범위 |
|---|---|---|
| S0 대화 원문 우선 검색 | 구현 | `93837f8` — 프롬프트/AI 원문을 문서·볼트보다 먼저 표시 |
| U02 공통 UI | 구현 | `abf4f68` — 키보드 이동·초점 복귀·HIG 컨트롤 |
| U03 생성·프로젝트·탭 | 주요 흐름 구현 | `abf4f68`, `a3d9683`, `e056d8b` — 9종 문서·실제 폴더 생성, 정리 폴더 구분 |
| U04 대화·초안 | 구현 | `abf4f68` — 읽기 위치·검색 원문 펼침·초안 보호 |
| U05 그림 결과 | 파일·사진·공유 연결 구현 | 기존 이미지·원본 decoder에 파일/사진/카메라 선택, 다운로드·Web Share, host·대화별 업로드 초안 복원을 추가했다. 실제 휴대폰 제공자·공유 화면 확인은 남음 |
| U06 작업 목록·명령 | 실제 공급자 하위 제어 연결 | Codex child steer/interrupt/resume+start, 원본 Claude task protocol·stopTask·backgroundTasks·승인, 별도 child 대화·TaskPanel·receipt·live 완료 알림 연결. 공급자가 제공하지 않는 제어는 표시하지 않음 |
| U07 역할·CLI/MCP API | 구현 | `9239725`, `498a710` — 역할 CRUD·요청 당시 설정 보존·공통 receipt |
| U08 9형식 Office UI | 주요 흐름 구현 | `b40fb38` — 원본 명령 메뉴·theme 전달. 전체 native OS 사용 확인은 통합 때 |
| U09 Office UI 독립 실행 | 8종 독립 adapter + 공통 질문·출력 코드 연결 | `aa6779d`, `f89fd18` 및 후속 R37 — 원본 Markdown/Word/한글/Sheets/PDF/HTML/XMind/EPUB send·선택·질문, 기존 요청/저장/재접속 연결. 이번 묶음에서 슬라이드 queue/QC 수명·PDF toolbar 작업·native 출력 서비스 연결을 추가했다. 실제 OS 실행·통합 확인은 남음. [범위](../../office-execution.md) |
| U10 검색·Bases·그래프 | 주요 흐름 구현 | `e056d8b` — 검색 취소 복귀·다중선택/일괄 보관·그래프 키보드 이동 |
| U11 설정·가져오기 | 온보딩 통합 구현 | 원본 Paseo onboarding model에 기존 AI 로그인·Dropbox·이음 독립 앱 등록·문서 시작·음성 캐시·기기 연결·기록 가져오기를 연결 |
| U12–U14 공유 웹·같은 페이지 AI | 핵심 코드 구현 | `2df5f41`, `1c5e688` — 네이티브 웹 탭·주소 이동·독립 웹 AI·사람 인계·숨김 유지·대상/문서/제어권 식별. 이번 묶음에서 다운로드·사이트 권한·macOS 14+ 프로필·문서/첨부 산출물 연결을 추가했다. Windows/macOS 실제 download 객체 취소와 요청 origin별 권한 저장·삭제까지 연결. 실제 OS 화면 사용은 통합 단계. [범위](../../shared-browser.md) |
| U15 외부 앱 조작 | 원본 CLI·세션·화면 연결 구현 | 공식 v1.1.0 설치/원본 installer, 창 선택, 관찰·조작·캡처·제어권·기록, Codex/Claude 도구 연결. 실제 OS 앱 조작과 설치본 사용은 남음. [범위](../../desktop-control.md) |
| U16 독립 host | AppImage 지속 경로까지 코드 구현 | 기존 서비스·재접속에 압축 runtime 보존, 별도 AppImage mount/Node 수명, 로그인 실행 경로 갱신을 연결. 새 AppImage/native OS 실행 확인은 통합 때 |
| U17–U18 기기·모바일 | 원본 전송·기기 승인·native 저장·모바일 입력 연결 구현 | Tauri OS keyring과 세션 값 이행, 사진·공유·파일 선택, IME 최종값·viewport·초안 복원을 연결했다. 브라우저는 session credential. 원본 scan model·카메라·QR 그림·붙여넣기를 연결했고 실제 외부망/휴대폰 확인은 남음. [사용 범위](../../remote-connections.md) |
| U19 서비스 알림 | push·OS 클릭 연결 코드 구현 | 원본 Paseo lease/store + web-push, VAPID OS vault, host별 구독, 현재 권한 resolve 뒤 실제 이동 시 ack, macOS/Windows native 클릭 helper 연결. 실제 OS·모바일 도착/권한/클릭은 미실행. [범위](../../service-notifications.md) |
| U20 workspace 운영 | 주요 흐름 구현 | `2462057`, `83a908b` — owned 서버 실행·포트 충돌·출력 재사용·정확한 소유 실행 종료와 UI 연결. 이번 묶음에서 원본 terminal controller/emulator/headless, 모바일 보조 키, 로그 검색·고정 서비스 HTTP 프록시를 연결. 원본 전체 HTTP/WebSocket 프록시도 별도 origin·owned 실행·기기 권한에 연결했다. 휴대폰 웹 화면은 별도 HTTPS preview 경로 설정 필요; 실제 모바일 입력·외부망 확인은 남음 |
| U21 예약 | 주요 흐름 구현 | `1a39d77` — occurrence 기록·timezone·횟수/기한·미실행 정책·unknown 재전송 방지 |
| U22–U24 음성·플러그인·Hub | 핵심 서비스·화면·원본 outbound Hub 연결 구현 | 음성/SDK/compiler/lifecycle + QuickJS, 서명 사건/TaskService receipt에 원본 Hub relationship/retry/execution·OS vault·관리 화면 추가. 실마이크/native 모델/실모바일/외부 계정 확인은 남음. [범위](../../voice-extensions-events.md) |
| U25 설치·릴리즈 | 6종 정식 게시·설치/업데이트 확인 완료 | source30112bc/run42648941283. Windows35/macOS32/업데이트17 PASS, 공개파일 동일 hash 확인. [결과](U25/result.json). 실제 휴대폰·외부망 등 개별 기기 수용 범위는 미확인으로 유지 |

현재 코드의 확인은 해당 묶음에서 확보한 결과를 재사용한다. Office production bundle은 Rust PATH와 vendor realpath를 보정한 실행에서 통과했다. U03/U10 관련 동작 15개, import 9개, 실제 폴더 경계 1개, U20 서비스 3개와 UI 4개, U19 host 알림 4개와 UI 6개 확인을 마쳤다. 전체 OS/실계정/실기기 완료를 뜻하지 않는다.

U12–U14 host 4개, UI 6개, 정확한 DOM adapter fixture, host/web TypeScript 및 Linux native compile을 확인했다. HTTP 환경의 nonce 생성도 별도 단일 확인했다. Native OS 화면 E2E나 실제 로그인은 아직 확인하지 않았다. 이번 공유 웹 묶음에서는 production/installer/CI를 실행하지 않았고 최신 구현은 로컬 개발 브랜치에 있다.

U09 실행 권한·저장 분리의 집중 22개와 영향받은 참조/스킬/스타일 49개, 독립 실행기·원본 Markdown 경로 6개와 Linux native check 결과를 재사용한다. R37에서는 기존 원본8형식의 adapter, 선택/입력 질문, 비동기 context 확인, UI 소실 뒤 출력 저장을 추가했다. R37 시점에 남아 있던 슬라이드 후속 실행 수명과 native 출력 서비스는 이번 묶음에서 연결했다. 실제 OS에서 UI 종료 뒤 실행 완료까지 아직 확인하지 않았으므로 U09 전체 완료로 표시하지 않는다. 기존 통과 suite와 production/installer/CI는 반복하지 않았다.

기존 CI `42575034938`은 lock 버전 두 항목 실수로 실패했고 복구했다. `42576006213`은 공통/macOS/Linux/Arch 성공, Windows 앱·NSIS 생성 후 WiX 다운로드 HTTP504로 MSI 실패했다. 실패한 bundle만 재시도하는 코드를 준비했으며 지금 재빌드하지 않는다.

사용자 교정에 따라 Paseo 관련 남은 범위는 **원본 코드·의존 묶음 재사용 + Workbench 연결**로 전환했다. 첫 relay 패키지와 실제 채팅 이미지 decoder를 반입했다. 원본 Noise 7개와 endpoint 연결 1개, 기존 media cache 2개 및 영향받은 타입 확인이 통과했다. 원본 source·출처·의존 라이선스와 배포 고지를 보존했다. 앱·설치본·CI는 실행하지 않았으며 U17–U18 전체 완료를 뜻하지 않는다.

후속 U17–U18에서는 원본 client/protocol source와 server 전송 의존 묶음을 반입하고 실제 기기 listener·단일 사용 QR/링크·PC의 프로젝트별 승인·credential 해시 저장·철회를 연결했다. 기존 대화/실행/이미지 API를 보호된 전송으로 사용하며 전역 owner token은 원격에 전달하지 않는다. 첫 연결 UI는 기존 App을 호스트별로 열며 로컬 경로 실행·detach를 차단한다. 전체 Paseo DaemonClient·공식 앱 protocol 호환이나 실제 휴대폰 완료로 표시하지 않는다.

기기 registry 8개, 연결 UI·저장소 5개, 실제 loopback 네트워크 2개 시나리오를 각 한 번 통과했다. 후속 첨부 연결은 media 권한 3개와 새 network 시나리오 1개를 추가해 통과했고, 기존 network 2개는 다시 실행하지 않았다. 원본 전송 closure의 protocol/client/server standalone emit과 변경 후 host/web 타입이 통과했다. 이전 통과 검사와 production/설치본/CI 빌드는 반복하지 않았다.

후속 연결·첨부 근거: `research:rr-79110658024cdb4797375aa15a22a771:39c50e6924caa7e9e0aed55dc8c114f195c9f46bea75d2ad71b54ecb8fbadbf4` (R7–R12). 전체 U17–U18, 실제 모바일, 0.4.0 릴리즈 완료 판정이 아니다.

원본 [156개 요구 대응표](../plans/support/coverage.json)와 [통합 계획](../plans/2026-11-09-workbench-integrated-release.md)을 유지한다. 이 상태표의 ‘구현’은 기능 코드 상태이며 전체 릴리즈 완료 판정이 아니다.

Paseo 재사용 전환·첫 반입 근거: `research:rr-79110658024cdb4797375aa15a22a771:413d49e0d715c8db9687a0b1a48c6669ad100f71a9fdf72b13a250ecf0fc6a03` (R1–R6).

연구 판: `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:eaf1781fb6ea15427f1698896ce325e66c7ae94fae3c0f05a1b3b54e907b0d2a` (R24–R37). 실행 교정: `decision-7287723b7dd57957ec551667abe6ddc8c02067f7f0f0988cb2a44d58b05cd626`, `decision-b10e79c5567f53f7c9dfe5e459933f13cbff1b06242c87566dfbaea9d13d4e63`.

U22–U24 원본을 실제 서비스와 화면에 연결했다. 음성 host3/UI4, 실행 확장3, 사건 수신3의 집중 확인은 각 한 번 통과했다. 새 타입 오류와 Hub UI 반환형 불일치를 수정했다. 배포용 voice-worker와 extension guest/WASM/compiler 및 Tauri host resource를 연결하고 저장소 밖 임시 경로에서 의존파일 실행을 확인했다. 앱/설치본/CI 빌드는 실행하지 않았다. 구현·한계·연구 근거: [음성·확장·사건 연결](../../voice-extensions-events.md), `research:rr-79110658024cdb4797375aa15a22a771:ec68d100c4776b2219a705303a379cc524ae2c83caca88c7c9c2f1d9b6c805b5` (R13–R18). 전체 goal은 미완료다.

## 2026-11-09 추가 구현과 사용자 교정

사용자 교정 `decision-5e2a5ff3288c4ec7973e1f9922dd873605f56843e258b8e4fea0485a18a4cd70`에 따라 준비하던 root/web 타입 및 Rust 검사는 시작하지 않았다. Office 담당도 시작 전이던 새 검사를 실행하지 않았다. 이미 끝난 새 desktop4·browser outputs4·terminal2 결과를 재사용하며 다시 돌리지 않는다. 전체 남은 기능 구현을 먼저 진행하고 필요한 통합 확인은 설치본 시점에 묶는다.

이전 묶음 e1cb098은 U09·U12–15·U20 연결을 추가했다. 아래 후속에서 AppImage·native credential·모바일 파일/입력·push·outbound Hub 코드를 연결했다. 25개 단위/156개 요구와 U25 릴리즈의 전체 완료를 뜻하지 않는다.

## 2026-11-09 지속 실행·모바일 후속

연구 판 `research:rr-a19bb59ee9cc2a51ca502509a421c7ac:de8443305abef0bb31264f43cf9032da8b79f5b654405db7645114dc0c13e3b4` (R1–R6). 기존 3 owner를 구현에만 배정했다. root가 지속 AppImage·keyring·공통 API/화면/권한·배포 출처를 연결했다. 원본 server/push 의존 모듈 emit 한 번은 성공했으며, 새 테스트·전체 타입검사·Rust·production/설치본/CI·외부 발송은 수행하지 않았다.

남은 구현에는 공급자 하위 작업 제어, 전체 온보딩, QR camera scan, 공유 웹의 OS별 남은 동작, 서비스 전체 웹앱/WebSocket 프록시가 있다. 실제 OS/휴대폰/외부망/음성·계정 확인과 전체 통합 빌드·설치·업데이트·배포는 별도 남은 작업이다. 이미 끝낸 검사를 반복하거나 기능 범위를 새로 늘리지 않는다.

## 최종 연결 구현 마감 · 통합 빌드 진입

U06 하위 작업 제어, U11 전체 온보딩, U17–18 QR scan, U12–14 Windows/macOS 다운로드 취소·사이트 권한, U20 전체 HTTP/WebSocket 서비스 화면을 합쳤다. 3 owner는 구현만 담당했으며 추가 검사를 돌리지 않았다. root의 host/web 타입과 실제 loopback 서비스 HTTP/WebSocket·격리 origin·권한 철회 경계 1개가 통과했다.

첫 통합에서 agent-desktop stream 타입과 Hub ChunkedTransport 생성물 누락을 수정했다. protocol emit 종료 이전 재시도는 실행 순서 오류로 기록했고, 생성 완료 뒤 순차 실행에서 통과했다. 이미 통과한 기존 suite는 로컬에서 반복하지 않았다. 전체 production build가 통과했고 Linux native release 실행파일도 생성했다. 아직 OS별 설치본/업데이트/배포 완료는 아니다.

최종 연결·통합 빌드 근거: `research:rr-8b1de8f70ac6198a1f734b3f63b45bcb:046ce54f184df15eb9eeb09a64d3c751434bb5ad388abf6c0623b51526362629` (R1–R8).

## 설치본 빌드 준비

최초 Linux native compile의 Rust let 문법과 webkit2gtk extension trait import를 고친 뒤 해당 native compile만 재개했고 3분7초에 완료했다. 새로운 승격 확인은 기존 후보 파일 6개를 그대로 복사하고 source/hash가 다른 파일을 거절하는 1개 시나리오만 통과했다. 같은 후보의 원래 설치 receipt와 SHA256SUMS를 보존하며 preview와 stable 모두 준비된 빈 draft에만 업로드한다.

U25의 기존 요구 중 빠져 있던 protocol/schema 협상과 업데이트·migration 데이터 보호 연결을 마쳤다. 이전 버전과의 명시된 payload 호환은 유지하고, 호환되지 않는 새 쓰기는 거절한다. NSIS는 실제 기존 host만 drain하고 작업이 남으면 설치를 중단한다. 이 변경은 최종 installer source에 합친다. 새로운 제품 기능이나 추가 리뷰 절차를 만들지 않는다.

근거: `research:rr-8b1de8f70ac6198a1f734b3f63b45bcb:4754ea8c9049f2bc887f2950b8624c01544bb1555ad1349d94dc1fd1b4e28f77` (R1–R10).

U25 통합: host/web TypeScript와 새 protocol·migration backup 경계 2개가 통과했다. 최종 Office drain allowlist 보완은 이 확인 직후 합쳤으며 해당 최종 source는 CI의 전체 타입/빌드에서 확인한다. 이미 완료한 웹·Office·native 로컬 빌드는 반복하지 않고 OS installer CI로 진행한다.

최종 연결·배포 준비 연구: `research:rr-8b1de8f70ac6198a1f734b3f63b45bcb:5274ec8a5649b1c7b9b0b06dabb836045b90e93122a32221b5a4e53492b82445` (R1–R11).

## 첫 최종 CI의 실제 실패 수정

`42632532399` / `de13e01`: 공통 production 및 전체 타입 확인 통과. 회귀 1463개 통과·9개 skip, 8개 실패. 실패는 Composer의 JSDOM matchMedia 누락 5개, Hub 모의 manager의 accessOf 누락 2개, HWP catalog 테스트가 host를 중복 빌드하다 5초를 초과한 1개다. 누락된 fixture를 채우고 HWP/PDF 테스트가 CI 직전 단계에서 만든 bundle을 사용하도록 했다. 실제 catalog·편집·변환 assertion은 유지한다. 실패했던 8개만 3.79초에 통과했다. NSIS prepare-update 대상도 실제 배포되는 workbench-service.mjs로 수정했다. 빌드 실패 뒤 남은 queued macOS 작업은 취소하고 수정 source로 최종 후보를 다시 실행한다.

근거: `research:rr-8b1de8f70ac6198a1f734b3f63b45bcb:96363956b13dea6cd1f0de2453861f46517a3b5c4027f7869a43b31fc2b9cf20` (R13–R14). 전체 목표와 OS 설치본 완료는 아직 미완료다.

## 두 번째 CI의 완료 알림 수정

`42634953460` / `4180be0`: 공통 production·전체 타입·238 test files / 1471 tests(9 skip)가 통과했다. 실제 UI는 10/11 통과했고 foreground 완료 toast만 실패했다. modern host의 OS 알림 소유권 확인이 화면 내 toast까지 꺼버린 제품 회귀를 수정했다. 웹만 다시 빌드하고 기존 실제 UI harness의 `--completion-only` 모드로 실패 동작 1개만 통과시켰다. 기존 병렬 문서·메인 세션·저장·권한·모델·삭제 검사를 로컬에서 반복하지 않았다. 다음 후보 CI에서 OS별 설치본 단계로 이어간다.

근거: `research:rr-8b1de8f70ac6198a1f734b3f63b45bcb:c7d270192a4bf518aadea96fb7b0ad28b232a229b04c23f88a1c8563ec72174e` (R15–R17). 설치본·업데이트·공개 완료는 아직 미완료다.

## 설치본 생성 후 실제 설치 오류 수정

`42638537165` / `6f12a92`에서 Windows EXE·MSI, macOS DMG, Linux AppImage·deb, Arch 패키지가 모두 생성됐다. Windows 업데이트의 데이터 보존 17개 항목도 통과했다. 그러나 host의 agent-desktop installer를 npm workspace의 잘못된 상대 폴더에 복사하여 실제 설치본에서 누락됐고, Windows/macOS 호스트 종료 시 예외가 발생했다. 복사 경로를 저장소 root 기준으로 수정했다. 공식 이음 저장소 이름 변경(openoffice → ieumoffice)도 반영하되 공식 구·신 URL과 버전·OS·CPU·크기·해시 검사를 유지했다. 선택 앱의 정상 미설치 안내까지 실패로 잡던 전체 JS 문구 검사는 실제 필수 엔진 상태와 컴파일 웹 파일 확인으로 좁혔다.

변경 host만 한 번 빌드한 뒤 저장소 밖에서 실행해 원본 installer와 세 OS helper, 실제 desktop API, stdin-close 종료 코드 0을 확인했다. 이음 변경 경계 2개도 한 번 통과했다. 기존 전체 로컬 suite·Office·native 빌드를 반복하지 않았다. 실패 후보를 정식 게시하지 않으며 수정 source의 설치본으로 신규 설치·업데이트를 이어간다.

근거: `research:rr-8b1de8f70ac6198a1f734b3f63b45bcb:e35537822163829170be1345a27af709827e916a871b5e2a9c7d8922dbdf3525` (R18–R24).

## 0.4.0 공개 결과

수정 후보 `42648941283`의 모든 빌드·설치 job이 성공했다. Windows/macOS에서 공식 이음 0.12.12의 자동 설치·OS 앱 등록·Workbench 없는 독립 GUI 실행도 확인했다. 게시 전 집계에서 단일 `upgrade-windows` artifact의 다운로드 경로가 잘못되어 실제 통과 결과가 누락된 것을 찾아 workflow 목적 폴더 한 줄을 수정했다. 원본 설치 파일과 실제 receipt를 올바른 폴더에 모아 **동일한 기존 collector의 `--require-install-checks`와 promoter**로 게시했다. 검사 조건을 완화하거나 설치 파일을 재빌드하지 않았다. 교정된 manifest의 `collectionCorrection`에 원본 집계 전체·해시·출처와 수정 이유를 보존했다.

공개 시각: 2026-11-10 01:51:21 KST. source/tag는 `30112bc8602b3d449c78ff59a5db2ff26431d405`이다. 이 뒤의 기록·CI 경로 수정은 설치 파일의 소스를 바꾸지 않는다. 실제 iOS/Android·외부망·마이크·OS별 앱 제어 및 계정 기능의 모든 수용 기준까지 입증했다는 결론은 내리지 않는다.

근거: `research:rr-8b1de8f70ac6198a1f734b3f63b45bcb:d12e95c7859fd25cc515252f68eaa150218bc17046562aa1abf5752f3ee2816c` (R25–R34).

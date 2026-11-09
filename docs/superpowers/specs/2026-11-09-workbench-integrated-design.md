# Achmage Workbench 세 영역 통합 설계

작성일 2026-11-09. 설계·계획을 작성한 뒤 같은 날 사용자가 구현과 GitHub 0.4.0 빌드까지 실행을 요청했다. 현재 실행 상태는 execution/STATUS.md에서 관리하며 이 설계 문서 자체는 제품 완료 증거가 아니다.

## 사용자가 얻게 될 결과

프로젝트 안에서 사람이 문서를 편집하는 동안 문서별 AI, 웹페이지별 AI, 메인 대화가 각각 일을 계속한다. 메인 대화에서는 자식 작업의 진행과 결과를 확인한다. 집과 연구실 컴퓨터의 실행을 휴대폰에서 확인하고, 후속 지시·승인·중단·파일 확인을 할 수 있다. 창을 닫아도 승인된 작업은 해당 실행기와 호스트가 살아 있는 조건에서 지속한다.

HIG의 탐색·계층·맥락 보존·접근성 원칙으로 앱 셸, 대화, 프로젝트, 설정 및 내장 Office 도구를 함께 개편한다. 브랜드·서체·사용자 설정과 기존 편집 엔진은 유지한다. 보기 좋아진다는 이유로 기존 메뉴나 기능을 숨기는 것은 완료로 인정하지 않는다.

[상세 실행 계획](../plans/2026-11-09-workbench-integrated-release.md), [전체 요구 대응표](../plans/support/coverage-notes.md), [기계 대응표](../plans/support/coverage.json)를 함께 사용한다. 156개 원본 정의, 53개 수용 기준, 12개 회귀 묶음, Office 9형식을 25개 목적별 단위에 연결한다. 원본 ID는 변경하지 않는다. HIG F01과 Paseo F01은 namespace로 구별한다.

## 범위와 완료의 의미

| 영역 | 이번 전체 프로그램에 포함하는 결과 | 책임 단위 |
|---|---|---|
| HIG 전면 개편 | 공통 UI, 프로젝트 개요/YAML, 생성 메뉴, 탭/분할, 문서 집중, 채팅, 검색/볼트/Bases/그래프, 9형식 Office 내부 메뉴, 설정/온보딩, 기존 개발 도구 | U01-U11, U20 |
| Aside 사용성 | 일반 주소 입력·탐색이 가능한 웹 탭, 사람이 보는 같은 페이지를 AI가 제어, 페이지별 독립 AI, 제어권 인계, Lightpanda 조사와 결과 연결 | U12-U14 |
| 외부 앱 제어 | agent-desktop 대상/관찰/행동/결과 계약, 실제 OS별 지원과 저장 검증 | U15 |
| Paseo 대화·병렬 작업 | 읽기 위치·긴 이력·이미지/첨부·결과 파일, 공통 task/child/approval, 모델·역할 프로필 | U04-U07 |
| Paseo daemon·모바일·여러 기기 | 기존 host의 독립 수명, 문서 실행기, 기기 인증·취소·복구, 다중 호스트, iOS/Android, 알림·push·정확한 이동 | U09, U16-U19 |
| 이전 추가 후보 E01-E08 | workspace 서비스, 역할 프로필, 기록 가져오기, 예약/heartbeat, 한국어 음성, 실행 플러그인, 외부 이벤트 Hub, 버전/업데이트 호환 | U07, U11, U20-U25 |
| GitHub 전달 | 초반부터 중간 설치본, 동일 검증 산출물의 정식 승격, OS별 새 설치/업그레이드·데이터 보존 | U25a/U25b |

"전부"는 위 세 조사에서 정의한 기능과 이번에 편입한 E01-E08, X01-X03를 뜻한다. 브라우저 암호 관리자 전체, 확장 스토어, 프로필 클라우드 동기화, 살아 있는 프로세스의 다른 컴퓨터로 자동 이전은 이 조사 범위에 없었다. 새로 발견한 기능 아이디어는 별도 backlog로 기록하며 기존 완료선을 계속 늘리지 않는다.

버전 숫자와 커밋 수는 종료 기준이 아니다. 미검증 OS, 작동하지 않는 Office 형식, 미완료 원본 수용 ID가 남으면 전체 완료라고 표시하지 않는다. 중간 설치본은 그때 완성된 범위와 남은 범위를 명시해 배포할 수 있다.

## 현재 기준판과 재사용

| 사실 | 근거와 해석 |
|---|---|
| 작업트리 HEAD | bc1057c2c5fb04f2046f4fd711bf718f5cc93737, branch fix/urgent-usability-033, package 0.3.3 |
| 공개 v0.3.3 설치본 | source 6108d7894bf919bcdf392cafd3f64c414d50003c. 현재 HEAD는 업그레이드 검증 harness 수정 SHA이기도 하므로 설치본의 source로 바꾸어 쓰지 않는다 |
| 현행 제품 구성 | React 웹 UI + Tauri/Rust 셸 + Node host + 공급자 어댑터 + 내장 Office + Fast Find. 새 앱이나 DB를 처음부터 다시 만드는 계획이 아니다 |
| 현행 웹 제어 코드 | office_browser.rs의 WebView2/WKWebView/WebKitGTK 경로는 숨은 문서 변환 창을 위한 것. 실제 웹 탭과 trusted input을 검증한 증거가 아니다 |
| 현행 Office | 문서별 세션과 writer 검사가 이미 있다. renderer 도구와 UI 수명 의존이 있어 daemon 분리만으로 무창 편집이 완성되지 않는다 |
| 현행 서비스 | Node가 데스크톱 stdin 수명과 연결된다. hide/tray와 UI process 종료는 다르다 |
| 현행 Windows Lightpanda | 별도 native 빌드/CI 경로가 있다. Windows 포트를 처음부터 새로 만드는 과거 작업을 반복하지 않는다 |
| 현행 배포 | 3 OS 빌드와 일부 설치 검사 존재. Windows/macOS Node/API 설치 검사는 완전한 Tauri UI E2E와 구별한다 |

위 사실은 [출시 경로 분석](../plans/support/release-notes.md)과 [구조 실증 게이트](../plans/support/architecture-gates.md)에 파일 경로·관찰 근거를 연결했다. 이 문서 작성 중 제품 테스트를 재실행한 것은 아니다.

## 화면과 핵심 흐름

**기본 작업 화면.** 왼쪽에는 프로젝트와 종류가 구별되는 자식 항목, 위에는 열린 작업 탭, 가운데에는 선택한 개요·대화·자료가 있다. 프로젝트 이름 클릭은 바로 개요와 YAML로 간다. 펼치기는 별도 행동이다. 생성 메뉴는 상단 +, 프로젝트 우클릭, 키보드 명령에서 같은 action을 호출한다.

**문서 집중 화면.** 문서를 열면 문서 도구와 편집 영역을 중심으로 전환한다. "이 문서의 AI"를 필요할 때 연다. 메인 탐색과 하단 메인 입력 때문에 문서 공간이 좁아지지 않는다. 메인 탭으로 돌아오면 기존 입력과 탐색 상태가 복원된다. 이는 앱 내부 집중 모드이며 OS 전체 화면을 자동 강제하는 행동은 아니다.

**웹 화면.** 주소/이동 도구와 웹페이지, 선택적으로 "이 페이지의 AI"를 표시한다. 사용자가 로그인한 그 pageId와 profileId를 대상으로 AI가 작업한다. 작업을 숨겨 놓아도 같은 실행이 계속되며 사람이 개입하면 다음 행동 경계에서 제어권을 돌려준다. 같은 URL의 탭 두 개도 독립된 대상으로 취급한다.

**Lightpanda 조사.** 공개 정보 수집은 기존 headless 경로를 유지한다. 조사 결과를 사람이 열 때는 새로운 시각 웹페이지를 연다. Lightpanda의 로그인 상태·DOM·입력 중 폼이 그대로 시각 페이지로 옮겨졌다고 표시하지 않는다.

**대화와 결과.** 원문 프롬프트, AI 본문, 도구 실행, 이미지, 파일 결과의 계층을 구분한다. 오래된 메시지를 읽는 동안 스트림이나 이미지 로드로 읽기 위치가 움직이지 않는다. 파일 카드에는 해당 결과의 host/workspace/revision을 연결하고 적합한 기존 편집기로 연다.

**모바일.** 호스트 선택, 진행 작업, 대화, 결과, 승인/질문, 중지, 터미널을 작은 화면에 맞춰 제공한다. 데스크톱과 같은 작업의 관찰·조작이며 세션 복사본을 새로 만드는 방식이 아니다. 인증된 휴대폰을 철회하면 실행 서버에서도 권한이 사라져야 한다.

**이음오피스.** CLI 설치에서 독립 이음오피스 설치·OS 등록·연동을 함께 제공한다. "앱으로 열기"는 같은 실제 파일을 별도 앱에서 연다. 외부 저장을 감지해 revision을 갱신하고 복귀 후 AI가 최신 내용을 읽는다. 단순 내장 iframe을 별도 앱 설치 완료로 계산하지 않는다.

## 공통 구조와 계약

한 셸, 한 작업 조정자, 한 artifact 계약, 한 검색 경로, 한 알림 producer를 세 영역이 공유한다. 원본 프로젝트/세션 ID, provider native session ID, 기존 기록은 유지한다. 새 계약은 packages/contracts의 기존 자료형을 확장하고, 새 canonical session DB를 병렬로 만들지 않는다.

아래 필드는 제안 계약이다. 구현 초반 U01/U06에서 기존 스키마와 migration을 대조해 확정하고 모든 후속 단위가 동일 정의를 import한다.

| 계약 | 핵심 값 | 책임과 불변 조건 |
|---|---|---|
| TaskRef / RunRef | hostId, workspaceId, sessionId, nativeSessionId, runId, parentRunId, executorKind | 메인과 자식의 독립 실행, provider native child의 관찰/제어 capability 구분 |
| CommandReceipt | commandId, targetRunId, accepted/running/completed/rejected/outcome_unknown, resultRef | 네트워크 응답 손실 시 조회·조정. 결과 불명 외부 행동을 무조건 재실행하지 않음 |
| EventCursor | hostInstanceId 또는 epoch, seq | host 재시작 시 이전 seq를 새 host에 그대로 적용하지 않고 snapshot 복구 |
| ArtifactRef | artifactId, hostId, workspaceId, canonicalPath, revision, hash, MIME, sourceMessageId | 동일 이름/URL/경로만으로 결과를 식별하지 않음. 원격 권한·만료·현재 파일과 당시 결과 구별 |
| BrowserTarget | pageId, profileId, navigationRevision, capabilities | 같은 URL인 서로 다른 페이지를 혼동하지 않음. stale observation 폐기 |
| ControlLease | targetId, ownerRunId, generation, expiresAt, handoffState | 사람 인계와 취소 이후 늦은 AI 행동을 차단. 변경 행동을 같은 target에서 조정 |
| DocumentExecutionLease | physicalFileIdentity, revision, diskHash, writerOwner, generation | 미저장 버퍼·외부 저장·늦은 writer commit을 보존적으로 처리. 한 파일에 두 writer 금지 |
| DeviceGrant | deviceId, hostId, scopedCapabilities, expiresAt, revokedAt | read/send/approve/cancel/terminal 권한 분리. 철회·회전·재접속 시험 |
| AttentionEvent | completionId, taskRef, reason, readState, deepLink | 완료/실패/입력 필요 구분, producer는 host, 기본 push에 민감한 본문 미포함 |

작업 상태는 적어도 queued, running, waiting_input, completed, failed, cancelled, interrupted, outcome_unknown을 구별한다. UI의 전송 대기와 host의 실행 중도 구별한다. "한 번만 실행"은 durable 접수·결과 조정으로 달성할 범위를 명시하며 모든 외부 시스템에 exactly-once를 보장한다고 쓰지 않는다.

## 실증 뒤 확정하는 선택

전체 설계의 방향은 결정했지만 다음 실행 가능성은 코드 열람만으로 입증되지 않는다. pstack의 prototype 원칙에 따라 구현 첫 단계에 작은 실증을 배치한다. **계획 단계에서 실증을 실행한 것처럼 체크하지 않는다.**

| 결정 | 기본 경로 | 통과 증거 | 실패 또는 장비 없음 |
|---|---|---|---|
| 보이는 웹 렌더러 | OS WebView 드라이버를 재사용 | 실제 Windows/macOS/Linux에서 동일 페이지 조작·한글·포커스·hide/show·사람 인계 | 실패 capability를 기록하고 제한된 공통 renderer 대안을 비교. 외부 창만 띄운 것으로 embedded 완료 주장 금지 |
| 독립 실행 | 기존 Node host detach/attach + OS 서비스 | UI 종료 중 동일 run 완료, 정상 stop, crash epoch/snapshot 복구 | shell-owned 모드를 유지하고 미완료 표시. 기존 임의 process 채택/일괄 종료 금지 |
| Office UI 없는 작업 | 공통 task authority와 format executor | 먼저 Markdown 실제 저장, 이어 9형식의 기존 승인된 AI 도구별 실행/저장/인계 검증 | UI-required는 중간 지원 상태이며 전체 무창 요구의 합격을 대신하지 않음 |
| 모바일 | Workbench 계약을 쓰는 적응형 client를 기본안으로 검증 | 실제 iOS/Android의 연결·대화·사진·파일·승인·취소·재접속·push | 공식 Paseo app/adapter를 작은 conformance 실험으로 비교. SDK 연결만으로 공식 앱 호환 완료 금지 |

G-BR0/1/2, G-DM1, G-OF1/2, G-MB1/2/3는 모두 NOT_RUN이다. 단일 위험 가설의 최초 실험은 90분, 새 증거/가설이 있을 때 한 번 45분 추가를 제안한다. 이것은 기능 전체 구현 시간 약속이 아니다. 장비 없음은 NOT_RUN_PLATFORM으로 남긴다. 같은 오류를 가설 변경 없이 계속 반복하지 않는다.

Office의 UI 독립 실행은 모든 편집 엔진을 headless로 재작성한다는 뜻이 아니다. 형식별 기존 AI 도구를 host-capable과 renderer-required로 조사한다. 순수 host 도구는 먼저 이전하고, renderer 도구는 독립 수명과 자원 등록을 가진 실행용 host에서 기존 엔진을 재사용하는 경로를 검증할 수 있다. 사용자가 보는 셸 종료와 실행기 종료를 분리해야 하며, 단순 숨김 탭 유지나 가짜 heartbeat만으로 PA08을 통과시키지 않는다. 일반 수동 UI 명령 전체를 AI 도구로 새로 만드는 것은 이 요구에 포함하지 않는다.

공식 Paseo 앱을 쓸 수 있더라도 Workbench 문서·브라우저 기능을 모르는 부분이 있으면 companion 경로로 표시한다. full client 요구를 대체하지 않는다. OS별 service, mobile push, deep link, 서명/배포 설정에는 실제 해당 플랫폼의 검증이 필요하다.

## 원본 재사용과 구현 순서

- Paseo의 순수 스트림/reader anchor/메시지 정규화 로직, 공개 client 계약, 기기/이벤트 개념은 경계를 확인해 재사용한다. React Native 또는 Electron UI를 Tauri React에 복사하는 것으로 호환을 가정하지 않는다.
- Lightpanda는 정보수집 실행기로 유지하고, visible browser 및 agent-desktop은 별도 capability의 실행기로 연결한다.
- agent-desktop은 고정 버전·checksum·JSON 결과·관찰 freshness·대상 창·cancel/unknown 경계를 가진 adapter로 격리한다.
- HIG는 셸과 형식별 도구의 디자인 규칙이다. 기존 문서 렌더링 엔진과 문서 내용 CSS를 UI theme 변경으로 깨뜨리지 않는다.
- 코드 반입 때 upstream SHA, license, copyright/NOTICE 및 수정 목록을 남긴다. 원본 로고나 이름을 우리 브랜드로 도입하지 않는다.

U01 이후 U02 공통 UI, U06 작업 계약, U12 웹 실증을 병행할 수 있다. 공통 파일은 한 owner가 관리한다. 작업 조정자/문서 registry/전역 CSS를 서로 다른 agent가 동시에 재작성하지 않는다.

| 전달 단계 | 구성 | 사용자가 받는 결과 |
|---|---|---|
| A | U01-U06과 U25a 빌드 기반 | 프로젝트/탭·대화·이미지·독립 작업을 확인할 중간 설치본. 문서 집중의 현행 회귀도 포함 |
| B | U07-U08, U10-U15 | Office 전면 UI, 검색/볼트/이음, 웹 탭/동일 페이지 AI/외부 앱의 검증 범위 |
| C | U09, U16-U19 | UI 독립 실행, 여러 기기, 모바일, 알림의 실제 기기 설치본/연결 결과 |
| D | U20-U24와 미완료 E01-E07 세부 | workspace 서비스·예약·음성·플러그인·Hub |
| 전체 | U25b와 모든 원본 ID/회귀/9형식 | 검증한 동일 설치 파일을 GitHub 정식 릴리즈로 승격 |

U25a는 U01 다음에 시작한다. U25b만 U01-U24 전체를 기다린다. 전체 기능이 끝날 때까지 최초 설치본을 미루는 의존관계는 만들지 않는다. 순서를 바꾸더라도 원본 기능의 완료 조건은 지우지 않는다.

## 검증과 종료

각 단위는 기능 변경에 필요한 failing test, 단위 확인, 실제 화면/기기 시나리오, 성능 비교를 남긴다. 문서·출처·스타일 토큰 등 저위험 변경에 구현을 그대로 복제하는 테스트를 양산하지 않는다. pstack의 10 lanes는 구분된 시나리오 10개이며 10개 cloud worker를 의무 실행한다는 뜻이 아니다.

U01에서 동일 fixture·데이터 크기·장비·build type을 고정한다. 성능 기본 경고선은 p95 사용자 지연 15%, idle/peak 메모리 15%, 설치 크기 10% 증가다. noisy 측정은 baseline/current를 교차 실행해 확인한다. 초과하면 원인·기능 비용·대안을 기록하고 원래 요구를 보존하는지 판단한다. 새 기능은 비교 가능한 기존 동작과 자체 absolute budget을 사전에 적는다. 숫자는 목표·검토 문턱이며 현재 측정 결과가 아니다.

전체 회귀의 최소 묶음은 수동 생성, 프로젝트 개요/종류 구분, 문서 집중/복귀, 여러 문서 AI와 메인 병행, 원문 프롬프트 Ctrl+K, 읽기 전용 볼트 이동, 모델 갱신, 보관/삭제, 완료 알림, 별도 이음 설치/저장 복귀, Dropbox 우선, 기존 worktree·도구 진입이다. 원본 YAML의 key/형태/값과 읽기 전용 볼트 본문 bytes를 보존한다.

전체 완료에는 모든 원본 수용 ID와 형식별 검증, 설치/업데이트/데이터 보존, 같은 artifact의 hash/provenance, 실제 지원 OS와 모바일 evidence가 필요하다. 실패한 일반 chat이나 Office를 부분 기능 UI 뒤에 숨겨 완료 처리하지 않는다. 반대로 통과한 단위를 이유 없이 다시 열어 무기한 재검증하지 않는다. 관련 코드 변경·새 실패·미해결 위험이 있을 때만 재실행한다.

## 실행 운영과 기술 사용

Superpowers writing-plans는 구현자가 그대로 착수할 구체적 단계와 검증 책임을 맡고, pstack은 단일 목적 변경·의존 순서·리뷰·설치본 전달을 맡는다. 계획 단계의 설계 입력을 유지한다. 실행 요청에 따라 Superpowers의 구현·검토 절차와 pstack의 목적별 변경·검증·빌드 순서를 현재 host에서 적용한다.

최대 3개 작업 owner와 root로 제한하고 무거운 build/render/test는 Achmage workId/nativeSessionId의 자원 예약과 stable resource-run으로 실행한다. 외부 모델/Grok/10 cloud workers/주기적 loop는 자동 켜지 않는다. pstack autopilot-stack의 기본은 merge-ready 전달이며 자동 merge가 아니다. 현재 실행 요청 범위의 목적별 변경을 준비한 뒤 필요한 GitHub 빌드를 진행한다. 이미 주어진 실행 권한을 불필요하게 다시 묻지 않는다.

제품 구현을 시작한 뒤에는 완료/실행 중/미검증을 구분해 보고한다. 계획 checkbox, 리뷰 완료, 테스트 통과, 실제 설치본 검증, 공개 릴리즈를 서로 다른 상태로 기록한다. 사용자 계정이 필요한 연결은 준비된 구체적 설치/연동 화면까지 만든 뒤 실제 기기·계정 확인이 필요한 지점만 요청한다.

## 근거와 정확한 연구 revision

- Aside 원본 조사 [README](../../research/aside-agent-desktop-2026-11-04/README.md). 연구 revision research:rr-dd53e234a77f3fe9e4e3afc62aea3018:2807fc5a0c540680000deb85ab0ea25cb53a6ffa89a4c436c9317c7a19b08ea9.
- HIG 원본 설계 [README](../../design/hig-remake-2026-11-09/README.md). 연구 revision research:rr-da5ca50fa3e6593f1a243cce69cc5ed7:36aff60113a7574e1b41bb9ce53999de1ae9a325cde9fe73abf3304c122323f7.
- Paseo 원본 조사 [README](../../research/paseo-2026-11-09/README.md). 연구 revision research:rr-b3a4efd5af5ac21ca608ac4ce17dd71d:89fcdaee6e62df01c31f9f4c56c19d9916acab297f64b1b42cd5b67317e03ad5.
- [Superpowers 공식 소스](https://github.com/obra/superpowers/tree/22f0b463e7a5e579904dd6211a520321035526f7), 7.0.2, MIT, 236개 파일 hash 일치. OS adapter와 원본은 분리했다.
- [Paseo 공식 pinned source](https://github.com/getpaseo/paseo/tree/1fff127f45b11c1c9c573fbbd12791673004c912), Apache-2.0. 하위 의존성은 각 license를 따른다.
- [v0.3.3 공개 릴리즈](https://github.com/laguna821/Achmage-workbench-CLI/releases/tag/v0.3.3). 목표 버전은 2026-11-09 사용자 요청으로 0.4.0을 확정했고 최신 공개 태그는 같은 날 v0.3.3으로 확인했다.
- 통합 연구의 정확한 신규 revision과 검증 결과는 [provenance](../plans/support/integration-provenance.json)에 기록한다.

## 2026-11-09 실행 승인과 검색 우선순위

기본 Ctrl+K 검색에서는 일치한 각 세션의 사용자 프롬프트 원문과 AI 대화 로그를 문서 및 읽기 전용 볼트 본문 결과보다 먼저 표시한다. 관련도 비교와 그룹/페이지 제한 전에 이 제품 우선순위를 적용하고, 문서에 연결한 AI 답변도 대화 결과에서 사라지지 않게 한다. 명시한 문서/볼트 범위 검색은 유지한다. 목표 버전은 사용자 요청에 따라 0.4.0으로 확정했다. 이 긴급 변경을 먼저 검증한 뒤 기존 단계 순서를 따른다.

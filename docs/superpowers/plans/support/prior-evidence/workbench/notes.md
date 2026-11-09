# Workbench 현행 기능과 Paseo 도입 경계 — 읽기 조사

- 조사 상태: **PASS — 지정된 저장소의 읽기 조사 완료. 제품 기능 구현 완료나 설치본 검증 PASS를 뜻하지 않는다.**
- 관찰일: 2026-11-09, Asia/Seoul.
- 저장소: /home/achamge/다운로드/achmage-workbench
- branch: fix/urgent-usability-033
- HEAD: bc1057c2c5fb04f2046f4fd711bf718f5cc93737, package version 0.3.3
- workId: work-1b7f68199bcb4756b2a7fd2a102ccc2e
- nativeSessionId: 01a187dc-c850-7991-93c0-aa60b50f9a26
- 부모가 읽은 현재 context: context-2aad2c6ccd214b628f1722ab762adacc.
- 수행 범위: 소스와 현재 설계/릴리스 문서 읽기, 관련 키워드 검색, 이 증거 폴더에 메모와 SHA-256 manifest 작성.
- 하지 않은 검증: 앱 실행, 새 빌드, 테스트 실행, CLI/모델 호출, 실제 설치본/UI 검사, RSS/시작 지연 측정, 모바일 연결 실험, 설치/원격 쓰기. 과거 문서의 시험 결과는 과거 기록으로만 인용한다.
- 시작·마무리 읽기 시 보인 기존 untracked 자료: docs/research/, docs/design/hig-remake-2026-11-09/. 부모 작업으로 보존하고 수정하지 않았다.
- 정책과 관찰을 구분한다. 이번 계획의 Dropbox 우선 및 외부 독립 이음오피스 설치·연동 정책은 부모가 전달한 현재 사용자 맥락이다. 아래 소스·문서는 그에 부합하는 현재 구현 증거이며, 과거 반대 문장은 현재 실행 권한으로 취급하지 않는다.
- 파일별 읽기 시점의 해시는 inspected-files.sha256 및 inspected-files.json에 기록한다. 소스는 변경하지 않았다.

## Components Found

**핵심 판단:** Workbench에는 이미 Tauri 셸, Node HTTP/SSE 게이트웨이, 두 CLI 어댑터, 영속 세션/문서 상태, 독립 문서 AI, 이미지 첨부와 도구 그림 표시가 있다. Paseo를 참고할 가장 큰 결손은 기능 전체의 부재가 아니라 독립 서비스 수명, 원격 장치 접속 계약, 일반화된 하위 작업 관리, 긴 대화/다수 탭의 측정 기반 경량화다.

### Current / Reuse / Gap 기능 대응표

| # | 기능 | Current: 현행 코드 | Reuse: 유지·재사용 | Gap: 더 필요한 경험/계약 |
|---|---|---|---|---|
| 1 | 창 닫기와 계속 실행 | main 창 close를 hide로 바꾸고 트레이 유지. app Exit 또는 셸 stdin EOF는 게이트웨이와 엔진을 종료 | Tauri 창·트레이·단일 인스턴스, Node SessionManager | 앱 종료와 별도인 사용자 서비스 시작/중지·상태·자동 시작·재접속. 숨은 창을 독립 daemon이라고 부르면 안 됨 |
| 2 | 원격·다기기 접속 | hostId/hostLabel 메타데이터 및 같은 로컬 게이트웨이를 보는 다중 창. 서버 세 개 모두 127.0.0.1 | 현재 HTTP API, snapshot/SSE, native session ID와 workspace ID | 장치 등록/해제, 실행 호스트 선택, 안전한 접속 경로·주소 광고, 원격 capability. hostId만으로 원격 라우팅이 생기지 않음 |
| 3 | 인증·전송 | 시작 때 24-byte random shared bearer; API 헤더 인증, SSE만 query token. UI는 token을 sessionStorage로 옮겨 주소에서 제거 | 이미 있는 인증 검사와 문서별 토큰·writer lease | 기기별 자격·회수·scope, 원격 전송 보호, 재연결 인증. 현재 master token을 그대로 공유하는 설계로 확정하지 말 것 |
| 4 | 이벤트와 재접속 | 순번 SSE, heartbeat 20s, 5000개 메모리 replay, 초과 시 snapshot resync; 브라우저 재시도 1.5s | snapshot + delta + request idempotency | host 세대/epoch·재시작 커서, 긴 오프라인 후 복원, 대용량 snapshot/선택 구독, 장치 동시 응답 조정 |
| 5 | 제공자·모델·권한 | Claude Agent SDK + Codex app-server stdio JSON-RPC. 실제 엔진 모델 목록, 추론 강도, access 묻기/자동/전체, compact, fork/import | ProviderAdapter와 Session/Transcript 계약, CLI 탐색·로그인·모델 refresh | 새 provider를 넣을 때 capability 차이 표시. 현재 Provider union은 claude/codex 두 개. 모델을 하드코딩할 이유 없음 |
| 6 | 대화 읽기 | react-markdown+GFM, Mermaid 지연 렌더, 연속 tool/reasoning 접기, 요청별 rail/고정 요청, 읽던 위치·자동 스크롤 | Transcript의 의미 블록과 렌더러 | 더 가벼운 계층·일관된 작업 카드·코드/링크 동작, 긴 이력 pagination/windowing 여부를 측정 후 결정 |
| 7 | 이미지 입력·출력 | 붙여넣기/드롭 → 내용 해시 첨부 → 엔진 이미지 입력. 썸네일/확대. imageView/MCP 그림/명령이 만든 그림을 tool 아래 표시 | Attachments, tool-images, attachmentUrl의 인증 fetch→blob | assistant Markdown의 임의 로컬 이미지 경로 해석, 기기 독립 이미지 주소, 실패/만료/캐시 정책, 모바일 파일 선택. 현재 모든 이미지가 누락된 상태는 아님 |
| 8 | 세션 제어·승인 | 세션별 중지·끼어들기·대기열 편집/취소/즉시 전송, request ID 중복 방지, 승인 카드, 완료·오류 상태 | SendGate, Store requests, SessionManager, 현행 승인 API | 여러 기기에서 같은 요청/승인 경쟁, 더 일반적인 입력 요청 UI. Codex form/URL elicitation은 현재 거절 안내, requestUserInput류 지원은 없음 |
| 9 | 멀티에이전트 관리 | 다중 세션 및 문서별 독립 AI. 2~6 세션 round-robin 잇기. Claude Task/Agent는 접힌 tool 항목 | 세션 상태·links·handoff·문서 부모 보고 패턴 | 엔진 내부 하위 에이전트 tree/정체성/현재 작업·개별 열기/중지의 공통 모델. Codex collabAgentToolCall은 생성 타입에 있으나 transcript mapper는 처리하지 않음 |
| 10 | Office 병렬 작업 | documentAgent child 세션 재사용, 부모 메인과 독립 실행·완료 보고, 다음 메인 요청에 문서 현황 제공. hidden 탭은 mounted 유지 | 실제 문서 저장/판·writer 검증·turn journal·부모 report | 화면이 사라져도 job 지속하려면 UI presence와 task runtime/권한 분리. 현재 live writer 검증 실패/연결 종료는 Office run을 중단 |
| 11 | 프로젝트·작업공간·Git | 프로젝트, 고정 workspace cwd, worktree 생성/연결/비교/적용/폐기, terminal, 환경 준비, Git/GitHub 기능 경계 존재 | 기존 IDs·폴더 경계·원본 보존·충돌/복구 경로 | 경량 화면에도 기능 진입점 유지. remote cwd는 실행 호스트 소유로 명시; 동일한 Dropbox 상대 경로를 같은 live workspace라고 가정하지 않음 |
| 12 | 검색·맥락·보관 | Fast Find 단일 Rust worker, prompt/reply/doc/vault 검색 및 정확 item/line target. 프로젝트 note, 읽기 전용 vault, Achmage work-brief. 보관·프로젝트 삭제 별도 | 검색 엔진·source identity·문서/프로젝트 context. 파일과 DB 경계 | 작업/호스트/자식 에이전트까지 검색 범위 확장 시 기존 source 계약에 연결. 별도 중복 chat DB 불필요 |
| 13 | 알림 | 메인 UI가 완료 event를 처리; foreground toast, Tauri OS 알림, 승인/오류, 트레이 attention 수. detached 중복 알림 억제 | 완료 ID 중복 방지·세션 열기 동작 | UI가 없어도 서비스에서 알림·미확인 상태 보관; 모바일 push/장치별 읽음. 현재 OS 알림이 모바일 push는 아님 |
| 14 | 경량화 | Tauri/system WebView, DocumentView/Reader/TerminalView lazy, Mermaid lazy, 엔진 10분 idle 정리, 단일 검색 worker | 현행 lazy·idle·공유 worker | transcript는 전체 turns.map, 모든 기동 탭은 hidden 유지, attachment blob cache 제한 없음. 실측으로 최적화 순서 결정; 탭 unmount로 Office job을 끊으면 회귀 |
| 15 | 모바일 사용성 | 좁은 창에서 sidebar overlay·검색 preview 숨김·분할 축소, 터치 스크롤 감지 | 웹 UI와 소형 창 CSS 일부 | 연결 온보딩, 작은 화면 navigation/composer/approval, 키보드/파일/이미지, background suspend/reconnect, 실제 iOS/Android 브라우저 검증. Tauri mobile entry annotation은 제품 모바일 지원 증거가 아님 |
| 16 | Dropbox·외부 이음 | 로컬 Dropbox 폴더 연결·같은 파일 열기·외부 변경 감시·충돌 보존. 독립 공식 Ieum 자동 준비/등록/열기; 내장 편집 엔진은 별개 | 현재 문서·artifact·외부 저장 재인식 흐름 | 원격 클라이언트는 실행 호스트 파일을 다룬다는 계약 필요. Dropbox sync는 앱 관할; live SQLite/인증 동기화 수단으로 사용하지 않음 |

### 주요 구성 요소

- apps/desktop/src-tauri/src/lib.rs: Node 자식 게이트웨이를 시작하고 ready URL/token을 받아 WebView 생성. 창·트레이·OS 알림·별도 세션 창과 종료를 소유한다.
- apps/host/src/main.ts, http.ts, sessions.ts, store.ts, bus.ts: 로컬 transport, 세션 orchestration, 영속 항목/request journal, transient 이벤트를 소유한다.
- apps/host/src/providers/{codex,claude}.ts 및 packages/provider-*: CLI 실행과 protocol→Transcript 변환. 제공자 내부 세션을 Workbench session/nativeSessionId에 매핑한다.
- apps/web/src/App.tsx, state.ts, api.ts: snapshot 및 events를 state reducer에 반영하는 UI. tabs/panes는 문서와 채팅의 표시 상태를 보존한다.
- apps/host/src/office-sessions.ts + document-registry.ts + apps/web/src/document-session.ts: 문서 독립 실행, UI owner·writer 권한, 기록 순서·중복·중지·부모 결과 전달.
- apps/host/src/search-service.ts 및 search.ts: 게이트웨이당 단일 native worker. 검색 범위 판단과 source identity는 host에 남는다.
- apps/host/src/achmage.ts: 현재 Achmage 런타임 연동은 프로젝트 note의 achmage_work로 읽기 전용 work-brief를 얻는 경로. 라이브 원격 세션 attach 프로토콜과 다르다.

## Flow

### 데스크톱 시작과 종료

1. Tauri setup → gateway_command → Node child spawn.
2. WORKBENCH_READY 줄로 loopback URL과 token 수신 → main WebView 생성.
3. API snapshot → SSE subscribe → 각 세션의 항목을 필요할 때 읽고 delta 반영.
4. main 창 X → prevent_close + hide → Tauri·Node·엔진 유지.
5. 트레이 끝내기/app Exit → stop_gateway가 stdin을 닫음 → Node stop() → SessionManager/Office/provider/terminal/search 종료. 3초 후에도 child가 남으면 Tauri가 kill.
6. 셸 crash로 stdin이 닫혀도 WORKBENCH_EXIT_ON_STDIN_CLOSE=1에 의해 Node가 종료하도록 설계됨.
7. 별도 수동 Node 시작은 가능하고 README에 개발용 예가 있지만, 이것은 OS별 서비스 관리·attach/reconnect·모바일 접속을 제공하는 제품 daemon이 아니다.

### 일반 채팅 및 이미지

1. 파일 paste/drop → upload POST /api/attachments → SHA-256 ID 및 content sniff → local attachments 폴더.
2. send(requestId, sessionId, text, refs, attachments, mode) → SendGate → durable request receipt → provider.send/steer/queue.
3. Codex app-server 또는 Claude SDK → mapper/sink → Store item + EventBus event.
4. 도구 이미지: imageView/MCP result/최근 생성된 로컬 이미지 경로 → keepImage → Attachment metadata → tool item.images.
5. UI는 bearer fetch로 blob URL을 만든 뒤 이미지 썸네일·확대에 사용.
6. 일반 assistant Markdown은 별도의 로컬 이미지 resolver 없이 react-markdown+diagramComponents를 사용한다. 첨부 ID로 등록한 그림 표시와 임의 file/absolute path 문자열을 표시하는 것은 다른 경로다.

### 문서별 AI와 부모 세션

1. 문서 artifact와 workspace에 맞는 documentSession을 재사용/생성; 부모 세션을 활성화하거나 중단하지 않음.
2. 탭의 viewId/windowId + writer token을 등록하고 10초마다 heartbeat; registry TTL은 60초.
3. 문서 AI 요청은 scope, live writer, saved revision, disk state, request identity를 확인한 후 시작.
4. ordered Office events는 Workbench transcript에 저장. 일반 chat 1개, long job, 최대 2개 PDF reading helper가 공존하도록 제한.
5. 완료/중단/실패 → child turnEnd → parent notice(문서명, 경로, 판, 답변 일부).
6. 부모의 다음 일반 CLI turn은 nativeContext()로 새 문서 기록·자식 현황을 받으며, 자료이지 새 지시가 아님을 표시.
7. 단순 탭 전환은 hidden mount 유지로 계속 실행. 그러나 실제 pagehide/unmount, lease 만료, session/권한 변경, response disconnect는 중단 경로다. UI 없이 모든 Office job이 계속 실행된다고 결론 내릴 수 없다.

## Files Read / 중요한 줄번호

파일 전체의 해시는 manifest에서 확인한다. 아래는 주요 결론을 직접 뒷받침하는 읽은 구간이다.

| 파일 | 중요한 줄 | 근거 |
|---|---|---|
| apps/desktop/src-tauri/src/lib.rs | 144–225, 265–280, 298–315, 376–388, 435–445, 457–464, 504 | 게이트웨이 spawn, stdin coupling, loopback UI, 트레이, hide vs exit, 자식 종료 |
| apps/host/src/main.ts | 41–49, 124–155, 184–224, 228–255 | shared token, providers, 3 loopback origins, scheduler, stdin/SIG shutdown |
| apps/host/src/http.ts | 196–217, 262–271, 378–379, 588–660, 703–711, 872–881 | SSE replay/heartbeat, API 인증, 채팅·큐·승인·첨부·editor API |
| apps/host/src/bus.ts | 8–49 | seq=0, memory buffer capacity=5000, replay 범위와 resync 조건 |
| apps/web/src/api.ts | 100–109, 137–147, 526–555, 559–572 | sessionStorage token, bearer fetch, SSE retry, attachment blob cache |
| apps/host/src/store.ts | 9–10, 23–71, 403–407, 480–498 | local SQLite WAL, request receipts, 전체 세션 item query |
| apps/host/src/sessions.ts | 512–544, 632–661, 719–728, 1083–1100, 1148–1163, 2205–2222 | persist/publish, restart interruption+held queue, snapshot, 파일 보존 삭제, child session, shutdown |
| apps/host/src/send-gate.ts | 4–25 | 세션별 준비 직렬화와 같은 request ID 중복 방지 |
| packages/contracts/src/index.ts | 22, 70–138, 331–391, 554–573 | provider 두 개, session/documentAgent/hostId, transcript/approval/snapshot 구조 |
| apps/host/src/providers/types.ts | 65–113 | provider 공통 lifecycle, steer/compact/fork/import/approval capabilities |
| packages/provider-codex/src/rpc.ts | 50–80, 111–112 | app-server stdio spawn, process exit 처리, SIGTERM |
| apps/host/src/providers/codex.ts | 61–65, 128–148, 205–225, 484–550, 707–713, 779–825, 900–928 | 권한, models pagination, idle, resume, 지원 approval/미지원 input, mapping |
| apps/host/src/providers/claude.ts | 205, 579–605, 785–796, 1007–1015 | SDK 실행, native resume, idle/shutdown |
| packages/provider-codex/src/map.ts | 28–110 | 현재 매핑 종류, collab 없음, unknown null |
| packages/provider-codex/src/generated/v2/ThreadItem.ts | 88–104 | collabAgentToolCall 타입은 생성되어 있음 |
| packages/provider-claude/src/map.ts | 84–90, 174–188, 239–242, 284–287 | Task/Agent tool, peer 메시지, subagent stream 제외 |
| apps/host/src/office-sessions.ts | 43–64, 75–117, 128–154, 166–195, 213–235 | Workbench 권위 기록, lease/run identity, sequence, 부모 report, context, disconnect |
| apps/host/src/document-registry.ts | 7, 18–20, 45–68, 82–92 | TTL 60초, 물리 파일당 writer 하나, ownership 검증 |
| apps/web/src/document-session.ts | 5–18, 28–58, 61–65 | fresh window ID, heartbeat 10초, pagehide/unmount close |
| apps/web/src/components/Panes.tsx | 33–42, 105–135 | 본 탭을 mounted set에 추가, inactive hidden 유지, 좁은 칸 축소 |
| apps/web/src/components/Transcript.tsx | 36–92, 105–149, 202–215, 352–398, 607–608, 661–675 | Markdown, tool 접기/이미지, scroll 측정, 전체 turn render |
| apps/web/src/components/Diagram.tsx | 18–29, 47–60 | Mermaid lazy import와 streaming 때 code 유지 |
| apps/web/src/components/Attachments.tsx | 35–85, 109–164 | paste/drop 처리, preview 정리, thumbnail/lightbox |
| apps/host/src/attachments.ts | 7–10, 23–34, 44–79 | content-addressed storage, 25MiB, sniff, ID path validation |
| apps/host/src/tool-images.ts | 12–15, 25–50, 57–60 | 미리보기 10MiB/단계당 6개, 새로 바뀐 로컬 파일, 저장 |
| apps/web/src/App.tsx | 76–78, 390–433, 975–1027, 1946–1988 | lazy views, snapshot/event, UI 소유 알림·attention, document rendering |
| apps/web/src/state.ts | 181–192 | 로드된 transcript만 item event를 적용하되 전역 reducer로 처리 |
| apps/web/src/windows.ts | 1–4, 21–35 | 같은 gateway의 별도 session window |
| apps/host/src/binaries.ts | 25–30, 121–166 | CLI override 보존, Codex 최신 후보, Claude 후보 정책 |
| apps/host/src/engine-env.ts | 7–30, 44–63 | 엔진 billing env 정리·launch PATH; 로컬 계정 실행 경계 |
| apps/host/src/workspaces.ts | 16–26, 68–88 | 메타데이터 migration, current host 강제, local absolute cwd |
| apps/host/src/worktree-workspaces.ts | 33–39, 76–100, 118–160 | repository inspect, worktree 연결·생성·shutdown |
| apps/host/src/terminals.ts | 25, 42–80, 134–147 | terminal 재시작은 interrupted, owned child만 종료 |
| apps/host/src/links.ts | 30–35, 301–310, 334–349, 609–616 | 순차 세션 잇기와 restart pause, approval 대기 때 clock pause |
| apps/host/src/schedules.ts | 5–7, 94–117 | 앱 기동 중 tick, 놓친 예약 1회, dispatch 전 schedule advance |
| apps/host/src/search-service.ts | 3–4, 55–70 | host당 single worker, native binary 사용 |
| apps/host/src/search.ts | 33–70, 134–142, 399–424 | host scope, archive filters, exact session/item/artifact/line 결과 |
| apps/host/src/pkm.ts | 175–200 | 새 engine context card와 vault write guard |
| apps/host/src/project.ts | 87–88, 171–189, 300–344 | achmage_work, context hooks, 실제 project note와 판 |
| apps/host/src/achmage.ts | 7–9, 48–73 | read-only work-brief, 10분 cache, live remote transport 아님 |
| apps/host/src/dropbox.ts | 57–78, 89–121 | local Dropbox scope, live DB 제외, 같은 파일/변경 감시 |
| apps/host/src/ieum-desktop.ts | 44–74, 117–137, 180–194 | standalone 공식 app 자동 준비, 선택 경로 보존, 별도 process |
| scripts/install-linux.sh | 3–8, 32–38 | systemd user scope로 앱/엔진 자원 격리; persistent service unit 아님 |
| docs/releases/v0.3.3.md | 3–16 | 현행 모델·병렬 Office·알림·삭제 기록; 과거 11/11 결과의 범위 |
| docs/design/hig-remake-2026-11-09/design-brief.md | 7, 21, 23–35, 72–75 | 기존 HIG는 데스크톱 범위, 기능 유지, Dropbox/Ieum, 측정 경계 |
| docs/design/hig-remake-2026-11-09/implementation-plan.md | 3, 9–17, 23–41 | 설계 단계, shell 표시층 재구성, iframe/AI 수명과 기존 계약 보존 |
| docs/research/aside-agent-desktop-2026-11-04/04-workbench-design.md | 3, 82–99, 136–173 | 아직 설계인 browser/page/task 계약과 기존 재사용 경계 |
| docs/office-integration.md | 21–29, 117–133, 135–157, 187–191 | Dropbox 현행 및 Drive 먼 후속, Office 기록의 역사/현재 구분 |

## Boundaries

1. **Gateway ≠ 독립 daemon.** 현재 main 창을 숨기면 계속 실행하는 것은 맞다. Tauri app가 없어진 뒤 Node가 살아남도록 만든 서비스는 아니다. Linux systemd-run --scope도 이 수명을 바꾸지 않는다. 서비스화에서는 기존 실행을 강제로 채택하거나 PID로 일괄 종료하지 않고 새 소유권·정상 종료·attach 계약을 정해야 한다.
2. **다중 창 ≠ 다기기 연결.** 동일 토큰/같은 loopback origin의 여러 WebView는 이미 된다. 세 loopback origin(메인·편집기·설정), Tauri native command, OS file picker/알림/키링은 원격에서 그대로 작동하지 않는다. 포트 하나만 바인딩 변경하는 것으로 문서 편집까지 완료되지 않는다.
3. **Tab hidden ≠ browser disconnected.** 0.3.3의 병렬 문서 작업은 안정된 tab ID와 mounted iframe 덕분이다. 화면 분리/종료/모바일 suspend까지 지속해야 한다면 Office의 view writer lease와 실행 권한을 따로 정의해야 한다.
4. **여러 세션 ≠ 엔진 내부 agent tree.** documentAgent, handoff, SessionLinks는 유용한 재료지만 Codex/Claude subagent를 현재 공통 목록으로 관리한다는 근거는 없다. generated protocol type 존재와 실제 mapper/adapter/UI 지원을 구분한다.
5. **본문 이미지 ≠ 임의 로컬 파일 렌더링.** 기존 첨부/도구 이미지 흐름을 우선 재사용한다. AI 텍스트에 있는 절대 경로를 클라이언트 임의 읽기 권한으로 바꾸지 않고 host에서 workspace/실제 경로를 검증해 opaque media reference로 해석하는 경계가 필요하다.
6. **Durable transcript ≠ durable event log.** SQLite 상태·request receipt는 영속적이지만 SSE seq/buffer는 프로세스 메모리다. 재시작 시 같은 seq 의미를 가정하지 않고 generation-aware snapshot reset을 검증해야 한다.
7. **기능 수 ≠ 경량성 실측.** Tauri/lazy/idle 정리 등의 선택은 확인했지만 RSS·시작 시간·CPU·token stream input latency는 측정하지 않았다. 전체 transcript render와 계속 mounted 탭은 후보 병목이며, 실제 성능 결함으로 단정하지 않는다.
8. **Dropbox 자료 sync ≠ live session sync.** 프로젝트 파일은 Dropbox를 사용할 수 있다. SQLite WAL·credentials는 로컬이며 Dropbox 연결 코드는 데이터 폴더 겹침을 거절한다. 원격 UI는 한 execution host의 상태를 제어하는 모델부터 설계하는 편이 현재 구조와 맞는다.
9. **계획 문서 ≠ 현재 기능.** HIG 전면 개편·Aside 공유 웹은 명시적으로 설계 상태다. 기존 문서 독립 AI와 새 일반 웹 child-task coordinator를 중복 구현하거나 완료 상태를 혼합하지 않는다.
10. **과거 검증 기록 ≠ 이번 검증.** v0.3.3 문서의 11/11은 실제 web/host/Office를 사용한 당시 통합 검사이며 모델은 시험 서버였다고 명시한다. 이번 조사는 이를 재실행하지 않았고 현재 설치본과 일치 여부를 확인하지 않았다.

## Non-Obvious Things

- 셸이 꺼져도 백엔드는 살아있다는 일반적인 인상과 달리, 소스는 stdin EOF로 의도적으로 정리한다. 반대로 창 X는 실제 종료가 아니라 hide이므로 현재도 “창 닫고 계속”은 있다.
- Office에는 일반 채팅 외 PDF long job/reading helper concurrency가 존재한다. 이 동작을 새 일괄 단일 실행 락으로 후퇴시키면 안 된다.
- 부모에게 전달되는 문서 결과는 현재 최대 6000자 notice이며, 전체 자식 task graph를 실시간 부모 모델 입력으로 주입하지 않는다. 다음 CLI 요청의 nativeContext 경로도 존재한다.
- Codex 최신 collab 타입이 생성 파일에 있어도 mapThreadItem default=null이라 표시되지 않는다. 원본 protocol 업데이트만으로 멀티에이전트 UI가 완성되지 않는다.
- Claude mapper는 subagent stream/assistant를 메인 응답에 합치지 않는다. 이것을 단순 누락 버그로 바꿔 전부 합치면 화자와 작업 소유권을 잃을 수 있다. 독립 자식 view로 모델링하는 편이 적합하다.
- 알림은 현재 UI event listener가 구동한다. 독립 headless service만 실행했을 때 같은 알림이 발생한다는 증거가 없으며 서비스 notification producer가 별도 필요하다.
- 이벤트 replay가 오래된 since를 resync하는 기능은 이미 있지만, 메모리 seq가 재시작 때 0으로 돌아간다. 현재 replay(since>=seq)는 빈 배열을 반환하고 client는 event.seq<=lastSeq를 무시한다. 재시작/토큰 회전과 함께 끊긴 client가 복구되는지는 새 실험 대상으로 남겨야 한다(재현 미실시).
- 현재 transcript 전체 items query/turns.map, 각 렌더 뒤 rail 측정, 각 delta의 전역 reducer 반영은 경량화 우선 측정 지점이다. 반면 세션 transcript는 필요할 때 로드하고 아직 로드하지 않은 세션의 delta는 보관하지 않아 불필요한 모든 이력 UI 로딩을 피한다.
- attachmentUrl은 immutable 첨부를 한 번 fetch해 blob URL을 Map에 유지하며 이 함수에는 revoke/eviction이 없다. pending upload preview에는 revoke가 있다. 서로 다른 캐시 수명을 혼동하지 말 것.
- 엔진은 기본 10분 idle 뒤 정리되고 다음 요청에서 같은 native session/thread를 resume한다. 세션 개수와 항상 살아 있는 엔진 process 개수를 동일시하면 안 된다.
- 예약은 앱이 꺼진 사이 매번 실행되는 OS 예약이 아니다. 다시 열었을 때 놓친 시각을 1회 처리한다. 지속 서비스 도입 시 사용자에게 바뀐 예약 의미를 명시할 필요가 있다.
- 외부 Ieum은 자체 별도 설치·detached process이고 내장 Office renderer는 여전히 Workbench UI의 iframe이다. 외부 앱까지 새 셸로 통합하거나 제거하는 것은 이번 요청의 전제 조건이 아니다.
- 소스의 Tauri mobile_entry_point annotation, 반응형 CSS, hostId는 각각 scaffold/작은 창/메타데이터 근거일 뿐 모바일 제품·원격 daemon 지원의 증거가 아니다.

## Open Questions

아래는 사용자에게 작업을 중단하고 확인받아야 하는 질문 목록이 아니라, 부모 계획에서 독립 조사/실증 항목으로 다룰 질문이다.

1. UI 없는 일반 chat service와 UI 없이 계속되는 Office job을 같은 단계로 제공할 것인가? 첫 실증은 일반 chat에서 시작하고 Office renderer/lease 작업은 명시적으로 분리할 수 있다.
2. 첫 원격 client가 동일 LAN/사용자 관리 tunnel인지, 제품 pairing/relay까지 포함하는지? 두 방식의 인증·주소·운영 범위가 다르며 현재 코드만으로 결정되지 않는다.
3. 실행 호스트 하나에 여러 client가 붙는 단계와 여러 실행 호스트를 통합하는 단계는 어떻게 나눌 것인가? current hostId/cwd guard를 유지하는 계약이 필요하다.
4. Codex collab와 Claude task/subagent의 실제 event 범위·개별 interrupt/resume capability는 어떤가? adapters는 관찰·열기·중지를 구분해 지원하는 것만 표시해야 한다.
5. form/URL elicitation·질문 응답을 원격 UI에 제공할 범위는 무엇인가? 현행 approval boolean과 별도 구조가 필요하다.
6. 긴 대화·다수 문서·다수 agent 대표 fixture에서 startup/RSS/CPU/입력 지연·delta 비용·첨부 blob memory는 어떠한가? 실제 측정 없이 Paseo보다 가볍다고 주장하지 않는다.
7. host restart 및 token rotation 중 떠 있는 client가 generation-aware snapshot으로 정상 복구되는가? same-process network reconnect와 별도로 확인한다.
8. 모바일 백그라운드 중단 뒤 새로고침/재연결 시 중복 요청·중복 승인·이미지 만료·읽던 위치를 어떻게 복원할 것인가?
9. UI lease가 사라진 문서 AI의 수정 권한은 누가 가지며, 사용자가 다시 파일을 열 때 충돌을 어떻게 처리할 것인가? persisted job과 편집기 미저장 상태를 구분해야 한다.
10. 현재 설치본이 이 HEAD 및 v0.3.3 문서와 일치하는가? 최종 검증은 OS별 실제 설치본에서 따로 해야 한다.

### 부모 계획에 권장하는 좁은 실증 순서

1. 현재 셸·문서·검색·이음 경계를 유지하며 작업 목록/대화·그림 표현 개선을 HIG W2 표시층과 합친다.
2. existing Node host에 서비스 start/status/stop/attach와 generation-aware transport를 붙이는 별도 실증. “숨김”, “UI 종료”, “서비스 중지”, “호스트 재시작”을 다른 인수 시나리오로 둔다.
3. 일반 chat에서 desktop+mobile 동시 접속, request/approval 중복 방지, 끊김 후 restore를 입증한다.
4. native subagent mapping + 공통 task identity/parent relation을 추가하되 기존 Session/Office 기록을 새 DB로 복제하지 않는다.
5. Office의 UI presence/실행 권한 분리를 먼저 검증한 뒤 UI 없는 지속 실행을 주장한다. Aside의 page/task coordinator와 공통 부분만 추출한다.
6. 위 기능과 함께 대표 작업에서 성능을 측정하고, 가시성 변경이 job 취소로 이어지지 않는 선에서 pagination·selective render/cache 정책을 조정한다.

조사 중 새 제품 실패를 실행으로 확인한 것은 없다. 로컬 경로 탐색에서 없는 관례 디렉터리/파일을 찾은 경우는 저장소 구조 확인 후 실제 apps/host·apps/web·apps/desktop 경로로 좁혔다. 같은 실패한 제품 실험을 반복한 것은 아니다.


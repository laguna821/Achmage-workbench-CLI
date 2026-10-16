# 진행 기록

기준: [PRD v1.0](PRD-v1.0.md) · 시안 [assets/ui](../assets/ui) · 2026-10-16 · Linux 노트북(CachyOS, niri, Wayland)

## 단계 A — 설치형 기반과 실제 엔진 연결

### 구현됨

| 항목 | 내용 |
|---|---|
| 설치형 앱 | Tauri 2 셸이 게이트웨이(Node)를 자식 프로세스로 띄우고 창을 연다. 종료 시 게이트웨이도 정리. 단일 실행. |
| 게이트웨이 | HTTP 명령 + SSE 이벤트(재연결 시 `since` 재생, 범위 밖이면 스냅샷 재요청). SQLite(`~/.local/share/achmage-workbench/state.sqlite`)에 작업·폴더·세션·대화·requestId. |
| Codex | 공식 `codex app-server`(PATH와 ChatGPT 번들 중 최신). 스레드 시작·재개, 턴, 중단, 승인(명령·파일·권한), 계획, 사용량. 쉬면 엔진을 내리고 다음 요청 때 같은 스레드로 재개. |
| Claude | 공식 Claude Agent SDK + 설치된 `claude`. 스트리밍 입력, `canUseTool` 승인, 중단, `resume`, TodoWrite 계획, `rate_limit_event` 사용량. 쉬면 프로세스를 닫고 다음 요청 때 재개. |
| 기본 화면(시안 01) | 상단: Achmage · 작업 ▾ · 새 작업 · 작업 제목(눌러서 이름 바꾸기) · 확인 N · ⋯(연결·로그인·사용량). 분류 경로 · 상태 한 줄(상태·엔진·실행 위치) · 세션 탭(두 개 이상일 때, 두 번 눌러 이름 바꾸기) · 대화 한 열 · 입력창 하나(엔진·세션 선택) · 다른 작업 진행 수. |
| 대화 표시 | 도구 호출·생각을 한 줄로 접기, 승인 카드(Enter 허용 / Esc 거절), 계획 카드, 중단 표시. Markdown 렌더. |
| 새 작업 | 첫 화면에서 엔진(Claude/Codex)·폴더(없이 시작 / 선택 / 최근)를 고르고 바로 보내기. 폴더 없이 시작하면 앱 전용 폴더 생성. |
| 작업 찾기(시안 04) | 검색, 최근/폴더 탭, 중첩 폴더 생성·접기, 폴더별 새 작업, 확인 필요 바로가기. 분류 이동은 앱 안 분류만 바꾸고 실제 파일은 그대로. |
| 입력 | 한글 조합 중 Enter 오발송 방지, 작업·세션별 초안 보존. |
| 로그인 | Codex: app-server `account/login/start` → 브라우저. Claude: `claude auth login --claudeai`. 상태는 공식 명령 값만 표시, 모르면 "확인 불가". |

### 실제 검증됨 (모의 응답 없음)

- `scripts/smoke-real.ts`로 **설치본과 같은 묶음 게이트웨이**(`host.mjs`)를 대상으로 두 엔진 각각 **12/12 통과**.
  - 검증 항목: 응답 · 승인 → 파일 생성 · 거절 → 미실행 · 중단 → "중단됨" · 유휴로 엔진을 내린 뒤 같은 세션 재개 · 앱 재시작 뒤 같은 세션 재개.
- `scripts/ui-shots.ts`로 실제 화면(Chromium)을 따라감: 새 작업 → Claude 응답 → Codex 세션 추가 → 승인 카드 → 허용 → 결과 → 작업 찾기·폴더 생성.
- 설치된 앱(시스템 WebKitGTK 2.52)이 niri/Wayland에서 뜨고, 화면이 오류 없이 시작(`client.log`), 종료 시 게이트웨이 정리.
- 단위 테스트 17개(`npm test`): 두 엔진 변환기, 요청 중복 방지, 응답 중 중복 전송 거절, 재시작 복구, 이벤트 재생 범위, 한글 조합 Enter, 대화 묶기.

### 측정 (Linux, 유휴, 앱 스코프 전체 PSS)

| 구성 | 시스템 WebKit 설치본 | AppImage |
|---|---|---|
| Tauri 셸 | 108 MB | 109 MB |
| WebKit 화면 + 네트워크 | 140 + 33 MB | 139 + 34 MB |
| AppImage 런타임 | — | 22 MB |
| 게이트웨이(Node) | 83 MB | 85 MB |
| **합계** | **363 MB** | **388 MB** |

- PRD 목표 "유휴 UI + 게이트웨이 300 MB 이하"를 **약 60 MB 넘는다**. 대부분 WebKitGTK 기본 비용. 엔진은 쓸 때만 추가(Codex app-server 약 234 MB, Claude 세션당 약 250–340 MB).
- 엔진 유휴 종료 전에는 Codex app-server가 상주해 593 MB였다.
- 설치 크기: 실행 파일 + 게이트웨이 1.3 MB + 화면 0.4 MB (시스템 WebKit·Node·각 CLI 별도). AppImage 106 MB(WebKit 포함). 화면 첫 전송 gzip 127 KB.
- 비교 기준(같은 노트북, 2026-10-16 RSS): Orca 셸 약 1.03 GB.

### 미검증 · 제한

- **Windows**: 빌드·실행 미검증(NSIS 미작성). Linux 결과로 대신하지 않는다.
- **로그아웃 상태에서 로그인 완료**: 로그인 시작 경로만 구현. 실제 로그인 완료는 확인하지 못함(두 계정 모두 로그인된 상태).
- **창 닫기 = 앱 종료**: PRD의 "트레이로 이동, 작업 유지"는 미구현. 닫으면 진행 중 응답이 멈추고 다음 실행에서 "멈춤"으로 표시된다.
- **Node 24+ 필요**: 게이트웨이를 시스템 Node로 실행한다(번들하지 않음).
- 이 노트북 설치는 시스템 WebKit 실행 파일. 배포용 AppImage는 별도로 빌드된다.
- 모델 선택 메뉴 없음(엔진 기본 모델). 세션별 승인 방식 선택 없음(Claude: 매번 묻기, Codex: on-request + workspace-write).
- Claude 세션은 사용자 설정(`~/.claude`)을 읽으므로 Achmage 훅도 함께 실행된다.

## 다음

- **단계 B (문서)**: 대화 안 파일 카드 → 중앙 편집(Markdown CodeMirror, HWPX HOP/RHWP, PDF, HTML 미리보기), artifact revision 계약, "다른 세션에" 보내기(시안 02·03).
- **단계 C (일상 사용)**: 트레이 유지, 진행 보기·재개(시안 05), Achmage 근거 연결, 폴더 이동·이름 바꾸기 마감, Windows 빌드.

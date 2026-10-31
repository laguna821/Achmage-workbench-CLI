# Orca·이음오피스 기능 대조표

2026-10-31 I18 최신 갱신: 원본 디자인12종의 표지24개·번들 글꼴10종·선택 기억/추가 요청·스타일 판 보존·원본 생성과 같은 세션의 재시작/재사용을 Linux **19/19**, 인접 **40/40**으로 확인했다. [범위와 남은 인수](../office-integration.md#ppt-디자인-갤러리저장-스타일), 검증 판 `research:rr-97a130d83927682d768c9f16a54c4442:72d3c0ae57af32b8a711f88a234090be6f5ded287a3c6e4b04f8cb85d287b2a9`. 이전 단계의 I18 차단 설명은 이 갱신으로 대체하며 전체 Office/OS 릴리스 목표를 유지한다.

2026-10-31 최신 갱신: K04의 새 디자인·사람 편집·같은 대화 수정안·복구·작업공간/독립 자산 사본·PNG/PDF 확정 출력·권한 재획득을 실제 Linux 앱 **23/23**, 관련 검사 **24/24**로 확인했다. 전체 메뉴·영상 출력·다른 OS 인수는 남는다. [doory 범위와 증거](doory-연동-조사.md#정식-문서-흐름-2026-10-31); 검증 판 `research:rr-d1c95d98944421a7b93c5d23e80ab6db:cde914ab22bc9325008622d6004c54abda3947a977128de58715d6e9b9e04628`.

I17은 `91cc3d0`에서 현재 문서 양식 미리보기·가림·원본/사본 저장·취소까지 연결했다. 아래 이전 단계의 “현재 문서 미리보기 후속”은 이 갱신으로 대체하며, 전체 관리/OS 동등성은 별도다. 검증 판 `research:rr-18a5ff82e57e7a606474396cc29836cb:d780fedcdaebd92d3b36c60eef75365bd9cee706e2f68f06ea9fcfa499203dbb`.

2026-10-31 I16 카드 단계: 원본9종 제안 카드의 명시 저장·본문 편집·자동 호출·대화 복원을 연결했다. 설치 원본 보존·프로젝트 사본 선택/복귀·CAS/백업·중복/중단을 검사했다. 관련72/72, 최종 PPT+스킬/양식22/22. I17 현재문서 미리보기·I18 디자인 갤러리와 전체 Office는 미완료다. [세부 범위](../office-integration.md#원본-스킬-제안-카드-저장); 검증 판 `research:rr-18a5ff82e57e7a606474396cc29836cb:89d5ab9641ae37160346062e1896b5e9f8b45f7db362e99195d1bbbb0be3cbe1`.


2026-10-31 G2/G4 스킬 갱신: I16/I17의 원본9종 다중 선택·읽기·이력/판 보존·양식 사본의 같은 대화 인계는 Linux86/86 및 인접84/84로 검증했다. 기존 Workbench 보관함과 생성 기록을 재사용한다. 제안 카드 저장·현재 문서 양식 미리보기와 I18 디자인 갤러리는 여전히 부분이며 전체 행의 완료 기준을 유지한다. [상세 범위](../office-integration.md), 검증 판 `research:rr-23b6877f1f5f065e3f98bd3a61ee42a4:b55ba6f1df5fb74aeef5bf9d69cae5a628ffaf0fac302c488c9168d0f6876646`.

2026-10-30 G4 갱신: M01/M03/W01의 원본 Markdown·HTML renderer, 저장·보기 전환·충돌·복구를 연결했다. Linux 실제 앱25/25, 인접22/22 통과. 이미지·내보내기·내부 AI 등은 여전히 부분이며 여섯 화면을 전 기능 완료로 세지 않는다. 현재 우선순위는 Office 전체와 Electron 실행 경로 대체다. [구현·검증·잔여 범위](../office-integration.md), 연구 판 `research:rr-b5508ffc0997569185acfe1f63b30318:a54a11aca8b345099bdeeda5f61bbd477196973d83281b699e399f4af03f9b7c`.

후속 갱신: Markdown·HTML의 로컬 그림 삽입/읽기·소유 자산과 HTML 상대 경로 CSS/일반 스크립트를 연결했다. Linux 실제 앱30/30, host/경로 검사13/13 통과. 클라우드 이미지·출력·AI 등은 계속 부분이며 아래 전체 기능 완료 기준은 유지한다. 연구 판 `research:rr-8304c87c1ea63f23530f55605bd002f7:68995e88a4c2037d47eb31d190bb3d8612c78e80473a9636b9eeb7ef2bdb7b9b`.

2026-10-29 · [통합 계획](업데이트-통합계획-2026-10-29.md)의 범위·근거·검증 목록

## 읽는 법

이 표는 **현재 소스에서 확인한 기능 묶음과 누락, 구현 후 통과해야 할 동작**을 기록한다. 기능 수나 완료율 표가 아니다. 한 행에는 여러 명령과 조건이 포함된다. 같은 화면이 있다는 사실만으로 원본 기능을 전부 이식했다고 세지 않는다.

- **있음**: 해당 구현 경로를 확인했다. 이번 조사에서 설치본으로 실행했다는 뜻은 아니다.
- **부분**: 일부 흐름은 있으나 원본 계약·기능 범위를 채우지 못한다.
- **차단**: 현재 연결 코드가 UI를 숨기거나 호출을 무효화한다.
- **미연결**: 해당 원본 편집기 또는 공통 서비스의 직접 연결이 없다. 유사한 Workbench 기능이 있으면 함께 적는다.
- **미확인**: 대조가 끝나지 않았다. 없다는 판정으로 바꾸지 않는다.

기준: Workbench `b3bceab5`, 이음 `bdd4fa9d`(현지 포트 고정판은 `30ff4f05`), Orca 설치 소스 1.4.221 `9dd88123`. Orca v1.4.244는 릴리스 설명만 추가 확인했다. 시험 파일과 과거 보고서는 존재 증거이며, 이번 실행 성공 증거가 아니다.

G0–G7은 통합 계획의 구현 단계다. 필수 기능은 해당 단계와 G6 통합 인수까지 통과해야 완료다. 원본의 제한은 그대로 적고, 사용자 정책에 따른 변경은 기능 누락과 구분한다.

## 1. Orca 작업공간·화면·개발 흐름

| ID | Orca 기능 묶음 | Workbench 현황·격차 | 목표와 확인할 동작 | 단계·근거 |
|---|---|---|---|---|
| O01 | 좌우·상하 재귀 분할, 탭 그룹 | **부분**: `PaneId a/b`, `left/right`인 두 칸 구조 | leaf/split 트리. 2×2·중첩·크기 변경·빈 칸 정리·키보드 초점 | G1 · W1/O1 |
| O02 | 그룹 안 탭 정렬·그룹 사이 이동 | **부분**: 현재 좌우 이동과 focus 기능 존재 | 세션/문서/터미널/diff/브라우저를 같은 규칙으로 이동. 드래그와 IME 실제 입력 검사 | G1 · W1/O1 |
| O03 | worktree별 레이아웃·활성 탭 복원 | **부분**: 비율 저장 중심, 탭 트리·복원 범위 부족 | worktree 전환과 앱 재시작 후 탭·그룹·초점·문서 위치 복원 | G1 · W1/O1 |
| O04 | 작업공간의 탭과 세션 수명 분리 | **부분**: 세션 중심 구조 | 탭 숨김/닫기와 실행 종료 분리. 탭 이동으로 CLI를 중복 실행하지 않음 | G1/G3 · W2/O1 |
| O05 | 기존 저장소·worktree 발견·연결 | **부분**: 앱이 세션용으로 생성한 worktree 위주 | `git worktree list`와 실제 경로 확인, 기존 worktree 연결, 사라진 경로 처리 | G3 · W2/O2 |
| O06 | base/start-from ref·branch 선택 | **부분**: HEAD에서 세션 이름으로 자동 생성 | 로컬/원격 브랜치·commit ref 선택, 사용자 branch명, 충돌·fetch 실패 처리 | G3 · W2/O2 |
| O07 | PR·issue·작업 티켓에서 생성 | **미확인**: 동일한 제품 흐름 없음 | PR/issue 참조를 workspace에 보존. GitHub 기본 흐름, 다른 tracker는 커넥터별 대조 | G3/G7 · W2/O2 |
| O08 | 생성 진행·백그라운드 작업·취소 | **부분**: 기본 생성/적용/폐기 호출 | 생성 단계·실패 이유·취소 후 남은 branch/path 식별, 중복 요청 방지 | G3 · W2/O2 |
| O09 | 공유 디렉터리·복사 파일·준비 훅 | **미확인**: `.worktreeinclude` 동등 경로 미확인 | 공유 vs 복사 구분, 준비 훅·기본 탭·실패 복구. 사용자 로컬 설정 보존 | G3 · W2/O2 |
| O10 | workspace 하나에 여러 세션·터미널 | **부분**: worktree가 `SessionWorktree` 부속 | workspace를 여러 session이 참조, 각 CLI cwd·branch 정확성 유지 | G1/G3 · W2/O2 |
| O11 | 보관·휴면·복원·삭제 수명주기 | **부분**: discard 뒤 세션 archive | 표시 보관과 디스크 삭제 구분, 실행 상태·미병합 상태에 맞는 처리 | G3 · W2/O2 |
| O12 | 삭제 전 실행·변경 확인, 브랜치 보호 | **격차 확인**: force 제거/branch -D, 오류를 삼키는 경로 | 실제 종료·삭제 결과를 확인. 실패 후 성공 안내/보관 금지, branch 보존 선택 | G0/G3 · W2/O2 |
| O13 | 변경 목록을 안전하게 읽기 | **격차 확인**: `worktreeChanges()`가 intent-to-add로 index 변경 | 조회 전후 index 동일. untracked는 별도 수집해 표시 | G0/G3 · W2/O3 |
| O14 | SCM stage/unstage·commit·fetch/pull/push | **부분**: 현재 핵심 경로는 binary diff 적용 | 원래 Git history를 유지하는 SCM. 실패·인증·진행 표시 | G3 · W2/O3 |
| O15 | rebase/merge·충돌 검토 | **미확인**: 동등한 UI 없음 | base/ours/theirs, 해결·저장·stage·계속/취소. 단순 `git apply`와 구분 | G3 · W2/O3 |
| O16 | 파일·hunk·행 diff, 이미지 diff | **부분**: `WorktreeReview`의 텍스트 pre 중심 | 변경 유형별 뷰와 staging, rename/binary/큰 파일 처리 | G3 · W2/O3 |
| O17 | diff 행 주석을 에이전트에 묶어 전달 | **연결·Linux 검증** | 서버 원문·기준·행/범위·본문의 영속 의견, 같은 workspace 대화의 불변 묶음·queue·재시작 보존. 다른 OS·실제 모델 수정 정확도는 별도 | G3 · W2/O3 |
| O18 | PR 작성·검토·CI 상태/로그 | **부분**: [GitHub PR/CI·작성/수정/상태·병합·호스팅 리뷰·수정 전달](../github-review.md), 계정·포크·커밋·시도 고정, 초안·영속 기록·재시작 복구와 Linux 실제 앱 검증. 등록 stack 생성·다른 호스트·OS 검증은 후속 | PR→수정→CI→재검토 이동과 오류 표시. 단순 외부 링크와 구분 | G3 · O3 |
| O19 | 실제 터미널 PTY·중첩 터미널 분할 | **미확인**: 실행 로그를 동등 기능으로 세지 않음 | PTY 입출력·크기·cwd·프로세스 소유권·종료 확인. Linux/Windows/macOS 각각 | G3 · O4 |
| O20 | 터미널 검색·스크롤 기록·재시작 복원 | **미확인** | 출력 검색/선택/복사/붙여넣기/스크롤 유지, 실제 프로세스와 복원 기록 구분 | G3 · O4 |
| O21 | 파일·worktree·명령·세션 quick open | **부분**: 검색·세션 목록·바로가기 존재 | 하나의 검색에서 종류/프로젝트별 이동, 최근 선택과 키보드 동선 | G1/G3 · W6/O5 |
| O22 | 기존 Claude/Codex 기록 가져오기·native resume | **있음/부분**: 같은 native thread 재개, cwd 검증 있음 | 현재 기능 보존, sidechain 제외 경계 명시, 동시에 같은 세션 쓰기 충돌 방지 | G1/G3 · W3/O5 |
| O23 | 에이전트 상태·큐·계획·권한·알림 | **있음/부분**: 계획/승인/예약/알림 등 이미 존재 | 숨은 탭의 작업 상태, 요청/오류/완료 구분과 focus 복귀; Orca와 항목별 대조 | G3/G6 · W3/O5 |
| O24 | 엔진·모델·계정·사용량·초기화 시각 | **부분**: 실제 모델 목록을 받으나 표시/캐시 문제 후보 | 실제 model ID·resolved model·추론 강도·잔량을 구분, stale 목록과 계정 전환 검사 | G0/G3/G7 · W3/O5 |
| O25 | 내장 브라우저·작업공간 프로필 | **부분**: 외부 Playwright Chromium 공유 브라우저 | 탭 안 내장 브라우저, 개발 서버·cookie/profile 범위·새로고침·다운로드·탐색 복원 | G3 · W6/O6 |
| O26 | Design Mode의 요소·CSS·화면→에이전트 | **미연결** | 선택 요소/영역/출처를 같은 작업 세션에 전달하고 수정된 앱 확인 | G3 · O6 |
| O27 | SSH에서 원격 파일·Git·PTY·포트 연결 | **미확인** | 로컬과 원격 workspace 호스트를 구분, 끊김/재연결/포워딩/자격정보 경로 검증 | G7 · O7 |
| O28 | 모바일/원격 접속·작업 알림 | **미확인** | 원격 세션 보기/입력/알림의 허용 범위와 연결 복구 검증 | G7 · O7 |
| O29 | 추가 CLI 에이전트·계정 전환 | **부분**: 주 경로는 Claude/Codex | 임의 터미널 CLI 실행과 제품이 관리하는 provider를 구분. 실제 지원 단위로 등록 | G7 · W3/O5 |
| O30 | Runs/Tasks/Dispatch·worker·DAG·게이트 | **미확인**, 원본도 실험적 기능 | 일반 세션·스케줄과 구별해 선택 활성화, 의존성·취소·중복 실행 검증 | G7 · O8 |
| O31 | 설정·단축키·테마·알림·진단 | **부분**: Workbench 자체 설정 존재 | 기존 설정 보존, 기능 이동 후 접근성·단축키 충돌·진단 export 확인 | G1/G6 · W6/O5 |

설치판 Orca의 tab group은 worktree에 종속되고 다른 worktree 사이의 탭 드래그를 허용하지 않는다. **서로 다른 worktree를 같은 분할 화면에 놓는 기능을 원본 동등성으로 주장하지 않는다.** 필요하면 worktree 격리를 유지하는 추가 기능으로 따로 설계한다. 기존 agent-session 탭과 최신 릴리스에서 소개한 채팅 기능도 상세 참조판을 맞추어 비교한다.

2026-10-30 G3e2 갱신: O18의 PR 작성/수정·초안/검토 준비·닫기/열기, CI 재실행, 병합/자동 병합/큐와 등록 스택의 비동기 병합을 연결했다. 초안 CAS·불변 실행 기록·회차별 중복 방지·불명확/부분 결과·재시작 조회 복구를 제공한다. 회귀60/60, 최종 호스트20/UI5, Linux 실제 앱 연속27/27 통과. 공개 쓰기·실제 조직/스택 규칙·다른 OS는 미검증이며 호스팅 리뷰·에이전트 피드백·스택 생성은 계속 구현한다. 확정 연구 판: `research:rr-de9cdd63516392603b7c71e29a551398:c2b4fcb18a51e71e1e9a1270dc6a243cf1587b59e96c5f32247116f162201e97`.

2026-10-30 G3e3 갱신: O18에 댓글·답글·8종 반응·해결/다시 열기·검토자/팀 요청, 행 범위·묶음 리뷰와 작성 중인 리뷰의 명시적 제출/삭제를 연결했다. 선택 의견·실패 검사는 같은 작업공간의 실제 대화 요청과 전달 기록에 묶인다. 초안 충돌·응답 유실·재시작 복구·Markdown·본인 승인 차단을 검증했다. 인접84/84·최종 집중/인접36/36·Linux 실제 앱32/32 통과. 등록 스택 생성·다른 호스트·공개 쓰기/조직 규칙·다른 OS와 전체 릴리스는 남았다. 확정 연구 판: `research:rr-bed06bf2c4e723d4ba17aed6afb23f6f:de171b50adee72d39e2d44bc070878772919a074463355cfb33aaf5af687f2e8`.

2026-10-30 G3e4 갱신: O18에 대조 불가 미확정 요청의 명시적 확인과 후속 작업 재개를 추가했다. 원래 결과·확인 이력·같은 요청/CI 회차 중복 방지를 보존한다. 인접89/89·Linux 실제 앱38/38·전체 타입/빌드 통과. 등록 스택 생성·계층 지도 등 O18 전체와 나머지 원래 릴리스 범위는 계속 부분이다. 확정 연구 판: `research:rr-f80fe48d657e0cffeec0937f3a24bcc0:449b450f93d071587fc7c0eab73567145e1a106298c7a518651039e1fb6acb9c`.


2026-10-30 G3a 갱신: O05/O06/O08과 O10/O11/O12의 Git 수명주기를 [워크트리 작업공간](../worktree-workspaces.md)으로 연결했다. 실제 Linux 앱 14/14, 호스트 회귀 27/27을 통과했다. 외부 연결의 삭제 금지, 기준 ref/브랜치 생성, 중단 보존, 복수 세션/재시작, 삭제 시 다른 프로젝트·문서 편집 보호를 포함한다. O09, PTY와 SCM/PR/CI, 다른 OS는 남았다. 위 표는 최초 조사 상태이며 이 갱신을 전체 Orca 기능 완료로 해석하지 않는다. 연구 판: `research:rr-356e679212a6a82948a3e2f1c82b8ee4:5199ff74f8ba0819175c3e0a07b5380710a35958384e9b7ad619000c08f62d55`.

2026-10-30 G3b 갱신: O19/O20의 [실제 PTY·출력 복원](../terminals.md)을 연결했다. Rust worker, 공통 탭/중첩 분할, cwd·크기·입력 순서, 검색/복사/붙여넣기, 명시적 종료와 기록 보존을 제공한다. 실제 Linux 앱 12/12와 최종 호스트/탭/하네스 12/12를 통과했다. Windows/macOS와 고급 터미널 기능은 남았다. 연구 판: `research:rr-fdd3f16d3f14981eddc957e59a4cfcd2:bbbc1e7a1379b7a97614968db4dc2f1005dc71cf303263c12455aa4d5f11ee7e`.

2026-10-30 G3c 갱신: O09의 [명시적 환경 준비](../workspace-preparation.md)를 연결했다. 설정 출처·개인 설정 CAS·복사/공유·미리보기·실제 PTY 훅·기본 탭·보관 보호와 중단 기록을 제공한다. 실제 Linux 앱 준비 14/14, worktree/PTY/준비 연속 32/32를 통과했다. 자동 준비 신뢰 정책·APFS·shebang 세부 옵션·다른 OS·원격 환경은 남았다. 연구 판: `research:rr-bf6f793af6712cc230a66cace31d0482:f19750f03169a9f12b0e61fc6b61d4f388a64c7995c58187c238ed8ccf44a8b6`.

## 2. 이음오피스 공통 셸·AI·문서 관리

| ID | 원본 기능 묶음 | Workbench 현황·격차 | 이식·검증 범위 | 단계·근거 |
|---|---|---|---|---|
| I01 | 9종 문서 열기·새 문서·최근·파일 연결 | **부분**: 직접 포트는 Word/PPT/Sheets | HWP/PDF/MD/HTML/EPUB/XMind 포함, 확장자별 내부 편집기로 라우팅 | G2/G4 · W4/W5/IE1 |
| I02 | 탭·옆 칸·별도 창·활성 문서 | **부분**: Workbench 두 칸과 문서 탭 | 통합 문서 레지스트리, 중복 열기·창 간 이동·닫기/dirty 규칙 | G1/G2 · IE1 |
| I03 | 저장·다른 이름·자동 저장·충돌·복구 | **부분/미확인**: 형식별 어댑터 존재 | 제목 없는 문서·외부 변경·실패·강제 종료 후 복구, 원본 파일 보존 | G2/G4/G6 · IE2 |
| I04 | 프로젝트·폴더·즐겨찾기·파일 검색·Quick Look | **부분**: Workbench 고유 PKM 존재 | 동등한 사용자 동작으로 연결, 검색 필터·미리보기·최근 항목·경로 변경 | G1/G2/G6 · W6/IE1 |
| I05 | 홈 질문·지식 자료/파일 인덱스 | **부분**: 세션·볼트 검색과 다름 | 근거 파일/범위/최신 판, 검색 결과에서 문서 탭으로 이동 | G2 · IE1/IE3 |
| I06 | 문서 옆 AI 대화·선택 범위·편집 도구 | **부분**: 9종 원본 AI 패널·첫 세션 자동 연결·대표 수정/저장/이력 검증. 선택 범위·전 도구 검증은 후속 | 현재 문서와 참조 분리, 같은 프로젝트 세션, 선택·도구·저장 판 연결 | G2/G4 · W4/IE3 |
| I07 | 스트리밍·중지·큐·편집/재정렬·재시도 | **부분**: 9종 같은 세션 스트림/중지/복원 검증, Linux 부분 답변 전달 지연 수정. 큐·재정렬·재시도 전체 후속 | 원본의 문서 AI 동작을 실제 세션 실행/취소/오류와 일치시킴 | G2 · IE3 |
| I08 | AI 차례별 되돌리기·변경 검토·대화 보존 | **부분**: 9종 대표 되돌림·재저장 검증. PDF 저장 후 바탕 판 복원·다음 AI 읽기 확인. Sheets 구조 변경·전 도구·사람 편집 혼합은 후속 | 사람 편집을 덮지 않는 Undo 경계, 저장/이름 변경 후 대화 연결 | G2/G4 · IE3 |
| I09 | 파일·이미지·붙여넣기·드래그 첨부 | **부분**: 원본7종 등록 문서 참조 연결. 로컬/이미지/붙여넣기·드래그 후속 | 형식/크기/실패 표시, 현재 문서와 첨부의 역할 유지 | G2/G4 · IE3 |
| I10 | `+`로 열린 탭·옆 칸·분리 창·최근 문서 첨부 | **부분**: 원본7종 버튼→프로젝트 열린/최근 문서 선택창·dirty 안내 연결. 옆 칸 우선 분류/분리 창 전체 후속 | 원본 doc-picker의 대상/중복 제거/자기 문서 제외, dirty 안내 | G2 · W4/IE4 |
| I11 | `@`로 문서 검색·선택 | **부분**: 원본7종 @·최신 저장 참조·후속 갱신 Linux 검증. 입력 참조는 Markdown, 바이너리 전체/첨부 복원 후속 | `+`와 같은 목록·판 정책, MD→PPT 요청에서 실제 사용 확인 | G2 · IE4 |
| I12 | 구독 연결 탐지·설치·로그인·전환·로그아웃 | **부분**: Workbench 엔진 연결은 이미 존재 | 중복 계정 창 없이 원본 기능을 공통 설정에 연결, 실제 설치본에서 끝까지 검증 | G0/G2 · W3/IE3 |
| I13 | 직접 ChatGPT·무료/키 제공자·로컬 AI | **미확인/미연결**: CLI 2종과 다름 | 제공자별 능력·도구 지원·모델·오류·사용량, 선택한 연결을 임의 전환하지 않음 | G2/G4 · IE3 |
| I14 | 모델 목록·사용량·연결 안내·전송 판단 | **부분**: 실제 엔진 메뉴 있음 | 편집기/본 채팅 모델 일치, 만료/한도/오프라인 안내와 작업 정지 | G0/G2 · W3/IE3 |
| I15 | 웹 검색·URL 읽기·이미지 생성·미디어 분석 | **차단/미연결**: 일부 외부 도구와 다름 | 원본 각 도구의 입력/결과·참조·문서 삽입·사용자 설정 이식 | G2/G4 · IE3/IE10 |
| I16 | 사용자 스킬 목록·명령·설치/수정/삭제·import/export | **부분**: 기존 보관함과9종 선택/읽기/제안 저장/자동 호출·복원 검증. 전체 원본 관리 동등성 후속 | 설치된 사용자 스킬 우선, 원본 이름/명령·프로젝트 범위·업데이트 동작 | G2 · W6/IE5 |
| I17 | 문서를 사용자 양식 스킬로 등록 | **부분**: 원본9종 선택/등록·현재 문서 미리보기·가림·원본/사본 저장·같은 대화 인계 검증. 전체 관리/OS 동등성 후속 | `ieum-template` 원본 보존, 양식 미리보기, 사본 생성, 재사용·내보내기 | G2 · IE5 |
| I18 | PPT 디자인 템플릿·갤러리·저장 스타일 | **연결·Linux 검증**: 원본12종/표지24개·글꼴10종·선택/추가요청·저장/재시작/재사용. 기존 standalone 스타일 이행·다른OS 인수 후속 | 본인 템플릿 추가·선택·글꼴·미리보기·다시 사용, 양식 스킬과 함께 제공 | G2/G4 · W4/IE6 |
| I19 | 문서/파일 그룹에서 새 문서 만들기 | **차단/미연결** | 자료 선택·dirty 저장·목표 종류·요청→새 탭, 정확히 한 번 handoff | G2/G4 · IE7 |
| I20 | AI 없이 형식 변환 | **부분/미확인** | 원본 convert 경로별 입력·출력·제한, 새 미저장 문서와 파일 보존 | G4 · IE7/IE10 |
| I21 | 출처 보기·이 문서로 만든 문서 | **미연결** | 원본 외부 메타데이터 계약, 경로 변경/없어진 파일 표시, 원본에 태그 강제 삽입 금지 | G2/G4 · IE7 |
| I22 | 폴더의 에이전트 모드·작업 도구 | **부분**: Workbench 세션 기능은 별도 구현 | 같은 workspace의 cwd·허용 범위·문서 도구·중지/복구, 별도 대화 중복 방지 | G2/G3 · IE3 |
| I23 | Google Drive 탐색·열기·첨부·검색/읽기 | **미연결** | 사용자 연결과 파일 버전/오프라인/실패, Drive 자료를 AI가 실제 참조 | G2/G4 · IE8 |
| I24 | PDF/EPUB 장기 AI 작업과 결과 보관소 | **미연결** | 계획량·진행·중지·재개·한도·부분 결과, 사람이 수정한 번역 보존 | G4 · IE3/IE11 |
| I25 | 앱 내부 MCP: 열린 문서 목록·읽기·저장·닫기 | **미연결**: 외부 MCP 연결과 다른 기능 | 디스크와 미저장 편집 상태 구분, 대상 문서 판·실패·도구 능력 표시 | G2/G4 · IE10 |
| I26 | `ieumoffice` CLI·MCP·capabilities·pipelines | **부분**: 원본 실행본 일부 활용 | 명령/도구별 대체 경로와 exit/error·출력 형식, 미지원과 손상 실패 구분 | G4/G5 · W7/IE10 |
| I27 | 글꼴·한글/다국어 IME·클립보드·DPI | **부분/미확인** | 설치 글꼴과 문서 글꼴·오프라인·붙여넣기/드래그·OS별 실제 입력 | G4/G5/G6 · IE2/IE9 |
| I28 | PDF 내보내기·인쇄·PNG·발표/새 창 | **차단/부분**: 숨은 Electron 렌더 경로 잔존 | 각 형식의 출력·페이지·폰트·다중 창 계약을 Tauri 호스트로 옮김 | G4/G5 · W4/W7/IE9 |
| I29 | 설정·언어·도움말·업데이트·라이선스 고지 | **부분**: Workbench 셸로 대체 | 사용자 기능 접근 경로·설정 이행·출처 고지·설치 후 업데이트·오류 안내 | G2/G6 · IE2/IE9 |
| I30 | 가리기와 다른 파일로 읽을 때의 처리 | **미확인**, 원본에도 알려진 빈틈 | 원본의 형식/GUI/CLI/MCP별 범위부터 표시. 보호되지 않는 경로를 보호된다고 보이지 않게 함 | G2/G4/G6 · IE3/IE12 |

원본의 셸 UI를 픽셀 단위로 복사하는 것이 목표는 아니다. Workbench의 프로젝트·내비게이터가 원본 기능을 제공한다면 그 기능과 인수 시나리오를 매핑한다. 단, 공통 셸에서 사라진 기능을 “본 채팅에 물어보면 된다”로 대체했다고 판정하지 않는다.

2026-10-31 I06/I07 갱신: 원본9종 AI 패널과 대표 수정 도구의 같은 Workbench 세션 기록·저장·복원·새 세션·취소를 Linux에서 검증했다. 순차 검증된64개 흐름의 출처/전체 실행 상태는 `office-suite-native-06/verification.json`에 남긴다. PDF 저장 시점과 Sheets 입력 포커스를 수정했으며 정확한 요청 문장과 셀 원래 값 보존을 확인했다. AI 차례 Undo/큐/선택/전 도구, 직접 AI·첨부·검색·Drive·템플릿은 전체 완료로 세지 않는다. 연구 판: `research:rr-743f8783d3831764b58ba96ea2ccf045:58af427fbce70df749069c265a97fdc1be88572bef1bfbf06c5ed4d91778377a`.

2026-10-31 I07/I08 추가 갱신: Sheets 저장 확인의 오래된 변경 개수 사용을 제거하고 Linux WebKit의 부분 답변 전달 지연을 공백 NDJSON heartbeat로 해소했다. 7종 원본 Undo/Redo와 Word AI 이전 상태로/복원 취소의 실제 파일 저장 16개를 포함해 9종 대표 80개를 순차 검증했다. PDF 저장 후 Undo는 실패로 남아 있으며, Sheets 시트 구조·일부 시각 요소의 이력 예외도 완료 처리하지 않는다. 근거: `office-undo-native-10/verification.json`; 되돌림 판 `research:rr-83a38898aec2e7a79a888b89fae470e8:19663864966b7299f716a7f7b19c165fb156f40c3a3908395b656958820bdeba`, 스트림 판 `research:rr-e519c6a82db02e257c792a3eaed0f9e6:eb478c2f4251bef5ca14548a6ad0d19cb9c8b723f68cf1e0e486e699fb467afc`.

2026-10-31 I08 PDF 후속: 저장 후 이력을 유지하고 바탕 PDF 판과 편집 스냅샷을 함께 복원한다. 최신 판 CAS·외부 파일 보호와 원본 저장 엔진은 유지한다. 실제 메모 Undo/Redo, 글자/회전/빈 페이지 세 단계 왕복, 읽기 실패·손상·지연, 다음 AI 읽기와 기존 회귀를 **35/35**로 검증했다. UI 이력은 열린 편집기 수명이며 가림·새 파일·원본 직접 재작성 경계와 전 도구 인수는 별도다. 근거 `pdf-undo-native-02/verification.json`; 연구 판 `research:rr-83a38898aec2e7a79a888b89fae470e8:74189da1c6cbd9d6470584df0b53a3d9bfa82caf1b1e29ece4b899f5a38e35b5`.

## 3. 이음 편집기 9종의 세부 범위

2026-10-31 I06 첫 세션 후속: 문서를 열 때는 대화를 만들지 않고 첫 요청의 저장 확인 뒤에 연결한다. 원본 입력창을 유지하며 요청을 한 번 기록하는 흐름과 수정/저장/복원/새 대화/취소를 9종 단일 Linux 실행 **86/86**으로 검증했다. 인접 **47/47**, 전체 타입/제품 빌드 통과. 원본 `@`/`+` 첨부와 최신 참조는 아직 후속이다. 근거 `office-first-session-native-00/verification.json`; 연구 판 `research:rr-e6e9abfeeec587137aae8e9d2f47aef0:ac5be7ecc611e84d24411cb7109bc255dbe9bfcabafe7a2e4f524d2539f63b3f`.

Word/PPT/Sheets에는 원본 렌더러 일부가 이미 들어왔다. 아래의 **부분·미검증**은 그 기능이 전부 없다는 뜻이 아니다. 각 원본 UI→호스트 호출→엔진→저장/재열기 경로를 연결해 판정해야 한다. 나머지 형식의 기존 Workbench 뷰어·도구도 유지할 기능과 대체할 기능을 구분한다.

| ID | 편집기·기능 묶음 | 현황·구체적 대조 항목 | 합격 기준 | 단계·근거 |
|---|---|---|---|---|
| D01 | Word 본문·문단·스타일·목록·표·그림 | **부분·미검증**: 포트 존재 | 사람 입력·선택·서식·표 구조·그림 수정 후 저장/재열기 비교 | G4 · W4/I-DOCS |
| D02 | Word 페이지·구역·머리/바닥글·각주·미주 | **부분·미검증** | 실제 원본 지원 요소와 보존 전용 요소 구분, 페이지 배치·출력 확인 | G4 · I-DOCS/IE12 |
| D03 | Word 목차·캡션·인용·서지·Zotero·편지 병합 | **부분·호스트 연결 미검증** | 원본 리본과 Zotero IPC/데이터 입력 경로를 검증. UI 존재만으로 완료 아님 | G4 · I-DOCS |
| D04 | Word 검색·검토·변경 표시·AI·ODT | **AI 차단**, ODT 범위 별도 대조 필요 | DOCX/ODT 기능 제한 표시, AI 차례 되돌리기, 지원하지 않는 개체 보존 | G4 · W4/I-DOCS/IE2 |
| P01 | Slides 슬라이드·섹션·노트·주석 | **부분·미검증** | 생성/삭제/복제/순서/섹션/노트/주석을 저장 후 보존, AI가 주석 문맥 사용 | G4 · I-SLIDES |
| P02 | Slides 텍스트·도형·표·차트·이미지·배치 | **부분·미검증** | 선택/그룹/정렬/격자/편집점/서식·복사/붙여넣기와 결과 개체 검사 | G4 · I-SLIDES |
| P03 | Slides 템플릿·스타일·글꼴·AI 생성/편집 | **차단**: 템플릿/AI 관련 제외 | I06–I19와 결합, 본인 템플릿으로 MD→PPTX 실제 편집 | G2/G4 · W4/IE6 |
| P04 | Slides 쇼·발표자·전체 화면·PDF/이미지 | **차단/미검증** | 새 창·발표자 노트·키보드·export 결과·인쇄, 원본 미지원 효과는 별도 표시 | G4 · W4/I-SLIDES |
| P05 | Slides 암호 문서·가리기·원본 개체 보존 | **미검증**, 원본 일부 결함 보고 있음 | 암호 입력/잘못된 암호/저장, 가리기 재열기, 모르는 요소의 보존 | G4/G6 · IE2/IE12 |
| S01 | Sheets 셀·행열·시트·서식·수식 | **부분·미검증**: WASM 엔진 포트 | 계산/오류 값·다중 시트·수식 참조·키보드·범위 붙여넣기·재열기 | G4 · W4/I-SHEETS |
| S02 | Sheets 표·정렬·필터·유효성·조건부 서식 | **부분·미검증** | 각 명령 적용 범위·Undo·저장 유지, 리본 명령과 엔진 구현 대조 | G4 · I-SHEETS |
| S03 | Sheets 피벗·차트·슬라이서·타임라인·그림 | **부분·미검증**: 원본 명령 경로 존재 | 실제 원본 지원 조합별 생성/새로고침·데이터 연결·원본 보존 | G4 · I-SHEETS |
| S04 | Sheets CSV/변환 입력·암호·페이지/출력 | **부분·호스트 미검증** | 입력 형식별 지원 범위·변환 손실 안내·인쇄 영역·XLSX 저장/재열기 | G4/G6 · IE2/I-SHEETS/IE12 |
| S05 | Sheets AI 범위 편집·첨부 통합 문서·MCP | **차단**: ai/mcp/files/projects | 선택 범위·수식 결과·복수 파일 참조·중지/Undo, 파일 간 혼선 없음 | G2/G4 · W4/I-SHEETS |
| H01 | HWP/HWPX 열기·편집·저장·복구 | **미연결**: 현재 kordoc 보기/별도 HOP | 이음 rhwp+studio plugin 기준선, HWP 입력·HWPX 결과 정책, 미지원 내용 안내 | G4/G5 · W5/I-HWP |
| H02 | 한글 글자·문단·스타일·용지·구역·각주 | **미연결**, HOP 패치 후보 존재 | 글꼴/메트릭/조판·여백·쪽 번호·겹침 표본 비교, 원본과 패치를 구분 | G4/G5 · I-HWP/IE12 |
| H03 | 한글 표·병합·중첩 표·양식·체크박스 | **미연결**, 원본 단계별 제한 있음 | 실제 한컴 키맵·셀/표 입력·크기·양식 쓰기, 단순 표만으로 통과하지 않음 | G4/G5 · I-HWP/IE12 |
| H04 | 한글 그림·수식·메모·검토·AI 도구 | **미연결** | 원본 도구별 위치/범위·Undo·메모 앵커·서식 복사·이미지 삽입 검사 | G4 · I-HWP |
| H05 | 한글 출력·외부 읽기·CLI 편집·글꼴 | **부분**: 기존 도구와 중복 | studio/CLI/MCP 경로별 저장 계약, 출력 쪽 수·글꼴, HOP 패치 충돌 시험 | G4/G5 · W5/W7/I-HWP |
| F01 | PDF 보기·탐색·검색·OCR·선택 | **부분**: 자체 PDF 뷰어/도구 존재 | 원본 검색 결과/좌표·OCR 경로·페이지 이동·목차·확대/축소 | G4 · W5/I-PDF |
| F02 | PDF 주석·그리기·스탬프·가림·서명 | **미연결/미검증** | 주석과 영구 가림 사본 구분, 지원 서명 종류 표시, 저장 후 결과 내용 검사 | G4 · I-PDF |
| F03 | PDF 텍스트·그림·링크·양식·페이지 작업 | **부분/미확인** | 원본 지원 범위의 편집·양식 입력·추가/교체/회전/자르기·Undo | G4 · I-PDF |
| F04 | PDF 도구 허브·변환·병합/분리·출력 | **부분**: PDFCraft 등 별도 경로 | 원본 PDF tools/CLI별 변환 결과, 암호·파일 보존·실패, 중복 엔진 교체 | G4/G5 · W7/I-PDF/IE10 |
| F05 | PDF 구절 카드·대역·노트 연결·AI 핵심 표시 | **미연결** | 사용자가 시작한 작업, 받아들인 주석만 문서에 반영, 노트/사람 번역 보존 | G4 · IE11/I-PDF |
| F06 | PDF AI 읽기·번역·긴 개요·결과 보관 | **미연결** | 페이지별 진행/재개·언어 제한·새 파일 출력·문서 변경 후 결과 이행 | G4 · IE11/IE12 |
| M01 | Markdown 시각 편집·소스·문법/표/그림 | **부분**: Workbench 자체 편집기 존재 | 원본 지원 명령·소스 전환·실제 bytes·상대 경로·Undo 비교 | G4 · W5/I-MD |
| M02 | Markdown AI·가리기·외부 읽기·새 문서 | **미연결/미검증** | AI 도구·첨부·템플릿·변환, 인라인 코드와 txt/json 재열기 제한 확인 | G2/G4 · I-MD/IE12 |
| M03 | Markdown 저장·복구·출력·MCP | **부분** | 미저장 내용 읽기·저장·HTML/PDF 등 원본 출력 경로를 각각 확인 | G4 · I-MD/IE10 |
| W01 | HTML 편집·미리보기·선택 도구·소스 | **부분**: 현재 뷰어/열기와 구분 | 원본 편집/미리보기 동작·관련 자원·클립보드·저장, 문서 코드와 앱 권한 분리 | G4 · W5/I-HTML |
| W02 | HTML AI·검색·가리기·생성 handoff·출력 | **미연결** | 자료에서 새 HTML 생성→문서 탭·현재 요소 편집·원본 보존 | G2/G4 · I-HTML/IE7 |
| E01 | EPUB 읽기·목차·링크·보기·검색·위치 | **미연결**: 형식 등록부터 필요 | reflow/fixed layout·DRM/손상 거절·읽기 위치, 원본 자원 보존 | G4 · W5/I-EPUB |
| E02 | EPUB 본문·찾기/바꾸기·Undo·AI 편집 | **미연결** | 원본이 허용한 블록 편집만, 장/그림/표 구조는 원본 제한 유지, ID·링크 보존 | G4 · I-EPUB/IE3 |
| E03 | EPUB 번역·저장·복구·CLI/MCP | **미연결** | 고정 배치 읽기 전용·중단/재개·사람 번역·변경 없는 항목 bytes 보존 | G4 · I-EPUB/IE10 |
| X01 | XMind 토픽·관계·요약·테마·배치·시트 | **미연결**: Pele 다이어그램과 다른 기능 | 원본 6개 배치와 대체 표시·그림·링크·접기·다중 시트·프레젠테이션 | G4 · I-XMIND |
| X02 | XMind 저장·복구·미지원 개체 보존 | **미연결**, 원본 일부 불확실성 있음 | 무변경 bytes 동일, 변경 시 원본 ZIP 항목 보존, 구형/암호 거절 경계 | G4/G6 · I-XMIND/IE12 |
| X03 | XMind AI·문서 변환·PNG/PDF/개요·MCP | **미연결** | 새 지도/편집·자료→생성·출처·내보내기, 원본 MCP에 없는 편집 도구는 없다고 표시 | G4 · I-XMIND/IE10 |

원본이 제공하지 않는 MS Office 매크로 전체, 모든 한컴 조판 호환, EPUB 구조 편집, XMind 8 호환 등을 이 표의 “전체”에 억지로 포함하지 않는다. 원본에 있는 기능은 누락하지 않고, 원본의 미지원·보고된 결함은 별도로 드러낸다.

## 4. 기존 Workbench 기능과 연결

| ID | 유지·추가 범위 | 현재와 다음 작업 | 단계·근거 |
|---|---|---|---|
| K01 | 프로젝트 노트·분류·태그·즐겨찾기·Bases식 보기 | 현지 master에 구현된 내비게이터/홈 그룹 보기를 새 workspace 계약에 이행. 공개 v0.2.2와 구분 | G1/G6 · W6 |
| K02 | 그래프·달력·검색·문서·세션 연결 | 기존 ID/노트 링크 보존, 다른 worktree 동일 경로를 잘못 합치지 않음 | G1/G6 · W6 |
| K03 | 썸네일·폴더 템플릿·`.base` 내보내기 | 중단 대화의 남은 항목. 표현 불가능한 동적 속성은 경계 표시 | G6 · W6 |
| K04 | doory 새 문서·정식 탭·AI 후속 편집 | Linux23/23: 메뉴 생성·사람 편집·같은 세션 수정안·복구/재열기·독립 자산 사본·PNG/PDF·권한 복구. 전체 메뉴/영상·다른OS 후속 | G2/G4 · W6 |
| K05 | hallym-kordoc 기본 생성 스킬 | 별도 거대 앱으로 취급하지 않음. 설치된 사용자 버전·개인 양식 보존, 생성 HWPX→이음 탭 | G5 · W5 |
| K06 | HOP 개선과 패키지 정리 | 이음 한글에 필요한 패치만 비교 적용. 전체 HOP/Electron 제거는 대체 출력/생성 검증 후 | G5/G6 · W7 |

## 5. 기능별 작업 티켓의 필수 정보

위 행을 구현 티켓으로 나눌 때 다음 필드를 채운다. 코드 심볼 수·IPC 문자열 수·테스트 파일 수를 기능 완료율로 바꾸지 않는다.

```text
featureId: 이 표의 ID + 개별 명령
upstream: 저장소 / 정확한 commit / UI·호스트·엔진 심볼
current: Workbench commit / 연결 경로 / 있음·부분·차단·미연결·미확인
contract: 입력 / 결과 / 오류 / 취소 / Undo / 저장 판
host: renderer 재사용 / Tauri 명령 / 서비스 어댑터 / 외부 프로세스
policyDifference: 명시적인 사용자 정책 차이 또는 없음
acceptance: 사용자 행동 + 화면 결과 + 저장 파일/원본 비교
evidence: 실제 실행 OS·빌드·로그·결과 파일·hash / 아직 실행 안 함
upstreamLimitation: 원본 미지원·조건부·미해결 보고와 재현 여부
stage: G0–G7 및 의존 featureId
```

G0에서 각 동적 IPC·메뉴의 연결을 이 티켓으로 내려 매핑한다. 아직 구현되지 않은 호출을 범용 `null` 응답으로 성공 처리하지 않는다. 상류의 테스트를 가져와도 Electron 전용 호스트·좌표·권한 가정은 Tauri에 맞게 다시 검증한다.

## 6. 근거 위치

### Workbench

| 코드 | 확인한 파일·범위 |
|---|---|
| W1 | [panes.ts](../../apps/web/src/panes.ts), [panedrag.ts](../../apps/web/src/panedrag.ts), 기존 STATUS의 분할/복원 경계 |
| W2 | [worktree 계약](../../packages/contracts/src/worktrees.ts), [worktrees.ts](../../apps/host/src/worktrees.ts), [WorktreeReview](../../apps/web/src/components/WorktreeReview.tsx), [sessions.ts](../../apps/host/src/sessions.ts)의 create/apply/discard |
| W3 | [Claude provider](../../apps/host/src/providers/claude.ts), [Codex provider](../../apps/host/src/providers/codex.ts), [ModelPicker](../../apps/web/src/components/ModelPicker.tsx), sessions 및 STATUS native import/resume |
| W4 | [Vite 제외 목록](../../apps/office/vite.config.ts), [bridge.ts](../../apps/office/src/bridge.ts), `apps/office/src/{docs,slides,sheets}.{ts,css}`, [OfficeEditor](../../apps/web/src/components/docs/OfficeEditor.tsx), [office.ts](../../apps/web/src/office.ts) |
| W5 | [DocumentView](../../apps/web/src/components/docs/DocumentView.tsx), sessions의 openExternal, [hop.ts](../../apps/host/src/hop.ts) |
| W6 | [STATUS](../STATUS.md), [내비게이터·그룹 보기 설계](프로젝트-내비게이터-그룹보기-설계.md), [프로젝트 노트 설계](프로젝트-노트-설계.md), 현재 웹·호스트 코드 |
| W7 | [bundled-apps.json](../../packaging/bundled-apps.json), [fetch-bundled-apps.ts](../../scripts/fetch-bundled-apps.ts), [ieumoffice.ts](../../apps/host/src/ieumoffice.ts), [.github/workflows/release.yml](../../.github/workflows/release.yml) |

### 이음오피스

모든 경로는 [원본 고정판 bdd4fa9](https://github.com/pblsketch/openoffice/tree/bdd4fa9d2c2fcbb8f599d6d639ca2e6804d0416d)에 대한 것이다. 로컬 조사 사본은 `/tmp/ieum-upstream-src/upstream`이며 실행하지 않았다.

| 코드 | 원본 경로·근거 |
|---|---|
| IE1 | `apps/shell/src/main/`, `apps/shell/src/renderer/`, `docs/business-rules.md`의 탭·프로젝트·지식 자료 |
| IE2 | `docs/contracts.md`, `docs/tracking/decisions/0034-odt-through-word-editor.md`, `0041-open-password-workbooks-and-decks.md`, `0061-crash-recovery-and-session-restore.md`, `0069-autosave-in-pdf-and-hwp.md` |
| IE3 | `docs/business-rules.md`, `packages/ai-provider`, `packages/agent-core`, 공통 AI UI 및 회수 `ai-shell.md` |
| IE4 | `apps/shell/src/main/doc-picker/doc-list.ts`, `doc-asker.ts`, 결정 0035/0051 |
| IE5 | `apps/shell/src/main/user-skills/`, `template-tabs.ts`, `template-tabs-ipc.ts`, 결정 0048/0053/0064 |
| IE6 | `apps/slides/src/renderer/ai/TemplateGallery.tsx`, `TemplatePicker.tsx`, `template-selection-state.ts`, `src/main/template-selection-ipc.ts`, business-rules의 슬라이드 디자인 템플릿 |
| IE7 | `apps/shell/src/main/generate/`, `document-links*`, 편집기 generate-handoff, 결정 0017/0018 |
| IE8 | `apps/shell/src/main/drive/`, `packages/google-drive`, 결정 0033 |
| IE9 | `packages/electron-utils`, 각 editor preload/main, shell 메뉴·설치기·업데이트, 결정 0008/0013/0052 |
| IE10 | `packages/cli`, `packages/pipelines`, `apps/shell/src/main/mcp/`, `docs/contracts.md`, 회수 `cli-mcp.md` |
| IE11 | business-rules의 문서 작업/EPUB 번역/PDF 읽기 도우미, 결정 0043/0057/0066, PDF result store |
| IE12 | [미해결 보고 원문](https://github.com/pblsketch/openoffice/blob/bdd4fa9d2c2fcbb8f599d6d639ca2e6804d0416d/docs/tracking/findings.md). 이번 새 재현 결과와 구분 |
| I-DOCS | `apps/docs/src/renderer/components/ribbon-*.tsx`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/zotero-ipc.ts`, `packages/docx-engine` |
| I-SLIDES | `apps/slides/src/renderer/components/Ribbon*.tsx`, `context-menu-items.ts`, `show-menu.ts`, `src/shared/ipc.ts`, `packages/pptx-engine` |
| I-SHEETS | `apps/sheets/src/renderer/ribbon-actions.ts`, `pivot-actions.ts`, sheet/cell context menu, `src/shared/ipc-channels.ts`, `src/preload/index.ts` |
| I-HWP | `apps/hwp`, rhwp/studio plugin 및 patches, 결정 0021–0028/0050/0054/0055/0060/0068–0072/0079, 회수 `hwp-inventory.md`, `hwp-engine.md` |
| I-PDF | `apps/pdf`, shell PDF tools, PDF 관련 packages, 회수 `pdf-inventory.md` |
| I-MD | `apps/markdown/src/renderer/components/Ribbon.tsx`, `src/shared/ipc.ts`, `src/preload/index.ts`, 가리기·source-mode 시험 |
| I-HTML | `apps/html/src/renderer/components/{Ribbon,FloatToolbar}.tsx`, `src/shared/ipc.ts`, `src/main/{generate-handoff,ai-search}-ipc.ts` |
| I-EPUB | `apps/epub`, `packages/epub-engine`, 결정 0066, 회수 `epub-mindmap.md` |
| I-XMIND | `apps/mindmap`, `packages/xmind-engine`, 결정 0014/0015/0019/0075, 회수 `epub-mindmap.md` |

### Orca

상세 소스는 `/home/achamge/.local/share/hallym-orca/source-1.4.221`, commit `9dd8812384db85d0b4ede2d1e37f9d73bdb4ea8c`다. [공식 저장소](https://github.com/stablyai/orca)와 [v1.4.244 릴리스 설명](https://github.com/stablyai/orca/releases/tag/v1.4.244)은 추가 확인 자료다.

| 코드 | 설치 소스의 경로·근거 |
|---|---|
| O1 | `src/shared/tab-types.ts`, layout/탭 그룹 저장 경로, 회수 `orca-layout.md` |
| O2 | `src/preload/api/worktree-api.ts`, `docs/site/content/docs/model/worktrees.mdx`, worktree create/cleanup/settings |
| O3 | `src/preload/api/git-operation-api.ts`, `docs/site/content/docs/review/`의 diff-viewer, commit-push, annotate-ai-diff |
| O4 | `docs/site/content/docs/terminal.mdx`, terminal session/PTY·split·restore 소스 |
| O5 | 문서 model/session-restore, model/agents-sessions, quick-open, agents/session-history, agents/usage-tracking, settings |
| O6 | `docs/site/content/docs/browser/overview.mdx`, `design-mode.mdx`, browser/profile/design-mode 소스 |
| O7 | `docs/site/content/docs/ssh.mdx`, 공식 README의 모바일/원격 기능과 관련 preload 계약 |
| O8 | `docs/site/content/docs/cli/orchestration.mdx` 및 실험적 orchestration 계약 |

## 7. 증거의 범위와 연구 판

2026-10-30 구현 갱신: 위 표의 최초 조사 상태와 이후 구현은 구분한다. H01/H05 및 I03/I28의 한글 경로는 내부 HWP/HWPX 편집·저장·CLI 수정안·복구에 더해 Rust PDF/네이티브 인쇄·다른 이름 저장까지 연결했다. 최종 Linux 실제 앱 27/27을 통과했다. 다른 편집기 출력, 공통 AI, IME/복잡한 조판과 다른 OS 검증은 남았다. [실행 기록](../IMPLEMENTATION-2026-10-29.md)의 결과와 `research:rr-895c997cc6f90f44e4cb808130710752:62acb0d7121919c9764f6633e30e967d9ebbeb8d497a3d6e3d16405d2ed21561`을 따른다.

회수 보고서는 Claude의 완료 메시지를 원문 그대로 저장한 **과거 조사 자료**다. 직접 소스 확인과 구별한다. `recovered-manifest.json`에 원본 JSONL 줄·시각·내용 해시를 적었다. `source-surface-index.json`은 정적 파일/명령 후보 목록이다. 이음 관련 인터페이스·문서·E2E 433개 파일, literal IPC 322개, E2E spec 140개를 색인했으나 동적 호출과 각 명령 의미의 전수 감사를 대신하지 않는다. 테스트 이름의 존재를 통과로 세지 않는다.

계획의 실증 범위는 소스·계약·기존 보고서 대조다. 새 빌드, 실제 엔진 요청, OS 설치본 시험은 이번에 실행하지 않았다. 전체 기능 실행 동등성은 G0–G6의 검증 결과가 있어야 확정할 수 있다.

- Office 연구: `research:rr-f68ec824271f4b0be9d6e35e8a05f1ab:0a823f026787dacd7e8348c4b8e04b7c03a0c44b8c3e067293cfcc0de7e7adb5`
- Orca 연구: `research:rr-49835a49e779909b7c38e978e8b81eb7:2299d0531ac6657ce27efbd8420fb40a50f0f5381939a4bfeb34f283acbc7569`
- 원래 R 번호·기존 연구 판과 관리 자료 위치는 [통합 계획의 근거](업데이트-통합계획-2026-10-29.md#9-근거와-이어가기)를 따른다.

2026-10-30 G3d1 갱신: O14/O16의 [로컬 Git 변경 검토·스테이징·커밋](../source-control.md)을 연결했다. staged/working diff·줄 번호·제한된 이미지 비교, literal 경로·첫 커밋 전 취소·rename, 판 재검사·실제 훅·실행 기록과 중단/재시작을 제공한다. 관련 44/44, 인접 16/16, 실제 Linux 앱 13/13 통과. 원격 Git·충돌 해결·hunk·행 주석·PR/CI 및 다른 OS는 후속이다. 연구 판: `research:rr-50d34ea765b9cb6ae68640d4f4261132:6933612741a6fa4628b74439573698668f2519022bfb74f9caa194a219a8836a`.

2026-10-30 G3d2 갱신: O14의 [원격 Git 동기화](../git-remote.md)를 연결했다. 포크/추적 기본값, 실제 대상·설정 판, branch fetch, ff-only/merge/rebase 받기, 고정 OID push, 다중 대상 부분 결과와 실제 원격 HEAD의 exact lease를 제공한다. 관련 44/44, 실제 Linux 로컬/원격 연속 22/22 통과. 온라인 인증·태그/고급 fetch·3방향 충돌 편집·PR/CI·다른 OS는 남았다. 연구 판: `research:rr-134133e337cb2dc1780a697c4602d772:2b7822df727d8192db9f8c8365ce7a33a18b321f9c3f2d0b1e2335aea4905c8f`.

2026-10-30 G3d3 갱신: O15의 [실제 3방향 충돌·저장·해결·계속/취소](../git-conflicts.md)를 연결했다. merge/rebase/cherry-pick/revert, 정확한 단계·재배치 의미, 초안·외부 변경 차단, 문서 작성권·operation 판, 바이너리/삭제/링크와 로컬 복구 사본을 제공한다. 관련 49/49, 실제 Linux 충돌 16/16 통과. 서브모듈/폴더·고급 rename·skip UI와 다른 OS는 남았으며 O16/O17/O18과 전체 릴리스를 계속한다. 연구 판: `research:rr-393912d15a30f5b4064e9093fe88ed95:7c15cf5e54e8a779945ee57580346af9c5ebe5a1bf9569449242e4eda7b9018a`.

2026-10-30 G3d4 갱신: O16 검토에서 [변경 구간 선택·스테이징/취소](../git-hunks.md)와 F7 이동을 제공한다. 정확한 diff 판·서버 생성 구간, 인덱스만 적용, 작업 파일 보존과 범위별 거절을 검증했다. 관련 47/47, 실제 Linux 로컬 SCM/구간 선택 연속 22/22 통과. 원본 문서에서 확인한 것은 파일 staging과 구간 표시이며 구간 선택 staging 자체를 원본 동등성의 증거로 쓰지 않는다. 기준/커밋/통합 비교·개별 행 선택/주석과 O17/O18은 후속이다. 연구 판: `research:rr-9900852c56b70bef39480ef5eb23cde6:a23455a300329980203499dfffecad71a2616b8c8893a36469611695540fc23d`.

2026-10-30 G3d5 갱신: O16에 [작업 전체·기준·브랜치·커밋 비교](../git-comparison.md)를 추가했다. 검토 OID 고정, 공통 조상/끝점과 첫 커밋·병합 부모, rename/이미지·미추적/중간 staging, 오래된 작업 파일 거절과 새 포트의 설정 복원을 검증했다. 관련 호스트63/63, 저장 순서2/2, 실제 Linux19/19 및 화면 확인 완료. 개별 행 staging, O17 행 주석/에이전트 전달·O18 PR/CI와 다른 OS/전체 릴리스는 남았다. 연구 판: `research:rr-0bfd7a6a8c40fc67dd39f4bfbaa82481:09b97b8e9b077c9a2d71436cc9261f2a6e0e235507cded31b07b7bfd89a999fa`.

2026-10-30 G3d6 갱신: O17 [행 검토 의견·같은 작업공간 대화 전달](../git-review-notes.md)을 연결했다. 원문/기준/저장소 고정, 이동/모호/다른 기준 표시, CAS·중복 방지, 묶음 전달·대기·실패·종료/재시작을 검증했다. 회귀79/79, 종료/세션27/27, 실제 Linux 구간/의견/비교42/42와 화면 확인 완료. native는 대체 엔진이며 모델의 수정 정확도나 다른 OS/전체 릴리스 완료로 해석하지 않는다. 연구 판: `research:rr-52b02575f1eebe2c61a3e4e43a6ca74f:fe0104ec6b7112c8ceb37c7189edae80bae767be85304d46f259e4c668a321f5`.

2026-10-31 I09/I10/I11 후속: 원본7종의 등록 문서 `@`와 선택창을 연결했다. PPT 두 칸의 실제 사람 편집→저장→첫 참조→재첨부 없는 최신 후속과 원본 가림을 확인했다. 최종 단일 Linux **47/47**, 회귀 **63/63**, 전체 타입/빌드 통과. 로컬/이미지·첨부 복원·템플릿/doory·전 형식/OS 인수는 계속 남긴다. 근거 `office-document-references-native-06/verification.json`; 연구 판 `research:rr-e6e9abfeeec587137aae8e9d2f47aef0:a300e80dade495efb053fd3f867510fb4988576bcabae28ece610741303e5df5`.

2026-10-31 I09/I10/I11 추가: 원본7종의 로컬 파일·이미지 첨부와 재열기 표시/읽기 복원을 연결했다. 최신 로컬 원본·불변 업로드·같은 대화 기록·새 대화 분리를 확인하고 HWP 표시 누락을 보완했다. 문서 참조와 최종 단일 Linux **117/117**, 회귀 **85/85**, 전체 타입/빌드 통과. 입력은 Markdown/CSV/PNG이며 물리 OS 입력·전체 바이너리 형식·템플릿/스킬/doory·전체 OS 인수는 남는다. 근거 `office-local-files-native-06/verification.json`; 검증 판 `research:rr-b31c38482d609cd7a58ccd2c895f8d3a:db02746f1499818e05c808d4b0546cf18fcd6b226845afb237c13467e524dac9`.

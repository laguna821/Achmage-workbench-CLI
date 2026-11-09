# 세 조사 통합 coverage와 변경 의존관계

**계획 전용.** 제품 코드·원본문서·설정·빌드·테스트·PR·GitHub 배포를 실행하거나 변경하지 않았다. 아래 완료 조건은 모두 미래 검증이며, 문서 작성 완료를 제품 PASS로 계산하지 않는다.

## 범위와 추적 방식

현재 사용자 요청의 “전부”를 기준으로 Aside 핵심 웹 C01~C18, 외부 앱 X01~X03, HIG H01~H14와 S01~S15·D01~D14·F01~F11, Paseo F01~F36·PA01~PA18 및 E01~E08을 하나의 프로그램에 넣는다. 원래 Paseo 문서의 후보/별도 요청 표현은 이 통합 계획의 제외 근거로 사용하지 않으며, 원본문서의 ID와 문구는 그대로 보존한다.

HIG `F01`과 Paseo `F01`은 다른 항목이다. 기계 키는 `hig:F01` / `paseo:F01`로 만들고 originalId는 변경하지 않는다. Aside P0~P4, HIG W0~W6, Paseo P01~P07의 단계도 모두 연결했다. 출처의 A/I/D/T/V 참고자료 번호는 기능 수용 ID가 아니며, HIG 결정 D와 섞지 않는다.

총 **156개 원본 정의 → 25개 목적별 변경 단위**, **12개 명시적 회귀 묶음**, **내장 Office 9형식**을 연결했다. 원본 acceptance ID는 C 18 + X 3 + H 14 + PA 18 = **53개**다. [전체 기계 행렬](coverage.json)은 각 원문의 파일·줄·셀 내용·주 담당·관련 담당을 보존한다.

이 계획의 전부는 세 설계가 정한 기능과 이번에 편입한 E01~E08이다. 원문에서 별도 제품 동등성으로 제외한 브라우저 암호 관리자 전체·확장 스토어·프로필 동기화·클라우드 live migration을 새로 암묵 편입하지 않는다. 반대로 X01~X03이나 E07을 “나중 후보”로 빼고 전체 완료라고 선언하지 않는다.

## 25개 목적별 변경 단위

단위는 목적과 검증 책임의 경계다. 큰 단위의 세부 작업은 구현 계획에서 나눌 수 있지만 같은 UI·저장소·작업 조정자를 세 번 만들지 않는다. 특히 U08은 9형식 하위 체크를 각각 통과해야 완료다.

| 단위 | 목적·변경 범위 | 선행 | 완료 증거 |
|---|---|---|---|
| U01 기준판·지원 범위·시각/성능 계약 | 현재 설치본/설정/데이터 보존, S01~S15와 기존 command→새 진입점→shortcut 대응, 9형식 fixture, HIG W0 시안, 대상 OS/기기/성능 문턱 고정 | 없음 | 현재 SHA·설치본 식별·fixture 해시·before 화면/측정, 미확정 capability 및 후속 실증 목록 |
| U02 HIG 공통 UI와 접근성 | 기존 브랜드·서체·엔진별 룩 유지; 토큰·아이콘·버튼·메뉴·시트·focus·상태·light/dark·대비·reduced motion/transparency | U01 | 대표 상태 키보드·screenreader·200%·좁은 창; HIG 규칙 검사+시각 감사, 문서 캔버스 스타일 미변경 |
| U03 셸·프로젝트·탭·생성 흐름 | 홈/최근/프로젝트 개요·YAML 진입, 클릭/펼침 구별, 수동 생성 공통 action, 안정된 탭/분할·편집 집중·복귀·레이아웃 호환 | U02 | S01/S02/S06 실제 데이터 사용, AI 없이 문서/폴더/세션/웹 생성 진입, 초안·선택·작업 ID 보존 |
| U04 대화 읽기·스트림·검색 위치 | Markdown/표/코드/Mermaid·복사, 도구/턴 접기, reader anchor, 오래된 이력 paging/windowing·선택 유지·초안 | U02 | PA01/04/05와 H14 동일 fixture; 한글·이모지·긴 기록·완료 즉시 표시, 원문 검색 삭제 없음 |
| U05 이미지·artifact 정체성과 파일 결과 | 입력/도구/Markdown 이미지 통합, host/workspace path 검증, message/revision/hash media ref, gallery·원본·loading/error/expiry/eviction, MIME별 기존 편집기로 연결 | U04, U06 | PA02/03/05; 한글·공백 경로·같은 파일 덮어쓰기·느린 decode·첨부 실패·원격 인증, 과거 결과와 최신 파일 구별 |
| U06 공통 작업·자식·승인·전송 상태 | 기존 session/work/nativeSession 연결; task/run/parent와 native child 구분; provider capability·queue/steer/stop·plan/question/approval·durable receipt; 한 번의 부모 보고 | U01 | C06/07/11 및 PA04/06/07/12; 메인 비차단·중복/unknown·지원 불가 명시; UI별 재실행 없음 |
| U07 역할 프로필·모델 카탈로그·공통 API | E02; 조사/작성/코딩/검토 프로필, 실제 모델/사용량/메타데이터·사용자 모델; CLI/MCP/TypeScript SDK가 같은 권한·receipt·capability 사용 | U06 | F16/32/35; 프로필 변경은 다음 실행, 모델 발견/사용자 override 보존, API와 UI 결과·권한 동일 |
| U08 문서 셸과 9형식 내장 Office UI | S04/S05 한글·Word·슬라이드·시트·Markdown·PDF·HTML·마인드맵·EPUB 전부; narrow renderer adapter·theme message; 독립 AI와 메뉴/명령 대응 | U02, U03 | 형식별 편집/selection/Undo/dirty/save revision/내보내기/출력·원본 서식; 분할/테마/패널 변경 시 iframe 및 lease 유지 |
| U09 Office 작업의 UI 독립 실행 | 실행기 서버/iframe 의존 실증, 승인된 job/입력 snapshot/revision/task lease와 view presence 분리, writer 인계·외부 저장 충돌·부모 보고 | U06, U08, U16 | PA08의 문서 부분; UI 종료·재접속·미저장 상태·writer 만료·물리 파일 하나의 writer·기존 병렬 PDF/helper 회귀 |
| U10 Fast Find·휴먼볼트·Bases/그래프 | 단일 검색 엔진에 원문 prompt/reply/doc/vault 및 웹 child/url/artifact/host 참조; exact hit 위치; 읽기전용 볼트 navigation·YAML·보기/필터/선택 | U03, U04, U05, U06 | C15/H06/H07/PA16; 가상화된 원문 로드·Esc focus·볼트 뒤/앞/상위, human metadata/body bytes 무변경 |
| U11 설정·온보딩·이음·Dropbox·기록 가져오기 | S12/S13/S15; 독립 이음 설치/등록/열기/같은 파일 저장 복귀, Dropbox·볼트 연결, E03 CLI 기록/작업 추천, 보관·삭제·복구 의미 | U03, U07, U05 | H09/H13/C17/PA16; live session과 archive 구별·옛 지시 자동재개 없음; 외부저장/충돌·설정 보존·파일 보존 삭제 |
| U12 공유 웹 렌더러 OS 실증 | WebView2 우선, WKWebView/WebKitGTK driver 개별 검증 및 필요시 공통 renderer 대안; page/profile/DOM·팝업/파일·hide/bounds·IME/focus·앱 bridge 격리 | U01 | URL→동일 페이지 AI 제어→사람 인계→hide/show 전체 흐름; OS별 증거, 실패 원인·새 가설·대안 선택 기록 |
| U13 일반 웹 탭·프로필·다운로드 | Browser registry/pageId/profileId/navigationRevision, address/history/reload/stop/link/new tab·pin/clone/move·split/restore·site permissions·download | U02, U03, U12 | C01/02/03/10/12; 동일 URL 2개 정확한 대상, 로그인 유지·한글 focus, 외부 앱 UI와 권한 격리 |
| U14 같은 페이지 AI·사람 인계·Lightpanda | 공유 task coordinator의 page별 제어 owner·action boundary 인계·재관찰; 독립 sidebar child·부모 진행; LP 조사/새 시각 페이지 전환·artifact bridge | U06, U13, U05, U08, U10 | C04~C09/C11~C16·PA06; 웹2+문서1+메인 병행, 탭 숨김 지속, task별 executor 고정, DOM 소멸은 interrupted |
| U15 agent-desktop 외부 앱 어댑터 | 고정 CLI/hash/JSON envelope·capability·timeout/cancel; 앱/창 target·snapshot freshness·partial/unknown 결과; 물리입력 lease·사람 제어 조정 | U06 | X01~X03 실제 지원 OS/앱, niri 별도; 저장 결과 확인·stale ref 재관찰·불명 입력 중복 실행 없음 |
| U16 기존 Node host 독립 서비스 | start/status/stop/attach·owner identity·정상 종료·OS 시작 등록·desktop stdin 분리·resource lease·터미널/agent restart semantics | U06 | PA08 일반채팅·PA09/18; 창 hide/UI quit/service stop/crash/sleep/reboot 별도, 기존 프로세스 미채택·모든 작업 지속 과장 없음 |
| U17 기기 인증·복구·다중 호스트 연결 | device grant/revoke/rotation·protected transport·QR/relay/direct/VPN/desktop SSH; host epoch snapshot reset·unknown reconcile; 한 host 다기기 후 두 host | U05, U06, U16 | PA09~PA13/18; 동시 승인·응답 유실·host generation·외부망 복구·copied offer/revoke; 원격 비활성 로컬 사용; live migration 주장 없음 |
| U18 모바일 대화·파일·터미널 | native/PWA/공식 client 호환 bounded proof 후 경로 선택; phone/tablet·IME·safe area·회전·사진/공유·파일 결과·approval·background restore·CJK terminal | U02, U04, U05, U07, U09, U17 | PA13/14 및 F24/29 실제 iOS·Android; desktop와 동일 작업·초안/사진 identity·terminal selection/reconnect; UI 독립 Office는 U09와 통합 |
| U19 서비스 알림·push·정확한 이동 | UI 없는 producer·presence/read/attention·dedupe·generic push·native permission/token·deep link·host/task 이동·tray | U06, U14, U16, U17, U18 | C16/H10/PA15; desktop 종료 중 완료/승인 알림, warm/cold/open·기기 전환·중복 방지·민감 본문 기본 미포함 |
| U20 workspace 운영·개발 도구 | E01; local folder/worktree·setup/teardown·서비스 감독·포트/프록시·터미널·diff/conflict·GitHub·브라우저 배치; archive와 삭제 구별 | U03, U13, U16, U18 | H08/C18/F11/12/27/28/29; 대상 cwd/host 정확·비Git 문서 허용·충돌/포트·owned shutdown·mobile terminal U18 통합 |
| U21 예약·heartbeat의 지속 서비스 실행 | E04; 기존 scheduler 재사용·새 run/기존 session wake 구별·due/expiry/pause/end·missed policy·receipt·상태 화면 | U06, U16 | F31; 재시작/clock/중복 tick/승인대기/일시중지·기한·종료; UI가 없어도 명시된 정책대로 동작 |
| U22 한국어 받아쓰기·선택 음성 대화 | E05; 한국어 STT/model 선택·별도 다운로드·모바일 음성/사진 입력·선택 TTS/voice conversation·cancel/권한·비용 표시 | U07, U18 | F30; 실제 한국어 fixture·정확도/latency/모델 크기·offline/online 범위·작업 중 입력/중지·무음 설정·기본 설치 크기 분리 |
| U23 선택 실행 플러그인·라이브러리 UI | E06; tool/screen/provider extension lifecycle·version/scope·device capability·enable/disable/rollback; 기존 skills/templates/knowledge/image/convert 진입 유지 | U06, U07, U16, U18 | F33/S14/H08; OS skill 검색·ingest와 코드 설치/실행 분리, 권한 boundary·업데이트 실패 복구·모바일 capability |
| U24 외부 이벤트 Hub | E07; GitHub/Slack/Discord 등 선택 connector→검증 event→중복키→대상 제한 workflow; credential local·기한/pause/audit·모델 작업 dispatch | U07, U16, U17, U21, U23 | F36; signed/verified event·redelivery·unknown reconcile·잘못된 대상 거부·실제 연결별 E2E; 단순 webhook 수신만으로 완료 아님 |
| U25 버전 호환·업데이트·전체 GitHub 배포 | E08; stable/trial channel·client/daemon protocol·데이터 migration/rollback·활성 작업 보존·설치/upgrade/remove·GitHub CI/artifact/tag/release provenance | U25a는 U01; U25b는 U01-U24 | 전체 C/H/PA/X·모든 E/F·9 Office formats·REG 통과, 실제 각 지원 OS 설치본+모바일 증거·SHA/hash·release asset 검증 |

## 중복 구현을 막는 공통 책임

- 한 셸과 action registry: HIG W2, Aside 생성·탭, Paseo 대화·작업 목록은 U02~U06에 합친다.
- 한 task/run/parent/receipt 계약: U06이 일반 채팅·Office·웹·외부 앱의 공통 상태를 소유하고 U09/U14/U15는 대상별 실행기·lease만 추가한다.
- 한 artifact/media 계약: 이미지·웹 다운로드·문서·원격 파일은 U05에서 host/workspace/revision/hash를 연결한다.
- 한 Fast Find와 provenance: U10이 원문 프롬프트와 정확한 source target을 유지하며 별도 검색 DB·세션 DB를 추가하지 않는다.
- 한 알림 producer: C16/H10/PA15는 U19가 공통 완료 ID·attention·읽음·deep link를 처리한다.
- 한 실행 host: 기존 Node를 U16에서 독립시킨다. 외부 Paseo daemon이나 공식 client adapter는 U18의 제한 실증 결과가 기존 문서/권한/기록을 보존할 때만 선택하며 두 backend를 기본 의무로 만들지 않는다.
- 기존 예약·프로필·온보딩·모델 목록·worktree·이음/Dropbox는 이미 있는 경로를 발전시킨다. “새 구현 필요”와 “현재 기능 회귀 검증”을 구별한다.

## 실행 의존과 중간 전달

통합 계획 보정. U25a의 후보 빌드·provenance 인프라는 U01 뒤에 시작한다. U25b의 최종 호환·승격만 U01-U24 전체 완료를 기다린다. 기계 행렬 executionGraph는 25개 요구 소유 단위를 26개 실행 노드로 표현하며, units.dependsOn은 단위 완료의 선행 조건이다. A/B/C/D 중간 설치본은 U25b를 기다리지 않는다.

핵심 선행은 U01 → U02 → U03/U04 → U05이고, U06 → U16 → U17 → U18 → U19가 실행/모바일 축이다. U12 → U13 → U14가 공유 웹 축이며 U06을 함께 사용한다. U08+U16+U06 → U09가 UI 없는 Office 축이다. 서비스가 생겼다는 이유만으로 Office 실행기·미저장 상태·writer 인계가 해결됐다고 계산하지 않는다.

권장 병렬 탐색은 U01 이후 공통 UI(U02), task 계약(U06), renderer 실증(U12)이다. UI 대규모 개편이 공유 웹 실증을 기다릴 필요는 없지만 U13/U14의 완료는 실제 renderer proof를 통과해야 한다. 무거운 실행은 승인된 작업 단계에서 실제 work/session의 resource 예약·안정 launcher를 통해 수행한다.

| 전달 | 사용자에게 확인할 결과 | 전체 종료와의 관계 |
|---|---|---|
| 중간 A | U02~U06의 홈/프로젝트·대화·이미지·문서 집중 진입을 실제 데이터로 쓰는 설치본 | 미완료 C/H/PA/E/Office 형식을 그대로 표시 |
| 중간 B | 공유 웹(U12~U14), 내장 Office UI(U08), 자료/검색(U10), 이음/Dropbox(U11), 외부 앱(U15)의 검증된 범위 | 외부 앱·OS 미검증을 실제 지원처럼 표시하지 않음 |
| 중간 C | 독립 서비스·문서 지속·기기 연결·모바일·push(U09/U16~U19) | 일반 chat 지속과 모든 문서 지속을 따로 보고 |
| 중간 D | workspace·프로필·import·예약·음성·플러그인·Hub 등 E01~E07의 완료 | 선택 사용 기능도 전체 프로그램 구현·검증 범위에서 제외하지 않음 |
| 전체 | U25 stable/trial 업데이트·버전 호환·rollback과 모든 원본 ID/회귀/9형식 실설치 증거 | 첫 설치본, CI green, 버전 상승만으로 전체 종료하지 않음 |

U25의 CI/릴리즈 설계는 U01부터 준비할 수 있으나 최종 릴리즈 승격은 앞선 모든 범위의 증거가 필요하다. 버전 숫자는 root가 저장소의 현행 태그·워크플로를 확인한 뒤 정하며 이 coverage 메모는 임의 버전이나 플랫폼 성공을 약속하지 않는다.

## 원본 acceptance coverage

| 원본 ID | 원문 시나리오/종료 조건 | 주 담당; 관련 |
|---|---|---|
| aside:C01 | 프로젝트에서 `+`와 우클릭 사용 — 새 세션·지원 문서·폴더·웹 탭이 보이고 AI 없이 생성 가능 | U03, U13 |
| aside:C02 | 웹을 일반 브라우저처럼 사용 — 주소 입력, 뒤로/앞으로, 새로고침·중지, 링크·새 탭이 올바른 페이지에 적용 | U13 |
| aside:C03 | 분할·탭 이동·동일 URL 두 개 — pageId를 혼동하지 않고 한글 입력·크기·포커스가 유지 | U12, U13 |
| aside:C04 | 로그인 후 이 페이지의 AI 요청 — 사람과 AI가 동일 프로필의 **같은 살아 있는 페이지**에서 작업 | U14 |
| aside:C05 | 사이드 AI 실행 후 다른 탭 이동 — 작업이 계속되고, 돌아오면 같은 대화·진행·결과가 보임 | U14, U06 |
| aside:C06 | 웹 2개와 문서 1개에 작업, 메인에도 요청 — 독립 세션으로 실행; 탭 전환으로 쓰기 권한 오류/취소가 발생하지 않음 | U14, U08, U06 |
| aside:C07 | 부모 세션에서 자식 진행 확인 — 부모 입력을 막지 않고 진행 카드와 완료 맥락이 전달; 중복 실행 없음 | U06, U14 |
| aside:C08 | AI 작업 중 사람이 개입하고 재개 — 진행 중 행동 경계에서 인계, 사람 입력을 덮지 않음; 재관찰 후 계속 | U14 |
| aside:C09 | 같은 페이지에 두 작업의 변경 요청 — 변경 작업을 조정하고 다른 페이지의 작업은 진행 가능 | U14 |
| aside:C10 | 팝업·다운로드·사이트 권한 발생 — 대상 탭/프로필을 보존하고 다운로드가 올바른 프로젝트에 등록 | U13, U05 |
| aside:C11 | 실행 중 탭 닫기·명시적 중지 — 숨김과 중지를 구별; 중지는 자식 실행까지 끝내며 종료 이벤트 중복 없음 | U14, U06 |
| aside:C12 | 앱 종료·재시작 — 대화·탭 기록 복원; 살아 있지 않은 DOM 작업은 중단 상태로 정확히 표시 | U13, U14, U16, U25 |
| aside:C13 | 공개 자료 조사를 메인에서 요청 — LP 경로로 수집하고 출처·결과를 반환; 불필요하게 화면을 열지 않음 | U14 |
| aside:C14 | LP 결과를 사람이 웹 탭에서 확인 — 새 렌더링 페이지임을 구별; 기존 로그인·폼이 자동 복제됐다고 표시하지 않음 | U14, U13 |
| aside:C15 | Ctrl+K에 원문 프롬프트 일부 입력 — 사이드/메인 요청 원문 모두 검색되고 해당 대화로 이동 | U10, U04, U14 |
| aside:C16 | 다른 탭에서 작업 완료·입력 필요 — 정책에 따른 알림 1회, 클릭 시 해당 작업/탭으로 이동 | U19, U06, U14 |
| aside:C17 | 결과 파일을 편집기→이음오피스에서 저장 — 돌아와 최신 내용을 읽고 같은 프로젝트의 다른 세션도 결과를 찾음 | U05, U08, U11 |
| aside:C18 | 기존 프로젝트·문서·볼트·worktree 흐름 — 개요 진입·문서 집중 모드·볼트 이동 유지; 다른 worktree 결과를 동일 파일로 혼동하지 않음 | U03, U08, U10, U20 |
| aside:X01 | 지원 OS에서 지정 앱 관찰·한 가지 수정·저장 — 정확한 앱/창을 선택하고 저장 결과를 별도로 확인 | U15 |
| aside:X02 | stale ref·부분 snapshot·불확실한 입력 결과 — fresh observation과 안전한 재시도로 처리; 중복 저장/전송 없음 | U15 |
| aside:X03 | 사용자 조작·다른 작업과 경합 — 포커스·포인터 정책과 대상 앱 소유권을 지키고 미지원 기능을 정확히 표시 | U15 |
| hig:H01 | 프로젝트 이름/펼침/폴더/대화/문서의 역할이 구분되고 이름 클릭으로 개요에 진입 | U03 |
| hig:H02 | 생성 기능을 상단·프로젝트 메뉴·키보드에서 찾고 AI 없이 문서/세션/폴더 생성 | U03, U08 |
| hig:H03 | 문서 집중과 메인 복귀 시 필요한 도구와 입력이 복원; OS 전체 화면을 임의로 바꾸지 않음 | U03, U08 |
| hig:H04 | 여러 문서 AI와 메인 세션을 병행; 탭/분할/테마/패널 변경이 작업·쓰기 권한을 끊지 않음 | U08, U06, U09 |
| hig:H05 | 형식별 기존 메뉴/명령 대응표의 누락 없음; 편집·저장·Undo·출력과 실제 문서 서식 보존 | U08 |
| hig:H06 | Ctrl+K 원문 프롬프트·답변·문서·볼트 검색과 원문 위치 열기, 범위 표시가 유지 | U10, U04 |
| hig:H07 | 볼트 뒤/앞/상위와 읽기 전용, Bases/그래프 선택·필터 및 프로젝트 YAML 값 보존 | U10, U03 |
| hig:H08 | worktree·터미널·GitHub 검토 등 현재 노출된 기존 기능의 새 진입점이 있고 대상 workspace가 정확 | U20, U23 |
| hig:H09 | 이음오피스 독립 설치/열기/저장/복귀와 Dropbox·모델·외형·단축키 설정 유지 | U11, U07, U02 |
| hig:H10 | 완료/실패/입력 필요를 구분, 알림 중복 없음, 알림에서 정확한 작업으로 이동 | U19, U06 |
| hig:H11 | 키보드만으로 핵심 흐름 가능, 초점 표시·순서·대화상자 닫기·원위치 복귀, 스크린리더 이름 검증 | U02, U25 |
| hig:H12 | light/dark·대비·움직임/투명도 줄이기·200% 글자 확대와 좁은 창에서 내용/제어가 잘리지 않음 | U02, U08, U18, U25 |
| hig:H13 | 이전 설정·프로젝트·레이아웃을 실제 설치본에서 열고, 재시작 후 저장 상태와 작업 결과가 일관됨 | U25, U11, U03, U16 |
| hig:H14 | 같은 fixture로 대화 스트림·검색·탭 이동의 전후 시간/메모리 측정. 큰 회귀는 원인과 근거 없이 수용하지 않음 | U01, U04, U10, U25 |
| paseo:PA01 | 원문 질문·답변·표·코드·Mermaid를 읽고 부분 복사하며, Ctrl+K로 원문 프롬프트 위치로 돌아옴 | U04, U10 |
| paseo:PA02 | 한글·공백 경로의 사용자 첨부와 AI 생성 이미지를 대화에서 확대·원본 확인 | U05 |
| paseo:PA03 | 같은 이름의 이미지가 바뀌어도 과거 메시지 당시 결과와 최신 파일을 구분 | U05 |
| paseo:PA04 | 작업 로그를 접어도 실패·승인·최종 결과·원문 검색이 보존됨 | U04, U06, U10 |
| paseo:PA05 | 과거 메시지 로드·이미지 디코딩·도구 펼침·새 토큰 수신 중 읽던 줄과 선택 유지 | U04, U05 |
| paseo:PA06 | 메인 대화와 문서/웹 자식 작업 여러 개가 병행되고 개별 결과·후속 지시를 식별 | U06, U08, U14 |
| paseo:PA07 | 공급자 내부 자식과 Workbench 자식을 구분. 지원하지 않는 제어를 성공처럼 표시하지 않음 | U06 |
| paseo:PA08 | UI 종료 뒤 승인된 일반·문서 작업이 유지되고 휴대폰 또는 재실행 UI에서 확인 | U09, U16, U17, U18 |
| paseo:PA09 | daemon 재시작·토큰 변경·호스트 실행 세대 변경 뒤 snapshot·요청 상태를 복구. 결과 불명 요청을 보존·조회하고 프롬프트를 무조건 재실행하지 않음 | U16, U17 |
| paseo:PA10 | 같은 프로젝트·파일 이름이 있는 PC 두 대에서 실행 위치와 결과가 섞이지 않음 | U17, U20 |
| paseo:PA11 | 기기 등록·권한 변경·회수 후 서버가 실제로 새 접근을 허용하거나 거절 | U17 |
| paseo:PA12 | 두 기기에서 같은 요청을 보내거나 승인해도 동작이 한 번만 접수·실행 | U06, U17 |
| paseo:PA13 | 휴대폰 앱 전환·잠금·Wi-Fi/셀룰러 변경 후 최신 작업 상태로 복구 | U17, U18 |
| paseo:PA14 | iOS·Android에서 한글 입력·사진 첨부·긴 표·복사·승인·파일 결과 확인 가능 | U18, U05 |
| paseo:PA15 | 데스크톱 UI 없이 완료/승인 알림 수신. 알림을 열면 올바른 호스트·작업으로 이동 | U19 |
| paseo:PA16 | 기존 편집 집중·문서 병렬 AI·외부 이음 저장 재인식·Dropbox·볼트·Fast Find 유지 | U08, U09, U10, U11, U25 |
| paseo:PA17 | 동일 fixture로 시작·입력·스트림·긴 기록·이미지·메모리를 기준판과 비교해 회귀 기준 통과 | U01, U04, U05, U18, U25 |
| paseo:PA18 | 원격 연결 비활성 상태에서 기존 로컬 사용 가능. 앱/daemon 버전 차이를 안내하고 저장 데이터 보존 | U17, U25, U16 |

## Paseo 발견 F01~F36 및 후보 E01~E08

| 원본 ID | 기능/후보 | 담당 |
|---|---|---|
| paseo:F01 | 대화 답변과 도구 실행 기록의 위계 | U04 |
| paseo:F02 | 보낸 이미지와 AI가 참조한 로컬 이미지의 대화 내 표시 | U05 |
| paseo:F03 | 이미지 확대·이전/다음·원본 확인 | U05 |
| paseo:F04 | Markdown 표·코드·링크·Mermaid의 전용 표현 | U04 |
| paseo:F05 | 문장 선택·부분 복사와 모바일 텍스트 선택 | U04, U18 |
| paseo:F06 | 스트리밍 중 읽던 위치 보존 | U04 |
| paseo:F07 | 긴 기록을 다루는 렌더·전송 제어 | U04 |
| paseo:F08 | 질문·승인·계획을 실행 가능한 UI로 표시 | U06 |
| paseo:F09 | 지금 지시·대기열·취소를 구분 | U06 |
| paseo:F10 | 검색·대화 위치 이동·입력 초안의 연속성 | U10, U04, U18 |
| paseo:F11 | 프로젝트 안의 workspace가 작업의 안정적인 단위 | U03, U20 |
| paseo:F12 | 기존 폴더와 Git worktree 중 격리 선택 | U20 |
| paseo:F13 | 여러 공급자의 에이전트 생성·지시·결과 수집 | U06 |
| paseo:F14 | Workbench형 자식 세션과 공급자 내부 자식의 구분 | U06 |
| paseo:F15 | 하위 작업을 별도 track에서 열고 관리 | U06 |
| paseo:F16 | 역할별 에이전트 프로필과 선택 설명 | U07 |
| paseo:F17 | 다른 호스트의 작업 생성·후속 지시 | U17 |
| paseo:F18 | 상태별 작업 목록·미확인 결과·입력 필요 표시 | U06 |
| paseo:F19 | 여러 클라이언트가 같은 daemon 작업을 봄 | U17, U18 |
| paseo:F20 | QR·링크를 통한 연결과 relay 경로 | U17 |
| paseo:F21 | 직접 연결·VPN·SSH 등 연결 선택 | U17 |
| paseo:F22 | 연결 복구와 기록 이어 받기 | U17 |
| paseo:F23 | 완료·승인 대기 push와 해당 작업 이동 | U19 |
| paseo:F24 | 폰·태블릿에 맞춘 레이아웃과 키보드 처리 | U18 |
| paseo:F25 | 데스크톱 없이 서버에서 실행 | U16, U09 |
| paseo:F26 | daemon 재시작 후 터미널 보존·에이전트 복구 | U16, U20, U25 |
| paseo:F27 | 작업 공간별 setup·teardown·상주 서비스·포트 배정·프록시 | U20 |
| paseo:F28 | 파일·diff·터미널·브라우저를 같은 workspace에 배치 | U20, U13, U03 |
| paseo:F29 | 모바일 터미널의 한글·CJK·선택·재접속 기록 | U18, U20 |
| paseo:F30 | 음성 받아쓰기와 음성 대화 | U22 |
| paseo:F31 | 새 에이전트를 만드는 예약과 기존 대화를 깨우는 heartbeat | U21 |
| paseo:F32 | CLI·MCP·TypeScript SDK의 공통 실행 기능 | U07 |
| paseo:F33 | daemon 플러그인이 모바일에도 기능을 제공 | U23 |
| paseo:F34 | 기존 CLI 기록 불러오기와 프로젝트 추천 | U11 |
| paseo:F35 | 모델·공급자 카탈로그·계정 사용량·메타데이터 생성 | U07 |
| paseo:F36 | Hub의 외부 이벤트·워크플로, 안정/베타 업데이트 | U24, U25 |
| paseo:E01 | E01 작업 공간 운영 — 폴더/worktree 의미 정리, 준비 명령, 서비스·포트·터미널, diff·브라우저 배치 | U20, U18 |
| paseo:E02 | E02 역할 프로필·capability — 조사·작성·코딩·검토 설정 묶음과 설명, 실제 모델 목록, 공통 CLI/MCP API | U07 |
| paseo:E03 | E03 초반 온보딩·기록 가져오기 — 기존 CLI의 작업 폴더·기록 추천, 실행 가능한 세션과 보관 기록 구분 | U11 |
| paseo:E04 | E04 예약·heartbeat — 현재 예약 엔진을 독립 서비스와 연결, 새 실행·기존 대화 재개 구분 | U21 |
| paseo:E05 | E05 한국어 음성 — 받아쓰기, 선택적 음성 대화, 기기에서 사진·음성 전달 | U22 |
| paseo:E06 | E06 플러그인 — 선택적 도구·화면·provider 확장 | U23 |
| paseo:E07 | E07 외부 이벤트 Hub — GitHub·Slack·Discord 같은 외부 사건에서 작업 시작 | U24 |
| paseo:E08 | E08 업데이트 운영 — 안정/시험 채널, 클라이언트·daemon 버전 호환, 복구 경로 | U25 |

## HIG 화면·흐름·결정과 원래 단계

| 원본 ID | 원문 제목/내용 | 담당 |
|---|---|---|
| aside:P0 | P0. 렌더러 실증 | U12 |
| aside:P1 | P1. 일반 웹 탭 | U13 |
| aside:P2 | P2. 탭 AI와 작업 수명 | U14, U06 |
| aside:P3 | P3. 기존 기능 연결 | U05, U10, U11, U19 |
| aside:P4 | P4. 외부 앱 조작 | U15 |
| hig:W0 | W0 현재 기준과 대표 시안 | U01 |
| hig:W1 | W1 공통 UI | U02 |
| hig:W2 | W2 셸·프로젝트·대화 | U03, U04, U05, U06 |
| hig:W3 | W3 문서와 편집기 내부 | U08 |
| hig:W4 | W4 나머지 화면 | U10, U11, U20, U23 |
| hig:W5 | W5 통합 마감 | U25 |
| hig:W6 | W6 공유 웹 연결 | U12, U13, U14 |
| hig:S01 | S01 시작/최근 작업 | U03, U11 |
| hig:S02 | S02 프로젝트 개요 | U03, U10 |
| hig:S03 | S03 메인 대화 | U04, U05, U06 |
| hig:S04 | S04 문서 작업 셸 | U08, U09 |
| hig:S05 | S05 형식별 편집기 내부 | U08 |
| hig:S06 | S06 나란히 작업 | U03, U08, U13 |
| hig:S07 | S07 자료·볼트·보기 | U10 |
| hig:S08 | S08 통합 검색 | U10 |
| hig:S09 | S09 공유 웹 탭 | U13, U14 |
| hig:S10 | S10 worktree·변경 검토 | U20 |
| hig:S11 | S11 터미널 | U20, U18 |
| hig:S12 | S12 설정 | U11, U07, U02 |
| hig:S13 | S13 온보딩·설치·연결 | U11 |
| hig:S14 | S14 라이브러리·보조 작업 | U23, U21, U22 |
| hig:S15 | S15 보관·삭제·복구·공통 피드백 | U11, U19, U25 |
| hig:F01 | F01 시작·복귀 | U03, U11, U25 |
| hig:F02 | F02 프로젝트 | U03, U10 |
| hig:F03 | F03 수동 새 문서 | U03, U08 |
| hig:F04 | F04 병렬 AI | U06, U08, U09 |
| hig:F05 | F05 문서·외부 앱 | U08, U11 |
| hig:F06 | F06 통합 검색 | U10, U04 |
| hig:F07 | F07 볼트 | U10 |
| hig:F08 | F08 Bases·그래프 | U10 |
| hig:F09 | F09 변경 검토 | U20, U06 |
| hig:F10 | F10 연결·설정 | U11, U07 |
| hig:F11 | F11 웹 작업 | U13, U14 |
| hig:D01 | D01 탐색과 내용 목록 분리 | U03, U10 |
| hig:D02 | D02 열린 작업 탭 유지 | U03, U13 |
| hig:D03 | D03 생성 진입점 노출 | U03 |
| hig:D04 | D04 편집 집중 기본 | U03, U08 |
| hig:D05 | D05 속성과 AI 대화 분리 | U08, U13 |
| hig:D06 | D06 대화의 내용 우선 | U04 |
| hig:D07 | D07 상태와 제어 표시 | U06, U19 |
| hig:D08 | D08 검색은 한 진입점 | U10 |
| hig:D09 | D09 현재 대상의 도구 | U03, U08, U20 |
| hig:D10 | D10 파괴성과 복구 가능성 구별 | U11, U25 |
| hig:D11 | D11 설정을 작업 옵션과 분리 | U11, U07 |
| hig:D12 | D12 같은 자료의 보기만 전환 | U10 |
| hig:D13 | D13 내용과 앱 장식을 분리 | U08, U09 |
| hig:D14 | D14 설정 전에 가치 제공 | U11 |
| paseo:P01 | P01 대화 읽기 | U04, U10 |
| paseo:P02 | P02 결과물 연결 | U05 |
| paseo:P03 | P03 작업 현황 | U06 |
| paseo:P04 | P04 독립 실행 | U16, U09 |
| paseo:P05 | P05 기기 연결 | U17 |
| paseo:P06 | P06 모바일 작업 | U18 |
| paseo:P07 | P07 모바일 알림 | U19 |

## 반드시 명시적으로 통과할 회귀

| 추적 묶음 | 보존할 동작 | 담당 |
|---|---|---|
| REG01 | 내장 Office 9형식 내부 UI·기존 명령·선택·Undo·dirty/revision·저장·출력·실제 문서 서식 | U08, U09, U25 |
| REG02 | 메인+복수 문서/PDF helper 병행; tab/split/theme/panel 변경 시 remount·lease 취소 없음 | U06, U08, U09, U25 |
| REG03 | 독립 공식 이음 설치/등록/열기/같은 파일 수정/저장/Workbench 복귀·최신 맥락·외부 충돌 보존 | U08, U11, U25 |
| REG04 | Dropbox 기존 연결·같은 실제 파일 감시·다른 host 경로 구별; live DB/credential은 로컬 | U05, U11, U17, U25 |
| REG05 | Fast Find 메인·side·문서·vault 원문 prompt/reply 검색·exact hit; 접기/가상화로 원문 삭제 없음 | U04, U10, U14, U25 |
| REG06 | 휴먼볼트 원문 read-only, YAML key(콜론 포함)/scalar-list/empty-unknown/body bytes·기존 링크/태그/source metadata 무변경 | U10, U11, U25 |
| REG07 | 프로젝트 YAML·노트·Bases/graph 집합·필터·선택·볼트 뒤/앞/상위·분할별 이동 유지 | U03, U10, U25 |
| REG08 | workspace/worktree 실제 저장 위치·Git/비Git·diff/conflict/GitHub·터미널·원본 보존; archive≠삭제 | U13, U17, U20, U25 |
| REG09 | 실제 모델 발견·사용자 override·브랜드/폰트/테마/엔진룩·Ctrl+S/Ctrl+K·단축키·권한 설정 보존 | U02, U07, U11, U25 |
| REG10 | 이전 설치 데이터/레이아웃/초안 복원·중단/unknown 정확표시·새 버전 migration/rollback·파일 보존 | U03, U16, U17, U25 |
| REG11 | Windows/macOS/Linux(현재 niri 포함) 실제 focus/IME/DPI/keyboard/screenreader; iOS/Android 사진·회전·복귀 | U02, U12, U15, U18, U25 |
| REG12 | 동일 SHA/fixture/장치의 시작·검색·탭·입력·스트림·이미지·메모리; 본체/이음/선택모델/cache 크기 분리 | U01, U04, U05, U18, U25 |

**Office 형식별 완료표는 9개 모두 별도로 유지한다:** 한글, Word, 슬라이드, 스프레드시트, Markdown, PDF, HTML, 마인드맵, EPUB. 각 형식은 기존 command→새 진입점→단축키→검증, 실제 파일의 편집/저장/출력 및 원본 표현을 확인한다. PDF/OCR/번역·EPUB·HTML·마인드맵을 Word/HWP 셸 검증으로 대신하지 않는다. 외부 독립 이음 앱 자체를 포크하는 것은 포함하지 않으며 설치·연동·파일 왕복은 필수다.

## 계획에서 빠뜨리기 쉬운 종료 관문

1. C12의 사라진 DOM은 interrupted가 맞고 PA08의 승인된 문서 job은 유지되어야 한다. 실행기가 UI에 필요한지에 따라 구별하며 모순을 숨기기 위해 “모든 작업 지속”이라고 합치지 않는다.
2. PA11은 기기 목록 삭제가 아니라 서버에서 해당 기기의 접근을 거절하는 결과이며, PA12는 전송 receipt와 승인 경쟁을 포함한다. 외부 side effect 결과가 불명확하면 unknown을 보존하며 무조건 exactly-once라고 주장하지 않는다.
3. 한 host 다기기 실증 → 두 host 경로/결과 분리 → 외부망 pairing/revoke/reconnect 순서다. Dropbox 파일 동기화를 live DB·credential·process migration으로 사용하지 않는다.
4. H05는 바깥 CSS 완성이 아니라 모든 renderer 내부 메뉴/도구/대화상자까지다. 테마 변경으로 iframe을 재마운트해 AI나 Undo가 끊기는 최적화는 회귀다.
5. X01~X03은 agent-desktop ok=true, 부분 snapshot, 입력 delivery와 실제 저장 성공을 구별한다. 현재 niri는 GNOME 지원 주장으로 통과시키지 않는다.
6. E05는 영어 기본 STT를 한국어 지원으로 계산하지 않는다. E06은 OS skill ingest와 실행 plugin 활성화를 구별한다. E07은 connector 검증·중복 event·대상 권한·재시도·기한이 동작해야 하며 webhook 수신 스크린샷만으로 완료하지 않는다.
7. native provider child는 공급자가 제공하는 제어만 노출한다. 정규화된 관찰만 가능한 작업에 실행 가능한 세션이라고 표시하지 않는다.
8. OS별 unsupported 항목은 증거와 대안을 남긴다. 합의한 지원 범위를 줄여 체크를 지우거나 중간 빌드를 전체 완료로 바꾸지 않는다. 필요한 기기/계정 검증은 미래 실행의 gate로 남고 계획 작성 자체를 막지는 않는다.

## 출처와 이번 문서 검사

원본 Markdown 22개와 source metadata JSON 3개를 읽거나 구조 파싱한 범위는 [파일 해시](source-files.sha256.json)에 구분했다. 원문 제품 파일과 연구 문서는 수정하지 않았다. 외부 원문을 다시 조사하거나 앱/서비스를 실행하지 않았다.

정확한 연구 revision:

- `research:rr-dd53e234a77f3fe9e4e3afc62aea3018:2807fc5a0c540680000deb85ab0ea25cb53a6ffa89a4c436c9317c7a19b08ea9`
- `research:rr-da5ca50fa3e6593f1a243cce69cc5ed7:36aff60113a7574e1b41bb9ce53999de1ae9a325cde9fe73abf3304c122323f7`
- `research:rr-b3a4efd5af5ac21ca608ac4ce17dd71d:89fcdaee6e62df01c31f9f4c56c19d9916acab297f64b1b42cd5b67317e03ad5`

이번 검사는 원본 정의 156개가 모두 매핑되고 ID 중복/누락이 없으며 변경 단위 25개의 의존관계에 cycle이 없다는 문서 구조 검사다. 제품 테스트·성능·설치·OS/모바일 성공을 의미하지 않는다. source hash는 이 메모를 작성할 때 읽은 상태를 고정한다.

통합 구현 검토 보정. U05는 U06이 정의하는 TaskRef를 소비하므로 U04와 U06 모두를 선행으로 한다. 원본 요구 ID와 담당 단위는 유지한다.

통합 구현 검토 보정. U11의 ArtifactRef 사용 때문에 U05를 선행에 추가했다. U14의 실제 웹 결과→Office/Fast Find 흐름은 U05/U08/U10을 기다린다. U10은 먼저 실제 검색 UI에 계약 fixture를 넣어 검증하고, 실제 웹 실행 연동은 U14, 기기 권한 end-to-end는 U17에서 검증한다.

Root interface review 보정. U18의 공유 client와 실제 Office 지속 검증은 U07/U09를, U19의 실제 웹 deep link는 U14를, U20의 웹 배치와 모바일 터미널 완료는 U13/U18을 선행으로 한다. U20 서비스 코드 작성은 U03/U16 이후 먼저 시작할 수 있다. 기기 연결용 얇은 probe와 모바일 UX, 플랫폼 push capability와 최종 notification producer는 별도 증거다.

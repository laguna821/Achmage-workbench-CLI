# 0.4.0 실행 상태

2026-11-09. **남은 기능을 구현하고 전체 기능 연결 뒤 통합 빌드·릴리즈한다.** 기능 추가마다 production/설치본 빌드를 반복하지 않는다. 다음 후보 CI는 취소했다. 필요한 동작 확인은 묶음당 한 번, 실제 실패는 해당 부분만 수정·재확인한다.

| 기능 묶음 | 현재 코드 | 근거와 남은 범위 |
|---|---|---|
| S0 대화 원문 우선 검색 | 구현 | `93837f8` — 프롬프트/AI 원문을 문서·볼트보다 먼저 표시 |
| U02 공통 UI | 구현 | `abf4f68` — 키보드 이동·초점 복귀·HIG 컨트롤 |
| U03 생성·프로젝트·탭 | 주요 흐름 구현 | `abf4f68`, `a3d9683`, `e056d8b` — 9종 문서·실제 폴더 생성, 정리 폴더 구분 |
| U04 대화·초안 | 구현 | `abf4f68` — 읽기 위치·검색 원문 펼침·초안 보호 |
| U05 그림 결과 | 주요 흐름 구현 | `53c60ce` — 당시 이미지 보존·로컬 미리보기·갤러리. 원격 미디어/전체 파일 연동 남음 |
| U06 작업 목록·명령 | 주요 흐름 구현 | `22166e5`, `498a710` — 독립 문서·하위 작업과 공통 접수. 공급자 하위 작업은 관찰만 지원 |
| U07 역할·CLI/MCP API | 구현 | `9239725`, `498a710` — 역할 CRUD·요청 당시 설정 보존·공통 receipt |
| U08 9형식 Office UI | 주요 흐름 구현 | `b40fb38` — 원본 명령 메뉴·theme 전달. 전체 native OS 사용 확인은 통합 때 |
| U09 Office UI 독립 실행 | 8종 독립 adapter + 공통 질문·출력 코드 연결 | `aa6779d`, `f89fd18` 및 후속 R37 — 원본 Markdown/Word/한글/Sheets/PDF/HTML/XMind/EPUB send·선택·질문, 기존 요청/저장/재접속 연결. 슬라이드는 adapter가 있으나 queue/QC 수명 때문에 ui-required 유지. native 출력 서비스·실제 OS 실행은 남음. [범위](../../office-execution.md) |
| U10 검색·Bases·그래프 | 주요 흐름 구현 | `e056d8b` — 검색 취소 복귀·다중선택/일괄 보관·그래프 키보드 이동 |
| U11 설정·가져오기 | 주요 흐름 구현 | 기존 이음/Dropbox 흐름 유지, `18bac42` 과거 기록/실행 구분·원문 보존. 전체 온보딩 통합 남음 |
| U12–U14 공유 웹·같은 페이지 AI | 핵심 코드 구현 | `2df5f41`, `1c5e688` — 네이티브 웹 탭·주소 이동·독립 웹 AI·사람 인계·숨김 유지·대상/문서/제어권 식별. 다운로드·사이트 권한·macOS 프로필·산출물 및 실제 OS 화면 확인은 남음. [범위](../../shared-browser.md) |
| U15 외부 앱 조작 | 남음 | agent-desktop 연결 |
| U16 독립 host | 주요 흐름 구현 | `4924188` — 창 종료 뒤 지속·재접속·epoch·선택 로그인 시작. AppImage 지속 runtime 남음 |
| U17–U18 기기·모바일 | 원본 보안 전송 반입·endpoint API 구현 | Paseo relay 전체 원본과 host/client protected 연결 코드. 실제 listener·기기 권한·모바일 UX 연결 남음. [재사용 실행표](PASEO-REUSE.md) |
| U19 서비스 알림 | 주요 흐름 구현 | `9c56e75`, `573eebf` — host의 영구 기록·중복 방지·읽음/승인 분리·정확한 세션/문서 원문 이동. 모바일 push와 OS 클릭 연동 일부 남음 |
| U20 workspace 운영 | 주요 흐름 구현 | `2462057`, `83a908b` — owned 서버 실행·포트 충돌·출력 재사용·정확한 소유 실행 종료와 UI 연결. 원격 포트 프록시·모바일 터미널·로그 검색 남음 |
| U21 예약 | 주요 흐름 구현 | `1a39d77` — occurrence 기록·timezone·횟수/기한·미실행 정책·unknown 재전송 방지 |
| U22–U24 음성·플러그인·Hub | 원본 반입 범위 확정, 연결 남음 | 통합 범위 유지. Paseo 음성·SDK·manifest·lifecycle·Hub client 원본을 가져와 연결. 공개 repo에 없는 Cloud consumer는 별도 구현 |
| U25 설치·릴리즈 | 전체 통합 뒤 진행 | 두 과거 후보 run은 증거로 보존. 다음 candidate dispatch 없음 |

현재 코드의 확인은 해당 묶음에서 확보한 결과를 재사용한다. Office production bundle은 Rust PATH와 vendor realpath를 보정한 실행에서 통과했다. U03/U10 관련 동작 15개, import 9개, 실제 폴더 경계 1개, U20 서비스 3개와 UI 4개, U19 host 알림 4개와 UI 6개 확인을 마쳤다. 전체 OS/실계정/실기기 완료를 뜻하지 않는다.

U12–U14 host 4개, UI 6개, 정확한 DOM adapter fixture, host/web TypeScript 및 Linux native compile을 확인했다. HTTP 환경의 nonce 생성도 별도 단일 확인했다. Native OS 화면 E2E나 실제 로그인은 아직 확인하지 않았다. 이번 공유 웹 묶음에서는 production/installer/CI를 실행하지 않았고 최신 구현은 로컬 개발 브랜치에 있다.

U09 실행 권한·저장 분리의 집중 22개와 영향받은 참조/스킬/스타일 49개, 독립 실행기·원본 Markdown 경로 6개와 Linux native check 결과를 재사용한다. R37에서는 기존 원본8형식의 adapter, 선택/입력 질문, 비동기 context 확인, UI 소실 뒤 출력 저장을 추가했다. 슬라이드의 후속 실행 수명과 native 출력 서비스가 남으며 실제 OS에서 UI 종료 뒤 실행 완료까지 아직 확인하지 않았으므로 U09 완료로 표시하지 않는다. 기존 통과 suite와 production/installer/CI는 반복하지 않았다.

기존 CI `42575034938`은 lock 버전 두 항목 실수로 실패했고 복구했다. `42576006213`은 공통/macOS/Linux/Arch 성공, Windows 앱·NSIS 생성 후 WiX 다운로드 HTTP504로 MSI 실패했다. 실패한 bundle만 재시도하는 코드를 준비했으며 지금 재빌드하지 않는다.

사용자 교정에 따라 Paseo 관련 남은 범위는 **원본 코드·의존 묶음 재사용 + Workbench 연결**로 전환했다. 첫 relay 패키지와 실제 채팅 이미지 decoder를 반입했다. 원본 Noise 7개와 endpoint 연결 1개, 기존 media cache 2개 및 영향받은 타입 확인이 통과했다. 원본 source·출처·의존 라이선스와 배포 고지를 보존했다. 앱·설치본·CI는 실행하지 않았으며 U17–U18 전체 완료를 뜻하지 않는다.

원본 [156개 요구 대응표](../plans/support/coverage.json)와 [통합 계획](../plans/2026-11-09-workbench-integrated-release.md)을 유지한다. 이 상태표의 ‘구현’은 기능 코드 상태이며 전체 릴리즈 완료 판정이 아니다.

Paseo 재사용 전환·첫 반입 근거: `research:rr-79110658024cdb4797375aa15a22a771:413d49e0d715c8db9687a0b1a48c6669ad100f71a9fdf72b13a250ecf0fc6a03` (R1–R6).

연구 판: `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:eaf1781fb6ea15427f1698896ce325e66c7ae94fae3c0f05a1b3b54e907b0d2a` (R24–R37). 실행 교정: `decision-7287723b7dd57957ec551667abe6ddc8c02067f7f0f0988cb2a44d58b05cd626`, `decision-b10e79c5567f53f7c9dfe5e459933f13cbff1b06242c87566dfbaea9d13d4e63`.

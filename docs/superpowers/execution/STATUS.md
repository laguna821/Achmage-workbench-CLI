# 0.4.0 실행 상태

2026-11-09. **남은 기능을 구현하고 전체 기능 연결 뒤 통합 빌드·릴리즈한다.** 사용자 재교정: 기능마다 검사·재검토를 끼워 넣지 않는다. 이미 통과한 검사는 반복하지 않고, 발견한 문제에 필요한 확인만 수행한다. 남은 기능 연결을 먼저 마친 뒤 설치본 단계에서 통합 확인을 묶는다. 기능 추가마다 production/설치본 빌드를 반복하지 않는다. 다음 후보 CI는 취소했다. 필요한 동작 확인은 묶음당 한 번, 실제 실패는 해당 부분만 수정·재확인한다.

| 기능 묶음 | 현재 코드 | 근거와 남은 범위 |
|---|---|---|
| S0 대화 원문 우선 검색 | 구현 | `93837f8` — 프롬프트/AI 원문을 문서·볼트보다 먼저 표시 |
| U02 공통 UI | 구현 | `abf4f68` — 키보드 이동·초점 복귀·HIG 컨트롤 |
| U03 생성·프로젝트·탭 | 주요 흐름 구현 | `abf4f68`, `a3d9683`, `e056d8b` — 9종 문서·실제 폴더 생성, 정리 폴더 구분 |
| U04 대화·초안 | 구현 | `abf4f68` — 읽기 위치·검색 원문 펼침·초안 보호 |
| U05 그림 결과 | 주요 흐름 구현 | `53c60ce`, `50cb030` 및 후속 연결 — 당시 이미지 보존·미리보기·원본 decoder. 원격 승인된 대화/업로드 첨부 연결 코드 추가; 전체 파일·획득 흐름 남음 |
| U06 작업 목록·명령 | 주요 흐름 구현 | `22166e5`, `498a710` — 독립 문서·하위 작업과 공통 접수. 공급자 하위 작업은 관찰만 지원 |
| U07 역할·CLI/MCP API | 구현 | `9239725`, `498a710` — 역할 CRUD·요청 당시 설정 보존·공통 receipt |
| U08 9형식 Office UI | 주요 흐름 구현 | `b40fb38` — 원본 명령 메뉴·theme 전달. 전체 native OS 사용 확인은 통합 때 |
| U09 Office UI 독립 실행 | 8종 독립 adapter + 공통 질문·출력 코드 연결 | `aa6779d`, `f89fd18` 및 후속 R37 — 원본 Markdown/Word/한글/Sheets/PDF/HTML/XMind/EPUB send·선택·질문, 기존 요청/저장/재접속 연결. 이번 묶음에서 슬라이드 queue/QC 수명·PDF toolbar 작업·native 출력 서비스 연결을 추가했다. 실제 OS 실행·통합 확인은 남음. [범위](../../office-execution.md) |
| U10 검색·Bases·그래프 | 주요 흐름 구현 | `e056d8b` — 검색 취소 복귀·다중선택/일괄 보관·그래프 키보드 이동 |
| U11 설정·가져오기 | 주요 흐름 구현 | 기존 이음/Dropbox 흐름 유지, `18bac42` 과거 기록/실행 구분·원문 보존. 전체 온보딩 통합 남음 |
| U12–U14 공유 웹·같은 페이지 AI | 핵심 코드 구현 | `2df5f41`, `1c5e688` — 네이티브 웹 탭·주소 이동·독립 웹 AI·사람 인계·숨김 유지·대상/문서/제어권 식별. 이번 묶음에서 다운로드·사이트 권한·macOS 14+ 프로필·문서/첨부 산출물 연결을 추가했다. Windows/macOS 다운로드 취소와 실제 OS 화면 사용 등은 남음. [범위](../../shared-browser.md) |
| U15 외부 앱 조작 | 원본 CLI·세션·화면 연결 구현 | 공식 v1.1.0 설치/원본 installer, 창 선택, 관찰·조작·캡처·제어권·기록, Codex/Claude 도구 연결. 실제 OS 앱 조작과 설치본 사용은 남음. [범위](../../desktop-control.md) |
| U16 독립 host | 주요 흐름 구현 | `4924188` — 창 종료 뒤 지속·재접속·epoch·선택 로그인 시작. AppImage 지속 runtime 남음 |
| U17–U18 기기·모바일 | 원본 전송·실제 listener·기기 승인·첫 연결 UI 구현 | 원본 client/protocol/server 전송 묶음 + Workbench 프로젝트 권한·기존 HTTP/event·첨부·호스트 전환 연결. 실제 loopback 두 클라이언트에서 등록/범위/철회/재접속 확인. 실제 외부망·모바일 UX·native credential 저장 남음. [재사용 실행표](PASEO-REUSE.md), [사용 범위](../../remote-connections.md) |
| U19 서비스 알림 | 주요 흐름 구현 | `9c56e75`, `573eebf` — host의 영구 기록·중복 방지·읽음/승인 분리·정확한 세션/문서 원문 이동. 모바일 push와 OS 클릭 연동 일부 남음 |
| U20 workspace 운영 | 주요 흐름 구현 | `2462057`, `83a908b` — owned 서버 실행·포트 충돌·출력 재사용·정확한 소유 실행 종료와 UI 연결. 이번 묶음에서 원본 terminal controller/emulator/headless, 모바일 보조 키, 로그 검색·고정 서비스 HTTP 프록시를 연결. 실제 모바일 입력과 전체 웹앱/WebSocket 프록시는 남음 |
| U21 예약 | 주요 흐름 구현 | `1a39d77` — occurrence 기록·timezone·횟수/기한·미실행 정책·unknown 재전송 방지 |
| U22–U24 음성·플러그인·Hub | 핵심 서비스·화면 연결 구현 | 원본 음성/SDK/compiler/lifecycle + 실제 QuickJS 실행, 서명 사건 consumer/기존 task journal, Composer·설정 메뉴 연결. 실마이크·native 모델·실모바일·외부계정·원본 outbound Hub client 남음. [사용 범위](../../voice-extensions-events.md) |
| U25 설치·릴리즈 | 전체 통합 뒤 진행 | 두 과거 후보 run은 증거로 보존. 다음 candidate dispatch 없음 |

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

이 묶음은 U09·U12–15·U20의 실제 코드 연결을 추가했으며, U25 릴리즈나 25개 단위/156개 요구의 전체 완료를 뜻하지 않는다. AppImage 영속 runtime, 실제 외부망/모바일·native credential·push, 전체 파일 흐름·하위 작업 제어·온보딩, outbound Hub, 통합 설치·업데이트 등 기존 미완료 범위를 유지한다.

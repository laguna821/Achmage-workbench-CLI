# Aside 사용 흐름과 화면·메뉴 조사

확인일: 2026-11-04 KST. 공식 도움말·변경 이력·제품 및 회사 소개 자료 32개와 간접 자료 5개를 수집했다. 상세 목록과 수집 한계는 [출처 목록](06-sources.md)에 있다.

## 무엇을 확인했나

Aside는 일반 웹 탐색, AI 작업 대화, 현재 페이지의 사이드 AI, AI가 사용하는 탭을 한 브라우저 안에 배치한다. 사용자가 설명한 네 가지 흐름은 공식 문서와 일치한다. 다만 아래는 **문서·공개 이미지 조사**이며, 이 Linux 컴퓨터에서 Aside 앱을 실행해 검증한 결과는 아니다. [브라우저 기본 기능](https://docs.aside.com/help/browser-basics), [사이드 패널](https://docs.aside.com/help/side-panel)

| 사용자가 말한 경험 | 확인한 근거 | Workbench에 필요한 대응 |
|---|---|---|
| 왼쪽에서 여러 AI 대화를 선택 | 작업 대화와 최근 채팅, 작업별 설정 | 기존 프로젝트·세션 탐색 유지 |
| 탭에서 일반 인터넷 사용 | 일반 웹 탭, 주소 검색, 분할 보기 | 실제 렌더링되는 웹 탭과 이동 도구 |
| Ask Aside를 누르면 오른쪽 AI | 현재 페이지를 붙인 사이드 패널 | 페이지에 연결된 독립 AI 대화 |
| AI가 쓰는 웹을 사람이 열어 확인 | Agent Tabs, 사용자에게 제어 인계 | 동일한 pageId를 사람과 AI가 공유 |
| 중앙 대화에서 진행 상황 확인 | 대화 안의 도구 실행·상태·결과 | 같은 taskId의 진행/결과를 메인 세션에 보고 |

마지막 열은 **우리 제품 설계 제안**이다. Aside 내부의 세션·작업 ID 구현을 확인했다는 의미는 아니다.

## 화면의 정보 구조

다음은 공식 페이지의 UI 예시, 도움말, 공개 리뷰를 종합한 구조도다. 제품 화면의 픽셀 복제가 아니라 구성 요소 지도다.

```text
브라우저 창
├─ 프로필 / 전역 메뉴
├─ 왼쪽 탐색
│  ├─ 북마크
│  ├─ 채팅 목록 / 새 채팅
│  ├─ 일반 탭 / 새 탭 / 탭 그룹
│  └─ Agent Tabs: AI가 사용 중인 페이지
├─ 중앙 작업 영역
│  ├─ 새 탭: 주소·검색 / AI 요청
│  ├─ 일반 웹: 주소창 + 페이지
│  ├─ AI 대화: 프롬프트 + 실행 경과 + 결과물
│  └─ 분할: 대화와 페이지, 또는 두 페이지
├─ 오른쪽 Ask Aside
│  ├─ 현재 페이지 제목·도메인 컨텍스트
│  ├─ 대화 / 실행 상태
│  └─ 입력 / 첨부 / 모델·작업 옵션
└─ 설정: 브라우저, 모델, 에이전트, 기억, 자동화, 개발자 연동
```

공식 [홈페이지](https://aside.com/)의 UI는 마케팅 예시다. 좌측의 Bookmarks/Chats/Tabs/Agent tabs 구분과 입력부를 관찰할 수 있지만, 그 HTML을 실제 Aside 앱의 상태로 취급하지 않는다.

## 핵심 사용 흐름

| 흐름 | 출발 → 사용자 행동 → 이어지는 경험 | 근거 |
|---|---|---|
| 일반 탐색에서 AI로 | 페이지 열기 → Ask Aside → 현재 페이지를 붙인 대화, 필요하면 첨부 해제 | [A05](https://docs.aside.com/help/side-panel) |
| 대화에서 조사로 | 새 작업 → 목표와 컨텍스트 전달 → 여러 사이트 탐색과 결과 확인 | [A04](https://docs.aside.com/help/tasks) |
| 사람과 AI가 나란히 | 대화·페이지 분할 → AI의 작업 내용을 페이지와 함께 확인 | [A03](https://docs.aside.com/help/browser-basics) |
| AI 탭을 직접 조작 | Agent Tab 선택 → 일반 페이지처럼 사용 → 탭 전환 시 그룹으로 복귀하는 동작 | [A18, v1.0.914.1](https://docs.aside.com/changelog/native#improved-agent-tabs) |
| 로그인·추가 입력 | AI 작업 중 사용자 입력 요청 → 사람이 처리 → 작업 계속 | [A04](https://docs.aside.com/help/tasks), [A09](https://docs.aside.com/help/password-manager) |
| 반복 작업 | Routines에서 예약 → 새 작업 또는 기존 대화를 깨우는 방식 선택 | [A07](https://docs.aside.com/help/automation) |
| 기존 CLI와 연결 | 개발자 설정 → CLI/MCP/REPL → 외부 에이전트도 브라우저 사용 | [A16](https://docs.aside.com/help/developers) |

사이드 AI는 단순히 화면 옆에 입력창을 놓는 기능을 넘어선다. **어느 페이지에 대한 대화인지 유지하고, 탭을 바꿨다가 돌아와도 해당 대화가 이어져야 한다.** 최신 변경 이력도 이 동작을 수정 대상으로 명시한다. [A17, 2026-10-29](https://docs.aside.com/changelog/components#v126102943)

## 메뉴와 기능 분류

아래 경로는 현행 도움말에서 확인한 것만 표기했다. 화면에서 보이는 메뉴명 전체를 실측한 목록은 아니다. 괄호 속 한글은 설명이다.

| 기능군 | 확인된 진입점·선택지 | 우리 앱에서의 의미 |
|---|---|---|
| 웹 탐색 | 새 탭, 주소 검색, 분할, 선택 영역 요약·번역, Lasso | 웹 탭 기본 기능부터; Lasso는 확장 |
| 대화 입력 | `@` 컨텍스트, 작업 폴더, 모델, 추론 옵션 | 기존 문서·세션·웹 컨텍스트 선택과 통합 |
| 실행 권한 | Read-only / Guard / Full access | 사용자의 작업 권한을 도구 경로에도 적용 |
| 모델 | Settings → Models → Providers | 현재 연결 계정의 실제 모델 목록 사용 |
| 에이전트 | Settings → Agents, Chat의 Queue/Steer | 탭별 후속 요청·중지·대기 정책 명확화 |
| 파일/도구 권한 | Sandbox, File permissions, Tool permissions | 문서 도구·웹 도구·외부 앱 도구 구별 |
| 기억 | Settings → Memory: Overview/History/Configure | 프로젝트 맥락·명시적 기억을 구별 |
| 반복 작업 | Settings → Routines, Cron/Heartbeat | 초기 핵심 흐름 이후 확장 가능 |
| 비밀번호 | Settings → Passwords, 자동완성·사이트 예외·Vault | 첫 단계에서는 웹 프로필 로그인 유지부터 |
| 개인정보 | Settings → Security & Privacy | 웹 데이터·사이트 권한·삭제 범위 안내 |
| 개발자 | CLI/MCP/REPL, 외부 에이전트 연결 | Orca와 Workbench의 도구 연결 방식 참고 |
| 데스크톱 조작 | Settings → Agents → Computer Use | agent-desktop으로 검토할 별도 확장 |

출처: [A03](https://docs.aside.com/help/browser-basics), [A04](https://docs.aside.com/help/tasks), [A07](https://docs.aside.com/help/automation), [A08](https://docs.aside.com/help/memory), [A10](https://docs.aside.com/help/passwords), [A11](https://docs.aside.com/help/ai), [A12](https://docs.aside.com/help/privacy), [A13](https://docs.aside.com/help/security), [A16](https://docs.aside.com/help/developers). Computer Use는 [A17의 2026-10-23 항목](https://docs.aside.com/changelog/components#v12610235)에 Mac/Windows와 제공 대상이 명시되어 있다. 이 사실만으로 Aside가 agent-desktop을 사용한다고 추정하지 않는다.

## 이미지에서 직접 관찰한 것

| 이미지 | 관찰 | 해석의 한계 |
|---|---|---|
| [V01: 공식 추론 메뉴](https://aside.com/_next/static/immutable/media/ultrabrowse.2s7urf6hsilvn.webp) | 추론 강도와 Ultrabrowse를 한 메뉴에 표시 | 마케팅 이미지, 실제 성능 증거 아님 |
| [V02: 공식 기록 보기](https://aside.com/_next/static/immutable/media/1.128t-vhmdbwp7.png) | 날짜별/그룹별 기록 탐색 | 기억 기능 전체 화면을 검증한 것은 아님 |
| [V03: 공식 대화 예시](https://aside.com/_next/static/immutable/media/2.0sjx52o1m2j5u.png) | 사이트 열기·파일·일정 등의 실행 경과가 답변 사이에 표시 | 예시 작업의 성공을 재현하지 않음 |
| [V04: 과거 온보딩](https://piunikaweb.com/wp-content/uploads/2026/06/aside-browser-setup-3.webp) | AI 제공자 선택, 연결 단계 | 2026-06 리뷰 시점의 UI |
| [V05: 과거 메인 화면](https://piunikaweb.com/wp-content/uploads/2026/06/aside-browser-benchmarks-chat.webp) | 좌측 채팅/웹 목록, 중앙 대화, 페이지 첨부, 하단 모델·권한 | 최신 화면의 배치와 완전히 같다고 단정하지 않음 |
| [V06: 과거 개발자 설정](https://piunikaweb.com/wp-content/uploads/2026/06/aside-browser-mcp.webp) | 좌측 설정 분류와 중앙 CLI/MCP 설정 | 당시 AI/Permissions 명칭은 현행 Models/Agents와 다름 |

이미지는 Lightpanda가 추출한 링크에서 찾아 실제로 열어 보았다. 원본 이미지 재배포 대신 출처 링크와 해시를 [sources.json](sources.json)에 남겼다.

## 간접 자료를 어떻게 해석했나

- [PiunikaWeb의 2026-06-24 리뷰](https://piunikaweb.com/2026/06/24/aside-ai-browser-comet-dia-alternative/)는 온보딩과 화면 배치 확인에 유용하다. 출시 초기 화면이므로 현재 기능 누락 판단에는 쓰지 않았다.
- [ArcBrowser 사용자 글](https://www.reddit.com/r/ArcBrowser/comments/1wczmjg/anyone_else_tried_aside_closest_ive_felt_to/)은 기존 AI 구독 연결과 로그인된 사이트 작업을 유용하게 평가한다. 며칠 사용한 개인 의견이며 성공률·속도 측정 자료는 아니다. 댓글 전체는 이번 수집에 들어오지 않았다.
- [일본어 소개 글](https://note.com/wokson/n/nc49cae58fe84)은 간접 발견 자료로만 보관했다. 클라우드 작업 이전 같은 설명은 [현행 공식 다중 기기 문서](https://docs.aside.com/help/devices)로 재확인해야 한다.
- [한국어 메뉴 안내 영상](https://www.youtube.com/watch?v=P686evjMs6A)과 [공식 데모](https://aside.com/demo)는 링크·제목 등만 확보했다. 영상 재생·자막 검토를 하지 않아 화면별 버튼의 근거로 사용하지 않았다.
- [r/browsers 글](https://www.reddit.com/r/browsers/comments/1ue9lad/aside_browser/)은 본문이 짧고 댓글이 수집되지 않았다. 검색 결과에 나타난 댓글 주장을 검증된 사용성 결함으로 옮기지 않았다.

## 그대로 따라 하면 안 되는 부분

| 확인된 사실 또는 차이 | 설계 시 처리 |
|---|---|
| 일부 단축키는 문서 앱의 저장 기능과 충돌할 수 있음 | Workbench의 Ctrl+S·Ctrl+K를 유지하고 웹 기능 단축키 별도 정의 |
| 프로필과 로그인 상태가 작업 맥락의 일부 | URL만 다른 엔진에 넘겨 동일 페이지라고 표시하지 않음 |
| 채팅 삭제와 실제 파일 삭제의 범위가 다름 | 삭제 메뉴에 대상과 보존되는 파일을 분명히 표시 |
| 브라우저 동기화가 채팅·프로젝트·실행 중 작업 전체를 옮기지는 않음 | Dropbox 문맥 공유와 브라우저 로그인/실행 상태 이동을 구별 |
| Cloud handoff는 공식 문서상 Coming Soon | 컴퓨터가 꺼져도 작업이 계속된다는 전제를 두지 않음 |
| 전체 Aside에는 암호 관리·동기화·루틴·외부 앱·채널 등도 있음 | 핵심 웹/대화 경험과 추가 제품 기능을 도입 계획에서 각각 표시 |

근거: [브라우저 기본](https://docs.aside.com/help/browser-basics), [작업 관리](https://docs.aside.com/help/tasks), [다중 기기](https://docs.aside.com/help/devices). 마지막 열은 우리의 설계 판단이다.

## 구현 검증으로 가져갈 교훈

공식 변경 이력에는 분할의 잘못된 페이지에 Reload가 적용되는 문제, 탭 복원 시 AI 탭이 불필요하게 재생성되는 문제, 사이드 대화 유지와 자식 작업 중지 문제가 나타난다. 이를 우리 제품의 **탭 대상 식별, 복원, 작업 수명 검증 항목**으로 사용한다. Aside가 현재도 동일 결함을 갖고 있다고 주장하는 것은 아니다. [브라우저 변경 이력](https://docs.aside.com/changelog/native), [컴포넌트 변경 이력](https://docs.aside.com/changelog/components)

우리 앱에 우선 가져올 경험은 “웹을 보고 요청한다 → 다른 일을 한다 → 해당 웹 작업과 대화는 살아 있다 → 결과를 메인 세션과 프로젝트에서 이어 쓴다”이다. 구체적인 화면과 상태 설계는 [Workbench 도입 설계](04-workbench-design.md)에 있다.

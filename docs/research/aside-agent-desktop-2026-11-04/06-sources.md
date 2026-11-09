# 출처 목록과 수집 범위

수집일: 2026-11-04 KST. 원시 시각은 UTC로 [sources.json](sources.json)에 보존했다.

## 자료의 성격

- A: Aside 공식 도움말·제품·변경 이력·회사 소개 32개.
- I: 간접 자료 5개. 경험·발견 자료이며 기술 구현을 증명하는 근거와 구별한다.
- D: agent-desktop 문서·저장소 자료 6개. D01~D05는 검토한 commit으로 고정했다.
- T: Tauri/Playwright/Lightpanda 공식 기술 자료 5개.
- V: 공개 페이지에서 찾은 참고 이미지 6개. 실제로 열어 보았고 원본 해시를 기록했다.

48개 요청 모두 HTTP 200이었으나 완전 수집을 뜻하지 않는다. A21/I01은 영상 메타데이터만, I04/I05는 댓글 전체 없이 게시글 중심, D06은 이슈 목록만 수집했다. 로그인 뒤의 Aside 화면, 비공개 자료, 웹 전체의 모든 리뷰를 망라한 조사로 표현하지 않는다.

## URL 목록

| ID | 자료 | 수집·해석 범위 |
|---|---|---|
| A01 | [시작·온보딩](https://docs.aside.com/help/get-started) | 페이지 텍스트 |
| A02 | [구독 관리](https://docs.aside.com/help/subscription) | 페이지 텍스트 |
| A03 | [브라우저 기본·분할·단축키](https://docs.aside.com/help/browser-basics) | 페이지 텍스트 |
| A04 | [작업·권한·입력·생명주기](https://docs.aside.com/help/tasks) | 페이지 텍스트 |
| A05 | [현재 페이지 사이드 AI](https://docs.aside.com/help/side-panel) | 페이지 텍스트 |
| A06 | [Ultrabrowse](https://docs.aside.com/help/ultrabrowse) | 페이지 텍스트 |
| A07 | [Routines·Cron·Heartbeat](https://docs.aside.com/help/automation) | 페이지 텍스트 |
| A08 | [Memory](https://docs.aside.com/help/memory) | 페이지 텍스트 |
| A09 | [Password Manager](https://docs.aside.com/help/password-manager) | 페이지 텍스트 |
| A10 | [비밀번호 자동완성](https://docs.aside.com/help/passwords) | 페이지 텍스트 |
| A11 | [AI 제공자·모델 설정](https://docs.aside.com/help/ai) | 페이지 텍스트 |
| A12 | [개인정보·로컬 데이터](https://docs.aside.com/help/privacy) | 페이지 텍스트 |
| A13 | [에이전트 권한](https://docs.aside.com/help/security) | 페이지 텍스트 |
| A14 | [문제 해결](https://docs.aside.com/help/troubleshooting) | 페이지 텍스트 |
| A15 | [다중 기기·동기화·cloud handoff](https://docs.aside.com/help/devices) | 페이지 텍스트 |
| A16 | [CLI·MCP·REPL](https://docs.aside.com/help/developers) | 페이지 텍스트 |
| A17 | [컴포넌트 변경 이력](https://docs.aside.com/changelog/components) | 페이지 텍스트 |
| A18 | [브라우저 변경 이력](https://docs.aside.com/changelog/native) | 페이지 텍스트 |
| A19 | [공식 홈페이지 UI 예시](https://aside.com/) | 페이지 텍스트; 마케팅·사용 예시 |
| A20 | [다운로드·지원 OS](https://aside.com/download) | 페이지 텍스트 |
| A21 | [공식 데모 영상](https://aside.com/demo) | 영상 메타데이터; 재생·자막 미검토 |
| A22 | [브라우저 에이전트 소개](https://aside.com/features/browser-agent) | 페이지 텍스트; 마케팅·사용 예시 |
| A23 | [기억 기능·이미지](https://aside.com/features/memory) | 페이지 텍스트; 마케팅·사용 예시 |
| A24 | [암호 관리 소개](https://aside.com/features/password-manager) | 페이지 텍스트; 마케팅·사용 예시 |
| A25 | [연구자 사용 예시](https://aside.com/blog/researchers) | 페이지 텍스트; 마케팅·사용 예시 |
| A26 | [개발자 사용 예시](https://aside.com/blog/developers) | 페이지 텍스트; 마케팅·사용 예시 |
| A27 | [운영 업무 사용 예시](https://aside.com/blog/operations) | 페이지 텍스트; 마케팅·사용 예시 |
| A28 | [인사 업무 사용 예시](https://aside.com/blog/hr) | 페이지 텍스트; 마케팅·사용 예시 |
| A29 | [영업 업무 사용 예시](https://aside.com/blog/sales) | 페이지 텍스트; 마케팅·사용 예시 |
| A30 | [제품 방향](https://aside.com/manifesto) | 페이지 텍스트 |
| A31 | [요금·제공 범위](https://aside.com/pricing) | 페이지 텍스트 |
| A32 | [Y Combinator 회사 소개](https://www.ycombinator.com/companies/aside) | 페이지 텍스트 |
| I01 | [한국어 메뉴·사용 안내 영상](https://www.youtube.com/watch?v=P686evjMs6A) | 영상 메타데이터; 재생·자막 미검토 |
| I02 | [WORKSON 일본어 소개 글](https://note.com/wokson/n/nc49cae58fe84) | 페이지 텍스트; 2026-06 자료 |
| I03 | [PiunikaWeb 초기 사용 리뷰](https://piunikaweb.com/2026/06/24/aside-ai-browser-comet-dia-alternative/) | 페이지 텍스트; 2026-06 자료 |
| I04 | [r/ArcBrowser 사용자 경험 글](https://www.reddit.com/r/ArcBrowser/comments/1wczmjg/anyone_else_tried_aside_closest_ive_felt_to/) | 게시글 중심; 댓글 전체 미확보 |
| I05 | [r/browsers 소개·토론 글](https://www.reddit.com/r/browsers/comments/1ue9lad/aside_browser/) | 게시글 중심; 댓글 전체 미확보 |
| D01 | [agent-desktop README](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/README.md) | 페이지 텍스트 |
| D02 | [agent-desktop FAQ](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/docs/faq.md) | 페이지 텍스트 |
| D03 | [agent-desktop 설치·플랫폼](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/docs/install.md) | 페이지 텍스트 |
| D04 | [agent-desktop JSON 계약](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/docs/json-output.md) | 페이지 텍스트 |
| D05 | [agent-desktop 개념](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/CONCEPTS.md) | 페이지 텍스트 |
| D06 | [agent-desktop 이슈 목록](https://github.com/vercel-labs/agent-desktop/issues) | 이슈 목록; 개별 이슈 전수 검토 아님 |
| T01 | [Tauri OS별 WebView](https://v2.tauri.app/reference/webview-versions/) | 페이지 텍스트 |
| T02 | [Playwright WebView2·CDP](https://playwright.dev/docs/webview2) | 페이지 텍스트 |
| T03 | [Tauri WebView API](https://v2.tauri.app/reference/javascript/api/namespacewebview/) | 페이지 텍스트 |
| T04 | [Lightpanda 아키텍처](https://lightpanda.io/docs/core-concepts/architecture-overview) | 페이지 텍스트 |
| T05 | [Lightpanda MCP](https://lightpanda.io/docs/usage/mcp) | 페이지 텍스트 |

## 공개 참고 이미지

| ID | 출처 페이지 | 이미지 |
|---|---|---|
| V01 | A22 | [원본 이미지](https://aside.com/_next/static/immutable/media/ultrabrowse.2s7urf6hsilvn.webp) |
| V02 | A23 | [원본 이미지](https://aside.com/_next/static/immutable/media/1.128t-vhmdbwp7.png) |
| V03 | A23 | [원본 이미지](https://aside.com/_next/static/immutable/media/2.0sjx52o1m2j5u.png) |
| V04 | I03 | [원본 이미지](https://piunikaweb.com/wp-content/uploads/2026/06/aside-browser-setup-3.webp) |
| V05 | I03 | [원본 이미지](https://piunikaweb.com/wp-content/uploads/2026/06/aside-browser-benchmarks-chat.webp) |
| V06 | I03 | [원본 이미지](https://piunikaweb.com/wp-content/uploads/2026/06/aside-browser-mcp.webp) |

관찰 내용과 오래된 UI의 차이는 [Aside 조사](02-aside-ux.md)에 정리했다. 이미지 파일과 기사 원문 전체를 이 저장소에 재배포하지 않았다.

## 버전 고정과 추가 근거

- agent-desktop 소스: `93ae89e86fb849eeb5fc265b0b8e37eca56aaf72`. 소스 파일별 해시도 sources.json에 기록했다.
- Workbench 소스: `bc1057c2c5fb04f2046f4fd711bf718f5cc93737`. 코드의 존재와 실행 검증은 구분했다.
- [Lightpanda 1.0.2 공식 배포](https://github.com/lightpanda-io/browser/releases/tag/1.0.2): 설치 바이너리·해시 근거.
- [Codex MCP 공식 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): MCP 설정 근거.
- 위 추가 근거와 git clone은 48개 Lightpanda URL 수집 건수에 중복 계산하지 않았다.

## 결론의 강도

| 구분 | 이 조사에서의 예 |
|---|---|
| 실행 관찰 | 이 Orca 터미널의 Lightpanda 버전·MCP·페이지 읽기 |
| 소스 관찰 | 기존 View 종류, 브라우저 엔진 선택, agent-desktop 정책·JSON 계약 |
| 공식 설명 | Aside 메뉴·Agent Tabs·작업 흐름·공식 지원 범위 |
| 이미지 관찰 | 공개 이미지의 배치·레이블. 기능 성공 증명은 아님 |
| 간접 경험 | 리뷰 작성자 개인의 사용 후기. 현재 버전 보장 아님 |
| 설계 제안 | Workbench pageId/taskId, 작업 수명, 구현 순서 |

모든 기능·속도·메모리 사용량을 실제 Aside와 비교 측정한 연구는 아니다. 성능 수치를 옮겨 적어 우리 앱의 예상 성능으로 사용하지 않았다.

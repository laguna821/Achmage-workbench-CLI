# Lightpanda 설치와 Aside·agent-desktop 도입 조사

2026-11-04 KST · 대상: Achmage Workbench 0.3.3 / Orca 로컬 실행 환경

**Orca에서 쓸 Lightpanda 설치와 실제 호출 검증을 완료했고, Aside의 사용 흐름·메뉴와 agent-desktop 소스를 조사해 도입 설계를 작성했다.** 이 디렉터리는 조사 결과이며 웹 탭 기능을 구현한 릴리즈는 아니다.

## 요청별 완료 상태

| 요청 | 결과 | 문서 |
|---|---|---|
| 1. Orca에 Lightpanda 설치 | 1.0.2 설치·해시 대조, Codex/Claude MCP 등록, 실제 Orca 터미널에서 32개 도구와 페이지 읽기 확인 | [설치·사용·검증](01-orca-lightpanda.md) |
| 2. Aside 사용성과 메뉴 조사 | 공식·회사 소개 자료 32개와 간접 자료 5개 수집, 공개 이미지 6개 육안 검토, 메뉴·흐름·버전 차이 정리 | [Aside 조사](02-aside-ux.md) |
| 3. agent-desktop 문서·소스 조사 | 문서/저장소 자료 6개 수집, commit을 고정해 실제 소스 검토 | [소스 분석](03-agent-desktop.md) |
| 4. 내 CLI에 구현할 방안 | 기존 코드 대응표, 화면 구성, 작업 수명·엔진 분담·OS별 실증 계획과 완료 기준 | [도입 설계](04-workbench-design.md), [구현 순서](05-delivery-plan.md) |

추가 기술 문서 5개까지 **총 48개 URL**을 Lightpanda로 요청했다. 이 숫자는 완전한 본문 확보 건수와 같지 않다. 영상 2개는 메타데이터만, Reddit은 게시글 중심으로 확보했으며 댓글 전체는 확인하지 못했다. Aside 설치 앱의 네이티브 화면을 직접 조작하지 않았다. 공식 문서·마케팅 이미지·과거 리뷰·실제 코드 관찰·우리 설계 제안을 구분했다. [전체 출처와 수집 한계](06-sources.md)

## 설계 결론

**Lightpanda + agent-desktop에 실제 웹 탭과 작업 조정 기능을 더하면 사용자가 설명한 Aside 흐름을 목표로 삼을 수 있다.** 두 도구가 완제품 UI와 세션 연결을 대신 제공하지는 않는다.

- Lightpanda: 보이지 않는 곳에서 검색·수집·추출.
- 실제 웹 탭: 사람이 보고 로그인하며, AI도 같은 페이지를 사용.
- 기존 Workbench: 프로젝트·세션·문서·분할·검색·결과물·부모 세션 보고.
- agent-desktop: 이음오피스 같은 외부 앱 UI를 조작할 때 연결하는 확장.

기존 [Lightpanda 연결](../../../apps/host/src/browse-lightpanda.ts), [탭/분할](../../../apps/web/src/tabs.ts), [문서 작업과 부모 보고](../../../apps/host/src/office-sessions.ts)는 재사용할 근거가 있다. 범용 웹 View와 동일 페이지 AI 제어는 현재 코드에 추가해야 한다. Windows WebView2부터 실제 공유 페이지 동작을 실증하고, macOS/Linux는 별도 드라이버 기능을 확인한다. 상세 판단과 출처는 [설계서](04-workbench-design.md)에 있다.

## 읽는 순서

전체 방향은 **[도입 설계](04-workbench-design.md) → [구현 계획과 18개 핵심 완료 기준](05-delivery-plan.md)** 순서로 보면 된다. 화면·메뉴 근거는 [Aside 조사](02-aside-ux.md), 도구의 실제 한계는 [agent-desktop 분석](03-agent-desktop.md)에서 확인할 수 있다.

## 재현과 연구 기록

- Workbench 기준: `bc1057c2c5fb04f2046f4fd711bf718f5cc93737`.
- agent-desktop 기준: `93ae89e86fb849eeb5fc265b0b8e37eca56aaf72`.
- [sources.json](sources.json): URL, 수집 시각, 상태, 본문 해시, 이미지 해시와 수집 범위.
- [evidence/](evidence/): 설정 비밀을 제외한 설치·실제 호출 증거.
- [연구 기록과 로컬 원자료 위치](07-provenance.md): 기존 연구의 정확한 revision, 이번 연구 revision, 캐시 경로.

원문 페이지 전체와 외부 소스 checkout은 로컬 조사 작업공간에 보관했다. 이 저장소에는 계정 설정·인증 정보·쿠키·원문 기사 전체·외부 이미지 파일을 넣지 않았다. 제품 소스 변경·빌드·새 배포는 이번 조사에 포함하지 않았다.

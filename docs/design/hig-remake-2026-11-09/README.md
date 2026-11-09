# Achmage Workbench — Apple HIG 프론트엔드 전면 개편 계획

2026-11-09 · **계획 완료, 제품 UI 구현 전** · 기준 commit `bc1057c2c5fb04f2046f4fd711bf718f5cc93737`

**앱 전체를 “프로젝트에서 내용을 찾고, 각 작업에 집중하며, 여러 AI의 진행을 확인하는 데스크톱 작업 공간”으로 다시 구성한다.** Apple HIG를 화면·상호작용의 판단 기준으로 삼고, Achmage 브랜드와 기존 사용자 설정을 연결한다. 현재 React/Tauri와 문서·AI 실행 기능 위에서 프론트엔드 구성을 개편한다.

적용 스킬: [Achmage OS apple-hig-design](</home/achamge/Dropbox/-- ACH_한림대 미디어스쿨/= Ach's Obsidian/Achmage_OS/20_Master-Skills/apple-hig-design/SKILL.md>), Plan 모드. 규칙의 원문과 정확한 연구 revision은 [근거 기록](sources-and-evidence.md)에 있다.

## 사용감은 이렇게 바뀐다

| 영역 | 새 경험 | 핵심 판단 |
|---|---|---|
| 프로젝트 탐색 | 프로젝트 이름은 개요로, 펼침은 목록으로. 대화·문서·하위 프로젝트가 구분됨 | 탐색과 내용의 위계 분리 |
| 상단·탭 | 열린 작업 탭 + 현재 내용에 맞는 도구 모음. `새로 만들기`가 항상 발견됨 | 위치와 행동을 한눈에 이해 |
| 메인 대화 | 답변과 결과물이 중심. 도구 로그는 필요할 때 펼침. 다른 탭의 AI 상태는 작업 요약으로 확인 | 내용과 실행 상세의 중요도 구별 |
| 문서 편집 | 상단 작업 탭을 남긴 편집 집중 모드. 해당 문서 AI만 곁에 표시 | 작업 영역 확보, 맥락 유지 |
| 이음오피스 내부 | 각 형식의 도구 모음·메뉴·대화상자·AI 패널까지 공통 문법 적용 | 바깥 셸과 편집기 안의 이질감 해소 |
| 검색·볼트·Bases | 검색 범위와 원문 위치가 명확하고, 선택·뒤로가기·분할이 일관됨 | 찾은 다음 작업까지 연결 |
| 웹 탭 | 주소·이동·이 페이지 AI·사용자 인계가 같은 위치에서 작동 | 앞선 Aside 설계를 새 셸에 수용 |
| 외형 | 차분한 내용 면, 절제된 강조색, 일관된 타이포·아이콘. 재질 효과는 탐색/제어층에 제한 | 가독성과 작업 상태가 먼저 보임 |

HIG 근거: [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars), [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars), [Materials](https://developer.apple.com/design/human-interface-guidelines/materials). 표의 구체적인 제품 배치와 행동은 [HIG transfer] 또는 [House]인 설계 제안이며, 각각의 판단 근거는 [결정 기록](decisions.md)에 연결했다.

## 문서 구성

1. [설계 목적·범위](design-brief.md): 전면 개편의 의미, 보존할 사용자 경험, 화면 모드.
2. [사용 흐름](flow-map.md): 진입·탭 이동·검색·편집·병렬 작업·복원.
3. [전체 화면 목록](screen-inventory.md): S01~S15와 형식별 편집 UI, 실제 코드 위치.
4. [HIG 결정·시각 체계](decisions.md): D01~D14, 브랜드/스킬 충돌과 적용 방식.
5. [구현 순서·완료 기준](implementation-plan.md): W0~W6, 기능 대응표와 회귀 검증.
6. [근거·검증 범위](sources-and-evidence.md): 스킬·Apple 문서·코드·연구 revision.

## 작업 순서

**대표 화면 시안 → 공통 컴포넌트 → 셸·탐색·대화 → 모든 편집기 내부 UI → 부가 화면 → 통합 검증** 순서다. 첫 구현에서 홈/프로젝트·메인 대화·문서 집중 화면을 실제 데이터에 연결해 사용감을 빨리 확인할 수 있게 한다. 전체 완료는 화면 목록의 누락과 기존 기능의 회귀가 없는지로 판단한다.

앞선 [Aside 도입 계획](../../research/aside-agent-desktop-2026-11-04/05-delivery-plan.md)의 웹 엔진 실증은 별도 의존성이다. HIG 시안에 웹 탭이 보인다는 이유로 Lightpanda와 시각 브라우저의 공유 상태가 구현됐다고 계산하지 않는다.

이번에는 코드·기존 설정을 변경하거나 앱을 재빌드하지 않았다. 스킬과 최신 공식 문서, 현재 소스를 확인해 **실행 가능한 개편 계획**을 저장했다. 현재 설치본의 모든 화면을 새로 캡처해 시각 감사를 완료했다는 의미는 아니다.

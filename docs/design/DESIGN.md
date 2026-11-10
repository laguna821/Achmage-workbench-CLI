# Workbench — Apple HIG 기반 작업공간

2026-11-10. 현재 사용자 지시가 이전 ‘괘선 노트’ 브랜드·엔진 색·SameTone 기본값 보존 규칙을 대체한다. 판단 기준은 설치된 Apple HIG skill 1.0.0이며, Aside는 Search/Ask와 페이지 옆 AI 사용 흐름의 참고다. 서로 다른 콘텐츠를 섞는 Aside 사이드바는 복제하지 않는다.

근거: `research:rr-da5ca50fa3e6593f1a243cce69cc5ed7:36aff60113a7574e1b41bb9ce53999de1ae9a325cde9fe73abf3304c122323f7`는 이전 계획이다. 현재 정정과 코드 근거는 `research:rr-3fd22e3257c5026ce96b909f97309c9d:be31f89e0d27742e2eac6018a832de9308fb39efbfc728ed563727e33ca4b29e`에 기록했다.

## Overview

프로젝트를 중심으로 AI에 일을 맡기고 문서와 웹을 직접 다루는 데스크톱 작업공간이다. [HIG transfer] 프로젝트 → 종류별 콘텐츠 → 실제 작업의 계층을 유지한다. 프로젝트는 YAML 속성이 있는 관리 단위이며 폴더나 대화와 구분된다. 기본 화면은 단순하게, 여러 프로젝트 관리는 명시적인 화면 배치 선택으로 확장한다. `design-principles/simplicity/include-just-whats-necessary` `layout/visual-hierarchy/group-related-items-to-clearly-express`

## Colors

[House / HIG transfer] macOS 계열 중립 면과 시스템 블루를 Windows·Linux의 Tauri 웹 UI에도 일관되게 적용한다. 브랜드색과 엔진별 전체 배경은 기본값에서 제거한다. 사용자 지정 문서·태그·폴더 색은 콘텐츠다.

| 역할 | 라이트 | 다크 |
| --- | --- | --- |
| 읽는 면 | #FFFFFF | #1C1C1E |
| 올린 면 | #FFFFFF | #2C2C2E |
| 탐색 면 | #F2F2F7 | #1C1C1E |
| 본문 | #000000 | #FFFFFF |
| 보조 글자 | #6C6C70 | #AEAEB2 |
| 구분선 | #D1D1D6 | #3A3A3C |
| 작은 강조 글자 | #1E6EF4 | #5CB8FF |
| 강조 버튼 | #1E6EF4 | #0091FF |
| 오류 / 완료 | #E9152D / #008932 | #FF6165 / #4AD968 |

색만으로 상태를 전달하지 않고 이름·아이콘·상태 문구를 함께 둔다. [HIG] `branding/best-practices/ensure-branding-always-defers-to-content` `branding/best-practices/apply-your-apps-accent-color-judiciously` `accessibility/vision/strive-to-meet-color-contrast-minimum`

## Typography

[사용자 지정 / House] **Pretendard Variable**을 앱에 포함한다. CDN이나 사용자의 설치 글꼴에 의존하지 않는다. 45–920 가변 굵기로 선언한다. 기본 UI·제목·대화에 적용하며, 코드만 고정폭이다. 문서 자체에 지정된 서체는 바꾸지 않는다. 기존에 명시적으로 고른 사용자 외형은 보존한다.

macOS 데스크톱 스케일을 옮겨 UI 13px, 소제목 15px, 긴 대화 17px, 제목 22px, 큰 제목 26px. 대화 17px/1.75는 읽기 목적의 [House] 선택이다. 작은 글자에 얇은 굵기·음수 자간을 쓰지 않는다. 한글은 어절 줄바꿈, 긴 URL은 영역 안에서 감싼다. `typography/ensuring-legibility/use-font-sizes-that-most-people` `typography/conveying-hierarchy/adjust-font-weight-size-and-color`

## Layout

[HIG transfer] 기본은 한 개 프로젝트 탐색창과 한 작업 화면이다. 프로젝트를 누르면 개요와 YAML 속성을 바로 연다. 하위 채팅·웹 AI·문서 AI·문서를 라벨과 묶음으로 구분한다. 활동·보관·사용량은 접어 두고 필요할 때 펼친다. `layout/visual-hierarchy/order-content-by-relative-importance` `layout/visual-hierarchy/use-progressive-disclosure-to-make-layouts`

[House] 4px 간격 배수, 읽기 폭 720px. 744px 미만은 좁은 레이아웃. 데스크톱 제어 28px, 터치 44px. 1·2·4·9칸 배치를 제공하며 각 칸은 프로젝트/세션 정체성을 유지한다. 9칸은 전체 작업을 살피는 밀도(최소 240×180px)로 사용하고, 읽거나 편집할 때 한 칸 확대/복귀가 가능하다. 작은 화면에서는 활성 칸을 표시하되 선택기로 모든 칸에 접근한다. 배치를 줄여도 열린 탭과 작업을 보존한다.

## Elevation & Depth

본문·문서·목록은 불투명한 면이다. 떠 있는 메뉴와 대화상자만 그림자로 분리한다. 탐색 제어에 반투명 효과를 적용하더라도 투명도 줄이기·대비 증가에서 불투명하게 대체한다. 장식용 광원·네온·엔진 빛 효과는 기본값에서 사용하지 않는다. `materials/liquid-glass/dont-use-liquid-glass-in-the` `materials/liquid-glass/use-liquid-glass-effects-sparingly`

## Shapes

[House] 버튼 8px, 메뉴와 묶음 12px, 입력과 대화상자 18px. 모든 항목을 알약으로 만들지 않는다. 선택, 메뉴, 탭, 상태가 동일한 모양으로 혼동되지 않도록 한다. Lucide SVG를 사용하고 기존 임의 경로 아이콘을 대체한다. 24 단위 viewBox·currentColor·1.75 획, 아이콘 버튼에는 접근 가능한 이름을 준다.

## Components

HIG Kit 1.0.0 CSS를 실제 앱에 사용한다. `apps/web/src/vendor/hig-kit/kit.js`는 원본 행동 참고이며 React가 상태와 이벤트를 소유하는 `components/ui/Hig.tsx`로 연결한다. 직접 DOM을 변경하는 자동 초기화를 React와 중복 실행하지 않는다. [구현 결정]

- 시작: 중앙 입력 하나와 Search/Ask 분할 제어. Search는 웹 주소/검색, Ask는 실제 세션 요청이다.
- 웹: 뒤로/앞으로/새로고침/주소, AI 요청, 추가 메뉴. 우측 AI 패널은 전체 높이로 펼치고 접는다. 별도 ‘제어권 주기’ 절차와 빈 조작 상태 면을 두지 않는다.
- 대화: 사용자 요청과 연속적인 AI 본문을 구분한다. 이미지 첨부·결과를 본문에서 보고 확대한다. 작업 로그는 필요할 때 펼친다.
- 편집: 문서 탭은 편집기에 집중한다. 독립 AI·앱으로 열기·저장 동기화·탭 유지 기능을 보존한다.
- 작업 연결: 기존 세션 간 요청/회신 프로토콜을 사용한다. 보내는/받는 프로젝트와 세션, 요청 및 회신 상태를 보인다. 메시지를 전달하는 기능과 자동 의존 작업 그래프를 같은 것으로 표현하지 않는다.
- 설정/찾기/대화상자: 같은 서체·색 역할·초점·버튼 위계를 사용한다.

`design-principles/familiarity/use-concepts-that-people-know` `buttons/best-practices/always-include-a-press-state-for` `keyboards/best-practices/support-full-keyboard-access-when-possible`

## Do's and Don'ts

- 기본 화면에서 선택할 이유가 없는 제어는 추가 메뉴로 옮긴다. 기능 자체를 없애지 않는다.
- 프로젝트·채팅·문서·웹을 이름과 종류로 구분한다. 엔진별 배경색으로 대신하지 않는다.
- 실제 처리와 UI 상태를 연결한다. AI의 완료 문구만으로 웹 조작 성공을 대신하지 않는다.
- 저장된 예전 기본값은 appearance v3으로 이전하되, 변경한 사용자 설정은 보존한다.
- 라이트·다크·좁은 폭·큰 글자·키보드·이미지 표시를 실제 렌더에서 확인한다. 실행하지 않은 OS 검증을 통과라고 쓰지 않는다.

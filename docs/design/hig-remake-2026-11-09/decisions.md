# HIG 결정 기록과 시각 체계

판정 표기: **[HIG]** 직접 적용, **[HIG transfer]** 다른 플랫폼/매체에 의도 적용, **[House]** 사용자·제품 결정, **[HIG none]** HIG가 정하지 않는 부분. 구조·실행 계약은 별도로 [Engineering]이라 표기한다. Windows/Linux/Tauri의 커스텀 UI를 Apple 네이티브 컴포넌트라고 부르지 않는다.

## D01~D14: 상황 → 원칙 → 패턴 → 구성 요소

| ID·결정 | 상황과 원칙 | 패턴·구성 요소 | 근거·구분 |
|---|---|---|---|
| D01 탐색과 내용 목록 분리 | 프로젝트/폴더/대화가 섞임 → Simplicity/Familiarity | 사이드바에는 프로젝트·전역 진입, 깊은 계층은 내용 목록·경로; 프로젝트 클릭/펼침 분리 | `sidebars/best-practices/in-general-show-no-more-than`, `sidebars/best-practices/group-hierarchy-with-disclosure-controls-if` [HIG transfer] |
| D02 열린 작업 탭 유지 | 여러 문서·세션을 빠르게 이동 → Flexibility | 종류 아이콘·제목·작업 상태가 있는 동적 문서 탭, 안정된 ID·순서 | `design-principles/flexibility/preserve-a-persons-context`, `tab-views/best-practices/make-sure-the-controls-within-a` [HIG transfer + House] |
| D03 생성 진입점 노출 | 기능이 있어도 시작 메뉴를 못 찾음 → Agency | 이름 있는 `새로 만들기`, 프로젝트 우클릭·키보드의 같은 명령 | `toolbars/actions/provide-actions-that-support-the-main`, `pointing-devices/platform-considerations/macos/touch-support-for-hidden-controls/make-essential-hidden-controls-available-in` [HIG transfer] |
| D04 편집 집중 기본 | 전역 대화가 문서 공간을 차지함 → Agency | 편집 시 전역 사이드/하단 입력을 접고 작업 탭·현재 도구·복귀를 유지 | `going-full-screen/best-practices/continue-to-provide-access-to-essential`, `design-principles/agency/stay-out-of-the-way` [HIG transfer + 사용자 요구] |
| D05 속성과 AI 대화 분리 | 두 보조 역할이 경쟁 → Simplicity | 속성은 선택 대상 편집 패널, AI는 해당 작업의 대화. 기본적으로 한 보조 역할 선택, 동시 표시는 명시적 분할 | `layout/visual-hierarchy/group-related-items-to-clearly-express`, `design-principles/simplicity/include-just-whats-necessary` [HIG transfer + House] |
| D06 대화의 내용 우선 | 답변과 로그의 무게가 같음 → Purpose | 요청·응답·결과 우선, 실행 상세는 disclosure. 모델·권한·첨부는 입력 맥락 | `layout/visual-hierarchy/use-progressive-disclosure-to-make-layouts`, `generative-ai/transparency/communicate-where-your-app-uses-ai` [HIG transfer] |
| D07 상태와 제어 표시 | 여러 작업의 진행을 놓침 → Agency/Responsibility | 탭 상태+작업 요약, 정확한 단계, 중지/입력 필요, 완료 알림 | `progress-indicators/best-practices/if-its-helpful-display-a-description`, `generative-ai/best-practices/keep-people-in-control` [HIG transfer] |
| D08 검색은 한 진입점 | 원문·문서·볼트·명령을 찾아야 함 → Simplicity | Ctrl+K와 눈에 보이는 검색, 범위·종류·원문 문맥, 동일 검색 엔진 | `searching/best-practices/aim-to-make-your-apps-content`, `searching/best-practices/clearly-display-the-current-scope-of` [HIG transfer] |
| D09 현재 대상의 도구 | 잘못된 칸에 행동할 위험 → Familiarity | 활성 칸의 제목·이동·도구, 기능별 묶음과 일관된 배치 | `toolbars/item-groupings/group-toolbar-items-logically-by-function`, `toolbars/item-groupings/keep-consistent-groupings-and-placement-across` [HIG transfer] |
| D10 파괴성과 복구 가능성 구별 | 삭제/보관/취소의 의미가 다름 → Agency | 되돌릴 수 없는 프로젝트 삭제는 영향 안내+취소; 가능한 작업은 실제 복구 경로 | `alerts/buttons/if-theres-a-destructive-action-include`, `design-principles/agency/help-people-recover-from-mistakes` [HIG transfer] |
| D11 설정을 작업 옵션과 분리 | 긴 설정 목록에 작업 기능이 숨음 → Simplicity | 일반 설정은 S12, 파일/모델/권한 등 현재 선택은 관련 도구에 | `settings/general-settings/put-general-infrequently-changed-settings-in`, `settings/task-specific-options/when-possible-prefer-letting-people-modify` [HIG transfer] |
| D12 같은 자료의 보기만 전환 | 표·보드·그래프가 다른 곳처럼 보임 → Familiarity | 같은 집합·필터·선택을 유지하는 보기 선택 | `segmented-controls/best-practices/use-a-segmented-control-to-provide` [HIG transfer + House] |
| D13 내용과 앱 장식을 분리 | UI 개편이 문서 형식·미저장 상태를 건드릴 수 있음 → Responsibility | 앱 토큰은 제어층에, 문서 캔버스는 문서 서식. 저장·수정안·충돌은 명시 | `file-management/saving-work/help-people-be-confident-that-their`, `layout/visual-hierarchy/differentiate-controls-from-content` [HIG transfer + Engineering] |
| D14 설정 전에 가치 제공 | 설치·연결이 수작업을 막음 → Agency | 로컬 새 문서를 먼저 사용, 필요한 연결을 그 기능에서 안내; 설치 진행은 유지 | `onboarding/additional-requests/postpone-nonessential-setup-flows-or-customization`, `onboarding/additional-content/dont-let-large-downloads-hinder-onboarding` [HIG transfer] |

D01의 깊이 제한은 **앱의 전역 탐색**에 적용한다. 사용자의 실제 폴더 구조·하위 프로젝트·볼트 링크를 잘라내지 않는다. 내용 목록/트리에서 전체 구조에 접근할 수 있게 한다. D02의 문서 탭을 설정용 tab view와 혼동해 열린 문서를 여섯 개로 제한하지 않는다. 현재 탭 수용 정책의 변경은 별도 제품 결정이다. [House]

## 시각 체계: 역할부터 통일

현재 프로젝트 [DESIGN.md](../DESIGN.md), [styles.css](../../../apps/web/src/styles.css), [appearance.ts](../../../apps/web/src/appearance.ts)를 읽었다. 기존 토큰이 스킬의 기본값보다 우선한다. 이번 사용자 요청에 따라 화면 구조의 새로운 판단 기준은 HIG로 두며, 다른 디자인 스킬의 구성 처방을 추가로 겹치지 않는다.

| 역할 | 출발점 | 적용 계획·표기 |
|---|---|---|
| 앱 강조색 | 기존 `--accent`, 중립 셸의 Achmage blue | 선택·초점·주요 행동에 사용. Apple 파랑으로 무조건 교체하지 않음 [House] |
| 내용 면·전경 | 기존 `--bg`, `--surface`, `--text`, `--muted`, `--chrome-*` | 역할과 테마별 조합을 정리. 작은 보조 글자도 대비 검사 [House + HIG transfer] |
| 앱 글꼴 | 기존 `--font-ui` Pretendard/시스템 스택 | 메뉴·라벨·숫자를 통일. 오프라인 로딩과 실제 fallback을 검증 [House] |
| 대화/문서 내용 글꼴 | 사용자 SameTone/엔진별 룩 및 실제 문서 서식 | UI 통일을 이유로 덮어쓰지 않음 [House] |
| 크기·간격·모서리 | 기존 `--fs-*`, `--space-*`, `--r-*` | 기준 역할에 매핑하고 사용처의 중복 값 정리. 새 임의 숫자 추가 대신 토큰 사용 [House] |
| 아이콘 | 현재 `Icon.tsx` 의미 이름·외부 폴더 아이콘 ID | API/ID 매핑 보존, 공통 아이콘은 스킬의 Lucide 기반 규격으로 정규화; 고유 아이콘 예외 명시 [House] |
| 깊이·재질 | 내용 면과 제어층 구별 | 가벼운 탐색/도구 재질 후보와 불투명 대안 비교. 대화·표·문서 전체에 blur 적용하지 않음 [HIG transfer] |
| 움직임 | 기존 `--dur-*`, reduced-motion | 상태 전환에만 사용. 메뉴/탭 전환이 작업 진행을 기다리지 않음 [House + HIG transfer] |

`typography/using-custom-fonts/make-sure-custom-fonts-are-legible` `branding/best-practices/apply-your-apps-accent-color-judiciously` `icons/best-practices/maintain-visual-consistency-across-all-interface` `motion/best-practices/make-motion-optional`

### 수치의 근거

- 현재 프로젝트 UI 기준은 `--fs-ui: 14px`, `--fs-micro: 12px`, 본문 역할 `--fs-body: 16px`이며 대화는 별도 사용자 크기를 사용한다. 이는 **현재 프로젝트 값 [House]**이며 Apple의 강제 규격이 아니다.
- 스킬의 macOS 참고값은 본문 기본 13pt/최소 10pt, 포인터 대상 기본 28pt/최소 20pt다. pt를 CSS px와 일대일로 출발시키는 것은 스킬의 [House] 구현 가정이다. 실제 OS DPI·줌에서 확인한다. 기존 더 큰 글자를 HIG를 이유로 줄이지 않는다.
- 읽는 글자와 주요 라벨의 목표 대비는 4.5:1 이상으로 잡는다. 굵기만으로 작은 글자의 기준을 느슨하게 하지 않는 **프로젝트 목표 [House]**다. 원문 표와 차이를 구별한다.
- 200% 글자 확대에서 기능·레이블·제어가 사라지지 않는지 검증한다. 문서 캔버스 자체의 확대와 앱 UI 텍스트 확대는 구별한다. `accessibility/vision/support-larger-text-sizes` [HIG transfer]

수치 출처: 스킬 `references/tokens.md`의 macOS/contrast/control 표, 기존 프로젝트 CSS. [Apple Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)도 현재 원문으로 대조했다. 이 계획 단계에서는 렌더된 실제 색 쌍의 대비를 측정했다고 주장하지 않는다.

## 기존 결정과 HIG/스킬이 달라지는 지점

| 지점 | HIG 또는 스킬 | 이번 계획 |
|---|---|---|
| 사용자 글꼴·룩 | 스킬 기본은 Pretendard·Lucide·Apple 계열 토큰 | 프로젝트 서체·브랜드·저장 설정 우선. UI 역할을 정돈하고 대비를 검증 [House] |
| 유리 효과 | HIG는 내용층 사용 금지, 제어층에서도 절제 | 기존 평면 스타일에서 제어층 재질을 비교하는 계획만 추가. 사용자 내용에는 적용하지 않음 [HIG transfer] |
| 테마 선택 | HIG는 시스템 외형을 따르는 것을 권장 | 기존 명시적 엔진별 룩/테마 옵션을 유지하고 시스템 따라가기를 지원 [House 예외] |
| 자동 편집 집중 | HIG는 사이드바의 발견 가능성과 사용자 제어 강조 | 메인에서는 탐색을 표시, 문서는 기존 사용자 요구대로 자동 집중+복귀 동작 제공 [House 예외] |
| 작업 공간 폭 | 스킬 웹 기본은 제한된 앱 폭·읽기 폭 | 데스크톱 다중 작업은 창 전체 활용, 긴 대화에만 기존 읽기 폭 적용 [House 예외] |
| 일반 웹 브라우징 | HIG의 web-view 지침은 일반 앱의 간단한 웹 접근을 전제 | 사용자가 요청한 공유 웹 작업 공간은 명시적 제품 범위. 브라우저 기능 전체 복제까지 확대하지 않음 [House 예외] |
| 아래쪽 입력창 | HIG의 Mac 지침은 중요 정보의 하단 배치를 주의시킴 | 대화 입력은 익숙한 위치를 유지하되 가려짐·초점·짧은 창을 검증. 전역 생성/탐색을 여기에만 두지 않음 [House 예외] |

관련 규칙: `materials/liquid-glass/use-liquid-glass-effects-sparingly`, `dark-mode/best-practices/avoid-offering-an-app-specific-appearance`, `sidebars/best-practices/consider-letting-people-hide-the-sidebar`, `web-views/best-practices/avoid-using-a-web-view-to`, `layout/platform-considerations/macos/avoid-placing-controls-or-critical-information`.

## 플랫폼별 적용

| 플랫폼 | 공통 | 개별 적용 |
|---|---|---|
| Windows | 구조·컴포넌트·상태·접근성 | Ctrl 단축키, OS 창 버튼/메뉴·포커스·IME·DPI, WebView2 |
| macOS | 같은 작업과 의미 | Cmd 단축키, 네이티브 메뉴/전체 화면 관례, WKWebView |
| Linux | 같은 작업과 의미 | 기존 데스크톱 창 동작, Ctrl 단축키, 한글 입력·WebKitGTK·실제 compositor |

`design-principles/flexibility/approach-every-platform-with-intention` [HIG transfer]. Windows/Linux에 macOS 신호등 창 버튼을 그려 넣거나, CSS blur를 Apple의 네이티브 Liquid Glass 구현이라고 부르지 않는다. OS별 구현 방법은 [Engineering]이다.

## 시안 검토에서 남길 선택

[HIG none] 제어층을 불투명하게 할지, 제한된 재질 효과를 더할지는 대표 화면의 두 후보를 비교해 결정한다. 내용층·접근성·기능 보존 기준은 두 후보 모두 같다. 폭·읽기 밀도는 기존 창 크기와 실제 콘텐츠로 검토한다. 이러한 선택은 구현 중 무한한 외형 수정 목표로 남기지 않고 W0의 시각 계약에 고정한다.

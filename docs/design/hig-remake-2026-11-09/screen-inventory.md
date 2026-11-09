# 화면과 기능 대응표

S01~S15는 개편 추적용 화면군이다. 기존 메뉴 항목을 삭제하거나 하나의 거대한 화면에 모두 넣겠다는 뜻은 아니다. 기준 commit의 코드 관찰을 바탕으로 했으며 픽셀 수준의 현행 화면 감사는 W0에서 수행한다.

## 전체 화면군

| ID | 목적·내용 순서 | 주요 행동·구성 요소 | 진입·다음 흐름 | 코드·결정 |
|---|---|---|---|---|
| S01 시작/최근 작업 | 마지막 작업, 새 작업, 최근 프로젝트 | 간결한 입력·최근 목록·새로 만들기 | 실행 → S02/S03/S04 | `StartView`, `HomeModes`, `WorkModes`; D01/D03 |
| S02 프로젝트 개요 | 이름·설명·속성, 관련 대화/문서, 작업공간 | 프로젝트 노트, 속성 편집, 썸네일·템플릿·보기 전환 | 프로젝트 클릭 → S03/S04/S07/S10 | `project/ProjectView`, `PropertiesPanel`, `ProjectsMode`; D01/D09/D12 |
| S03 메인 대화 | 원문 요청·응답·결과, 작업 진행, 상세 로그 | 입력·첨부·모델·실행 제어·자식 작업·수정안 | 세션 선택/검색 결과 → 문서/웹/검토 | `WorkView`, `Transcript`, `Composer`, `SessionControls`, `ModelPicker`; D06~D08/D13 |
| S04 문서 작업 셸 | 파일명·저장 상태, 편집기, 해당 문서 AI | 저장·앱으로 열기·내보내기·작업공간 보기 | 문서 선택/생성 → S05/S06/외부 앱 | `docs/DocumentView`, `DocTabs`, `OfficeFileMenu`, `OfficeEditor`; D02~D05/D13 |
| S05 형식별 편집기 내부 | 편집 캔버스, 자주 쓰는 도구, 선택 대상 속성 | 아래 형식별 표의 모든 기존 명령 | S04 안에서 작업, 형식별 대화상자 | `apps/office`, 내장 renderer; D04/D05/D09/D13 |
| S06 나란히 작업 | 선택한 두 작업과 활성 칸 | 탭 이동·분할·크기·집중·복귀 | 사용자가 분할 선택 → 원래 작업 | `Panes`, `tabs`, `panes`, `layout-persistence`; D02/D04/D09 |
| S07 자료·볼트·보기 | 위치·읽기 권한, 폴더/목록, 노트·미리보기 | 뒤로/앞으로/상위, 필터·정렬·표/보드/그래프 | 프로젝트/연결 볼트 → 노트/문서/검색 | `pkm/VaultBrowser`, `VaultNoteView`, `views/*`, `project/ProjectsGraph`; D01/D08/D09/D12 |
| S08 통합 검색 | 검색어·범위, 종류별 결과, 원문 문맥 | Ctrl+K, 필터, 미리보기, 원문 위치 열기 | 모든 화면 → 정확한 작업/문서/메시지 | `SearchPalette`, `FastFindPreview`; D08 |
| S09 공유 웹 탭 | 주소·이동, 페이지, 이 페이지 AI | 사용자 인계·재개·분할·다운로드 | 생성/AI 작업 → 웹/문서 결과 | **신규 기능 설계**; 기존 `BrowserPill`과 구별, D02/D05~D07 |
| S10 worktree·변경 검토 | 작업공간, 변경 파일, 차이·충돌·검토 상태 | 준비·비교·적용·GitHub 검토/작업 상태 | S02/S03 → 검토/터미널/프로젝트 | `WorkspacePicker`, `WorktreeReview`, `SourceControlDialog`, `Scm*`, `GitHub*`; D09/D10/D13 |
| S11 터미널 | 현재 프로젝트/workspace, 출력, 입력 | 세션 생성·전환·찾기·닫기 | S02/S03/S10 → 기존 작업 | `TerminalView`, `TerminalDialog`; D02/D09 |
| S12 설정 | 작업과 분리된 일반 환경설정 | 외형·단축키·AI 연결/모델·권한·통합 기능 | 명시적 설정 메뉴 → 원래 화면 | `AppearanceSheet`, `ShortcutSettings`, `Connections`, `IntegrationsSheet`, `OfficeSettings`; D11/D14 |
| S13 온보딩·설치·연결 | 가능한 기능과 현재 설정 상태 | 이음오피스 독립 설치/연결, 엔진 설정, Dropbox·볼트 연결 | 최초/기능 첫 사용/설정 → 실제 작업 | `Onboarding`, `EngineSetup`, `IeumAppDialog`, `DropboxDialog`, `VaultDialog`; D11/D14 |
| S14 라이브러리·보조 작업 | 스킬·양식·지식·기존 이미지/변환 작업 | 선택·가져오기·적용·생성·상태 확인 | 생성 메뉴/문서/설정 → 결과물 | `SkillLibraryDialog`, `KnowledgeHome`, `ImageGen`, `ScheduleDialog` 등 **현재 노출된 기능**; D03/D07/D11 |
| S15 보관·삭제·복구·공통 피드백 | 대상·영향·복구 가능성·상태 | 복원·삭제·취소·재시도·결과 열기 | 메뉴/오류/알림 → 관련 화면 | `ArchiveView`, `ProjectDeleteDialog`, `Recovery`, 공통 알림; D07/D10/D14 |

모든 화면에서 가장 먼저 읽힐 내용은 작업 대상과 현재 내용이다. 큰 제목·강조색·애니메이션은 해당 화면의 행동 우선순위와 연결한다. `layout/visual-hierarchy/order-content-by-relative-importance` `layout/visual-hierarchy/use-progressive-disclosure-to-make-layouts` [HIG transfer]

## S05: 편집기 내부 UI도 완료 범위에 포함

바깥 `apps/web`의 CSS가 별도 origin의 Office iframe 내부를 자동으로 바꾸지 않는다. 형식별 renderer에서 공통 토큰·도구·메뉴 어댑터를 적용한다. **문서 자체의 글꼴·페이지·셀·슬라이드 스타일과 앱 UI 스타일을 분리**한다. [Engineering]

| 형식군 | 다시 구성할 UI | 유지할 동작·내용 |
|---|---|---|
| 한글 | 메뉴/도구 모음, 페이지·개체 속성, 파일 동작, AI 패널 | 현재 지원되는 읽기/편집/저장/변환, 원본 조판 |
| Word | 리본·서식·삽입·검토 진입, 속성·파일/출력 대화상자 | 기존 명령·키보드·선택·Undo·페이지 내용 |
| 슬라이드 | 썸네일 목록, 삽입/서식, 개체 속성, 발표·출력 | 캔버스·개체 편집·템플릿·매체·발표 동작 |
| 스프레드시트 | 시트 목록, 수식/도구, 셀·범위 속성, 출력 | 셀·수식·계산·선택·편집 단축키 |
| Markdown | 파일/미리보기/서식, 이미지·참조·AI | 원문·미리보기·링크·저장·이미지 처리 |
| PDF | 페이지/탐색/주석, 읽기·변환·추출·OCR 작업 | 현재 지원 기능, 진행·결과·원본 보존 |
| HTML | 코드/미리보기·출력·관련 도구 | 현재 편집/미리보기/변환의 계약 |
| 마인드맵 | 노드 조작·속성·보기·파일 동작 | 구조·캔버스 선택·편집·출력 |
| EPUB | 목차·읽기·편집·번역·출력 | 챕터·앵커·현재 위치·변환 작업 |

기존 기능을 줄이지 않으면서 도구를 자주 쓰는 명령, 현재 선택의 명령, 고급 명령으로 정리한다. 모든 기능을 작은 아이콘 한 줄로 압축하거나 `⋯` 안으로 밀어 넣지 않는다. `toolbars/best-practices/choose-items-deliberately-to-avoid-overcrowding` `toolbars/item-groupings/group-toolbar-items-logically-by-function` [HIG transfer]

## 공통 상태 목록

각 화면군에 해당하는 상태를 표시한다: 기본, 선택, 키보드 초점, 비활성+이유, 빈 목록, 로딩, 작업 중, 입력 필요, 오류, 완료, 읽기 전용, 저장 중, 미저장, 외부 수정 충돌. 존재하지 않는 상태를 억지로 추가하지 않는다. `design-principles/familiarity/provide-clear-feedback` [HIG transfer]

S03/S04/S09는 “내 작업”과 “AI 작업”의 대상·소유권을 명시한다. S07은 읽기 전용을 색만으로 전달하지 않는다. S10은 현재 worktree와 실제 파일 위치를 표시한다. S12/S13은 일반 설정과 지금 작업에 필요한 선택을 구분한다. [House]

## 창 크기에 따른 배치

- 넓은 창: 탐색·내용·선택적 보조 패널. 사용자 선택 분할을 허용한다.
- 좁은 창/큰 글자: 내용이 먼저 남고 탐색·보조 패널은 명시적으로 열 수 있게 한다. 현재 선택과 초안은 보존한다.
- 편집기: 기존 형식별 최소 조작 범위를 확인하고, 넓은 표/슬라이드는 콘텐츠 스크롤·확대로 처리한다. 메뉴까지 잘라 버리지 않는다.

`layout/adaptability/be-prepared-for-text-size-changes` `windows/best-practices/make-sure-that-your-windows-adapt` [HIG transfer]. 정확한 폭은 기존 창 제약과 대표 시안 실측에서 확정한다. 스킬의 웹 기본 폭을 데스크톱 작업 공간 전체에 강제로 적용하지 않는다. [House]

## 추적 규칙

구현 시 각 S##의 메뉴/명령을 기존 command → 새 진입점 → 단축키 → 검증으로 매핑한다. 비교 표가 없는 기능은 임의로 없어진 것으로 처리하지 않고 미완료로 남긴다. 실제 화면 루트에는 테스트/검토용 `data-screen="S##"`를 부여하고, 문서와 코드를 같이 갱신한다. [Engineering]

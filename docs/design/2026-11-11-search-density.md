# Ctrl+K 검색창 크기와 정보 밀도

검색창이 원래 참고한 Fast Find 10k보다 작고 정보를 한눈에 모아 보기
어렵다는 사용자 피드백을 반영했다. 현재 HIG CSS의 최대 폭 1,040px와
검색 CSS의 최대 높이 820px, 결과 행 12px 안쪽 여백이 함께 공간을 제한했다.

[참조한 원본 CSS](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/plugin/styles.css)는
90vw·85vh, 결과 55%와 본문 45%, 작은 행 여백을 사용한다. 이 원리를
기존 Workbench 검색 컴포넌트에 적용했다.

계획: `research:rr-cfc60e418e2e3f16fff52b6a09aeaf78:c9caf5143ddf5cbfdc7095aed8094cf539f8f415d945f264342db7c1180fea6b`.

## 변경

- 창을 94vw·92dvh로 확대하고 가운데 배치한다. 743px 이하에서는 가장자리
  8px만 남긴다. 큰 모니터에서도 기존 픽셀 상한 때문에 작게 남지 않는다.
- 결과 목록과 선택 본문을 55:45로 배치한다. 각 영역은 따로 스크롤한다.
- 입력 영역은 64→52px, 결과 행의 세로 여백은 12→6px로 줄인다.
  제목 15px·발췌 13px는 유지하며 발췌 대비를 높인다.
- 긴 프로젝트/메타데이터가 결과 제목을 밀어내지 않도록 열 너비를 제한한다.
  좁은 창의 목록/본문 전환과 터치 44px 대상은 유지한다.
- 검색 엔진·순위·페이징·문서 데이터는 바꾸지 않았다. 원문 사용자 프롬프트와
  AI 답변이 문서·프로젝트·볼트보다 먼저 보이는 기존 규칙을 유지한다.

## 같은 데이터로 확인한 차이

실제 Linux WebKitGTK, 1440×1000, 임시 프로젝트 6개·세션 12개에서 동일한
‘강의’ 검색어로 비교했다. 실사용자의 대화나 계정은 사용하지 않았다.

| 측정 | 기존 | 수정 |
| --- | ---: | ---: |
| 팝업 | 1040×820px | 약 1354×920px |
| 결과 영역 높이 | 614px | 738px |
| 첫 결과 행 높이 | 70px | 56px |
| 완전히 보이는 목록행(더 보기 포함) | 6 | 10 |
| 제목 / 발췌 글자 | 15 / 13px | 15 / 13px |

2016×1206에서는 약 1895×1110px로 확장됐다. 실제 720px 창에서도
화면 밖으로 넘치지 않으며 목록/본문 전환이 동작한다.
키보드 선택과 Enter로 대화 열기, 대화 우선 표시, 라이트·다크를 확인했다.
기존 포커스 테스트 3개와 프런트엔드 빌드가 통과했다.

첫 수집은 비교 화면을 완료한 뒤 테스트 도우미에 없는 KEY.down을 호출해
중단했다. 제품 변경 없이 WebDriver의 ArrowDown 코드를 사용하고 완료된
비교는 보존한 채 남은 동작·테마·좁은 화면만 확인했다.

화면: [기존](previews/2026-11-11-search-density/before-light.png),
[수정 라이트](previews/2026-11-11-search-density/after-light.png),
[큰 다크 화면](previews/2026-11-11-search-density/large-dark.png),
[좁은 화면](previews/2026-11-11-search-density/narrow-results.png),
[측정값](previews/2026-11-11-search-density/measurements.json).

## 설치

0.4.1 기반 로컬 패치 `search-density-20261111`로 이 노트북에 설치하고
정상 실행했다. 제품 소스 커밋은 `cb1bb14cdcf48dc14ee5b7bd5fe1cfc375d17a5d`다.
실행 중인 앱이 새 프런트엔드를 제공하는지 해시로 확인했으며, 기존 세션 9개와
대화 항목 342개는 그대로 유지됐다. 네이티브 실행 파일·호스트는 바꾸지 않았다.
직전 설치본은 `~/.local/opt/achmage-workbench.previous-20261111-search-density`,
DB 백업과 설치 확인은 `.hallmark/search-density/install/`에 보존했다.
이번 작업의 임시 런타임만 제거했다.

Windows/macOS 실행이나 새로운 GitHub 릴리즈를 수행했다는 의미는 아니다.

완료 근거: `research:rr-cfc60e418e2e3f16fff52b6a09aeaf78:ed831d8a929b88e5e5c48249554949fe027ecde731f5e5cbefecfdfd662f8191`.
연구 기록은 로컬 큐에 저장됐으며 이 시점의 원격 동기화 완료는 확인하지 않았다.

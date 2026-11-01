# Fast Find 기반 세션·볼트 검색 교체 계획

작성일: 2026-11-01. 갱신: 2026-11-02. 상태: **Finder·저장 보기·AI 기본 엔진과 검색 화면 교체 완료 / 고정 규모 측정 및 최종 OS 설치본 확인 중**.

사용자 요청은 기존 검색 옆에 검색기를 하나 더 두는 것이 아니라, 세션과 연결 Obsidian 볼트를 Fast Find 같은 즉시 검색·구조화 결과·넓은 미리보기로 찾도록 **기존 검색을 교체**하는 것이다. HOP 개선은 유지한다. 후속 사용자 정정으로 시각적 웹 Design Mode는 이번 릴리스에서 제외했으며 검색 작업의 선행 조건이 아니다.

범위 정정: `decision-d21398c56cf5de805cc77fcc3217b2519b6d733c372a61384a1861dd5687a5ce`; 정확한 판 `research:rr-52e63272408c52a10ffec47ce0a19a2f:76674b66f7a8d695ff793b380d18901b2580defbee377e3dfed010157cce0ba8`.

사용자의 후속 코어 사용성 점검에 따른 자동 이음 독립 앱 설치·OS 등록·연결과 실제 외부 GUI 왕복·병렬 AI 인수를 완료했다. [현재 인수 기준](../IMPLEMENTATION-2026-10-29.md)을 따른다. 웹 Design Mode 제외는 유지한다.

현재 완료한 연결: typed YAML/원문 보존, 상위 결과 절단 전 범위/집계/페이지 선택, 한글 부분어·조사·인접 띄어쓰기·NFD/이모지 강조, 단일 지속 worker와 호출자별 취소, 전체원문 캐시와 초기 배치/변경/삭제/긴 메시지 중복 제거. Finder·저장 보기·AI가 같은 native 엔진을 사용하고 기존 FTS 검색 테이블/순위 경로는 제거했다. 원본 Canvas 추출과 결과/미리보기/관련 항목/키 처리도 연결했다. 실제 native worker를 사용한 전체188파일1290시험, 배포 web/host의 화면 검사11개 및 타입 검사가 통과했다. 기본 입력의160ms 대기·자동 LLM 재정렬은 제거했으며 AI 재정렬은 명시적 버튼으로 유지한다.

현재 판: `research:rr-236ff3048f29782b4eb36a197c2932df:fdeab07034d81b8ed7793ef3c7824201a3a50ac07adfe2341454e281c4ebf2d0` (R18). 화면 결과 `fast-find-ui-03/results.json`, 전체 검사 `fast-find-full-suite-01.log`, 중복 작업 제거 후 회귀26/26 `fast-find-perf-regression-02.log`. 고정 규모 측정은 아래 성능 절에 기록했다. 실제 OS 설치본 인수는 별도이며 완료로 세지 않는다.

상류 unit 기능171개는 통과했으나 원본 개발기10ms 예산1개는 원본 release profile 복원 후에도13.458ms였다. 이는 아직 통과로 표시하지 않으며 고정10k/100k 앱 성능 인수와 구분한다. 같은 조건의 예산 검사를 반복하거나 상한을 완화하지 않는다. 정확한 연구 판 `research:rr-236ff3048f29782b4eb36a197c2932df:ac67bdd5e5813e0bb606574b4d10afebc73cba46ed9a19816b166b6c7201aec3` (R4–R11); 원본94개 hash와11개변경은 `third_party/fast-find/{upstream,adaptations}.json`에 기록했다.

## 1. 판단과 고정 기준

**도입을 권장한다.** 원본은 Obsidian 전용 UI와 독립 Rust 검색 라이브러리가 이미 분리돼 있다. Rust 코어와 원본 결과/미리보기 로직을 가져오고, Workbench의 데이터·열기·범위·한글 계약을 연결한다. 검색 알고리즘이나 퍼지 매칭을 새로 만드는 작업으로 확대하지 않는다.

| 구분 | 확인한 기준 |
|---|---|
| 원본 | [ssp-data/obsidian-fast-find-10k](https://github.com/ssp-data/obsidian-fast-find-10k) |
| 고정 소스 | `714548efd3e361a7011a5123f4ae928630a01614`, 플러그인 0.2.6 |
| 라이선스 | MIT, Copyright 2026 Simon Späti. 배포 시 원문·출처·변경 이력 유지 |
| 비교한 Workbench | `871bd22`; 미출시 Design Mode 변경은 사용자 요청으로 별도 보존 후 제품 소스에서 제외 |
| 실제 확인 | 원본 CLI release 빌드 성공, 합성 Markdown 7개·질의 13개 실행 |
| 초기 조사 당시 미확인 | 아래 후속 측정과 구분: 통합 앱 속도·메모리·OS별 패키지 증가량, 교체 후 GUI/설치본 |

정확한 연구 판: `research:rr-236ff3048f29782b4eb36a197c2932df:cc4f01703ac3c22394585ebacc01725ca7432b85b390978e818d2d83caa1370f`.
R1은 원본·현행 검색 대조, R2는 한글/속성 호환 실험, R3는 도입 경계 결정이다. R2에서 확인한 회귀는 **미해결**이며, 계획 작성으로 해결 처리하지 않는다.

### “따로 인덱싱하지 않는다”는 체감의 실제 구조

원본은 **인덱스가 없는 검색기가 아니다**. Rust에 제목·별칭·제목줄·본문·태그·속성·경로별 역색인을 만들고, 원문은 IndexedDB에 경로/mtime/크기와 함께 캐시한다. 시작 시 캐시를 배치로 읽어 메모리 인덱스를 채우고, 바뀐 파일만 다시 읽는다. 사용자가 검색 전에 별도 인덱싱 절차를 수행할 필요가 없는 구조다.

체감 속도를 만드는 조합은 필드별 역색인, 제한된 퍼지 검색 범위, 백그라운드 Worker, 입력 대기 제거, 오래된 요청 폐기, 상위 결과만 상세화, 선택한 항목만 미리보기다. 우리 앱에서도 이 조합을 가져온다. [원본 구조](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/docs/architecture.md), [인덱서](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/plugin/src/indexer.ts), [Worker](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/plugin/src/worker.ts).

## 2. 원본에서 가져올 기능과 연결 지점

| 원본 기능 | 가져오는 방식 | Workbench에서의 동작 |
|---|---|---|
| 제목·별칭 → 제목줄 → 본문 등 단계별 순위 | Rust `rank`·설정 재사용 | 제목 일치를 본문 반복 횟수가 밀어내지 않음 |
| 정확 일치·접두어·오타 허용 | 원본 tokenizer/neo_frizbee 재사용, CJK 호환만 추가 | 한글 띄어쓰기·부분어 계약을 보존 |
| 여러 단어 AND·따옴표·태그·경로·제외·속성·파일 종류 | 원본 query 재사용, 앱 범위는 별도 구조화 필터 | 프로젝트·세션·제공자·보관 상태 선택 가능 |
| 전체 검색 / 파일 제목 중심 검색 | 원본 모드 재사용 | 기존 Ctrl+K 안에서 전환 |
| 일치 필드·제목줄·발췌·강조·순위 이유 | 원본 results 및 range 로직 | 요청/답변/문서/프로젝트/볼트 종류를 함께 표시 |
| 넓은 본문 미리보기·일치 개수·일치 줄만 보기 | 원본 preview 재사용 | 세션은 선택 메시지와 주변 대화, 노트는 본문/제목줄 |
| 키보드 이동·열기·옆 칸 열기 | 원본 keys/actions를 앱 열기에 연결 | 정확한 itemId·문서 판·노트 위치로 이동 |
| 제목 기반 관련/유사 노트 | 원본 similar 재사용 | 선택 결과와 관련된 항목을 아래에 표시 |
| 새 노트 전 유사 제목·중복 확인 | 원본 similar + 기존 새 문서 기능 | 검색만으로 파일을 만들지 않고 명시적 생성에 연결 |
| 최근 열기·검색어별 자주 여는 결과 | 원본 frecency/combo 규칙 | 기기 로컬에 저장, 초기화 가능 |
| Markdown·Bases·Canvas·Excalidraw 텍스트 | 원본 형식 처리 재사용 | 이미 연결된 볼트의 허용 파일만 수집 |
| 이미지·Mermaid 지연 미리보기 | 원본 지연 처리 + 기존 렌더/자산 경로 | 선택한 항목만 처리, 지원되지 않는 개체는 원문 유지 |
| 존재하지 않는 위키링크 대상(ghost) | 원본 unresolved 재사용, 볼트에 한정 | “아직 없는 노트”로 구분, 실제 파일 결과와 혼동 방지 |
| 무시 경로·폴더 순위 조정·약어·퍼지 설정 | 원본 설정 중 관련 항목만 연결 | 기존 숨김 정책을 기본으로 하며 선택 설정만 노출 |
| Smart Connections 벡터/의미 검색 | 별도 호환 연결 | 아래 조건 충족 시 선택 기능; 기본 검색의 전제 아님 |

퍼지 검색은 원본처럼 제목·별칭·H1–H3 중심이다. “모든 본문의 모든 오타까지 같은 비용으로 검색한다”는 기능으로 확대하지 않는다. 결과의 원본 tier를 기본으로 유지하며 기존 선택형 AI 재정렬을 모든 키 입력에 자동 호출하지 않는다.

UI 코드는 `plugin/src/ui/{modal,results,preview,similar}.ts`, `keys.ts`, `actions.ts`를 기준으로 가져온다. Obsidian `Modal/Scope/MarkdownRenderer/TFile/WorkspaceLeaf`와 `.createDiv/.setText/.empty` 같은 DOM 확장에 의존하므로 그대로 React에 붙일 수는 없다. 원본 내부 동작은 유지하고 명시적인 DOM/열기/렌더 어댑터와 React 수명주기 래퍼를 둔다. CSS는 검색 화면 범위로 한정한다. Obsidian 전체 런타임이나 Electron 앱을 탑재하지 않는다.

## 3. 현재 검색에서 달라지는 부분

| 현행 코드/계약 | 현재 상태 | 교체 계획 |
|---|---|---|
| `SearchPalette.tsx` | 키 입력 후 160ms 대기, 짧은 발췌 목록 | 대기 제거, 오래된 응답 무시, 결과·미리보기·관련 항목 구성 |
| `search-index.ts` | SQLite FTS5 trigram + unicode61 | 검색 본체를 ff10k로 교체; 원본 데이터와 재생성용 캐시 유지 |
| `search.ts / Finder` | 검색·범위·묶음·문서/답변 결합 담당 | 검색 계산은 공통 서비스, 기존 범위·열기·묶음 계약 유지 |
| `search-text.ts` | CJK 음절쌍·조사·띄어쓰기·부분어 보정 | 검증된 규칙을 CJK 호환 모듈로 좁혀 이식 |
| `VaultMirror` | 파일/설정 감시, Notebook Navigator 숨김 반영 | 이 수집 경계를 재사용; 원본 플러그인의 전체 vault crawl 중복 금지 |
| `Store`의 메시지/문서 이벤트 | 완료 메시지·문서 판을 증분 반영 | 같은 이벤트를 검색 upsert/remove로 전달 |
| `/api/search`, `workbench-find` | 동일 Finder를 사용, 동기 호출 포함 | 동일 비동기 SearchService로 전환 |
| PKM/Bases 저장 보기의 `cardMatches` | 현재 검색 의미에 의존 | 새 서비스와 동등한 조건으로 연결, 저장 보기 회귀 확인 |
| `FoundHit/SearchPage` | itemId/artifactId/revision·그룹/전체 개수·offset 보유 | 이 식별자와 페이지 계약 보존, tier/일치 이유/미리보기 정보 추가 |

검색 코드의 UI, API, AI 도구 중 하나만 바꾸고 나머지에 오래된 검색 의미를 남기지 않는다. 문서·결정·프로젝트 검색도 기존 Ctrl+K에서 계속 제공한다.

## 4. 실제 실험에서 확인한 연결 과제

### 4.1 한글은 원본 그대로 교체하면 회귀한다

원본 CLI를 변경하지 않고 다음 문서를 포함한 합성 7개로 실행했다.

- 분리 본문: `채점 기준을 세 단계로 나눠 줘`
- 붙인 본문: `채점기준표를 만들었습니다. 평가 항목은 셋입니다.`
- 수업 기록: `채점기준은 다음과 같습니다.`
- 제목: `과제 채점 기준표.md`

| 검색어 | 원본 0.2.6 실제 결과 | 교체 시 보존할 조건 |
|---|---|---|
| `채점기준` | 붙인 본문·수업 기록, 분리 본문 누락 | 붙여쓰기/띄어쓰기 모두 찾기 |
| `채점 기준` | 분리 본문·제목, 붙인 본문 누락 | 같은 한글 단어가 붙어 있어도 찾기 |
| `기준` | 0건 | `기준을`, `채점기준표`의 부분어 찾기 |
| `가나다`의 NFC/NFD | 둘 다 같은 문서 발견 | 정규화 유지 |
| 일반 속성·태그·별칭 | 정상 발견 | 원본 장점 유지 |
| 콜론을 포함한 YAML 키 | 정확한 속성 필터 대신 일반 Property 텍스트 일치 | 원래 키와 값의 구조 보존 |

원본의 단독 단어 접두검색은 4문자 이상 조건이 있으며, 한글 띄어쓰기 회복·중간 부분어 검색이 현행과 다르다. 원인 근거: [rank.rs](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/crates/ff10k-core/src/rank.rs), [tokenize.rs](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/crates/ff10k-core/src/tokenize.rs).

연결 방법은 현재 `wordTokens/pairedAlternatives/stripJosa`의 의미를 CJK 모듈로 이식해 **필드별 후보 생성 단계**에 추가하는 것이다. 한글 후보도 같은 tier 규칙을 거친다. 영문 원본 tokenizer/퍼지 엔진을 전면 개작하거나 전체 SQLite 검색을 영구 병행하지 않는다. 단어 순서·음절쌍 위치·한 글자 검색을 보존하고, 추가 토큰의 위치는 원문 위치로 연결한다. 현재 `search.test.ts`의 한글 사례와 위 fixture가 완료 기준이다.

이 포팅은 구현·집중 검증했다. 필드 사전의 각 고유 단어를 음절/음절쌍 후보표에서 찾고 실제 부분 문자열과 원본 단어의 인접 위치로 확인한다. 원문에 검색용 가짜 단어를 덧붙이거나 미리보기 본문을 바꾸지 않는다. 제품 UI의 FF03 인수는 기본 엔진 전환 후 확인한다.

### 4.2 속성과 범위는 텍스트 검색과 분리한다

원본 frontmatter 파서는 간단한 줄 단위 파서다. 따옴표 안 콜론이 있는 `"DIKM_단계:"`나 빈 값, 복합 YAML을 사용자 원본의 구조 그대로 해석하는 계약과 다르다. 또한 인식되지 않는 태그/속성 표현을 일반 단어로 다시 찾는 관대한 fallback이 있다. [파서](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/crates/ff10k-core/src/markdown.rs), [질의](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/crates/ff10k-core/src/query.rs).

앱의 기존 YAML 파서에서 키/값을 읽어 구조화된 메타데이터로 넘긴다. 원본 키 이름, scalar/list 형태, 빈 값과 알 수 없는 값, 본문 바이트를 변경하지 않는다. 콜론 키처럼 텍스트 문법이 모호한 조건은 속성 선택 UI의 구조화 필터로 정확히 표현한다.

프로젝트·세션·제공자·보관·숨김 조건은 검색어의 `path:` 등으로 대신하지 않는다. host가 검증한 별도 범위 정보로 적용하고, 결과·관련 항목·개수·AI 출력 모두 같은 경계를 사용한다.

### 4.3 상위 결과를 받은 뒤 필터링하면 안 된다

원본 `SearchOptions`는 mode/limit/nowSecs/debug 중심이며 앱의 offset·그룹 페이지·권한 조건이 없다. `candidates`는 앱의 실제 표시 결과 개수가 아니고, `totalDocs`는 전체 인덱스 문서 수다.

필요한 작은 확장은 **후보 단계의 범위 제한 → 원본 순위/부분 일치 규칙 → 문서/답변 및 메시지 조각 중복 정리 → 실제 개수·그룹 집계 → 페이지 자르기 → 해당 결과만 상세화**다. 먼저 30건을 받고 허용 범위를 거르면 적합한 31번째 결과를 놓친다. 점수 함수를 새로 만들지 않고 이 경계를 드러내는 패치를 유지한다.

## 5. 권장 실행 구조

**기존 Tauri 실행 파일에 `ff10k-core`를 편입하고 `--search-worker`로 실행하는 지속 검색 프로세스**를 권장한다. 이미 앱은 PTY/글꼴용 자체 worker와 host로의 실행 경로 전달을 사용한다.

| 선택지 | 판단 |
|---|---|
| Rust core + 앱 자체 지속 worker | **선택**. UI/CLI 공통, 기존 Rust 빌드·배포에 편입, 브라우저 창 수와 엔진 수 분리 |
| 원본 WASM + Node worker_threads | 유효한 대안. native 연결을 실제로 막는 문제가 생길 때 전환 검토 |
| 웹뷰마다 원본 브라우저 Worker | 창별 인덱스/메모리 중복과 AI 도구 연결 문제가 있어 기본안에서 제외 |
| 새 검색 엔진·상시 AI 재정렬 | 원본 재사용 목적과 비용/즉시성에 맞지 않아 제외 |

host의 SearchService가 원본 이벤트와 요청을 연결한다. 앱 데이터 디렉터리당 하나의 worker를 유지하고, 세션/문서/창마다 새 엔진을 만들지 않는다. stdin/stdout은 버전 있는 메시지 프로토콜, 진단은 stderr, 정상 종료는 EOF/shutdown을 사용한다. 새로운 네트워크 서비스는 필요 없다.

원본 core는 Rc/RefCell 등을 사용하므로 만든 엔진을 여러 스레드로 무리하게 공유하지 않고 worker 내부에서 순서대로 사용한다. 변경 이벤트의 순서와 판을 보장하고 검색 취소는 **창/AI 호출자별**로 분리한다. 원본의 전역 latestSearchId를 그대로 공유해 다른 창이나 AI 검색을 지워 버리지 않는다. 일괄 수집 중에도 검색과 화면을 계속 처리한다.

### 수집과 캐시

- 세션: 프로젝트/세션 제목 레코드와 요청·답변·계획 레코드를 구분한다. UUID를 제목으로 검색하거나 같은 세션 제목을 모든 메시지의 최상위 제목으로 복제하지 않는다.
- 긴 메시지: 문단 기준 조각과 원래 itemId/오프셋을 연결하고, 조각 겹침은 한 결과로 정리한다. 스트리밍 토큰마다 전체 대화를 재색인하지 않으며 확정/수정/삭제 이벤트를 사용한다.
- 문서: 기존 document/artifact revision과 출처를 유지한다. 문서와 작성 답변을 묶는 현행 동작도 유지한다.
- 볼트: 기존 연결 root와 VaultMirror의 허용 경계에서 Markdown/Bases/Canvas 등을 읽는다. PDF/Office는 이미 추출된 텍스트가 있는 범위에서 연결하고, 검색 도입을 새 OCR·변환 프로젝트로 늘리지 않는다.
- 캐시: 원본의 raw-text + mtime/size + 변경분 갱신 원리를 기존 로컬 SQLite에 맞춘다. 버전/고정 원본 hash/원본 판을 함께 관리하고 불일치 시 파생 캐시만 재생성한다. 기존 Store 원본·대화 DB를 삭제하거나 Dropbox에 live DB를 옮기지 않는다.
- 처음 실행: 500건 정도의 작은 배치를 먼저 검색 가능하게 하고 진행 상태를 표시한다. 아직 준비되지 않은 범위를 “검색 결과 없음”으로 확정하지 않는다.
- 외부 변경: 생성/수정/이름 변경/삭제와 Notebook Navigator 설정 변경을 반영한다. 숨겨진 결과는 진행 중 요청과 관련 노트에서도 제거한다.
- 미리보기: 원본 UTF-8 범위를 JS UTF-16 범위로 변환하는 로직을 재사용한다. 한글·이모지 위치를 보존하고 상세 원문은 선택 결과만 요청한다.

세션 검색 레코드는 앱 내부 투영이다. 실제 Markdown 파일 수만 개를 만들어 세션을 볼트에 복사할 필요가 없다.

### UI와 AI 도구

기존 Ctrl+K 진입점에서 상단에 전체/프로젝트/세션/문서/볼트 범위를 둔다. 왼쪽에는 순위 결과와 출처·종류, 오른쪽에는 선택 결과의 본문과 일치 위치, 아래에는 관련 항목을 표시한다. 좁은 창에서는 미리보기를 전환해서 본다.

프로젝트는 YAML 속성을 가진 프로젝트 노트, 세션은 대화, 파일은 문서로 구분한다. 메시지 결과를 누르면 그 메시지로, 제목줄 결과는 해당 문서 위치로 간다. Enter/수정키로 열기·분할 열기를 기존 탭 동작에 연결한다. 입력 중 오래된 결과가 최신 결과를 덮지 않으며 한글 IME 조합·Esc·화살표를 정상 처리한다.

`workbench-find`는 같은 서비스의 결과를 사용하되 현재 작업 기본 범위, 명시적 전체 범위, 활성 턴 제외, **4,096바이트 출력 한도와 이어 읽기**를 유지한다. UI 속도를 위해 전체 세션 본문을 AI에 통째로 반환하지 않는다. 기본 검색에 LLM 호출은 없다.

## 6. 의미 검색의 경계

원본 Smart Connections 브리지는 Obsidian의 `window.smart_env`와 embedding model에 의존한다. 독립 Tauri에서 그 전역 객체를 사용할 수는 없다.

원본 CLI에는 `.smart-env` 벡터를 읽는 로더가 있다. 파일 형식·모델·차원이 호환되면 읽기 전용으로 기존 노트 벡터를 가져와 관련 노트에 연결할 수 있다. 쿼리 의미 검색은 **같은 모델의 쿼리 인코더**가 있을 때만 제공한다. 모델이 다른 QMD 벡터와 섞거나 API 호출을 자동으로 시작하지 않는다. 파일 경계·Windows 경로도 확인하고 원본 저장소에는 쓰지 않는다.

제목 기반 관련 노트와 기본 검색은 첫 교체에 포함한다. 새로운 임베딩 구축·모델 다운로드·모든 Smart Connections 버전 호환은 이번 검색 교체의 출시 차단 조건으로 추가하지 않는다. [원본 브리지](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/plugin/src/smart-connections-bridge.ts), [CLI 벡터 로더](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/crates/ff10k-cli/src/smart_env.rs).

## 7. 성능과 용량: 원본 수치와 우리 목표 구분

원본 측정은 Ryzen AI 9 HX 370, 9,385개 노트/27MB 조건이다. 5개 질의의 native p95는 약1.4–8.8ms, 입력부터 화면 표시까지는 30ms 미만으로 보고됐다. 첫500건 검색 가능 상태는 약300ms, warm 전체 준비는1.2–1.4초였다. WASM 메모리는 벡터/ghost 없이135MB, 포함 시164MB로 보고됐으며 원본도 메모리 목표를 모두 만족하지는 않았다. **우리 앱 측정치가 아니다.** [상류 측정 조건과 결과](https://github.com/ssp-data/obsidian-fast-find-10k/blob/714548efd3e361a7011a5123f4ae928630a01614/docs/perf.md).

현재0.2.6 릴리스의 main.js는1,627,500바이트로 Worker/WASM을 포함한다. 이것은 우리 native 설치본 증가량과 같지 않다. 별도 브라우저/AI 런타임은 필요 없지만 최종 실행 파일·캐시·작동 메모리는 별도로 잰다. 설치 용량과 실행 RAM을 섞지 않는다.

| 측정할 항목 | 첫 교체의 목표/완료 판단 |
|---|---|
| 10k 노트·약30MB의 warm 검색 | 엔진 p95 20ms 이하 목표, 입력→표시 p95 50ms 이하 목표; 160ms 인위 대기 제거 |
| 시작 | 첫500건 1초 이내 목표, 전체 준비는 수초 단위·진행 표시 |
| 파일/세션 변경 반영 | 일반 단건 변경 후 약1초 이내 목표; 원본 판/삭제/숨김 정확성 우선 |
| 대화 규모 | 노트 fixture와 별도로 100k 메시지 및 긴 메시지를 포함해 측정 |
| 메모리 | worker 수1개 확인, 실제 RSS/증가량 보고, 원문 중복 적재·창별 인덱스 중복 제거 |
| 설치 용량 | 같은 OS/설정의 이전·이후 바이너리/설치본 크기 비교 |

세션1만 개와 노트1만 개는 같은 크기가 아니다. 원본의5개 질의만 실행해 우리 대화 검색도 같은 속도라고 결론 내리지 않는다. 합성7문서 실험의 마이크로초 값 역시 성능 홍보 수치로 사용하지 않는다. 이 고정된 사례로 검증하고 무한한 벤치마크 경쟁으로 확대하지 않는다.

2026-11-02 최초 제품 측정(`scripts/fast-find-bench.ts`, `fast-find-bench-01/results.json`): 실제10k Markdown/30MB와100k 메시지/약61MB를 사용했다. 첫500건 준비47/42ms, 전체975/3628ms, 외부 변경107/81ms, worker peak105/410MiB다. Node 측정 harness는 별도로245/376MiB이며 앱 전체 RAM 측정이 아니다. 10k질의 p95는 native6.2–36.8ms/Finder14.8–140.9ms였고100k의 모든 메시지에 일치하는 질의는 native466ms/Finder1887ms였다. 모든 질의가20ms/50ms 목표에 도달했다는 뜻이 아니다. 화면 입력→렌더는 아직 별도 측정 전이다. 확인된 중복 작업(질의마다 scoped 전체 문서수 scan, 후보마다 같은 SQLite metadata 재조회)을 제거한 변경을 동일 사례로 검증한다.

후속 동일 사례(`fast-find-bench-02/results.json`): scope+generation별 정확한 문서수와 committed metadata를 재사용했다. 10k native p95는0.99–26.48ms, Finder3.47–79.57ms. 100k선택 질의는 Finder4.68–5.12ms, 1만건 일치는86.97ms, 10만건 전부 일치는1002.75ms다. 첫50049/42ms, 전체904/3458ms, 변경99/52ms, worker105/413MiB, Node harness218/408MiB. 실제10k코퍼스와 기능 fixture를 함께 읽는 배포 화면의 입력→결과 표시 p95는 순서대로 `data engineering`53.2, `alias9876`29.0, `자료707`45.9, `#교육`62.4, `채점 기준`127.1ms다(`fast-find-ui-03/input-to-paint.json`, Chromium155, 입력event부터 두 animation frame까지). 목표20/50ms를 모든 질의에서 달성하지 못한 상태는 유지한다. FF07의 고정 규모 실측 보고를 완료하고, 원본 점수 알고리즘을 재작성하는 추가 작업으로 확대하지 않는다.

## 8. 구현 순서와 종료 기준

| 순서 | 작업과 주요 파일 | 끝나는 조건 |
|---|---|---|
| 0 · 완료 | 소스/라이선스·현행 검색 대조, 원본 CLI 호환 실험, 이 계획 | 고정 소스와 실측 회귀·연결 범위 확인 |
| 1 · 범위 제외 | 웹 Design Mode는 사용자 요청으로 건너뜀. HOP 완료분 유지 | 해당 기능을 출시 차단 조건에서 제거하고 검색 작업으로 진행 |
| 2 | `third_party/fast-find` 원본·manifest·패치, Rust `search_worker.rs`, host `search-service.ts` | 원본 core가 공통 worker에서 검색/증분 변경/정상 종료 |
| 3 | typed input·CJK·범위/페이지 패치, Store/VaultMirror·Finder/PKM 연결 | 한글·정확한 YAML·숨김·세션 위치·그룹/페이지 계약 통과 |
| 4 | 원본 results/preview/similar/keys 이식, `SearchPalette.tsx` 교체 | 실제 앱에서 즉시 검색·미리보기·관련 노트·정확한 열기 |
| 5 | 기본 엔진 전환, 기존 전체 FTS 경로 정리, 설치본 반영 | 아래 고정 인수와 최종 OS 설치본 확인 후 사용자에게 전달 |

첫 버전의 core 패치는 typed document 입력, CJK 후보 호환, 범위·집계·페이지 경계로 제한한다. 원본 정렬/퍼지/형식 추출을 임의로 다시 쓰지 않고 각 패치의 이유와 원본 SHA를 남긴다. 모든 상류 미래 업데이트를 추적하는 일은 이번 완료 조건이 아니다.

고정 인수 항목:

| ID | 확인할 사용자 동작 |
|---|---|
| FF01 | 세션·요청·답변 검색, 결과 선택 후 정확한 메시지로 이동, 독립 문서 AI 세션 구분 |
| FF02 | 연결 볼트의 제목·별칭·제목줄·본문·속성·태그 검색과 원본 위치 열기 |
| FF03 | 위 한글 fixture + 기존 한글 조사/띄어쓰기/부분어 + 한글·이모지 강조 위치 |
| FF04 | 프로젝트·제공자·보관 범위, 숨김/삭제/이름 변경이 결과·미리보기·관련 항목·AI에 일관 적용 |
| FF05 | 문서/작성 답변·긴 메시지 중복 제거, 정확한 그룹/전체 개수·이어 읽기 |
| FF06 | 저장 보기와 기존 `workbench-find` 범위/4KB 제한 유지 |
| FF07 | 원본 보존, 캐시 재생성/재시작, 여러 창의 요청 간섭 없음, 고정 규모 성능 보고 |
| FF08 | 실제 Windows/macOS/Linux 앱에서 검색·열기·변경 반영, 해당 코드가 포함된 설치본 전달 |

구현 완료는 FF01–FF08과 기존 요청의 최종 인수로 판단한다. 버전 숫자나 새 기능 발굴을 종료 조건으로 쓰지 않는다. 기존 통과 항목은 관련 변경/재현 실패가 없는 한 반복 검증하지 않는다.

현재 전체 진행과의 관계: HOP 개선은 `871bd22`에서 구현·Linux 확인 완료, 웹 Design Mode는 사용자 요청으로 이번 릴리스에서 제외했다. **Fast Find 검색 교체와 최종 OS 설치본 인수**로 진행한다. 공개 preview0.2.8에 새 검색이 포함됐다고 표시하지 않는다.

## 9. 재현 근거

합성 fixture와 실행 결과는 사용자 원본 볼트/세션과 분리해 저장했다.

- 원본 소스 checkout: `/home/achamge/.local/state/achmage/workspaces/unclassified/work-1b7f68199bcb4756b2a7fd2a102ccc2e/branch-27ba0eb858324165beeea31dffb6299e/implementation-20261030/fast-find-source`
- 실행 스크립트: `/home/achamge/.local/state/achmage/workspaces/unclassified/work-1b7f68199bcb4756b2a7fd2a102ccc2e/branch-27ba0eb858324165beeea31dffb6299e/implementation-20261030/fast-find-probe.py`
- 입력과13개 결과/바이너리 SHA: `/home/achamge/.local/state/achmage/workspaces/unclassified/work-1b7f68199bcb4756b2a7fd2a102ccc2e/branch-27ba0eb858324165beeea31dffb6299e/implementation-20261030/fast-find-probe/results.json`
- 빌드: `cargo +1.93.1 build --locked --release -p ff10k-cli`, 별도 target 디렉터리 사용
- 비교할 기존 회귀: `apps/host/src/search.test.ts`의 한글·범위·문서 결합·페이지/AI 도구 항목

참조한 주요 현행 파일: `apps/host/src/{search,search-index,search-text,vault,store,sessions,http,find-tool}.ts`, `apps/web/src/components/SearchPalette.tsx`, `packages/contracts/src/search.ts`, `apps/desktop/src-tauri/src/{main,lib}.rs`.

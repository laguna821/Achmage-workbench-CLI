# doory 연동 조사: Workbench에 붙이면 무엇이 달라지나

- 조사일: 2026-10-20 · 기준: Workbench `1ad32fd`, doory `main` (2026-10-20 00:21 커밋까지)
- 연구 기록: `rr-26ea42a73394347480480a53518ab16e@8e9c7b92…` (achmage-workbench-research, status proposed)
- 범위: 소스·문서 읽기만 했다. doory를 빌드하거나 실행하지 않았다.

## 한 줄 결론

doory **서버째 붙이지 말고, 편집기만 들여와 Workbench의 다섯 번째 문서 형식(시각 디자인)으로 넣는다.**
AI 편집은 Workbench가 제공하는 디자인 도구로 작업 사본에만 하고, 대화에는 썸네일과 개체 단위 변경 카드로 보여 준다.
doory 서버/MCP는 사용자가 따로 운영할 때만 쓰는 선택 연결로 둔다.

## doory가 어떤 물건인지 (확인한 사실)

| 항목 | 내용 |
|---|---|
| 성격 | 오픈소스 Canva 대안. 저장소 2026-10-10 생성, 프런트 0.1.0, 별 1.6k, 하루에도 여러 번 커밋 |
| 프런트 | React 19, Fabric 7, Yjs, Zustand, TanStack Query, react-router 7, onnxruntime-web(브라우저 배경 제거), jspdf, mp4/webm muxer |
| 편집기 경계 | `EditorAdapter` **하나로만** 바깥과 연결됨 (편집기는 라우팅·인증·HTTP를 직접 안 만짐). `save / uploadAsset / resolveSrc / services / realtime / exportPdf` |
| 게스트 모드 | 서버 없이 IndexedDB에 저장, `idb://` 자산. brand·stock·ai 서비스가 `null`이면 그 기능만 숨김 |
| 문서 형식 | `DoryDocument` schema v1: pages(배경·objects·notes·guides·transition), objects = Fabric `toObject` + doory 속성, 모르는 키도 그대로 왕복. 최대 100쪽, 96dpi px |
| 렌더 | `editor/headless/render.ts`: 문서 JSON과 폰트 목록만으로 한 페이지를 canvas에 그림 (API 불필요). 서버는 이걸 headless Chromium으로 돌림 |
| 백엔드 | Django 5 + DRF + Channels + PostgreSQL 16. 서비스 셋(api / realtime `/ws` / mcp `/mcp`), 여러 worker면 Redis, 서버 내보내기는 Chromium(+약 400MB 이미지) |
| MCP | 기본 꺼짐. HTTP, 범위가 있는 Bearer `doory_…` 토큰. 디자인 CRUD·편집·필드 채우기·버전·공유·내보내기 |
| AI 편집 연산 | `edit_design`: 연산 목록을 전부 적용하거나 전부 거부. `base_revision`을 받지만 **편집기가 열려 있으면 검사하지 않고 실시간 세션에 합류**. 편집마다 "Before edits by …" 버전 생성 |
| 연산 구현 | add_text/shape/line/image/qr, update/arrange/group/ungroup/delete, 페이지·배경·노트, remove_background. **Python 서버에만 있음** (`designs/doc/ops.py` 1034줄 + builders 등). 프런트 테스트가 `backend-builders.json`으로 양쪽 결과를 맞춤 |
| 파일 형식 | 디자인 JSON을 파일로 가져오기/내보내기하는 기능은 찾지 못함 (파일 이름 기준) |
| 번들 예산 | 편집기 초기 JS 450kB gzip, 편집기 청크 160kB gzip, fabric은 별도 청크 |
| 라이선스 | **Attribution Assurance License** (GitHub SPDX: NOASSERTION). 재배포 시 서명된 원문 유지 + 시작 화면/페이지에 "Doory by Siam, creator and maintainer of Doory, https://github.com/shaongitbd/doory" 크레딧을 눈에 띄게 표시. 이름을 보증 용도로 쓰면 안 됨 |

## 붙이는 방식 세 가지

| | A. 서버째 붙이기 | B. 편집기만 들여오기 (권장) | C. B + 외부 doory 선택 연결 |
|---|---|---|---|
| 상주 프로세스 | Postgres + Django 셋 (+Chromium, Redis) | 없음. 디자인 탭을 열 때만 편집기 청크 로드 | B와 같음 (외부 서버는 사용자 몫) |
| 문서가 사는 곳 | doory DB | **작업 폴더의 파일** + Workbench 리비전 | 둘 다 (구분해서 표시) |
| AI 편집 | doory MCP `edit_design` 직결 | Workbench 디자인 도구 → 작업 사본 → 제안 | 외부 doory 편집은 승인 카드로 감쌈 |
| HITL | 편집기가 열려 있으면 **기준 리비전 검사 없이 바로 반영** → 제안 단계 우회 | 기존 계약 그대로: 제안, 기준 리비전 위 적용, 한 명의 작성자 | B와 같음 + 외부 작업은 승인 |
| 버전 기록 | doory 버전과 Workbench 리비전이 둘로 갈라짐 | Workbench 리비전 하나 | 외부 쪽은 doory 버전 |
| 오프라인 / Windows | Docker 필요, 무거움 | 그대로 동작 (WebView2에서 확인 필요) | B와 같음 |
| 잃는 기능 | 없음 | 템플릿·스톡·원격 AI·댓글·공유·서버 PDF·실시간 공동 편집 | 외부 서버에서는 그대로 |
| 메모리 목표(300MB) | 맞지 않음 | 닫혀 있으면 영향 없음, 열 때만 증가 (실측 필요) | B와 같음 |

A안을 기본으로 하지 않는 이유는 세 가지다. 무겁고, 문서가 작업 폴더 밖에 살고, 실시간 편집이 사람의 확인 단계를 건너뛴다.

## B안으로 붙이면 Workbench에서 달라지는 것

### 1. 문서 형식이 넷에서 다섯으로
- `DocFormat`에 `design` 추가. 파일은 `<이름>.design.json`(DoryDocument)과 옆의 `<이름>.assets/`(이미지·오디오).
  doory에는 파일 형식이 없으므로 Workbench가 이 묶음 형식을 정한다.
- 리비전은 JSON과 자산 목록을 함께 고정한다 (`r<N>.design.json` + 자산 해시 목록, 자산은 내용 해시로 한 번만 저장).
- `DocRef.selection`을 `{ pageId, objectIds[] }`로 넓힌다. 편집기에서 고른 개체가 그대로 다음 요청의 참조 칩이 된다.

### 2. 가운데 문서 화면: `DesignView`
- doory 편집기를 고정 커밋으로 들여와(vendor) 지연 로드한다. 디자인을 열 때만 fabric과 편집기 청크를 읽는다.
- `WorkbenchAdapter`가 연결을 맡는다.
  - `save` → 게이트웨이 리비전 저장. 오래된 리비전이거나 디스크가 바뀌었으면 거부하고 `onConflictResolve`로 Workbench 충돌 화면을 연다.
  - `uploadAsset` / `resolveSrc` → 작업 폴더 자산 + 게이트웨이 raw URL.
  - `services`: 폰트는 로컬 목록(SameTone 기본), 요소·템플릿은 정적 목록 또는 빈 목록, brand·stock·ai는 `null`.
- 위쪽 막대 슬롯(`topBarStart/End`)에 Workbench의 리비전 칩, 저장 상태, "AI에게 보내기"를 넣는다.

### 3. 세션 흐름에서 바로 보고 고치기 (요청하신 핵심)
- **파일 카드**: 페이지 썸네일 띠. 누르면 그 페이지로 편집기가 열린다.
- **제안 카드**: 글자 diff 대신 *전/후 썸네일*과 개체 단위 변경 목록(추가·삭제·이동·스타일·글자)을 보여 준다. 변경 개체를 누르면 편집기에서 그 개체가 선택된다.
- **선택 → 요청**: 편집기에서 개체를 고르고 "이 부분 고쳐줘"라고 하면 `pageId·objectIds`가 붙은 참조로 들어간다.
- **내보내기 결과**: PNG, PDF, MP4는 결과 파일로 추적한다. PDF는 기존 PdfView로 바로 열린다.

### 4. 엔진(Claude·Codex)이 디자인을 다루는 법
- 프롬프트에는 원 JSON 대신 **디자인 요약**(페이지, 개체 id, 종류, 글자, 위치)을 넣는다.
- Workbench 게이트웨이가 작은 MCP 도구를 제공한다. 쓰기는 항상 이번 제안의 작업 사본에만 한다.

  | 도구 | 하는 일 |
  |---|---|
  | `design_get` | 디자인 요약 반환 |
  | `design_edit` | doory 연산 일부를 TS로 옮긴 것 (전부 적용 또는 전부 거부) |
  | `design_render` | 페이지 PNG를 돌려줘 엔진이 결과를 눈으로 확인 |

- 턴이 끝나면 지금과 같이 **제안**이 생긴다. Codex와 Claude가 같은 도구를 쓴다.

### 5. HITL (사람 확인)
- 그대로 지키는 것: 한 디자인에 작성자 한 명, 제안은 기준 리비전 위에서만 적용, 사용자가 그사이 고쳤으면 적용을 거부하고 다시 요청한다.
- 나중에 고려할 것: 개체 id 단위 3-way 병합 (서로 다른 개체를 고쳤으면 자동 병합). 처음에는 거부만 한다.
- C안의 외부 doory MCP를 쓸 때:
  - `edit_design`, 공유 링크 생성·변경·취소, 버전 복원은 **항상 승인 카드**를 거친다.
  - "외부 doory에 직접 반영됨, Workbench 리비전 아님"을 카드에 명시한다.

### 6. 렌더와 메모리
- 썸네일과 `design_render`는 두 경로 중 하나로 만든다.
  1. 열린 Workbench 웹뷰에서 doory의 headless 렌더러로 그린 뒤 PNG를 게이트웨이로 보낸다.
  2. 게이트웨이에서 Fabric node + node-canvas로 그린다. Windows 네이티브 의존성 부담이 있다.
- 우선 1번으로 시작하고, 엔진이 렌더를 요청했는데 UI가 닫혀 있을 때만 2번을 검토한다.
- 디자인 탭이 닫혀 있을 때 메모리가 늘지 않는 것을 완료 조건으로 둔다.

### 7. 라이선스 표시
- 정보 화면과 디자인 화면 아래쪽에 AAL 크레딧을 늘 보이게 하고, 서명된 `LICENSE`·`NOTICE` 원문을 배포물에 넣는다.
- "Doory"를 Workbench 보증처럼 쓰지 않는다. 화면 이름은 "디자인"으로 하고 엔진 출처만 표기한다.

### 8. 다른 정책과의 경계
- doory에도 발표(프레젠터)·애니메이션·영상 기능이 있지만, 발표자료는 승인된 presentationPolicy(CMDS v3)를, 모션 필름은 Motion Art Director 경로를 그대로 쓴다.
- doory는 **포스터·카드뉴스·썸네일·SNS 이미지 같은 시각 디자인** 형식으로 한정한다. 기존 덱의 엔진을 조용히 바꾸지 않는다.

## 위험과 아직 모르는 것
- doory 편집기가 WebKitGTK(Linux)와 WebView2(Windows)에서 도는지 모른다 (Fabric 7, OffscreenCanvas, onnxruntime-web wasm).
- 디자인을 열었을 때 메모리가 얼마나 느는지 실측하지 않았다.
- `ops.py`가 Django(자산 resolver)에 얼마나 묶여 있는지, TS로 옮길 범위가 어느 정도인지 모른다.
- 템플릿·요소 목록을 서버 없이 줄 수 있는지 모른다 (`templates:build` 산출물).
- 0.x라 문서 스키마와 내부 API가 자주 바뀔 수 있다. 고정 커밋으로 들여오고 `migrateDocument`로 버전을 맞춘다.
- doory가 편집기 npm 패키지나 디자인 파일 가져오기·내보내기를 공식 제공하면 들여오는 방식을 다시 정한다.

## 검증 순서 (구현 전에 할 실험)
1. **동작 확인**: doory frontend를 고정 커밋으로 빌드해 Workbench 웹뷰 안에서 게스트 어댑터로 연다. 텍스트·도형·이미지 편집, 저장, PNG·PDF 내보내기가 되는지 본다. 무거운 빌드이므로 `resource_acquire`로 예약한다.
2. **메모리**: 디자인 탭을 닫았을 때와 열었을 때의 PSS를 잰다.
3. **어댑터**: `WorkbenchAdapter`로 바꿔 리비전 저장, 오래된 리비전 거부, 디스크 변경 감지를 확인한다.
4. **AI 경로**: `design_get/edit/render` 최소 연산(add_text, update_object, delete_objects, 배경)을 만들고, 실제 Claude·Codex로 제안 → 거부 → 재적용 시나리오를 돌린다. `smoke-docs`의 디자인판이다.
5. **흐름 UI**: 썸네일 파일 카드, 전/후 제안 카드, 개체 선택 참조 칩을 만든다.
6. **라이선스 표시** 확인.

## 구현 결과 (2026-10-20, 같은 날)

사용자 결정은 "편집기만 붙이고, AI는 세션이 파일을 직접 고친다(편집기 안 AI 기능 불필요)"였다. 이에 따라 계획을 바꿨다.
- **만들지 않은 것**: 위 "4. 엔진이 디자인을 다루는 법"의 `design_get/edit/render` MCP 도구. 대신 엔진 프롬프트에 디자인 규칙과 개체 목록을 넣는다.
- **썸네일**: 웹뷰의 숨은 iframe에서 doory 렌더러로 그린다(위 6절의 1번 경로).
- **검증 결과**: 실제 Codex 9/9, WebKitGTK 3/3, 편집기를 열 때 웹 프로세스 +67MB. 자세한 내용은 [STATUS](../STATUS.md)에 있다.
- **새로 찾은 빈틈과 수정**
  - 엔진이 셸 명령으로 쓴 파일은 경로 보고가 없어 추적되지 않았다. 턴이 끝날 때 작업 폴더를 훑도록 고쳤다.
  - 셸 명령으로 쓴 파일이 추적되지 않던 문제는 디자인만이 아니라 모든 문서 형식에 해당했다.

## 정식 문서 흐름 (2026-10-31)

원본 고정판 `2eb2557c1eed3aa256a78f1874abfb5a1315849c`를 유지하고 Workbench 어댑터에서 문서 흐름을 연결했다. doory 별도 AI/서버를 붙이지 않는 기존 결정과, 이음오피스의 원본 AI 전체 보존 요구는 별개의 범위다.

- 사람의 마지막 편집은 요청 ID가 있는 저장 응답을 확인한 뒤 같은 대화의 수정안 기준판으로 전달한다. 지연된 저장 표시나 시간 초과로 이전 판을 성공 처리하지 않는다. 외부 판 갱신도 편집기 자체의 미저장 여부를 확인한다.
- 문서/뷰별 복구본을 호스트 데이터 폴더에 보관한다. 앱·호스트가 새 포트로 다시 시작해도 복구본/저장된 원본을 명시적으로 고른다. 기준판·내용 해시·시점이 일치하는 복구본만 삭제하며 다른 열린 창의 초안은 유지한다.
- 충돌 사본은 원래 작업공간/폴더에 만들고, 중첩 상대 자산 경로를 독립된 폴더로 복사한다. 원본·외부 편집을 유지하고 출처 판/세션을 기록한다. 저장 중 추가 편집은 현재 창과 복구본에 남긴다.
- 출력은 실제 파일 저장 응답 뒤 완료로 표시한다. 전역 링크 클릭 가로채기를 제거하고, 원본 함수/호출부에 일치 검사를 하는 빌드 어댑터를 적용했다. 영수증에 작업공간·세션·파일 해시를 기록하며 출력 시작 문서가 저장된 내용과 일치한 경우에만 기준판을 연결한다. 미저장 화면/별도 영상 경로의 기준판은 추정하지 않는다.
- 권한 상실 시 DOM·미저장 내용을 유지하고 재획득 후 저장한다. 자산 읽기/쓰기는 디자인 폴더 밖 심볼릭 링크를 거절한다.

실제 Linux Tauri **23/23**, 관련 회귀 **24/24**, 네 TypeScript 프로젝트와 web/design/office/host/Tauri 빌드 통과. 패키징 리소스 **979/979**와 호스트 해시가 현재 빌드와 일치한다. 실제 메뉴·글자·도형·그림 처리·같은 대화 수정안·PNG/PDF·외부 충돌·앱 재시작·독립 자산 사본·권한 상실/재획득을 검사했다. 모델은 로컬 JSON-RPC 대역, 그림 드롭은 합성 File 입력이다. 과거 실제 Codex 증거는 현재 모델 품질 인수와 구분한다.

근거 `implementation-20261030/doory-native-05/verification.json`, SHA-256 `71dcf8e32ea01a9d8c44a9fc4bc3eda8f27e92c8dc6f9e04fb3b7ad5be907824`. 계획 판 `research:rr-d1c95d98944421a7b93c5d23e80ab6db:23ea71ae25d2d62c5bee9b0ccc3c6246e7763dee335e8801d3874fd1b004487d`, 검증 판 `research:rr-d1c95d98944421a7b93c5d23e80ab6db:cde914ab22bc9325008622d6004c54abda3947a977128de58715d6e9b9e04628`. 초기 타입·Cargo PATH·버튼 탐색·iframe 재생성·재시작 창 크기 실패 기록을 보존했다.

전체 doory 메뉴·영상/나머지 출력 형식, Windows/macOS와 물리 OS 입력은 남는다. 전체 Office/Orca 동등성, 중복 패키지 제거, 설치 이행·용량 실측·GitHub 릴리스의 완료를 뜻하지 않는다. 정식 검사는 `scripts/app-e2e/run.ts --only=design`이며 오래된 단독 iframe 진단 도구에는 문서 뷰 등록 권한이 필요하다.

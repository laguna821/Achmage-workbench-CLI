# Linux 실제 앱 검사

`--only=office-gallery --engines=stand-in`은 원본12종 디자인의 한국어/영어 표지24개, 번들 글꼴과 가변 굵기, 선택 시 원본 불변성, 실제 `generate_deck`/`save_style_template`, PPTX/sidecar 저장, 갤러리 선택, 앱·호스트 재시작, 같은 대화에서 저장 스타일 재사용/추가를 검사한다. 모델 응답은 로컬 SSE 대역이며 편집기·생성 엔진·파일은 실제 코드다. **19/19**, 인접40/40, 전체 타입·빌드 통과. async 저장 스타일 목록을 기다리며 고정 sleep을 쓰지 않는다. 증거 `gallery-native-04/verification.json`; 검증 판 `research:rr-97a130d83927682d768c9f16a54c4442:72d3c0ae57af32b8a711f88a234090be6f5ded287a3c6e4b04f8cb85d287b2a9`. 다른 OS/실제 글꼴 설치와 기존 독립 이음 데이터 이행은 별도다.

`--only=design --engines=stand-in`은 실제 새 디자인 메뉴·별도 작업공간·글자/도형/이미지·같은 대화의 최신 편집 수정안·명시 적용·확정 PNG/PDF·출처 영수증·외부 충돌·새 포트 앱 재시작·복구 사본/독립 자산·편집 권한 상실/재획득을 검사한다. 모델은 로컬 JSON-RPC 대역이고 그림 드롭만 합성 File 입력이며 실제 편집기/호스트/파일은 배포 코드다. 재시작 후 같은 창 크기를 복원하고, 판 전환 때 iframe을 다시 찾아 준비된 판을 확인한다. 2026-10-31 **23/23**, 관련 **24/24**, 전체 타입/빌드 통과. 근거 `doory-native-05/verification.json`; 검증 판 `research:rr-d1c95d98944421a7b93c5d23e80ab6db:cde914ab22bc9325008622d6004c54abda3947a977128de58715d6e9b9e04628`. 전체 메뉴/영상 출력·다른 OS·물리 파일 선택기는 별도 인수다.

`--only=office-previews --engines=stand-in`은 9종 원본 카드의 현재 문서 바이트 → 별도 양식 사본 → 원본 AI 도구 편집 → 명시적 저장과 원본 파일 보존을 검사한다. `APP_E2E_OFFICE_PREVIEW_FORMATS=md,hwpx`로 대상을 선택할 수 있다. 첫 형식은 실제 앱/host 재시작, 원본 탭의 진행 중 링크 복원, 사본으로 돌아올 때 AI 요청 중복 방지, 원본 그대로 저장, 취소와 실제 탭 닫기를 추가한다. Markdown에는 사람의 직접 문서 편집과 가림 표시가 있는 원본의 저장 차단·모델 입력 제외 검사가 있다. 이름/가림 판정과 표시된 iframe을 기다리며, 탭 전환이 gateway에 저장된 것을 확인한 뒤 새로고침한다.

모델 제공자는 로컬 SSE 대역으로 원본 도구에 확인 가능한 문장을 쓰게 한다. 따라서 실제 UI·바이트·대화·권한·재시작 통합을 검사하며, AI가 임의 문서의 모든 개인정보를 정확히 비우는 품질이나 다른 OS를 검증한 것으로 해석하지 않는다. 사본으로 인계한 최초 카드 초안의 복원과 이후 명시적 저장을 확인하며, 미리보기 카드 필드의 저장 전 자동 복구는 검사하지 않는다.

2026-10-31 기존 스킬·카드(PPT)와 미리보기(MD/HWPX) 최종 연속 **43/43**, 관련 회귀 **62/62**, 전체 타입/빌드 통과. 9종 미리보기의 형식별 통과 기록과 `native00–05` 실패/수정 근거는 `office-preview-native-06/verification.json`에 보존했다. Sheets 템플릿 바이트 내보내기는 제품 수정, 숨겨진 iframe·배치 저장·카드 판정 시점은 하네스 수정이다. 검증 판 `research:rr-18a5ff82e57e7a606474396cc29836cb:d780fedcdaebd92d3b36c60eef75365bd9cee706e2f68f06ea9fcfa499203dbb`.

`--only=office-skills --engines=stand-in`은 원본9종의 실제 `/`·`$` 선택 메뉴, 두 스킬의 본문/칩/해시, 원본 `read_skill_file`, live 후속 문맥, 앱/문서 재열기 후 최신 스킬 재읽기, 양식 원본 보존과 같은 세션의 새 내부 편집기 인계를 검사한다. PPT는 실제 앱/호스트를 재시작하고 Word 양식 사본을 직접 수정·저장한 뒤 후속 모델 입력까지 확인한다. `APP_E2E_OFFICE_SKILL_FORMATS=pptx,md,pdf`로 범위를 좁힐 수 있다. 제공자는 사설 로컬 SSE 대역이며 유료 모델은 호출하지 않는다.

2026-10-31 최종 **86/86**, 인접 회귀 **84/84**, 전체 타입·빌드 통과. 초기 native00의55/59 실패를 보존하고 비동기 이력 적용과 EPUB 양식 훅을 보완한 후9종 전체를 재검사했다. 제안 카드 저장·현재 문서 양식 미리보기·자동 호출의 별도 인수·다른 OS를 완료한 것은 아니다. 근거 `office-skills-native-01/verification.json`; 검증 판 `research:rr-23b6877f1f5f065e3f98bd3a61ee42a4:b55ba6f1df5fb74aeef5bf9d69cae5a628ffaf0fac302c488c9168d0f6876646`.

2026-10-30 CLI Node 전환 뒤 `--only=template-office` **12/12** 통과. 원본 CLI 실도구 검사는 `scripts/smoke-office-node.ts` **9/9**다. 문서 명령의 Electron 실행은 제거했지만 이 template 검사의 페이지 렌더링은 아직 기존 Electron 서비스와 전용 Xvfb를 사용한다. 연구 판: `research:rr-3064a5d54d6d8552880b86ec45668fce:8b00b7d29a2c71aa67089fc389e40b847e57d5a22406cf332f71888c75f98ab5`.

2026-10-30 `--only=text-office` **30/30**: 원본 Markdown·HTML 편집기의 실제 입력·저장·원문 보존·보기 전환·재열기·충돌 거절·초안 복구·명시적 충돌 해결을 검사한다. 기존 상대 경로 그림, Markdown 원본 붙여넣기 처리→소유 자산/상대 경로 저장→재열기, HTML 원래 `base`와 로컬 CSS/일반 스크립트도 확인한다. 클립보드 입력만 synthetic File 이벤트이며 브리지·호스트·파일·표시는 실제 경로다. 물리 클립보드와 OS 파일 선택/취소 검증을 대신하지 않는다. 테스트 환경에는 Electron Office를 설치하지 않는다. [현재 통합 범위와 미완료 항목](office-integration.md)을 함께 읽는다.

`scripts/app-e2e/run.ts`는 실제 Tauri 실행파일을 전용 Broadway 화면과 D-Bus 세션에서 WebDriver로 조작한다. WebKit 저장소와 gateway 데이터는 임시 폴더를 사용한다. 기본 엔진은 저장소의 대역이며 실제 모델 요청을 보내지 않는다.

필요 도구: `broadwayd`, GTK 3 개발 파일(`pkg-config gtk+-3.0`), C 컴파일러, `dbus-run-session`, `~/.cargo/bin/tauri-driver`, `~/.local/opt/webkit-webdriver/WebKitWebDriver`. 드라이버 경로는 `APP_E2E_TAURI_DRIVER`, `APP_E2E_WEBKIT_DRIVER`로 지정할 수 있다.

```bash
npm run build
npm run tauri -w @workbench/desktop -- build --debug --no-bundle
node scripts/app-e2e/run.ts apps/desktop/src-tauri/target/debug/achmage-workbench /tmp/workbench-native-result --only=start,panes,pkm,workspaces,navigation,tabs --engines=stand-in
```

명시한 출력 폴더에 결과 JSON, 로그, 스크린샷을 남긴다. `start`는 Tauri IPC, 실제 창 크기, 첫 화면, 온보딩 클릭과 저장을 검증한다. 아직 구현하지 않은 시나리오는 오류로 거절한다. 검사가 하나도 실행되지 않은 경우도 실패다.

`scm`은 작업공간 메뉴에서 Git 변경 검토를 열어 한글 파일/줄 번호와 인덱스 불변, 외부 변경 뒤 stale 거절, 파일별 스테이징, 실제 pre-commit 실패 출력과 커밋 초안 보존, 명시적 재시도, 커밋·unstage·앱 재시작 뒤 작업 기록을 검증한다. 임시 저장소만 변경하며 사용자 저장소에 커밋하거나 push하지 않는다. 2026-10-30 시작 검사 포함 **13/13** 통과.

`scm-remote`는 임시 bare 저장소와 다른 체크아웃을 실제 원격으로 사용한다. 주소·브랜치 표시, fetch의 로컬 무변이, ff-only 받기, 검토한 커밋 보내기, non-fast-forward 거절, 확인 뒤 원격 변경에 대한 exact lease 거절, 새 확인 후 명시적 force 및 재시작을 실제 입력으로 검사한다. GitHub에 테스트 push하지 않는다. 2026-10-30 `--only=scm,scm-remote` 연속 **22/22** 통과.

`scm-conflict`는 실제 병합·재배치 충돌에서 3방향 표시, 표식 차단, 입력 초안·외부 수정 거절, 저장과 스테이징 분리, 계속·취소·복구 파일, 재시작 후 기록을 검사한다. 초안 입력은 실제 Enter 키로 줄바꿈하며 재시작은 6개 기록과 복구 경로가 실제 렌더링될 때까지 기다린다. 헤더가 먼저 보인다는 이유만으로 이력을 검사하지 않는다. 2026-10-30 시작 검사 포함 **16/16** 통과.

`scm-hunks`는 실제 세 구간 diff에서 가운데 하나·떨어진 두 구간 선택, 인덱스만 반영, 선택 취소, F7/Shift+F7, 외부 변경 뒤 거절, 바이너리 안내와 재시작을 검증한다. 실제 작업 파일과 `git show :path`의 인덱스 내용을 각각 비교한다. 2026-10-30 `--only=scm,scm-hunks` 연속 **22/22** 통과.

`scm-comparison`은 실제 분기 이력을 만들어 통합 작업 변경, 시작 커밋, 공통 조상/두 끝점, 이름이 바뀐 이미지, 이동한 ref 고정/명시적 새로고침, 첫 커밋·병합 부모, 잘못된 ref·외부 수정 거절과 재시작 설정 복원을 검사한다. UI는 Git 쓰기를 요청하지 않으며 fixture의 의도적 커밋과 분리해 인덱스·작업 바이트를 검사한다. 설정 저장 응답을 확인한 뒤 새 포트로 재시작하고, 이미지의 실제 디코딩과 선택 항목도 확인한다. 2026-10-30 최종 **19/19** 통과. 최초 재시작 설정 손실은 앱 데이터 저장으로, 선택 상자의 오래된 글자 표시는 명시적 radio 항목으로 수정했다.

`github`은 임시 Git 포크 설정과 실제 gh 하위 프로세스 경계에 격리된 API 응답을 제공한다. 실제 입력으로 PR 연결·한글/rename/바이너리 파일, head/시험 병합·외부/승인 검사, 실행 시도의 로그·만료·네트워크 오류, 새 커밋·파일 선택 유지와 새 포트 재시작을 확인한다. 온라인 쓰기를 하지 않는다. 2026-10-30 비교 시나리오와 연속 **31/31**, 화면 마무리 후 최종 **16/16** 통과. 별도 실제 GitHub 읽기와 실패·수정 증거는 [PR·CI 문서](github-review.md)에 남긴다.

`github-actions`는 실제 입력으로 PR 제목·설명·커밋의 템플릿 선택, 초안 저장·재시작, 작성·검토 준비·CI 실패 작업 재실행·수정·병합을 수행한다. 쓰기 전송은 격리된 상태형 gh fixture만 받는다. 비동기 UUID를 저장한 상태에서 앱을 다시 시작하고 GET으로 결과만 복구하며, 쓰기 횟수·원문·로컬 Git 무변이와 페이지 예외를 확인한다. 이전 읽기 fixture와 같은 가상 저장소 이름을 쓰므로 새 시나리오는 소유한 호스트를 다시 띄워 가상 원격 교체 전 캐시를 분리한다. 2026-10-30 `--only=github,github-actions` **27/27** 통과. 공개 PR/댓글/CI를 만들거나 병합하지 않는다.

`github-discussion`은 실제 입력으로 댓글·자식 답글 회신·반응·해결 표시, 이전 행 범위의 묶음 리뷰, 사용자/팀 검토 요청·선택 취소, 기존 작성 중인 리뷰 제출을 검증한다. 같은 작업공간에 새 에이전트 대화를 만들고 선택한 댓글·실패 검사·고정 SHA가 실제 transcript 요청과 일치하는지 확인한다. SQLite 초안과 전달 기록을 새 포트에서 복원하고, 원격 게시 직후 응답 유실을 주입해 재시작 후 읽기만으로 복구하며 중복 게시를 검사한다. Git 파일·인덱스·브랜치와 페이지 예외도 확인한다. 초기 검증은 `pending` 중간 단계를 완료로 기다리지 않아 14/19였고, 최종 상태와 렌더링을 기다리도록 고쳤다. 2026-10-30 최종 Markdown 빌드의 `--only=github-actions,github-discussion`은 **32/32** 통과. 실제 Git/SQLite/gh 프로세스를 쓰되 외부 API 쓰기만 격리된 상태형 fixture이며 공개 게시 성공으로 해석하지 않는다. 확정 연구 판: `research:rr-bed06bf2c4e723d4ba17aed6afb23f6f:de171b50adee72d39e2d44bc070878772919a074463355cfb33aaf5af687f2e8`.


G3e4에서 `github-discussion`에 응답 유실 뒤 댓글 외부 수정 → 새 포트 재시작 → 미확정 원문 확인 → 명시적 후속 작업 허용 → 동일 댓글 재게시 거절 → 다른 댓글 게시 → 재시작 후 미확정 이력/원래 요청 ID 보존을 추가했다. PR 작업의 공통 실행 기록에서도 같은 이력이 보여야 한다. 2026-10-30 `--only=github-actions,github-discussion` **38/38** 통과. 실제 화면 `24-github-unknown-preview.png`, `24-github-unknown-retained.png`도 검토했다. 확정 연구 판: `research:rr-f80fe48d657e0cffeec0937f3a24bcc0:449b450f93d071587fc7c0eab73567145e1a106298c7a518651039e1fb6acb9c`.

`panes`는 네 칸 생성, 실제 드래그와 화면 노드 유지, 상하 경계선 키보드 조절, 좁은 창 전환, 종료 후 새 포트 복원과 칸 닫기를 검증한다. 재시작은 같은 임시 프로필을 사용하고 stage 종료 시 정리한다. 기본 gateway는 포트를 재사용하지만 이 검사는 `WORKBENCH_PORT=0`으로 새 포트에서도 복원되는지 확인한다.

`pkm`은 폴더 메뉴에서 템플릿 입력/저장, 하위 분류 프로젝트의 노트 생성, 로컬 표지 표시, 기존 노트 원문 보존을 검증한다. 이어 `.base`의 보기별 미리보기/미지원 조건 거절, 필터 적용·새로고침 복원, 내보내기 미리보기·저장 API·실제 파일 재가져오기를 검사한다. OS 저장 대화상자의 위치 선택은 이 검사에 포함되지 않는다. WebKitWebDriver의 일괄 `sendKeys`는 LF/비BMP 문자 입력을 누락하므로 줄별 입력과 실제 Enter 키를 사용한다. 이모지/CRLF 파일 보존은 호스트 회귀에서 검사한다.

`workspaces`는 실제 UI에서 폴더 연결, 새 세션의 공간 고정, 이름 변경, 보관/복원, 공간별 다른 배치 왕복과 새로고침 후 같은 세션 복원을 검사한다. `seedLayout`은 독립 배치 API에 v2 record를 CAS로 넣고 선택 공간도 명시한다. 전역 `prefs.paneLayout: null`을 별도 배치 저장소의 초기화로 사용하지 않는다. 실패 시 `failure.png`와 오류 stack을 남긴다.

`worktrees`는 실제 Git 저장소와 외부 체크아웃을 준비한다. 목록·명시적 연결·외부 삭제 금지, 기존 브랜치 충돌, 태그 기준 사용자 브랜치 생성, 두 제공자 세션의 같은 공간 공유, 새 포트 재시작 복원과 실제 삭제 확인을 검사한다. 삭제 후 같은 폴더를 연결한 다른 프로젝트의 공간도 보관되어야 하며 원본과 외부 체크아웃의 수정 파일은 그대로 남아야 한다. 두 번째 세션은 현재 선택된 실제 제공자를 읽고 반대 제공자로 만든다.

`terminals`는 실제 Rust PTY와 `/bin/sh -i`에서 WebDriver 키 입력으로 한글 파일을 만들고 검색한다. 별도 셸의 분할·크기 변경, 탭 닫기와 같은 PID 재열기, 명시적 종료·출력 보존, 새 포트 재시작의 기록 복원과 자동 실행 금지를 검사한다. 출력 API의 모든 페이지를 읽고, 화면이 초기 기록을 끝까지 복원한 뒤 정확한 출력 행을 확인한다. 셸은 하네스의 임시 폴더에만 생긴다. Windows/macOS·IME·모든 TUI 검증을 대신하지 않는다.

`preparation`은 실제 Git 원본과 새 워크트리를 만든 뒤 UI 미리보기, 원본 변경에 따른 거절, 독립 복사·공유 링크, 실제 준비 명령·기본 터미널 탭·한글 출력을 확인한다. 보관 명령의 실제 실패는 보관을 막아야 하며 명시적 건너뛰기 후에도 원본·작업 파일은 남아야 한다. 새 포트 재시작 후 실행 횟수와 기록을 확인한다. 탭 버튼은 DOM을 유지하는 숨겨진 칸을 제외해 선택한다. 모든 명령은 하네스의 synthetic 임시 저장소에서만 실행한다.

`navigation`은 편집기를 연 뒤 실제 파일을 외부에서 변경해 저장 충돌을 만든다. 프로젝트 이동과 탭 닫기가 보류되고 입력과 외부 파일이 유지되는지, 충돌을 해결한 뒤 저장과 이동이 되는지 검사한다. 프로젝트 노트 수동 편집도 검사하며, 페이지 정보가 갱신돼도 편집 시작 판을 유지해 외부 변경을 덮지 않아야 한다. 스크롤 영역에 클립된 저장/취소 버튼은 중앙으로 스크롤한 후 실제 WebDriver 클릭을 한다. Office의 flush 무응답·시간 초과·충돌과 연속 클릭 순서는 별도 컴포넌트/단위 검사로 확인한다.

`tabs`는 세션/문서 공통 탭, 실제 입력과 편집기 DOM 유지, 드래그 분할, 키보드 순서 변경, 새 포트 재시작 후 탭 ID/배치/문서 위치 복원, 다른 API writer와의 충돌 및 사용자의 명시적 해결, 닫기 후 파일/세션 보존을 검사한다. WebKit의 오른쪽 클릭 이후 Pointer 이벤트가 누락되는 경로를 관찰했으며 제품은 mouse 이벤트도 같은 press로 처리한다. 선행 분할이 실패하면 의존하는 후속 검사를 중단한다.

`documents`는 같은 파일의 두 뷰와 독립 API 작성자를 사용한다. 하나의 작성자, 무권한 저장 거절, 읽기 뷰 갱신, 이미 입력한 초안과 DOM의 보존, 권한 재획득과 명시적 충돌 해결, 탭 닫기 인계, 새로고침 후 권한 해제를 검사한다. 초안을 실제 입력한 다음 권한을 회수한다. 권한을 먼저 회수하면 입력 도중 읽기 상태가 되어 이후 키가 차단될 수 있다. 이 검사는 두 OS 창이나 Office 내부 입력 검증을 대신하지 않는다.

`references`는 두 문서에서 실제 `@` 항목과 `+` 메뉴를 클릭한다. 미저장 참조의 저장 충돌 시 전송 보류, 명시적인 저장된 판 선택, 이후 외부 수정과 분리된 판·해시의 전달, 같은 세션 한 번 전송과 후속 최신 판을 확인한다. 일반 대화창에서도 옆 문서로 초점을 옮겨 입력하고 첨부를 유지한 채 저장 후 전송한다. 실제 마우스 선택이 화면 전환 버튼에 가리지 않는지도 이 흐름에서 검증한다.

`APP_E2E_OFFICE_UNBOUND=1`로 `--only=office-suite,office-conversation --engines=stand-in`을 실행하면 9종 원본 Office 문서를 세션 없이 연다. 열기만으로 대화가 생기지 않고, 첫 요청이 세션을 하나 만들며 입력창을 교체하지 않은 채 정확히 한 번 기록되는지 추가로 확인한다. 기존 실제 도구/파일 저장·재열기·새 대화·취소 검사도 함께 수행한다. 2026-10-31 단일 실행 **86/86**, 인접 **47/47**. 근거 `office-first-session-native-00/verification.json`; 연구 판 `research:rr-e6e9abfeeec587137aae8e9d2f47aef0:ac5be7ecc611e84d24411cb7109bc255dbe9bfcabafe7a2e4f524d2539f63b3f`. 로컬 합성 제공자이며 원본 첨부·모든 도구·다른 OS 인수 검증을 대신하지 않는다.

`templates`는 개인 Markdown 양식을 실제 보관함 UI로 등록하고 꺼짐 기본값, 원본·해시 미리보기, 같은 세션의 새 사본 요청, 재전송 중복 없음, 결과 새 내부 탭과 재열기를 검사한다. 대역 엔진은 예약된 사본에만 시험 내용을 쓴다. PPTX/HWPX 렌더링과 실제 모델 품질 검증을 대신하지 않는다.

`template-office`는 Ieum의 synthetic PPTX fixture를 개인 양식으로 등록하고 실제 페이지 미리보기, 전체 바이트 사본, 내부 Slides의 실제 더블클릭·키 입력·Ctrl+S, 재열기, 같은 세션의 저장 판·해시 참조를 검사한다. 원본과 수정하지 않은 테마·마스터·레이아웃의 SHA도 비교한다. 렌더러는 재열기한 문장을 여러 단어 노드로 그리므로 한 stage의 텍스트를 결합해 비교한다. 저장 PPTX와 재열기 상태를 증거 폴더에 남긴다. 실제 모델의 생성 품질은 이 대역 검사 범위에 포함하지 않는다.

현재 페이지 미리보기의 기존 Electron 렌더러를 검사하려면 `Xvfb`, `xauth`도 필요하다. Xvfb 경로는 `APP_E2E_XVFB`로 지정할 수 있다. 하네스가 별도 X11 화면·인증 파일을 만들고 TCP 접속을 닫으며, Tauri는 계속 Broadway에서 실행한다. 사용자 화면·버스·프로필은 사용하지 않는다. Electron을 대체한 제품 렌더 경로가 마련되면 이 추가 검사 도구도 제거한다.

`--only=template-office --engines=real`은 설치된 실제 Codex로 3개 요청을 보낸다. 사람이 고친 PPTX에 Markdown 지시서를 읽기 참조로 붙여 수정안을 만든 뒤 UI에서 적용하고, 기존 내부 편집 탭의 갱신과 원본·서식 보존을 추가 검사한다. 모델 요청은 최대 5분씩 기다리고 임의 승인을 자동 수락하지 않는다. transcript·실제 모델/session 식별·수정 PPTX·렌더 노드를 증거 폴더에 남긴다. 문장 줄바꿈의 생략된 공백은 화면 비교에서 정규화하되 저장된 PPTX XML의 제목 검사는 유지한다.

연속 시나리오의 `seedLayout`은 테스트 전용 초기화다. 실제 400 ms 동안 판이 안정적인지 확인하고 마지막 CAS 경합만 제한적으로 다시 읽는다. 즉시 두 번 읽는 것은 자동 저장 완료 확인이 아니었다. 제품의 충돌 거절이나 사용자의 저장 판을 우회하는 경로로 사용하지 않는다.

웹/호스트 소스만 빌드하면 기존 실행파일 옆의 리소스가 그대로 남는다. **Tauri 빌드까지 수행**하고 `apps/web/dist/index.html`과 `apps/desktop/src-tauri/target/debug/web/index.html`이 같은지 확인한다. 이전 리소스 실행을 최신 UI 검증으로 오인하지 않는다.

`--only=hwp`는 HWP와 HWPX 각각의 synthetic 본문·메모를 내부 한글 탭으로 연다. 실제 페이지 클릭으로 입력부에 초점을 주고 Ctrl+Home·글 입력·Ctrl+S를 WebDriver 키 입력으로 보낸다. 저장한 바이트를 실제 rhwp 엔진으로 읽어 본문·메모·원본 보존을 확인하고 앱을 새로고침해 재열기 화면을 남긴다. 이전 버전의 HWPX Markdown 복구본도 안내 → 비교 → 명시적 복구로 검사한다. Electron/Xvfb는 사용하지 않으며 기본 검사는 모델을 호출하지 않는다. 이 검사는 한글 IME나 전체 표/인쇄 검증을 대신하지 않는다.

`--only=hwp --engines=real`은 실제 Codex에 HWPX 작업 사본의 문장 한 곳 수정을 요청한다. 실제 바이너리 수정안 생성, 적용 전 원본 불변, UI 적용과 같은 세션의 내부 편집기 갱신을 검사한다. 사람의 입력·기존 복구 문장·메모를 확인하고 transcript·실제 모델/session 식별·수정 파일·화면을 남긴다. 최대 5분 기다리며 임의 승인을 자동 수락하지 않는다.

`hwp`는 실제 파일 메뉴의 PDF·다른 이름 저장도 검사한다. 미저장 키 입력을 PDF와 사본에 포함하고 원본 바이트를 유지해야 한다. `pdfinfo`/`pdftotext`(Poppler)로 A4·한글·현재 내용을 읽는다. 추출 텍스트의 줄바꿈만 정규화한다. 새 사본의 내부 편집기 준비까지 기다린 뒤 화면을 남긴다. 마지막 인쇄는 실제 `GtkPrintUnixDialog`를 전용 GTK 모듈로 캡처하고 Cancel 응답을 보낸 후 정적 벡터 미리보기를 확인한다. 프린터로 인쇄하지 않으며 출력 성공을 흉내 내지 않는다. GTK 프로브는 `--only=hwp`의 하네스 자식 프로세스에서만 활성화한다.

`--only=pdf-office`는 원본 PDF.js 화면과 텍스트 레이어, 실제 글자 삽입 UI/글꼴 확인/저장, 페이지 회전·빈 페이지 추가, 미리보기 전환과 재열기를 검사한다. 다른 구조의 외부 PDF와 충돌시킨 뒤 새로고침으로 실제 PDF 복구본을 열고, 명시적 충돌 해결이 외부 판을 보존하면서 복구본 전체를 새 판으로 저장하는지 확인한다. 모델·Electron·PDFCraft 명령을 실행하지 않는다. 현재 Linux **16/16**이며 서명/영구 가림/출력/전체 공유 서비스나 다른 OS 인수 검증을 대신하지 않는다.

Tauri 패키징 전 `clean-web.mjs`는 Word/Slides/Sheets/HWP/Markdown/HTML/PDF/studio/design 진입 파일과 PDF 런타임 manifest를 모두 확인한다. 웹 단독 Vite 빌드가 Office 리소스를 지웠다면 전체 `npm run build` 후 Tauri를 빌드해야 한다.

Linux에서 Broadway는 파일로 보이지 않는 추상 UNIX 소켓을 사용할 수 있으므로 실제 연결로 준비 상태를 판별한다. 설정 저장은 화면이 닫히는 시점보다 늦을 수 있어 API의 영속 상태를 기다린다.

종료는 이 하네스가 시작한 자식 프로세스만 정상 종료한다. 종료되지 않으면 임시 폴더를 유지하고 실패를 기록한다. `--engines=real`은 실제 사용자 엔진 설정을 사용하는 별도 선택이며 기본 회귀 검사에 필요하지 않다.

`office-suite`는 추가8종 원본 AI 패널의 실제 입력→로컬 SSE 제공자→원본 수정 도구→파일의 새 판, 같은 세션의 이력·재열기·새 세션·부분 답변 취소를 검사한다. `APP_E2E_OFFICE_FORMATS=xlsx`처럼 한 형식만 선택할 수 있다. Markdown/HTML은 rich 모드, EPUB 도구 장 번호는1부터이며 Sheets는 원본 로딩 완료까지 기다린다. 입력란의 전체 문자열을 전송 전에 확인하고 XLSX 도구는 원래 A1 expectedValue를 요구한다. UI가 답변을 내놓아도 입력 일부가 셀로 흘러든 회귀를 성공으로 보지 않는다. PDF save 호출, 합성 모델 요청, 이력, 포커스/스트림 관찰을 근거 폴더에 남긴다. 원본9종 대표 흐름의 순차 합산 근거와 한계는 `office-suite-native-06/verification.json`, 연구 판 `research:rr-743f8783d3831764b58ba96ea2ccf045:58af427fbce70df749069c265a97fdc1be88572bef1bfbf06c5ed4d91778377a`다.

`APP_E2E_OFFICE_UNDO=1`은 `office-suite`와 `office-conversation`에 실제 원본 되돌리기·재저장 검사를 추가한다. 한글은 원본 Studio 메뉴, Sheets는 AI inline Undo, Word는 AI 이전 상태로/그 복원 취소를 사용한다. 앞선 8종에 이어 PDF도 저장 후 Undo/Redo를 검증했다. PDF는 Undo 후 다음 AI가 원본 `read_annotations`로 읽은 결과도 검사한다. `APP_E2E_OFFICE_FORMATS=md,html,xmind,epub,hwpx,pdf,pptx,xlsx`와 `--only=office-suite,office-conversation`으로 원본 9종 범위를 선택할 수 있다. 한 번에 모든 도구를 검증했다는 뜻은 아니다.

`APP_E2E_OFFICE_STREAM_STRESS=1`은 취소 검사 직전 첫 ping 처리에 200ms의 UI 작업을 넣어, 다음 응답을 읽기 전에 데이터가 도착하는 WebKit 경계를 검사한다. 모델 fixture는 부분 답변 한 번만 보낸 뒤 기다리며 데이터를 추가해 성공을 유도하지 않는다. `suite-*-stream-debug.json`에 실제 지연 시간과 수신한 NDJSON을 기록한다. 필요할 때만 `NODE_OPTIONS=--import=<repo>/scripts/fixtures/office-http-trace.mjs` 및 `OFFICE_HTTP_TRACE=<private evidence path>`로 이 하네스의 합성 모델 응답을 호스트 쪽에서도 관찰할 수 있다. 기본 실행에는 이 추적기를 사용하지 않는다.

수정 후 순차 실행에서 모은 9종 대표 80개와 별도 reader 지연 13/13의 출처·원본 실행 상태·한계는 `office-undo-native-10/verification.json`에 있다. [저장 뒤 되돌림과 응답 스트림](office-integration.md#저장-뒤-되돌림과-응답-스트림)에 정확한 연구 판을 기록한다. native 실행이 읽는 `apps/desktop/src-tauri/target/debug/host/host.mjs`와 `apps/host/dist/host.mjs`의 SHA가 같은지 확인해야 한다. 호스트 소스만 바꾼 채 기존 native 리소스로 실행하면 수정 전 코드를 검사하게 된다.

PDF 후속 검사는 `APP_E2E_OFFICE_UNDO=1 APP_E2E_OFFICE_FORMATS=pdf`와 `--only=pdf-office,office-suite`로 실행한다. `pdf-office`는 글자·회전·빈 페이지를 각각 저장한 뒤 세 번의 Undo/Redo와 매번 실제 PDF 저장, 원본 바이트로의 정확한 복원을 검사한다. 과거 판 fetch에 503/손상 바이트를 한 번 주입해 파일·화면·이력 위치 보존을 확인하고, 응답을 보류하는 동안 실제 문서 등록의 dirty 상태도 확인한다. 주입은 격리된 검사 화면에만 있고 검사 후 해제한다. 최종 **35/35**, 근거 `pdf-undo-native-02/verification.json`; 검증 판 `research:rr-83a38898aec2e7a79a888b89fae470e8:74189da1c6cbd9d6470584df0b53a3d9bfa82caf1b1e29ece4b899f5a38e35b5`.

`--only=office-references --engines=stand-in`은 원본7종의 실제 `@` 선택→원본 `read_attachment`→동일 세션의 판/해시 기록→재첨부 없는 후속 최신 판→문서 선택창/취소를 검사한다. PPT에서는 두 칸을 열어 원본 Markdown에 실제 미저장 편집을 하고, 나머지는 선택 이후 파일의 외부 변경을 확인한다. 가린 값이 모델 요청에 없는지 확인한다. `APP_E2E_OFFICE_REFERENCE_FORMATS=pptx`로 범위를 좁힐 수 있다. 정확한 파일 title의 행과 Sheets의 로딩 완료/표시된 입력창을 기다리며 Markdown marker는 원본 직렬화에 맞춘다.

2026-10-31 최종 단일 **47/47**, 회귀 **63/63**, 전체 타입/빌드 통과. 원본 Slides의 파일 전용 preload 누락을 수정했다. 초기 실패 실행과 원인 변경은 그대로 보존했다. 근거 `office-document-references-native-06/verification.json`; 연구 판 `research:rr-e6e9abfeeec587137aae8e9d2f47aef0:a300e80dade495efb053fd3f867510fb4988576bcabae28ece610741303e5df5`. 로컬 합성 제공자를 사용하며 입력 참조는 Markdown이다. 로컬 이미지/첨부 복원·모든 바이너리 입력·다른 OS를 검증했다는 뜻은 아니다.

`--only=office-references,office-files --engines=stand-in`은 기존 문서 참조와 원본7종의 로컬 첨부를 함께 검사한다. `office-files`는 Markdown File 드롭·CSV 선택·PNG 붙여넣기·선택 취소·두 파일 읽기/가림·실제 이미지 요청·첨부 기록·재열기/후속 최신 파일·새 대화 분리를 확인한다. 첫 형식은 앱과 호스트를 실제 재시작한다. `APP_E2E_OFFICE_FILE_FORMATS=pptx`로 범위를 좁힐 수 있다.

Tauri `invoke`는 쓰기 불가능하므로 원본 호출을 유지하고 정확한 dialog IPC fetch 응답만 주입한다. 합성 File 이벤트는 원본 drop/paste 처리기를 거치며 부모/호스트/파서/보관 경로는 실제다. 이미지는 파일명이 본문에 없을 수 있어 img의 alt·data URL·실제 디코딩으로 확인한다. 물리 OS 선택창·클립보드·끌기 검사를 대신하지 않는다.

2026-10-31 최종 단일 **117/117**(시작4·문서 참조43·로컬 첨부70), 회귀 **85/85**, 전체 타입 및 최종 빌드 통과. HWP 이력 매핑의 첨부 누락을 수정했다. 실패 실행00–04와 긴 파일명 보완 전 성공05도 보존했다. 근거 `office-local-files-native-06/verification.json`; 검증 판 `research:rr-b31c38482d609cd7a58ccd2c895f8d3a:db02746f1499818e05c808d4b0546cf18fcd6b226845afb237c13467e524dac9`. 모든 바이너리 입력·Windows/macOS·전체 Office/릴리스 완료를 뜻하지 않는다.


### 공통 사본 저장 서비스 회귀

`--only=office-copies,hwp`는 Word/PPT/Sheets/Markdown/HTML/XMind/EPUB에서 실제 미저장 입력→원본 Save As→취소→사본 생성→실제 콘텐츠 재열기와 기존 한글 저장/출력을 검사한다. `APP_E2E_OFFICE_COPY_FORMATS=pptx,xlsx`로 좁힐 수 있다. PPT는 본문과 노트, Sheets는 Go To 입력과 실제 셀 키 입력을 쓴다. Univer의 숨김 입력 호스트는 원본 코드처럼 focus한 뒤 WebDriver 키를 전달한다. Markdown은 Escape 직후 재시도, 503 주입 후 버퍼 복귀, 지연된 저장 중 CtrlS/입력 차단도 검사한다. 사본의 실제 파일·원본 해시·출처/대화/작업공간과 표시된 콘텐츠를 함께 확인한다.

최종 **58/58**, 인접 **41/41**, 근거 `office-copy-ui-native-08/verification.json`; [현재 내용 사본의 범위와 연구 판](office-integration.md#원본-편집기의-현재-내용-사본). 앞선 실행05의 로딩 화면 판정은 후속 콘텐츠 검사로 보완했고,06의 PPT glyph run 조건과07의 실제 Sheets 포커스 실패를 수정했다. PDF Save As·텍스트 자산 복사·실제 매크로·다른 OS를 검증한 것은 아니다.

`--only=hwp`는 공통 출력 계약을 확장한 뒤에도 원본 한글 메뉴의 취소·미저장 사본·메모·원본 불변·같은 대화 재열기·Rust PDF·네이티브 인쇄를 검사한다. 2026-10-31 **27/27**, 근거 `office-copy-hwp-native-01/verification.json`. 별도 호스트 검사 `office-output.test.ts`, `office-copy.test.ts`, `office-styles.test.ts`는 **29/29**로 등록된 뷰/대화, 형식 게이트, 출처·작업공간, PPT 선택, 동일 요청 재생과 파일 게시 후 등록 중단을 검사한다. 다른 편집기의 Save As 메뉴 연결·자산 이행·늦은 편집·다른 OS 검사는 아직 남아 있다. 정확한 연구 판과 한계는 [공통 사본 저장 서비스](office-integration.md#공통-사본-저장-서비스)에 기록한다.

### 원본 스킬 제안 카드

`--only=office-cards`는 9종 원본 `propose_skill` 카드에 실제 입력/저장을 하고, 같은 보관함의 자동 `use_skill`과 저장 표시 복원을 검사한다. 첫 PPT는 내 스킬 수정·수동 선택·취소와 앱/host 재시작도 확인한다. 제공자만 로컬 SSE 대역이며 원본 파일과 저장 전/취소의 미작성 여부를 검사한다. `APP_E2E_OFFICE_CARD_FORMATS=pptx`처럼 표적 실행할 수 있다. 이동 중 라디오를 다른 위치에서 클릭하지 않도록 화면 위치 안정과 실제 checked 상태를 확인한다. 현재문서 양식 미리보기 시나리오는 별도 후속이다. 근거는 `office-cards-native-03/verification.json`이며 앞선9종 실행과 표적 실패/수정을 모두 포함한다.

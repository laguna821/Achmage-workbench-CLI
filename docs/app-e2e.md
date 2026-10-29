# Linux 실제 앱 검사

`scripts/app-e2e/run.ts`는 실제 Tauri 실행파일을 전용 Broadway 화면과 D-Bus 세션에서 WebDriver로 조작한다. WebKit 저장소와 gateway 데이터는 임시 폴더를 사용한다. 기본 엔진은 저장소의 대역이며 실제 모델 요청을 보내지 않는다.

필요 도구: `broadwayd`, GTK 3 개발 파일(`pkg-config gtk+-3.0`), C 컴파일러, `dbus-run-session`, `~/.cargo/bin/tauri-driver`, `~/.local/opt/webkit-webdriver/WebKitWebDriver`. 드라이버 경로는 `APP_E2E_TAURI_DRIVER`, `APP_E2E_WEBKIT_DRIVER`로 지정할 수 있다.

```bash
npm run build
npm run tauri -w @workbench/desktop -- build --debug --no-bundle
node scripts/app-e2e/run.ts apps/desktop/src-tauri/target/debug/achmage-workbench /tmp/workbench-native-result --only=start,panes,pkm,workspaces,navigation,tabs --engines=stand-in
```

명시한 출력 폴더에 결과 JSON, 로그, 스크린샷을 남긴다. `start`는 Tauri IPC, 실제 창 크기, 첫 화면, 온보딩 클릭과 저장을 검증한다. 아직 구현하지 않은 시나리오는 오류로 거절한다. 검사가 하나도 실행되지 않은 경우도 실패다.

`panes`는 네 칸 생성, 실제 드래그와 화면 노드 유지, 상하 경계선 키보드 조절, 좁은 창 전환, 종료 후 새 포트 복원과 칸 닫기를 검증한다. 재시작은 같은 임시 프로필을 사용하고 stage 종료 시 정리한다. 기본 gateway는 포트를 재사용하지만 이 검사는 `WORKBENCH_PORT=0`으로 새 포트에서도 복원되는지 확인한다.

`pkm`은 폴더 메뉴에서 템플릿 입력/저장, 하위 분류 프로젝트의 노트 생성, 로컬 표지 표시, 기존 노트 원문 보존을 검증한다. 이어 `.base`의 보기별 미리보기/미지원 조건 거절, 필터 적용·새로고침 복원, 내보내기 미리보기·저장 API·실제 파일 재가져오기를 검사한다. OS 저장 대화상자의 위치 선택은 이 검사에 포함되지 않는다. WebKitWebDriver의 일괄 `sendKeys`는 LF/비BMP 문자 입력을 누락하므로 줄별 입력과 실제 Enter 키를 사용한다. 이모지/CRLF 파일 보존은 호스트 회귀에서 검사한다.

`workspaces`는 실제 UI에서 폴더 연결, 새 세션의 공간 고정, 이름 변경, 보관/복원, 공간별 다른 배치 왕복과 새로고침 후 같은 세션 복원을 검사한다. `seedLayout`은 독립 배치 API에 v2 record를 CAS로 넣고 선택 공간도 명시한다. 전역 `prefs.paneLayout: null`을 별도 배치 저장소의 초기화로 사용하지 않는다. 실패 시 `failure.png`와 오류 stack을 남긴다.

`navigation`은 편집기를 연 뒤 실제 파일을 외부에서 변경해 저장 충돌을 만든다. 프로젝트 이동과 탭 닫기가 보류되고 입력과 외부 파일이 유지되는지, 충돌을 해결한 뒤 저장과 이동이 되는지 검사한다. 프로젝트 노트 수동 편집도 검사하며, 페이지 정보가 갱신돼도 편집 시작 판을 유지해 외부 변경을 덮지 않아야 한다. 스크롤 영역에 클립된 저장/취소 버튼은 중앙으로 스크롤한 후 실제 WebDriver 클릭을 한다. Office의 flush 무응답·시간 초과·충돌과 연속 클릭 순서는 별도 컴포넌트/단위 검사로 확인한다.

`tabs`는 세션/문서 공통 탭, 실제 입력과 편집기 DOM 유지, 드래그 분할, 키보드 순서 변경, 새 포트 재시작 후 탭 ID/배치/문서 위치 복원, 다른 API writer와의 충돌 및 사용자의 명시적 해결, 닫기 후 파일/세션 보존을 검사한다. WebKit의 오른쪽 클릭 이후 Pointer 이벤트가 누락되는 경로를 관찰했으며 제품은 mouse 이벤트도 같은 press로 처리한다. 선행 분할이 실패하면 의존하는 후속 검사를 중단한다.

`documents`는 같은 파일의 두 뷰와 독립 API 작성자를 사용한다. 하나의 작성자, 무권한 저장 거절, 읽기 뷰 갱신, 이미 입력한 초안과 DOM의 보존, 권한 재획득과 명시적 충돌 해결, 탭 닫기 인계, 새로고침 후 권한 해제를 검사한다. 초안을 실제 입력한 다음 권한을 회수한다. 권한을 먼저 회수하면 입력 도중 읽기 상태가 되어 이후 키가 차단될 수 있다. 이 검사는 두 OS 창이나 Office 내부 입력 검증을 대신하지 않는다.

`references`는 두 문서에서 실제 `@` 항목과 `+` 메뉴를 클릭한다. 미저장 참조의 저장 충돌 시 전송 보류, 명시적인 저장된 판 선택, 이후 외부 수정과 분리된 판·해시의 전달, 같은 세션 한 번 전송과 후속 최신 판을 확인한다. 일반 대화창에서도 옆 문서로 초점을 옮겨 입력하고 첨부를 유지한 채 저장 후 전송한다. 실제 마우스 선택이 화면 전환 버튼에 가리지 않는지도 이 흐름에서 검증한다.

웹/호스트 소스만 빌드하면 기존 실행파일 옆의 리소스가 그대로 남는다. **Tauri 빌드까지 수행**하고 `apps/web/dist/index.html`과 `apps/desktop/src-tauri/target/debug/web/index.html`이 같은지 확인한다. 이전 리소스 실행을 최신 UI 검증으로 오인하지 않는다.

Linux에서 Broadway는 파일로 보이지 않는 추상 UNIX 소켓을 사용할 수 있으므로 실제 연결로 준비 상태를 판별한다. 설정 저장은 화면이 닫히는 시점보다 늦을 수 있어 API의 영속 상태를 기다린다.

종료는 이 하네스가 시작한 자식 프로세스만 정상 종료한다. 종료되지 않으면 임시 폴더를 유지하고 실패를 기록한다. `--engines=real`은 실제 사용자 엔진 설정을 사용하는 별도 선택이며 기본 회귀 검사에 필요하지 않다.

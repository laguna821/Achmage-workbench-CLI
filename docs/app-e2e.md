# Linux 실제 앱 검사

`scripts/app-e2e/run.ts`는 실제 Tauri 실행파일을 전용 Broadway 화면과 D-Bus 세션에서 WebDriver로 조작한다. WebKit 저장소와 gateway 데이터는 임시 폴더를 사용한다. 기본 엔진은 저장소의 대역이며 실제 모델 요청을 보내지 않는다.

필요 도구: `broadwayd`, GTK 3 개발 파일(`pkg-config gtk+-3.0`), C 컴파일러, `dbus-run-session`, `~/.cargo/bin/tauri-driver`, `~/.local/opt/webkit-webdriver/WebKitWebDriver`. 드라이버 경로는 `APP_E2E_TAURI_DRIVER`, `APP_E2E_WEBKIT_DRIVER`로 지정할 수 있다.

```bash
npm run build
npm run tauri -w @workbench/desktop -- build --debug --no-bundle
node scripts/app-e2e/run.ts apps/desktop/src-tauri/target/debug/achmage-workbench /tmp/workbench-native-result --only=start,panes --engines=stand-in
```

명시한 출력 폴더에 결과 JSON, 로그, 스크린샷을 남긴다. `start`는 Tauri IPC, 실제 창 크기, 첫 화면, 온보딩 클릭과 저장을 검증한다. 아직 구현하지 않은 시나리오는 오류로 거절한다. 검사가 하나도 실행되지 않은 경우도 실패다.

`panes`는 네 칸 생성, 실제 드래그와 화면 노드 유지, 상하 경계선 키보드 조절, 좁은 창 전환, 종료 후 새 포트 복원과 칸 닫기를 검증한다. 재시작은 같은 임시 프로필을 사용하고 stage 종료 시 정리한다. 기본 gateway는 포트를 재사용하지만 이 검사는 `WORKBENCH_PORT=0`으로 새 포트에서도 복원되는지 확인한다.

웹/호스트 소스만 빌드하면 기존 실행파일 옆의 리소스가 그대로 남는다. **Tauri 빌드까지 수행**하고 `apps/web/dist/index.html`과 `apps/desktop/src-tauri/target/debug/web/index.html`이 같은지 확인한다. 이전 리소스 실행을 최신 UI 검증으로 오인하지 않는다.

Linux에서 Broadway는 파일로 보이지 않는 추상 UNIX 소켓을 사용할 수 있으므로 실제 연결로 준비 상태를 판별한다. 설정 저장은 화면이 닫히는 시점보다 늦을 수 있어 API의 영속 상태를 기다린다.

종료는 이 하네스가 시작한 자식 프로세스만 정상 종료한다. 종료되지 않으면 임시 폴더를 유지하고 실패를 기록한다. `--engines=real`은 실제 사용자 엔진 설정을 사용하는 별도 선택이며 기본 회귀 검사에 필요하지 않다.

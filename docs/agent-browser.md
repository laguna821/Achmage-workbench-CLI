# AI 백그라운드 브라우저

Windows x64는 원본 Lightpanda 1.0.2와 공개 Windows 포팅 패치로 만든 **1.0.2+achmage.win.1**을 사용한다. 공식 Lightpanda의 Windows 배포판은 아니며, [소스·도구 버전과 빌드 절차](../third_party/lightpanda-windows/README.md)를 공개한다. Workbench 설치본에 실행 파일·필요한 DLL·라이선스·소스 출처가 포함되어 별도 WSL 설정 없이 준비된다. 기존에 Chromium을 선택했다면 입력창 아래 `브라우저` 메뉴에서 Lightpanda로 전환한다.

**네이티브 엔진 확인(2026-11-02):** [실행41420847598](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41420847598)에서 Windows x64 설치·해시·이전 설치 보존·포함 파일 탐지 **8/8**, 실제 JavaScript/fetch·한글 입력·세션 분리·권한·정상 종료·HTTPS **15/15**를 통과했다. 독립 ZIP은 **31.0MiB**, 압축 해제한 파일 합계는 **82.8MiB**다. 정확한 판: `research:rr-13db4ea9fd777aabed7c82207cfb1cda:8ac306f2cc62999eba32093c0e9a0d722bb0f1f1291a512ad45bc6cba31ac084`.

기본값은 **Lightpanda**다. AI가 조사·정보 수집을 할 때 사용자가 보는 브라우저 창은 필요 없다. `연결과 설정` 또는 입력창 아래 `브라우저`에서 세션의 브라우저를 켠다. Linux/macOS는 공식 1.0.2 바이너리를 필요할 때 내려받는다. Windows ARM64 소스 실행의 기존 WSL 경로는 유지하며, 이번 네이티브 패키지는 x64 전용이다.

Windows x64는 포함된 엔진과 DLL의 SHA-256을 시작할 때 확인한다. 포함 파일이 없거나 손상됐다면 앱 데이터 폴더에 고정 릴리스 ZIP을 받고 압축 파일·개별 파일 해시와 실행 버전을 확인한 뒤 활성화한다. 실패하면 이전 설치를 보존한다. Linux x64 바이너리 실측은 **76,408,136 bytes**이며, Linux/macOS 공식 바이너리는 약74–98MB다. 현재 프로세스에서 telemetry/core dump는 비활성화한다.

Claude/Codex는 `workbench-browser -s=<세션> ...`로 같은 권한 게이트와 명령 전달 경로를 사용한다. 원본 native MCP의 이동·검색·페이지 구조·본문·링크·구조화 추출·입력·클릭을 호출한다. 작업 세션마다 별도 프로세스와 페이지/쿠키 메모리를 사용하고, 사용자 Chromium 프로필을 복사하지 않는다. 기존 `playwright-cli` 별칭도 같은 게이트로 연결한다.

본문은 선택자/노드로 범위를 좁히고 기본12,000자, 최대16,000자씩 응답한다. `--offset`으로 같은 저장 결과를 이어 읽어 재탐색을 줄인다. 검색 API/직접 URL 읽기로 충분하면 기존 이음오피스 원본 도구를 그대로 쓴다. 이 출력 제한은 토큰 낭비를 줄이기 위한 장치이며, 실제 LLM 토큰 절감률이나 Chromium 대비 속도 배수는 아직 측정하지 않았다.

로그인 개입, Lightpanda가 지원하지 않는 사이트, 실제 스크린샷·레이아웃 확인은 **Chromium 호환 모드**를 사용한다. 별도 다운로드와 기존 지속 프로필을 보존하며 모드 사이의 로그인 공유를 가정하지 않는다. 웹 요소를 직접 고르는 Orca Design Mode는 2026-11-01 사용자 요청으로 이번 릴리스에서 제외했다. 일반 에이전트 탐색은 Lightpanda를 기본으로 유지한다.

중지를 누르면 결과 수락과 다음 명령을 중단한다. Lightpanda 1.0.2는 진행 중인 이동을 마친 뒤 표준 입력 종료를 처리하므로 실제 네트워크 정리는 지연될 수 있다. 느린 페이지 검사에서 약10초 후 연결과 프로세스가 정상 종료했다. Windows에서는 강제 프로세스 종료에 해당하는 Node의 SIGTERM을 사용하지 않고 입력 스트림 종료와 HTTP 시간 제한으로 정리한다.

Windows 네이티브 패키지의 검증 범위는 MCP 표준 입출력 기반 자동화다. CDP 서버의 광범위한 Windows 호환성과 사이트별 성능 배수는 별도로 검증하지 않았다. 독립 ZIP도 같은 엔진이며, `lightpanda.exe mcp`로 다른 MCP 클라이언트에서 사용할 수 있다.

**이전 WSL 실행 근거(2026-11-01):** Windows x64/WSL2 커널 `6.18.54.1-microsoft-standard-WSL2`에서 공식1.0.2 설치·MCP·브라우징 **15/15**를 통과했다. [실행41298915739](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41298915739). 이 결과는 이전 WSL 경로의 근거이며 새 네이티브 실행 검증과 구분한다. 정확한 판: `research:rr-3b367a2df4031b5f6de0209789b972ac:8e3fca769b3a82fd191000e0776338879a8c862836cca76a4f7cad6e09553b4b`.

검증은 공식 바이너리로 `node scripts/check-lightpanda.ts <binary> <report.json>`을 실행한다. 실제 JavaScript/fetch, 입력·클릭·추출, 두 세션 분리, 이어 읽기, 권한 거절·중지·정상 종료·프로필 보존 **14/14**, 기존 브라우저 회귀 **30/30**, 실제 Linux Tauri 기본 모드/화면 선택·저장 **9/9**를 확인했다. 당시 미확인 Windows WSL2는 위 최신 결과로 닫았다. 대규모 실제 사이트 비교는 별도 후속이다.

`--install`을 바이너리 인자 대신 주면 제품 설치 코드를 그대로 사용해 공식 파일의 해시와 실행 버전까지 확인한다. [Actions 41199033710](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41199033710)에서 **Linux x64·macOS arm64 각각 15/15**를 통과했다. 실제 바이너리 크기는 Linux 76,408,136 bytes, macOS arm64 93,242,456 bytes다. 두 OS 모두 GUI 브라우저·유료 모델 호출 없이 원본 MCP→Workbench 명령·권한 경로를 검증했다. 근거 판 `research:rr-a5815367a9ae4eec88f280a96eee6f7d:4fc1843db37ac87ebbade4456fa58826f1857840c1de65ae2b4120f91564b418`.

원본: [Lightpanda 1.0.2](https://github.com/lightpanda-io/browser/releases/tag/1.0.2), [해당 판 소스·AGPL-3.0](https://github.com/lightpanda-io/browser/tree/1.0.2). 바이너리는 변경하지 않고 공식 배포를 내려받는다. 조사 판과 후속 검증은 통합 실행 기록에 연결한다.

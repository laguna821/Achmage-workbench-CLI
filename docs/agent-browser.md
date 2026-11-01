# AI 백그라운드 브라우저

**필수 OS 실행 확인 완료(2026-11-01):** Windows x64 호스트에서도 실제 WSL2 커널(`6.18.54.1-microsoft-standard-WSL2`)을 사용해 원본1.0.2 설치·해시/버전·MCP·JS/fetch·입력/추출·두 세션·권한/중지/정상 종료·프로필 보존 **15/15**를 통과했다. [실행41298915739](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41298915739). Windows 시험은 Node에서 제품 게이트웨이와 WSL 경로를 실행했으며 사용자 PC에는 설치하지 않았다. Linux/macOS 각15/15와 함께 필수 OS 경계를 닫는다. 기존 코드 확인이며 `42dec7c`는 검사/워크플로 추가다. 정확한 판: `research:rr-3b367a2df4031b5f6de0209789b972ac:8e3fca769b3a82fd191000e0776338879a8c862836cca76a4f7cad6e09553b4b`.

새 기본값은 **Lightpanda 1.0.2**다. AI가 조사·정보 수집을 할 때 사용자가 보는 브라우저 창은 필요 없다. `연결과 설정` 또는 입력창 아래 `브라우저`에서 Lightpanda를 설치하고 세션의 브라우저를 켠다. Linux/macOS는 공식 바이너리를 사용하며 Windows에서는 WSL2 Linux가 필요하다. WSL2를 자동 설치하거나 컴퓨터를 재시작하지 않는다.

Lightpanda는 필요할 때 앱 데이터 폴더에 받는다. OS/CPU별 공식 고정 릴리스의 SHA-256과 실제 실행 버전을 검사한다. 설치 파일 자체에는 Chromium이나 Lightpanda를 추가하지 않는다. Linux x64 바이너리 실측은 **76,408,136 bytes**이며, 플랫폼별 공식 바이너리는 약74–98MB다. 현재 프로세스에서 telemetry/core dump는 비활성화한다.

Claude/Codex는 `workbench-browser -s=<세션> ...`로 같은 권한 게이트와 명령 전달 경로를 사용한다. 원본 native MCP의 이동·검색·페이지 구조·본문·링크·구조화 추출·입력·클릭을 호출한다. 작업 세션마다 별도 프로세스와 페이지/쿠키 메모리를 사용하고, 사용자 Chromium 프로필을 복사하지 않는다. 기존 `playwright-cli` 별칭도 같은 게이트로 연결한다.

본문은 선택자/노드로 범위를 좁히고 기본12,000자, 최대16,000자씩 응답한다. `--offset`으로 같은 저장 결과를 이어 읽어 재탐색을 줄인다. 검색 API/직접 URL 읽기로 충분하면 기존 이음오피스 원본 도구를 그대로 쓴다. 이 출력 제한은 토큰 낭비를 줄이기 위한 장치이며, 실제 LLM 토큰 절감률이나 Chromium 대비 속도 배수는 아직 측정하지 않았다.

로그인 개입, Lightpanda가 지원하지 않는 사이트, 실제 스크린샷·레이아웃 확인은 **Chromium 호환 모드**를 사용한다. 별도 다운로드와 기존 지속 프로필을 보존하며 모드 사이의 로그인 공유를 가정하지 않는다. 웹 요소를 직접 고르는 Orca Design Mode는 2026-11-01 사용자 요청으로 이번 릴리스에서 제외했다. 일반 에이전트 탐색은 Lightpanda를 기본으로 유지한다.

중지를 누르면 결과 수락과 다음 명령을 중단한다. Lightpanda 1.0.2는 진행 중인 이동을 마친 뒤 표준 입력 종료/정상 SIGTERM을 처리하므로 실제 네트워크 정리는 지연될 수 있다. 느린 페이지 검사에서 약10초 후 연결과 프로세스가 정상 종료했다. 종료 신호 전송을 완료로 간주하지 않으며 강제 SIGKILL을 사용하지 않는다.

검증은 공식 바이너리로 `node scripts/check-lightpanda.ts <binary> <report.json>`을 실행한다. 실제 JavaScript/fetch, 입력·클릭·추출, 두 세션 분리, 이어 읽기, 권한 거절·중지·정상 종료·프로필 보존 **14/14**, 기존 브라우저 회귀 **30/30**, 실제 Linux Tauri 기본 모드/화면 선택·저장 **9/9**를 확인했다. 당시 미확인 Windows WSL2는 위 최신 결과로 닫았다. 대규모 실제 사이트 비교는 별도 후속이다.

`--install`을 바이너리 인자 대신 주면 제품 설치 코드를 그대로 사용해 공식 파일의 해시와 실행 버전까지 확인한다. [Actions 41199033710](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41199033710)에서 **Linux x64·macOS arm64 각각 15/15**를 통과했다. 실제 바이너리 크기는 Linux 76,408,136 bytes, macOS arm64 93,242,456 bytes다. 두 OS 모두 GUI 브라우저·유료 모델 호출 없이 원본 MCP→Workbench 명령·권한 경로를 검증했다. 근거 판 `research:rr-a5815367a9ae4eec88f280a96eee6f7d:4fc1843db37ac87ebbade4456fa58826f1857840c1de65ae2b4120f91564b418`.

원본: [Lightpanda 1.0.2](https://github.com/lightpanda-io/browser/releases/tag/1.0.2), [해당 판 소스·AGPL-3.0](https://github.com/lightpanda-io/browser/tree/1.0.2). 바이너리는 변경하지 않고 공식 배포를 내려받는다. 조사 판과 후속 검증은 통합 실행 기록에 연결한다.

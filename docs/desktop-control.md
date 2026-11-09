# 외부 앱 연결

0.4.0 개발 브랜치의 구현 상태. 정식 릴리즈 또는 실제 Windows/macOS 앱 조작 완료를 뜻하지 않는다.

## 사용 흐름

연결 메뉴의 **외부 앱**에서 공식 도구를 설치하고 열린 앱 창과 채팅 세션을 선택한다. 기본은 접근성 조작이며 키보드·마우스를 사용하는 화면 조작은 선택해서 켠다. 연결한 세션에서 요청하면 Codex와 Claude가 `workbench-desktop`을 사용한다. 브라우저 켜기/끄기와 독립적으로 제공한다.

앱 화면 읽기와 캡처를 제공하며 캡처는 기존 첨부 저장소와 채팅 이미지 표시를 사용한다. 모든 조작은 현재 창·실행 인스턴스·관찰 ID·요소 참조를 확인한다. 같은 명령 ID는 기록만 돌려주고 재실행하지 않는다. 결과가 불명확하면 그 상태를 보존하고 현재 화면을 다시 읽는다. **내가 조작하기**는 Workbench가 시작한 앱 명령을 중단하고 연결을 해제한다.

`delivered_unverified` 또는 CLI의 `ok`는 파일 저장 완료를 의미하지 않는다. 파일 저장은 실제 앱 상태·산출물을 별도로 읽어 판단해야 한다. 앱이 접근성 기능을 제공하지 않거나 OS 권한이 없으면 원본 오류를 그대로 전달한다. 다른 앱 프로세스를 종료하거나 기존 실행을 소유한 것으로 간주하지 않는다.

## 재사용 범위

- [agent-desktop v1.1.0 원본](https://github.com/vercel-labs/agent-desktop/tree/d3dc190afbf34cd2377252398ddd5c30efbd093a)의 공식 6종 OS/CPU CLI archive와 JSON 2.6 계약을 사용한다.
- [공식 릴리즈](https://github.com/vercel-labs/agent-desktop/releases/tag/v1.1.0)의 크기·SHA-256을 `scripts/agent-desktop-manifest.json`에 고정한다. 이 릴리즈 commit은 이전 조사 checkout 93ae89e와 구별한다.
- 원본 npm archive 검사·설치 함수와 플랫폼 표를 재사용한다. Workbench의 임시 폴더를 전달하는 매개변수만 추가했다. 자동 postinstall, 기존 host 정리, 전역 PATH 변경, 스킬 자동 설치는 호출하지 않는다.
- Workbench가 추가한 부분은 세션·창 선택, 공유 물리 입력 제어, 명령 기록, UI/API/엔진 연결이다. 키보드·마우스 엔진을 다시 만들지 않는다.
- 출처·변경점·라이선스는 `vendor/agent-desktop/PROVENANCE.json`과 `third_party/agent-desktop/`에 보존한다.

## 현재 근거와 남은 범위

선택 창/실행 인스턴스 변경, 결과 기록·중복 실행 방지, 불명확 결과 재관찰, 물리 입력 공유·사용자 인계의 새 집중 확인 4개를 한 번 통과했다. Linux 임시 설치에서 공식 파일 SHA-256 확인과 `agent-desktop 1.1.0` 실행을 확인하고 해당 임시 폴더를 정리했다. 실제 사용자 앱 조작은 수행하지 않았다.

사용자의 구현 우선 교정에 따라 이번 묶음 뒤 전체 타입·Rust·production·설치본·CI 검사를 추가 실행하지 않았다. native 앱 조작, OS 권한 안내와 설치본의 실제 메뉴 동작은 통합 단계에 남아 있다. 포인터 좌표 기반 임의 조작과 전체 OS 자동화 호환성을 완료로 표시하지 않는다.

연구: `research:rr-fb025ea83d26bd1d7147dd3208893d54:d9f464f99080ff5b2977503a924625a278cd52656ad65dd9a41e9e613a4709ab` (R1–R5).

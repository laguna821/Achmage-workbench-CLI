# GitHub PR·CI 검토

작업공간 메뉴 → **Git 변경 검토 → PR·CI**에서 현재 브랜치의 GitHub PR을 확인한다. PR 설명·변경 파일·검사·작업 로그에 이어 PR 작성·수정·상태 전환, CI 재실행, 병합·자동 병합·대기열을 앱 안에서 실행한다. 호스팅 리뷰·댓글 등 O18 전체 범위는 계속 구현한다.

## 연결과 검토 기준

- 설치된 `gh`의 GitHub.com 인증을 사용한다. 앱이 토큰을 복사하거나 새 로그인을 임의 실행하지 않는다. CI 로그에는 `gh` 2.97 이상이 필요하다.
- Git의 실제 원격 주소와 push/추적 설정에서 후보를 만든다. 작업을 보낸 저장소·브랜치와 PR을 받는 저장소를 따로 고른다. 포크 원본은 GitHub 응답으로 확인해 후보에 추가한다. 모호한 다중 주소·다른 호스트·인증 정보가 들어간 주소는 자동 연결하지 않는다.
- 열린 PR은 head 저장소의 ID와 브랜치가 정확히 일치해야 연결한다. 후보가 여럿이면 선택한다. 닫힌 PR도 번호로 열 수 있지만 같은 저장소·브랜치 검사를 거친다.
- PR 파일은 GitHub가 제공하는 PR diff다. 파일 조회 전후의 head/base OID·파일 수가 달라지면 새 결과를 채택하지 않는다. 로컬 커밋과 PR 커밋이 다르면 화면에 표시한다. 조회는 Git fetch·checkout·index 변경을 실행하지 않는다.
- GitHub가 patch를 제공하지 않은 바이너리/큰 파일, 잘린 patch와 제한을 표시한다. GitHub가 준 부분 차이를 전체 파일이라고 표시하지 않는다.

## CI와 오류

PR head와 시험 병합 커밋의 검사 출처를 구분한다. CheckRun, 외부 status, 검사 실행 승인 요구를 함께 표시한다. 결과 없음·부분 조회·조회 실패는 성공으로 판정하지 않는다. [GitHub PullRequest 필드](https://docs.github.com/en/graphql/reference/pulls), [Check 객체](https://docs.github.com/en/graphql/reference/checks).

상세 버튼은 서버가 확인한 check ID에만 연결한다. Actions 저장소·SHA·run ID·시도 번호와 job의 check URL을 재확인한 후 완료된 작업의 로그를 읽는다. 임의의 검사 URL로 인증 정보를 보내지 않는다. 로그가 만료되거나 권한이 없으면 오류를 표시한다. [작업·로그 API](https://docs.github.com/en/rest/actions/workflow-jobs).

현재 CLI는 제어 문자가 있는 원시 로그 출력을 기본 차단한다. 작업 로그를 읽는 제한된 요청에만 `--allow-escape-sequences`를 쓰며, 호스트가 CSI/OSC 등 터미널 제어와 인증 정보 형태의 문자열을 제거한 후 텍스트로 표시한다. 이전 CLI는 업데이트 안내를 표시한다. [CLI API 옵션](https://cli.github.com/manual/gh_api), [2.97 변경 근거](https://github.com/cli/cli/security/advisories/GHSA-3m3g-3wcr-px46).

선택이 유지되는 동안 연결 실패 시 마지막 결과와 조회 시각을 남긴다. 열린 화면에서만 60초 간격으로 조회하며, 실패한 오래된 결과는 수동으로 다시 확인한다. 실제 제한 응답의 reset/retry-after를 따라 요청을 멈추고 추가 확인 요청을 반복하지 않는다. 앱 재시작 후에는 새로 조회한다.

## 경계

API 응답 8 MiB·30초, 조회 캐시 30초/64개/16 MiB, 검토 30분/16개/24 MiB로 제한한다. 파일은 최대 300개, 파일 patch 앞 128 Ki 문자·합계 4 MiB, 검사/승인과 한 실행의 작업 목록은 각각 앞 100개다. 로그는 8 MiB 이내 응답에서 마지막 128 Ki 문자를 표시한다. 제한에 걸린 결과에는 전체가 아니라는 안내가 있다.

리뷰 스레드·댓글·반응·검토자·리뷰 제출, 실패 수정 요청, 등록된 stack 생성, Enterprise·다른 호스팅·계정 전환, Issues/Projects는 다음 구현 범위다. GitHub에서 열기 링크는 보조 동선이다. Windows/macOS와 새 설치에서 CLI 공급·인증·용량 검증은 G6에 남는다.

## PR 작성과 실행 기록

**PR 작성/PR 작업 열기**에서 로그인 계정·저장소 ID·head/base 브랜치·실제 커밋·현재 권한을 다시 확인한다. 새 PR은 현재 로컬 HEAD와 선택한 원격 브랜치가 같은 커밋이어야 한다. 먼저 기존 Git 푸시 화면에서 커밋을 보낼 수 있다. 작성 기능이 몰래 push·checkout·rebase·브랜치 삭제를 실행하지 않는다.

제목·설명·기준 브랜치·초안·관리자 수정 허용을 입력하면 로컬 호스트의 버전 있는 초안에 저장한다. 다른 창의 변경과 충돌하면 입력을 보존하고 오류를 표시한다. 현재 로컬 커밋에 기록된 Markdown PR 템플릿은 선택해서 설명에 추가한다. 미커밋 텍스트·심볼릭 링크·임의 경로를 읽지 않는다. 템플릿은 20개, 각64 KiB·합계256 KiB까지다.

작성/수정/닫기/다시 열기/초안/검토 준비, 허용된 merge/squash/rebase, 자동 병합 설정/해제, 병합 대기열 등록을 제공한다. 실행 내용 화면은 전송 계정·저장소·PR·커밋·본문·효과를 고정한다. 호스트가 전송 직전 이를 다시 확인한다. 일반 자동 병합은 GraphQL 설정 요청을 사용하므로 CLI의 즉시 병합 부작용과 혼동하지 않는다. 대기열은 저장소가 정한 병합 방식을 사용한다.

GitHub의 생성·일반 수정 API에는 head 조건부 쓰기가 없다. 전후 상태를 재확인하되 원자적 CAS라고 주장하지 않는다. 병합·자동 병합은 서버 expected head 조건을 사용한다. 등록된 스택은 전체 메타데이터가 확인된 경우에만 포함될 하위 PR을 표시하고 비동기 병합 API로 보낸다. 하위 각 층의 모든 속성을 클라이언트가 원자적으로 고정한다고 주장하지 않는다. [GraphQL PR 입력](https://docs.github.com/en/graphql/reference/pulls), [비동기 병합 계약](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously).

모든 요청은 쓰기 전에 SQLite 실행 기록에 저장한다. 같은 request ID·동등 요청은 같은 기록을 반환하며, 같은 PR의 미확정 작업은 서로 경합하지 않는다. CI는 선택 검사/전체/실패 작업을 지원하며 Actions run ID·시도 번호별 한 번만 요청한다. 여러 check가 같은 workflow run에 속하면 합친다. 처리 중·일부 처리·실패·기준 변경·결과 미확정을 구분한다.

통신이 끊기거나 앱을 종료해도 쓰기를 자동 재전송하지 않는다. **실행 기록 → 원격 결과 확인**은 조회만 수행한다. 비동기 병합 UUID를 보존해 재시작 후에도 결과를 읽는다. 대기열 등록과 자동 병합 설정 완료는 실제 병합 완료가 아니며, CI 요청 수락도 검사 성공이 아니다. GitHub가 보관하는 비동기 결과는 마지막 갱신 후24시간 동안 조회 가능하다. 만료되거나 결과를 확정할 수 없으면 미확정 상태와 원격 PR을 함께 확인해야 한다. 새 실행이 관찰돼도 다른 사용자의 작업일 수 있다는 한계를 표시한다. [Actions 재실행 API](https://docs.github.com/en/rest/actions/workflow-runs), [병합 결과의 보관·대기열 상태](https://docs.github.com/en/rest/pulls/pulls#get-the-result-of-an-asynchronous-merge).

쓰기 전용 CLI 경로는 조회 캐시와 분리되고 재시도하지 않는다. JSON은 stdin으로 보내며 셸·`@file` 해석을 사용하지 않는다. REST 쓰기는 알려진 merge-async PUT과 rerun/rerequest POST로 제한하고, 인증은 기존 gh에 남긴다. 첫 공개 쓰기와 실제 조직 규칙·Actions·스택의 성공은 격리 fixture 결과로 대신 주장하지 않는다.

G3e2 계획 판: `research:rr-de9cdd63516392603b7c71e29a551398:9077e2d11fc18949f772480991f5cfd9e594dc5af7887fd94f05a7f226cf4926`. G3e1 최종 판을 확장한다.

G3e2 결과(2026-10-30): 인접 회귀60/60, 마지막 호스트 작업20/20·UI5/5, 전체 타입 검사·웹/Office/호스트/Tauri 빌드 통과. 실제 Linux 앱은 읽기와 작성 흐름을 연속 **27/27** 통과했다. 초안·템플릿·작성·상태 전환·CI 재실행·수정·비동기 병합·두 번 재시작·중복 전송 없음·로컬 Git 보존을 실제 입력으로 확인했다. 첫 native 실행에서 발견한 단일 PR 자동 연결의 작업 차단을 수정했고, 연속 fixture의 캐시 충돌은 별도 호스트로 격리했다. 실제 API는 조회와 스키마만 검증했다.

확정 연구 판: `research:rr-de9cdd63516392603b7c71e29a551398:c2b4fcb18a51e71e1e9a1270dc6a243cf1587b59e96c5f32247116f162201e97`. 증거: `implementation-20261030/native-github-actions-verified/results.json` 및 같은 폴더의 작성 미리보기·병합 복구 화면. O18 전체나 공개 쓰기·새 OS 릴리스 완료를 뜻하지 않는다.

## 구현 근거와 검증

계획은 `research:rr-00daa1a79adeaa0f17c29eb258a8b9de:1779fa27b9cddc091a8c4c80ab6f79adc7eeebd1af3d67adc8773a6e75d45291`에 고정한다. 기존 G3d6 결과 `research:rr-52b02575f1eebe2c61a3e4e43a6ca74f:fe0104ec6b7112c8ceb37c7189edae80bae767be85304d46f259e4c668a321f5`를 확장한다.

실제 Git fixture의 포크·저장소/브랜치 변경·조회 경합·부분 검사·Actions 시도·다른 작업공간 거절, 전송 경계의 캐시/제한/종료/제어 문자, UI의 오래된 응답/화면 변경을 시험한다. Native `--only=github`는 실제 앱·Git·gh 프로세스 경계를 사용하며 GitHub 응답만 격리된 fixture다. 실제 온라인 읽기 검증은 별도 증거로 남긴다. 공개 저장소에 시험 PR·댓글·CI 재실행을 만들지 않는다.

2026-10-30 결과: 인접 회귀 72/72, 최종 호스트/UI 20/20, 전체 타입 검사·웹/호스트/Tauri 빌드 통과. 실제 Linux 앱은 비교 시나리오와 연속 31/31, 화면 마무리 후 최종 PR 시나리오 16/16과 화면 확인 완료. 실제 공개 PR 읽기에서는 검사 6개, 실행/작업/시도 관계와 제어 문자가 제거된 51,485바이트 로그를 확인했다. 새 OS 설치·공개 쓰기 흐름의 성공으로 해석하지 않는다.

완료 연구 판: `research:rr-00daa1a79adeaa0f17c29eb258a8b9de:43cd6238ebc0c7bd29aa174bc94d80979f314c5bfc734764b02d498c5524aac5`. 최초 타입 추론·fixture import·실제 CLI 로그 출력 실패와 수정 조건을 보존한다.

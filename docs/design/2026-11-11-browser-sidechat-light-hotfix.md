# 브라우저 읽기·사이드 채팅·라이트 화면 수정

0.4.1 기반 로컬 수정본 `browser-read-model-light-20261111`을 Linux 노트북에 설치하고 재실행했다. GitHub 새 정식 릴리스는 이 작업에 포함하지 않았다.

## 달라진 동작

- 웹 사이드 채팅 입력창 바로 위에 Codex/Claude, 모델, 추론 강도 선택을 항상 표시한다. 좁은 패널에서도 추가 설정 메뉴 안에 숨기지 않는다.
- 엔진마다 독립 대화를 보존한다. 이전 엔진으로 돌아오면 기존 대화·모델 설정을 재사용하며 메인 세션은 바꾸지 않는다. 작성 중인 입력도 보존한다. 응답이나 대기 요청이 있는 동안에는 엔진 전환을 잠시 막고 모델 변경은 다음 요청부터 적용한다.
- 문서 원문/미리보기의 Workbench 채팅에도 같은 선택 UI를 추가했다. 내장 이음오피스 편집기의 기존 AiModelPicker는 유지한다. 이음오피스 자체의 공통 AI 설정을 문서별 설정으로 전환한 작업은 아니다.
- 같은 네이티브 페이지의 긴 본문을 나눠 읽는 `read` 명령을 추가하고 SPA 주소·문서 관찰 상태를 갱신한다. 로그인 상태를 다른 브라우저에 복사하지 않는다.
- 브라우저 지침 내용이 바뀌면 기존 Codex/Claude 대화에도 새 지침이 적용된다. 실제 페이지 접근과 본문 확인, 요청한 파일 저장을 구분하며 도구가 실행하지 않은 일을 완료했다고 말하지 않도록 안내한다.
- 라이트 탐색 영역에는 옅은 색조를, 선택 탭에는 흰 표면·파란 강조·작은 그림자를 적용했다. 홈 왼쪽의 둥근 잔여 모서리는 실제 PaneLayout 경계에서 제거했다. Pretendard Variable을 유지했다.

## 디자인 근거

- [HIG transfer] 관련된 엔진·모델 선택을 입력창 가까이에 묶는다: `layout/visual-hierarchy/group-related-items-to-clearly-express`.
- [HIG transfer] 사이드바와 내용 영역의 접합 경계를 맞춘다: `layout/visual-hierarchy/align-elements-to-make-them-easier`.
- [HIG transfer] 색상은 선택 상태와 주요 행동에 절제해서 사용한다: `branding/best-practices/apply-your-apps-accent-color-judiciously`.
- [House] 웹/Tauri에서 사용할 표면 색 혼합값, 30px 선택 컨트롤, 작은 탭 그림자는 이 제품의 조정값이다. Apple의 네이티브 구현이나 접근성 인증을 뜻하지 않는다.

## 확인 범위

호스트·웹 TypeScript와 빌드가 통과했다. 관련 회귀 테스트 23개가 통과했다. 네이티브 드라이버 14개 확인에는 HttpOnly 로그인 상태를 가진 로컬 자료의 긴 본문 끝부분 읽기와 SPA 주소 변경이 포함된다. 이미 통과한 네이티브 검사를 UI 수정마다 다시 실행하지 않았다.

실제 Linux Tauri/WebKit 창의 368.625px 오른쪽 패널에서 엔진 전환·복귀, 상세 모델 선택, 입력 보존, 메인 세션 불변을 확인했다. 해당 UI 확인은 별도 프로필과 시험용 엔진을 사용했고 실제 유료 AI 요청은 보내지 않았다. 라이트/다크 화면을 캡처했으며 실제 경계의 radius와 border가 0px임을 확인했다.

설치 후 새 실행 파일·호스트 빌드를 확인했다. 기존 프로젝트 1개, 세션 7개, 대화 항목 339개, 문서 6개와 판 32개가 유지됐고 대화 행의 내용 해시도 동일했다. 이음오피스의 별도 앱 등록을 보존했다. 이전 앱과 DB 백업은 로컬에 남겨 두었다.

실제 YouTube 요청은 네이티브 관찰 성공 후 모델이 외부 영상 전체 전사를 거절한 사례였다. 브라우저 로그인 실패와 구분한다. 이 패치는 모델 제한 우회나 모든 사이트의 성공을 보장하지 않는다. Windows/macOS 실행, 실제 로그인한 Naver/DBpia 작업은 이번 로컬 확인 범위 밖이다.

## 근거와 로컬 증거

- R12: `research:rr-bb51b60161c1052569432c6fd4d0650e:65e95d245f3cfbc3b07a2fb80e004176f53d74468313d947455de77917ed52ac`
- R13: `research:rr-2efe2a502c682cf43f1fbeddca892d06:1f73e5f73b3f632f8384314d9d2720688ec9ba963148f9ea7fadd0b1091bd4d4`
- 로컬 UI/네이티브 결과: `.hallmark/browser-read-fix/evidence/`
- 설치 결과: `.hallmark/browser-read-fix/install/verified.json`
- 설치 영수증: `~/.local/opt/achmage-workbench/WORKBENCH-INSTALL.json`의 `localPatch`. 공식 버전 표시는 0.4.1이다.

조사 기록은 로컬 큐에 보존했다. 이 문서는 세션 원문이나 로그인 자료를 포함하지 않는다.

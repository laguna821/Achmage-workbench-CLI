# 이음오피스 통합 진행

2026-10-30부터 남은 PR 스택 구현보다 **이음오피스 전체 기능과 Electron 제거**를 먼저 진행한다. 전체 릴리스 범위와 Orca 잔여 항목은 유지한다. 기준 계획은 `research:rr-b5508ffc0997569185acfe1f63b30318:cfa7c978083be45a250d505e79e356c2d2f751a4e88aa8fe7662f4168b60fe3d`다.

## Markdown·HTML 기본 편집 연결

원본 이음 renderer를 `/office/markdown.html`, `/office/html.html`로 빌드한다. 문서의 `편집`에서 열고 기존 Workbench 원문·나란히·미리보기로 전환할 수 있다. 전환 전에 편집기 원문을 저장하며 실패하면 현재 편집기를 유지한다. 예전 Workbench 원문 초안은 원문 보기에서 먼저 복구한다.

- 문서별 grant와 writer lease를 거쳐 저장한다. 오래된 판·외부 변경·상실한 편집권으로 덮어쓰지 않는다.
- 원본 renderer의 블록 단위 Markdown 저장과 HTML 범위 편집을 사용한다. 브리지에서 원문을 다시 직렬화하지 않는다. UTF-8 BOM도 제거하지 않는다.
- 저장 실패 시 IndexedDB에 원문과 기준 판을 보관한다. 새로고침 후 복원하고, 사용자가 선택하면 현재 판 다음의 새 판으로 저장한다.
- HTML 미리보기는 별도 읽기 토큰과 opaque-origin sandbox를 사용한다. 편집 grant를 문서 스크립트에 넘기지 않는다. HTTP 버퍼 갱신 완료 후 프레임을 다시 읽는다.
- grant를 갱신해도 같은 뷰의 미리보기 주소는 유지된다. grant가 모두 퇴출되면 미리보기도 접근할 수 없다.

실제 Linux Tauri 검사 `text-office` **25/25**, 인접 host/UI 검사 **22/22**. 원문 그대로 저장, 실제 입력·저장, 변경하지 않은 블록, 보기 전환, 재열기, 외부 판과 충돌, 새로고침 뒤 초안 복구, 명시적 충돌 해결을 확인했다. 이 검사 환경에는 기존 Electron Office를 설치하지 않았다.

검증 연구 판: `research:rr-b5508ffc0997569185acfe1f63b30318:a54a11aca8b345099bdeeda5f61bbd477196973d83281b699e399f4af03f9b7c`. 증거: `implementation-20261030/native-text-office-recovery/results.json`, `/tmp/wb-office-text-adjacent.log`. 초기 fixture와 빌드 어댑터 실패는 같은 연구 기록에 남아 있다.

## 문서 CLI의 Node 실행 전환

`IeumOffice` 게이트웨이와 에이전트용 `ieumoffice` 실행기는 이제 Workbench의 공통 Node로 원본 CLI를 실행한다. 상속된 `ELECTRON_RUN_AS_NODE`는 제거한다. 기존 앱은 아직 필요한 출력 서비스로만 별도 지정한다. POSIX와 Windows 실행기의 경로 인용·환경 변수 해제를 검사했다.

원본 고정판 CLI를 빌드한 뒤 실제 DOCX 생성·편집·텍스트 추출, PPTX 생성·읽기, XLSX 생성·수식 계산·읽기를 확인했다. 허용 폴더 밖 출력은 거절됐으며, 이 문서 명령들이 Electron 앱을 실행하지 않았음을 별도 실행 감시 파일로 확인했다. **실도구 9/9, 실행기 검사 10/10**. Node로 바꾼 뒤에도 기존 PPTX 양식 미리보기·사람 편집·저장·재열기·같은 세션의 후속 참조가 **실제 Linux 앱 12/12**를 통과했다. 전체 타입 검사와 host/Tauri 빌드도 통과했다.

연구 판: `research:rr-3064a5d54d6d8552880b86ec45668fce:8b00b7d29a2c71aa67089fc389e40b847e57d5a22406cf332f71888c75f98ab5`. 실제 실행은 Linux Node26.8.1이다. 다른 OS와 배포용 Node24의 검증은 남아 있다. 재현 도구는 `scripts/smoke-office-node.ts`; 증거는 `implementation-20261030/node-office-first/results.json`, `native-node-office-render-xvfb/results.json`이다.

## 아직 완료되지 않은 범위

현재 여섯 renderer 진입점이 있다는 것은 여섯 편집기의 전 기능이 끝났다는 뜻이 아니다. Markdown·HTML의 이미지/자산, 다른 이름으로 저장, 내보내기, 내부 AI·검색·첨부·위키 서비스는 연결 중이며 해당 브리지 메서드는 명시적으로 실패한다. 기존 Word·PPT·Sheets에도 AI·템플릿·출력 미연결 항목이 있다. PDF·EPUB·XMind의 원본 화면과 공통 제공자·세션·Drive·검색·doory도 남아 있다.

CLI의 실행파일은 Node로 전환했지만, 숨은 렌더링·일부 변환·기존 암호화 설정 해제/앱 제어와 Electron 배포 파일은 아직 남아 있다. 다음 구현에서 이 경로를 Rust/Tauri/WASM 서비스로 대체한다. 실제 대체 결과를 검증한 뒤 중복 번들을 제거한다. 현재 변경만으로 설치 용량이 줄었다고 주장하지 않는다. 모든 OS의 설치·기존 데이터 이행·용량 실측과 최종 GitHub 릴리스도 미완료다.

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

## Markdown·HTML 로컬 그림과 미리보기 자산

Electron의 `md-asset://`·`html-asset://` 대신 열린 문서 폴더에 한정한 읽기 주소를 사용한다. Markdown은 원문에 적힌 경로를 그대로 보존하고 표시할 때만 주소를 바꾼다. 복사한 그림의 주소도 원래 경로로 되돌리므로 이전 권한 토큰이 문서에 저장되지 않는다. HTML은 원래 `base`가 있으면 그대로 쓰고, 없으면 미리보기 사본에만 기준 주소를 넣는다. 상대 경로의 그림·CSS·일반 스크립트와 확장자가 없는 웹 저장 자산을 읽는다.

PNG/JPEG/GIF 선택·붙여넣기 저장과 로컬 그림 읽기 브리지를 연결했다. 실제 바이트 형식·크기를 검사하고 현재 writer/판/디스크 상태가 맞을 때만 새 파일을 만든다. 원본 이음의 배타적 생성 및 `.genoffice-assets.json` 소유/대기 기록을 재사용한다. 기존 그림을 덮어쓰지 않으며 이전 판·Undo가 필요로 할 수 있는 자산은 삭제하지 않는다. 원본의 자산 정리 기능은 아직 호출하지 않는다.

별도 읽기 토큰으로 편집 권한을 대신할 수 없다. 문서 폴더 밖·숨김 경로·외부 심볼릭 링크·일반 JSON/텍스트 이웃 파일은 읽지 않는다. HTML은 계속 opaque-origin sandbox에서 실행되고 일반 자산의 CORS 읽기는 열지 않는다. 글꼴에만 표시를 위한 CORS를 허용한다.

**host/클립보드 경로 검사 13/13, 실제 Linux Tauri `text-office` 30/30**. 기존 한글/공백 그림 경로, 원본 붙여넣기 처리, 상대 경로 저장·소유 기록·재열기, HTML 원래 `base`와 CSS/스크립트 표시, 이전 원문 보존/충돌/복구 검사를 통과했다. 붙여넣기 입력은 synthetic `File` 이벤트이며 원본 renderer와 실제 호스트가 처리했다. OS 파일 선택/취소·물리 클립보드·드롭과 Windows/macOS, 모듈 스크립트·대용량 미디어 Range는 별도 인수 검증이 남아 있다. 전체 타입 검사와 Office/host/Tauri 빌드도 통과했다.

연구 판: `research:rr-8304c87c1ea63f23530f55605bd002f7:68995e88a4c2037d47eb31d190bb3d8612c78e80473a9636b9eeb7ef2bdb7b9b`. 증거: `implementation-20261030/native-text-assets-first/results.json`, `/tmp/wb-office-assets-tests-fixed.log`, `/tmp/wb-office-assets-types-final.log`. 원본 순수 모듈은 `scripts/vendor-text-assets.mjs --check`로 출처와 내용 해시를 검증한다.

## PDF 원본 화면·편집 엔진·문서 판 연결

원본 이음 PDF renderer와 preload를 `/office/pdf.html`로 빌드해 문서의 `편집`에서 연다. PDF.js 화면·검색·주석·양식 UI를 사용하고, 저장은 원본 pdf-lib/PDFium 코드가 처리한다. Electron `nativeImage`가 맡던 PNG/JPEG와 bitmap 처리는 Node 코덱으로 교체했다. PDFium/HarfBuzz WASM의 실제 버전·SHA를 `third_party/ieumoffice/pdf-runtime.json`에 고정하고 호스트에서 검증한다. PDF.js의 CMap·표준 글꼴·WASM과 엔진 라이선스를 함께 배포한다.

저장은 원본 엔진의 저장 후 글자·그림 재검증, 적용하지 못한 편집 보고까지 재사용한다. 엔진은 전용 임시 파일만 쓰며 최종 문서 경로는 Workbench가 writer lease·기준 판·디스크 변경을 다시 검사한 뒤 쓴다. 변경 없는 사본은 바이트 그대로 유지한다. 주석 작성자 `/T` 등 기존 파일 데이터를 브랜드 이름으로 바꾸지 않는다. 페이지 크기·자르기·빈 페이지의 즉시 저장도 같은 문서 이력을 거친다.

복구본은 미저장 편집을 반영한 실제 PDF와 기준 판이다. 원본을 쓰지 않고 IndexedDB에 보관한다. 암호화된 PDF의 편집·복구본 작성은 서버에서도 거절한다. 명시적 충돌 해결에서는 복구 PDF 전체를 새 판으로 저장하며, 구조가 달라진 외부 PDF에 이전 페이지 번호의 편집 명령을 다시 적용하지 않는다. 기존 외부 판은 이력에 남는다. 영구 가림·주석 제거·임의 `targetPath`는 일반 저장 경로에서 거절한다.

**엔진/HTTP/기존 편집기 검사 17/17, 실제 Linux Tauri `pdf-office` 16/16**. 실제 검색 가능한 글자 삽입·폰트 확인, PNG 반투명과 JPEG 처리, 주석 작성자·양식 값, 회전/재정렬/삭제/빈 페이지/자르기/크기 변경, 읽기 권한·만료한 편집권·외부 판 충돌을 검사했다. native 검사는 원본 UI의 글자 삽입, 회전, 빈 페이지, 미리보기 전환, 재열기, 외부 변경 거절, 새로고침 뒤 복구, 명시적 충돌 해결을 확인했다. 모든 엔진 검사를 native UI로 반복한 것은 아니다. 원본 앱의 Electron 설치나 모델 호출은 사용하지 않았다.

계획 연구 판: `research:rr-d481a2d10a87d38a067298796d75fb69:b7f2c1e1f77814c0846ff74b8d68c99a73be210d63500e87629f4fafd47cdf0c`. 검증 판: `research:rr-d481a2d10a87d38a067298796d75fb69:5ad01b38e1b48667273678480a3dcc7d1b55bf7d8d34e8fd06c1ae19e94213c9`. 증거: `implementation-20261030/native-pdf-pinned/results.json`, `/tmp/wb-pdf-host-pinned.log`, `/tmp/wb-pdf-types-final.log`. 최종 검사는 원본 PDF 앱의 HarfBuzz 0.10.3과 PDFium 2.15.1을 사용했다. 처음 native 검사에서 보기 전환 완료 전에 iframe을 조회한 실패와 루트/중첩 HarfBuzz 경로 정정은 같은 연구에 남겨 두었다.

## XMind 원본 편집·보존·복구

원본 마인드맵 renderer와 preload를 `/office/mindmap.html`로 빌드한다. 토픽·가지·메모·시트·테마는 원본 편집기와 XMind 엔진을 사용한다. 글 보기·검색·저장한 판 참조에는 원본 엔진의 개요를 제공한다. 바이너리를 일반 텍스트나 아직 연결하지 않은 AI 수정안 경로로 저장하지 않는다.

열린 판과 저장할 바이트를 각각 원본 엔진으로 검사한다. 구형·암호화·손상 파일은 저장을 허용하지 않으며 최종 저장은 문서별 grant·writer lease·기준 판·외부 변경 검사를 거친다. 모르는 토픽 키·보이지 않는 요소·부속 파일을 보존하고, 변경하지 않거나 되돌린 저장은 원본 바이트와 같다. 실제 미저장 XMind와 기준 판을 IndexedDB에 보관하며 새로고침 후 복원한다. 명시적 충돌 해결은 외부 판을 이력에 남기고 복구본 전체를 새 판으로 저장한다.

원본 라이브러리의 입력 선택 전에 포커스를 주는 WebKit 보완과, 긴급 복구 전에 입력 중인 메모를 반영하는 보완을 추가했다. vendor 원본은 수정하지 않고 고정된 코드 모양을 검사하는 빌드 어댑터로 적용한다. 원본 코드가 바뀌면 빌드를 멈춰 재검토한다.

**host/기존 편집기 14/14, 실제 Linux Tauri `mindmap-office` 22/22**, 전체 타입·루트/Tauri 빌드 통과. 실제 입력·저장·Undo, 파일 내부 그림과 HTML 모양 글자의 비실행, 원본 요소 보존·테마·시트, 재열기·외부 변경 거절·복구·입력 중 메모의 긴급 보관을 확인했다. 최초 17/19, 선택 삭제만 바꾼 20/22 실패와 포커스 원인 판단의 정정도 기록했다. 물리 한글 IME와 다른 OS 검증은 남아 있다.

계획 판: `research:rr-3492c2c2a180a313cf65edeb5feed33a:2b5baf296a5961e72796e85e7ab09d7a628d2042e9ed25c7b475b7708da28227`. 검증 판: `research:rr-3492c2c2a180a313cf65edeb5feed33a:b6a6e97597fe3bd0fc2772c42406db559cdd323a62234c0b21751c2c9c5861ab`. 증거: `implementation-20261030/native-mindmap-focus/results.json`, `/tmp/wb-mindmap-host-first.log`, `/tmp/wb-mindmap-types-final.log`.

## EPUB 원본 읽기·편집·복구

원본 EPUB renderer·preload를 `/office/epub.html`로 빌드하고 `EpubBookSession`을 호스트에 연결했다. 장마다 원본 범위 편집을 유지하며 전체 DOM을 저장하지 않는다. 변경 없는 저장과 Undo 뒤 저장은 원본 바이트와 같다. 다른 장·BOM·CRLF·모르는 부속 파일을 보존한다. DRM·손상 파일은 거절하고 고정 배치·깨진 장·번역 잠금·오래된 장 판의 편집도 원본 엔진이 거절한다.

보기별 책 세션을 별도 토큰과 직렬 요청으로 관리한다. 편집권을 잃은 뒤에도 입력 중인 내용을 메모리에 반영해 복구본으로 남길 수 있다. 디스크 저장은 현재 writer·문서 판·외부 변경을 다시 검사한다. 복구본은 범위 편집을 반영한 실제 EPUB이다. IndexedDB 저장 확인 전에는 미저장 호스트 세션을 버리지 않으며, 명시적 충돌 해결에서 외부 판을 이력에 남긴다. 열린 책은 32개·보관 바이트 합계400MB·책 하나200MB로 제한하고 원본 zip 관문도 유지한다.

책의 이미지·CSS·글꼴은 해당 책에만 접근하는 주소로 제공한다. 디스크·원격 경로·스크립트 자산을 열지 않는다. 책 내부 링크와 목차, 원본 텍스트 보기, 읽던 위치·글자 크기·어두운 읽기 설정을 연결했다. 설정은 앱의 `office/epub-reading.json`에 저장하며 책 파일을 바꾸지 않는다. 기존 독립 이음 앱 설정의 이행은 공통 서비스 단계에서 수행한다.

WebKit에서는 원본의 `sandbox="allow-same-origin"`이 부모 편집기의 입력 이벤트도 막아 글이 저장되지 않았다([WebKit 218086](https://bugs.webkit.org/show_bug.cgi?id=218086)). Workbench 빌드 어댑터는 WebKit에서만 신뢰하는 부모 콜백이 동작하도록 sandbox 플래그를 조정한다. 이는 원본 Chromium 모듈의 플래그와 다른 호환 처리다. 원본 sanitizer와 문서 첫머리의 `script-src 'none'`, 책 주소에 한정한 CSP를 유지한다. 직접 제공하는 자산에는 별도 sandbox CSP도 적용한다. 원본 vendor 파일은 변경하지 않았다.

**호스트/인접 편집기17/17, 실제 Linux Tauri `epub-office`24/24**, 전체 타입·루트/Office/Tauri 빌드 통과. 실제 문단 입력·Undo·저장·내부 링크·다른 장 보존·읽기 설정·외부 판 충돌·새로고침/긴급 입력 복구를 확인했다. sanitizer를 거친 뒤 별도로 삽입한 스크립트와 인라인 클릭 코드도 CSP가 거절했다. 원본 회귀14파일의164개도 검증했다. Node26의 전역 WebStorage 때문에 처음 실패한 두 App 파일은 해당 Node 기능을 끈 jsdom 환경에서18/18 통과했다. 물리 IME·다른 OS·실제 구독 모델·기존 독립 앱의 데이터 이행을 이 결과에 포함하지 않는다.

계획 판: `research:rr-3492c2c2a180a313cf65edeb5feed33a:db3c579ba3bf918c68910a1fe022bb9b2bf3edcf9c3dd0490a2dbbfb7782c774`. 검증 판: `research:rr-3492c2c2a180a313cf65edeb5feed33a:1fbd261f2a6622b13a52d39f230119a2b1110cd900f605a143141db0d4623c58`. 증거: `implementation-20261030/native-epub-frame/results.json`, `/tmp/wb-epub-host-final.log`, `/tmp/wb-epub-types-final.log`, `/tmp/wb-epub-original-tests.log`, `/tmp/wb-epub-original-app-tests.log`. 최초 native 실패·검사 문자열 오류·빌드 어댑터의 주석 오매칭과 WebKit 호환 판단도 같은 연구에 보존했다.

## 공통 AI 호스트 기반

원본 `ai-provider`와 Docs의 제공자 선택·오류·스트림 병합·keepalive 코드를 Node 호스트에 연결했다. 화면에 돌려주는 설정에서는 키를 가리고, 실행에는 호스트에 저장된 설정을 사용한다. 오래된 제공자 선택이나 바뀐 접속 주소·키를 담은 요청은 실행 전에 거절한다. 봉인된 기존 키를 열지 못하면 연결 실패로 처리하며 키 문자열을 제공자에게 보내지 않는다. 읽기 과정에서 설정 파일을 고쳐 쓰지 않는다. 구형 custom 설정의 endpoint ID가 읽을 때마다 바뀌던 문제는 동일 파일 바이트의 정규화 결과를 메모리에 유지해 해결했다.

요청·취소·유지되는 제공자 세션은 문서와 뷰별로 분리한다. grant 갱신은 같은 뷰의 소유권을 유지하고, 다른 뷰의 취소 요청은 실행을 끝내지 못한다. 연결 단절과 앱 종료는 해당 실행을 취소한다. 원본 답변·추론·도구 호출·사용량·입력 축소 이벤트 순서를 유지하고, 입력·동시 실행·응답 및 전송 대기량에 한도를 둔다. 문서 grant로 전역 설정·CLI 경로·키·종량 동의를 변경할 수 없다.

**공통 AI/인접 편집기 검사22/22, 빌드된 실제 호스트6/6**, 전체 타입 검사와 host 빌드 통과. 원본 OpenAI 호환 프로토콜이 로컬 시험 서버에 요청하고 한국어 답변을 받는 경로, 취소·단절·정상 종료, 원본 파일 불변성과 설정 변조 거절을 확인했다. 실제 Claude/Codex나 사용자 자격증명은 사용하지 않았다. 원본 AI 패널·모델 선택/비밀키 보안 저장 화면·대화 기록·첨부·검색·Drive·결과 보관 연결은 다음 단계다. 이 결과에 네이티브 AI 화면과 다른 OS 검증은 포함되지 않는다.

계획 판: `research:rr-e71ed06ec7d8536f6d79b978226befd7:5bccddab66b6bb7ce2df99eae46e8b496d0cc2cb44738ec26b94f0a38a8173b2`. 검증 판: `research:rr-e71ed06ec7d8536f6d79b978226befd7:48fbf9949e6e280938692f4e48bcdc2697ae1bdcffdd89a8fba9f784c6d8fb81`. 증거: `/tmp/wb-office-ai-host-guarded.log`, `/tmp/wb-office-ai-types-all.log`, `implementation-20261030/office-ai-bundle/results.json`. 초기 설정 비교 실패, 원인 가설 정정과 음성 검사 fixture 보완도 같은 연구에 남겼다. 재현 도구: `scripts/smoke-office-ai.ts`.

## 기존 Workbench 세션과 Office AI 실행 연결

Office 요청은 신뢰하는 호스트가 문서 뷰의 기존 Workbench 세션에 연결한다. 같은 프로젝트·작업공간, 편집 권한과 저장된 판을 검사하고 요청에 판·해시·선택을 남긴다. 미저장 편집이 있으면 먼저 저장하도록 거절한다. 별도 Office 프로젝트나 대화 DB를 만들지 않는다. 요청·도구·답변·종료는 기존 SQLite 대화와 UI 이벤트에 저장한다.

같은 요청·이벤트의 재전송은 중복 저장하지 않고, 같은 제공자 호출을 다시 실행하지 않는다. 다른 창의 실행, 어긋난 이벤트 순서, 이미 마친 기록 변경을 거절한다. Office가 실행 중이면 같은 세션의 일반 CLI 요청은 대기한다. Workbench의 멈춤, 응답 연결 단절, 뷰 만료와 앱 종료가 해당 Office 실행을 중단한다. 재시작 뒤에는 부분 답과 중단 원인을 보존하며 자동 재실행하지 않는다.

후속 CLI 요청에는 아직 전달하지 않은 Office 기록을 자료로 제공한다. 전송 실패 시 그 기록을 남겨 두며, 전달 커서 저장 실패 때문에 이미 실행 중인 CLI를 실패로 바꾸지 않는다. 원래 CLI의 native session ID를 유지하고, 갈래를 만들 때 Office 실행을 CLI의 원본 요청 수로 세지 않는다.

**세션 연계/인접 검사57/57, 빌드된 호스트10/10**, 전체 타입 검사와 최종 host 타입·빌드 통과. 로컬 시험 제공자를 통한 원본 HTTP 요청, 같은 대화 기록, 중복 호출 거절과 정상 종료를 확인했다. 실제 구독 호출·네이티브 AI 화면 검증은 포함하지 않는다. 원본 패널의 실행 전 저장, 실제 편집 도구, 설정/보안 키 저장, 첨부·검색·Drive와 이력 복원은 다음 연결 단계다.

계획 판: `research:rr-9ea5b25fba78bdf457ec7b3505053d84:d5af36a220e22125d23038b9cacb6d6fa824ed7963d743c62cfc2d9257cd2889`. 검증 판: `research:rr-9ea5b25fba78bdf457ec7b3505053d84:36e728834971b42346058dfc945eafc7c54abb7eae099970820e4ddc9203a711`. 증거와 로그: `implementation-20261030/office-session-bundle-final/`. 초기 TypeScript 문법 검사 실패와 수정도 같은 연구 기록에 남겼다. 재현 도구: `scripts/smoke-office-ai.ts`.

## 아직 완료되지 않은 범위

현재 아홉 renderer 진입점이 있다는 것은 아홉 편집기의 전 기능이 끝났다는 뜻이 아니다. Markdown·HTML의 클라우드 이미지 호스트/원격 그림 읽기, 다른 이름으로 저장, 내보내기, 내부 AI·검색·첨부·위키 서비스는 연결 중이며 미구현 동작을 성공 처리하지 않는다. 기존 Word·PPT·Sheets에도 AI·템플릿·출력 미연결 항목이 있다. PDF의 영구 가림 사본·다른 이름 저장·추출/합치기 파일 선택·변환/출력·서명 보관/인증서 서명·AI/번역/결과 보관/노트·Windows/macOS OCR과 전체 기능 인수 검증이 남았다. 인증서 서명 읽기 코드는 연결했지만 실제 서명 검증 fixture는 아직 수행하지 않았다. XMind의 다른 이름 저장·내보내기·출력·링크 열기·문서 만들기, EPUB의 AI/번역/결과 보관·첨부·다른 이름 저장·외부 링크·이름 변경 동기화와 기존 설정 이행도 남았다. 공통 제공자·세션·Drive·검색·doory와 출력 서비스를 계속 연결한다.

CLI의 실행파일은 Node로 전환했지만, 숨은 렌더링·일부 변환·기존 암호화 설정 해제/앱 제어와 Electron 배포 파일은 아직 남아 있다. 다음 구현에서 이 경로를 Rust/Tauri/WASM 서비스로 대체한다. 실제 대체 결과를 검증한 뒤 중복 번들을 제거한다. 현재 변경만으로 설치 용량이 줄었다고 주장하지 않는다. 모든 OS의 설치·기존 데이터 이행·용량 실측과 최종 GitHub 릴리스도 미완료다.

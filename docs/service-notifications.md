# 서비스 알림

작업 완료·실패·승인 요청은 이제 Node host가 기록한다. 창을 닫아도 host가 실행 중이면 기록과 운영체제 알림 요청이 이어진다. 알림 기록은 기존 로컬 DB에 있고, 대화 본문과 프로젝트·파일 이름은 운영체제 알림에 넣지 않는다.

각 사건은 host/session/item/kind로 구분한다. 같은 사건이 다시 전달되어도 알림을 새로 만들지 않는다. 전송 중 host가 종료된 기록은 결과 미확인으로 남겨 자동 재전송하지 않는다. 화면 쪽 대체 알림도 한 창만 가져갈 수 있다. 설정의 알림 끄기와 세션 음소거를 적용한다.

사용자가 실제로 보고 있는 세션의 알림은 읽음으로 남기고 운영체제에 중복 표시하지 않는다. 화면 상태는 40초 뒤 만료되며 작업 실행 권한과 무관하다. 알림을 읽는 행위는 승인 요청을 수락하거나 취소하지 않는다. 알림의 대상은 인증된 host에서 다시 조회하며 삭제·보관·다른 host의 대상은 열지 않는다. 가져온 과거 기록을 새 작업 완료로 취급하지 않는다.

Linux는 `notify-send`의 열기 동작에서 현재 앱에 불투명 알림 ID만 전달한다. 앱이 이미 열렸거나 다시 시작된 경우 모두 해당 host에서 ID를 해석한 뒤 이동한다. macOS의 [시스템 알림 명령](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html)과 Windows의 [ToastNotificationManager](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmanager) 경로는 일반 문구로 알림을 요청한다. 운영체제 거부·알림 서비스 부재 시 앱 안의 알림 기록은 유지된다. 자체 생성한 알림 보조 프로세스만 종료하며 기존 앱 프로세스를 채택하지 않는다.

## 현재 확인 범위

`apps/host/src/notifications.test.ts`의 4개 동작을 한 번 실행해 통과했다. 화면 없는 완료 처리, 중복 방지와 정확한 문서 하위 작업 식별, 민감 본문 제외, 화면 상태 만료, 읽음과 승인 분리, 전송 결과 미확인 복구, 대체 알림 단일 접수, 설정과 대상 범위를 확인했다. host TypeScript 계약 확인도 통과했다.

각 OS의 실제 알림 권한·설치 앱 등록과 새 Rust 코드 실행은 전체 통합 빌드 때 확인한다. Windows/macOS 알림 클릭에서 직접 원문으로 이동하는 연결과 모바일 push는 아직 남아 있다. 일반 알림 제출 코드를 실제 장치 확인 완료로 표시하지 않는다. 이번 기능 추가로 production/설치본 빌드나 CI를 실행하지 않았다.

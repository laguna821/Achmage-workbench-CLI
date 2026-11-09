# 현행 Workbench에서 재사용할 것과 새로 필요한 것

기준은 `bc1057c2c5fb04f2046f4fd711bf718f5cc93737`, 0.3.3 소스다. 이번에 설치본을 다시 실행하지 않았다. 아래 “있음”은 해당 구현 경로를 읽었다는 의미다.

## 기존 기능을 발전시키는 범위

| 영역 | 현재 있음 | 추가할 범위 | 주요 코드 |
|---|---|---|---|
| 대화 표현 | Markdown·Mermaid·도구/생각 접기·읽기 rail | 본문·결과물 위계, 타입별 도구 상세, 긴 기록 최적화 | [Transcript](../../../apps/web/src/components/Transcript.tsx) |
| 이미지 | 붙여넣기·드롭·썸네일·확대·도구 결과 그림 | 일반 답변의 workspace 이미지 해석, 원격 media 참조, 캐시·실패 상태 | [Attachments](../../../apps/web/src/components/Attachments.tsx), [tool-images](../../../apps/host/src/tool-images.ts) |
| 메시지 제어 | 세션별 중지·끼어들기·대기열·중복 요청 방지 | 여러 기기의 접수 결과 조정, 초안·첨부의 전송 복구 | [SendGate](../../../apps/host/src/send-gate.ts), [sessions](../../../apps/host/src/sessions.ts) |
| 모델·공급자 | Claude SDK·Codex app-server, 실제 모델 목록 | 새 공급자와 하위 작업 capability. 과거 모델 목록을 다시 하드코딩하지 않음 | [provider 계약](../../../apps/host/src/providers/types.ts) |
| 문서 AI | 독립 세션·부모 보고·다음 요청의 문서 맥락 | UI 접속과 실행 권한 분리, 원격 관찰·제어 | [OfficeSessions](../../../apps/host/src/office-sessions.ts) |
| 프로젝트·워크트리 | 프로젝트 노트·고정 cwd·격리·비교·적용·터미널·준비 | 작업 공간의 상태 가독성, 서비스·포트, 원격 경로 연결 | [worktree-workspaces](../../../apps/host/src/worktree-workspaces.ts) |
| 검색 | Fast Find, 프롬프트·답변·문서·볼트, 메시지 위치 | 호스트·자식 작업 범위와 연결. 현재 원문 검색 보존 | [search](../../../apps/host/src/search.ts) |
| 알림 | UI가 완료·승인·오류를 수신하고 OS 알림·트레이 표시 | UI 없는 서비스에서 이벤트 생성, 모바일 push·미확인 상태 | [App](../../../apps/web/src/App.tsx) |
| 예약 | 호스트 기동 중 tick, 놓친 예약 1회 처리 | 독립 서비스에서의 예약 의미·기한·종료 정책 | [schedules](../../../apps/host/src/schedules.ts) |
| 외부 이음·Dropbox | 독립 이음 설치/열기, 같은 파일 저장 감시, 로컬 Dropbox 연결 | 원격 호스트 파일과 편집 권한·revision 계약 | [ieum-desktop](../../../apps/host/src/ieum-desktop.ts), [dropbox](../../../apps/host/src/dropbox.ts) |

이미 있는 이미지·큐·알림을 새 기능으로 세어 작업량을 늘리지 않는다. 반대로 데이터 타입이나 반응형 CSS가 있다는 이유만으로 모바일 제품이 완성됐다고 계산하지 않는다.

## daemon과 다기기의 실제 빈틈

| 경계 | 코드로 확인한 현재 상태 | 도입 조건 |
|---|---|---|
| 창 닫기 | main close는 hide, 트레이 유지 | 기존 사용성 유지 |
| 앱 자체 종료 | Tauri Exit → `stop_gateway`; 셸 stdin EOF → Node 종료 | 독립 service start/status/stop/attach, 정상 종료 소유권 |
| 접속 주소 | 메인·편집기·설정 서버가 모두 127.0.0.1 | 원격 origin·인증·파일 참조·브리지 재설계 |
| 인증 | 현재 프로세스의 공통 bearer와 문서별 토큰 | 기기별 자격·권한·폐기·회전 |
| 이벤트 | 메모리 SSE replay 5,000개, snapshot resync | 재시작 epoch·cursor·동시 응답·큰 기록의 선택 구독 |
| 문서 실행 | live writer lease와 응답 연결을 계속 검사 | 승인된 작업 권한과 UI presence 분리 |
| 하위 에이전트 | 문서 child는 있음. 엔진 내부 자식의 공통 제어 모델은 없음 | 원본 이벤트 매핑, 관계·상태·제어 capability |

직접 확인할 위치는 [Tauri 시작·종료](../../../apps/desktop/src-tauri/src/lib.rs), [host main](../../../apps/host/src/main.ts), [SSE bus](../../../apps/host/src/bus.ts), [문서 registry](../../../apps/host/src/document-registry.ts), [문서 UI heartbeat](../../../apps/web/src/document-session.ts)다.

문서 registry의 TTL은 60초, UI heartbeat는 10초다. Office 실행은 주기적 live 검사 실패나 응답 연결 종료 시 중단하는 경로가 있다. 현재 탭 전환이 가능한 이유 중 하나는 [Panes](../../../apps/web/src/components/Panes.tsx)가 숨긴 탭을 mounted 상태로 유지하기 때문이다. 탭 전환 지원과 앱 종료 뒤 지속 실행은 다른 수용 시나리오로 둔다.

## 공급자 내부 하위 작업은 새 정규화가 필요하다

[Claude mapper](../../../packages/provider-claude/src/map.ts)는 Task·Agent를 도구 항목으로 표시하고 `parent_tool_use_id`가 있는 자식 스트림을 메인 본문에 합치지 않는다. [Codex mapper](../../../packages/provider-codex/src/map.ts)는 현재 `collabAgentToolCall`을 공통 transcript에 매핑하지 않는다. 원본 타입이 생성 파일에 있다는 사실만으로 UI 지원이 완성되지 않는다.

기존 제외 처리를 지우고 자식 출력을 모두 부모 본문에 넣으면 화자·작업 구분이 사라진다. 새로운 자식 view와 상태 모델에 연결하고, 공급자가 실제 지원하는 관찰·열기·메시지·중단 기능만 표시한다. 문서 세션의 부모 보고와 기존 request journal을 재사용한다.

## 성능 조사에서는 가설을 결함으로 바꾸지 않는다

현재 lazy view·Mermaid 지연 로딩·단일 검색 worker·엔진 idle 정리가 있다. 전체 `turns.map`, hidden 탭 유지, 만료 없는 첨부 blob Map은 측정할 후보다. 이 후보를 실제 성능 결함이나 Paseo 대비 열세로 확정하지 않았다.

최적화는 [채팅 측정 계획](02-chat-and-artifacts.md)의 동일 조건 비교에서 결정한다. 특히 문서 탭의 수명을 바꾸는 최적화는 문서 작업 권한 분리와 함께 검증한다.

전체 조사 메모와 57개 기준 파일의 해시는 [근거 문서](06-evidence.md)에서 찾을 수 있다. 기존 HIG·Aside 문서는 설계 상태로 연결하며, 이번 표의 현행 코드와 합쳐 구현 완료 항목으로 표시하지 않는다.

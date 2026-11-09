# 대화 역할과 자동화 클라이언트

0.4.0에서 대화 입력창의 **역할** 메뉴로 조사·집필·개발·검토 역할을 선택하거나 직접 저장할 수 있습니다. 역할에는 엔진, 모델 ID, 추론 수준, 접근 방식, 추가 지침을 저장합니다. 대화에서 직접 고른 모델·추론 수준·접근 방식이 역할 기본값보다 우선합니다. 모델 목록에 없는 ID도 직접 입력할 수 있습니다.

역할 변경은 다음 요청부터 적용합니다. 이미 실행하거나 접수한 요청은 당시 설정을 유지합니다. 역할을 삭제하면 이를 선택한 대화의 역할 선택만 해제되며, 진행 중인 요청과 대기열은 유지됩니다. 역할의 지침은 엔진 입력에 붙고, 사용자가 입력한 원문은 그대로 기록·검색됩니다.

## 같은 호스트의 CLI와 MCP

설치본의 `host/workbench-client.mjs`와 `host/workbench-mcp.mjs`는 실행 중인 Workbench의 인증된 API를 사용합니다. 별도 대화 DB나 엔진 프로세스를 만들지 않습니다. Node 24 이상 또는 설치본에 포함된 Node로 실행합니다.

환경 변수 `WORKBENCH_URL`과 `WORKBENCH_TOKEN`에 자신의 호스트 주소와 토큰을 지정한 뒤 다음 명령을 사용합니다. 토큰은 로컬에서 보관하고 공유 문서·저장소에 넣지 않습니다.

```sh
node host/workbench-client.mjs snapshot
node host/workbench-client.mjs tasks
node host/workbench-client.mjs profiles
node host/workbench-client.mjs submit request.json
node host/workbench-client.mjs receipt my-request-001
node host/workbench-mcp.mjs
```

`submit` 입력은 실제 snapshot의 hostId·workspaceId·sessionId를 사용합니다. `commandId`는 요청별 고유 식별자입니다.

```json
{
  "commandId": "my-request-001",
  "hostId": "snapshot의 hostId",
  "workspaceId": "선택한 대화의 workspaceId",
  "sessionId": "선택한 대화의 id",
  "text": "프로젝트의 진행 상황을 요약해 줘",
  "mode": "queue"
}
```

같은 commandId와 같은 내용은 같은 접수 결과로 돌아갑니다. 내용을 바꿔 재사용하면 거부합니다. 응답을 잃었을 때는 `receipt`로 확인합니다. 완료된 접수 결과는 요청 전달이 끝났다는 뜻이며 AI 응답 완료 여부는 `tasks`에서 확인합니다. 중지·승인·대기열 조작도 `command`를 통해 같은 작업 API를 사용합니다.

MCP는 표준 입출력 방식이며 snapshot, tasks, profiles, submit, command, receipt 도구를 제공합니다. 원격 호스트 연결에는 HTTPS가 필요합니다. 다른 기기의 등록·권한 회수 UI는 별도 기능 단위에서 연결합니다.

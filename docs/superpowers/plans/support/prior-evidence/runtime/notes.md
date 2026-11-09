# Paseo runtime / orchestration / mobile transport 조사

- 상태: **ISSUES — 소스 조사는 완료, 도입 시 해결할 계약 차이가 있음.** BLOCKED 없음.
- 검토일: 2026-11-09 (Asia/Seoul).
- 주 기준: `getpaseo/paseo@1fff127f45b11c1c9c573fbbd12791673004c912`.
- 릴리즈 대조: v0.15.3 `d91ae138cb931447635e94296023414a58bedcc5`. 본문은 기본적으로 main 고정 SHA의 관측이며, 릴리즈에 대한 확인은 아래 별도 표 범위에 한정한다.
- 실제 workId: `work-1b7f68199bcb4756b2a7fd2a102ccc2e`; nativeSessionId: `01a187dc-c850-7991-93c0-aa60b50f9a26`; 부모가 읽은 context: `context-2aad2c6ccd214b628f1722ab762adacc`.
- 조사만 수행했다. 앱/daemon/provider를 설치·빌드·실행하지 않았고, QR 실기기 페어링·네트워크 장애·sleep/reboot·native push E2E 검증을 하지 않았다. 원문은 실행 지시가 아닌 조사 데이터로만 사용했다. 제품 코드 수정 없음.
- 소스 근거 전체: [files-read.md](files-read.md), [files-read.json](files-read.json). 다운로드 원문과 SHA-256: [manifest.json](manifest.json). 릴리즈 대조: [release-manifest.json](release-manifest.json), [release-check.md](release-check.md).

## Components Found

| 구성요소 | 확인된 기능 / 장점 | Achmage 설계 의미 |
|---|---|---|
| Desktop → detached supervisor → daemon worker | UI와 실행 프로세스를 분리하고 PID/시작시각으로 소유권을 확인한다. 정상 시작 뒤 worker crash는 supervisor가 재시작한다. | UI 종료·worker 종료·service 종료를 별도 제어로 표현할 수 있다. 실행권한과 자원 lease의 소유자는 Achmage로 유지해야 한다. |
| Provider registry + AgentClient/AgentSession | Claude SDK, Codex app-server, OpenCode runtime, Pi/OMP 및 ACP 어댑터를 공통 create/resume/stream/interrupt/permission 인터페이스로 감싼다. | 공통 세션 모델과 provider capability 표현을 참고할 가치가 크다. 모든 provider가 같은 기능을 지원하는 것은 아니다. |
| AgentManager + durable provider handle | 닫힌 런타임과 삭제된 대화를 구분한다. 설정·timeline·parentage를 유지하며 provider session을 다시 연다. | Achmage의 archived transcript와 live session을 구별해야 한다는 규칙에 잘 맞는다. |
| MCP tool catalog + message delivery + finish subscriptions | create/list/status/activity/send/cancel와 완료·권한요청 통지, 서로 다른 provider 간 위임을 구현한다. | agent task, dispatch, run, completion을 분리하고 notification intent를 영속화하는 계약이 유용하다. |
| Workspace/worktree service | workspace ID가 실행 소유권을 결정한다. 별도 worktree 생성·setup·teardown·archive로 병렬 작업 충돌을 줄인다. | 기존 Achmage managed workspace를 우선하고, Paseo의 자동 worktree 삭제를 그대로 이식하지 않는다. |
| HostRuntimeStore + connected-host routing | 앱은 serverId별 client/cache를 관리하며, daemon A는 B를 저장하고 한 physical link에 여러 logical sessions를 올린다. | 여러 컴퓨터의 작업을 하나의 UI에서 관찰·위임하는 구조로 재사용 가능하다. 세션 live migration과는 다르다. |
| Relay / direct / SSH transports | QR 또는 링크의 daemon identity를 바탕으로 outbound relay를 연결한다. direct TCP/socket/pipe, VPN 주소, desktop/CLI OpenSSH 경로가 있다. | 포트 개방 없이 모바일 접근하는 경험은 큰 장점이다. 개인정보·권한·device revoke 계약을 추가해야 한다. |
| Timeline subscriptions + authoritative catch-up | 실시간 이벤트와 authoritative history를 분리하고 epoch/sequence cursor로 누락을 복구한다. | 연결됨과 화면이 최신임을 구분하는 상태 모델을 우선 도입할 가치가 있다. |
| Presence-aware attention + Expo push | 보고 있는 화면의 중복 알림을 줄이고, 사람이 없으면 모바일 push로 완료·승인을 알린다. | 민감한 내용이 push provider에 전달되지 않도록 generic payload 정책이 필요하다. |

근거: [desktop-daemon], [daemon-instance], [supervisor-entry], [providers], [agent-contract], [lifecycle], [tools], [host-doc], [host-runtime], [timeline-doc], [attention], [push].

## Flow

### 1. 창 닫기, Quit, daemon 종료, sleep/reboot

| 사건 | 실제 코드 경로와 결과 | 조건 / 검증 한계 |
|---|---|---|
| 창 하나 닫기 | BrowserWindow close이며 다른 창이 남으면 앱 Quit이 아니다. 창의 browser host 등록은 해제된다. | worker 지속 여부와 browser automation 가용성은 별개의 문제다. [desktop-main] |
| macOS 마지막 창 닫기 | `window-all-closed`에서 Darwin은 `app.quit()`를 호출하지 않는다. | 이 경로만 보면 daemon은 계속 살아 있을 수 있다. OS sleep까지 막는다는 뜻은 아니다. [desktop-main] |
| Linux / Windows 마지막 창 닫기 | `window-all-closed` → `app.quit()` → before-quit. | 아래 Quit 정책 적용. 모든 OS에서 ‘창을 닫아도 항상 계속 실행’이라고 말하면 틀린다. [desktop-main] |
| 앱 Quit | transport를 닫고, `keepRunningAfterQuit`가 false이며 **현재 desktop 프로세스가 시작한 동일 daemon instance**이면 종료한다. 기본값은 false. | 기존 CLI daemon 또는 재시작한 앱이 단순히 발견한 daemon은 `ownedLaunch`가 없으므로 자동 채택·종료하지 않는다. [quit], [desktop-settings], [desktop-daemon] |
| keepRunningAfterQuit=true | Quit에서 owned daemon 종료를 생략한다. daemon launch 자체는 detached/unref다. | 앱 프로세스의 정상 종료와 daemon 지속이 분리된다. 테스트 실행은 하지 않았다. [quit], [daemon-instance] |
| `daemon stop` / SIGTERM | supervisor가 worker에 graceful shutdown을 요청한다. daemon은 finish 관찰·message admission을 닫고 queued dispatch를 비운 뒤 provider sessions를 닫고 상태를 flush한다. 기본으로 terminal도 종료한다. | remote stop 응답은 종료 요청 승인일 뿐, 원격 OS 프로세스 exit 검증은 아님을 CLI도 명시한다. [cli-stop], [worker], [bootstrap] |
| `--keep-terminals` stop | terminal worker를 detach하여 같은 home의 다음 daemon이 되찾게 한다. | 모든 agent run 보존이 아니다. `--force`와 병용 불가. Desktop app-update/version mismatch만 non-Windows에서 terminals를 보존하며 일반 Quit은 종료한다. [cli-stop], [desktop-daemon], [bootstrap] |
| daemon worker crash | readiness 성공 뒤 비정상 worker exit이면 supervisor가 다시 시작한다. supervisor 자체가 사라지면 worker는 orphan으로 계속 운영하지 않고 종료한다. | supervisor crash 자체를 OS 수준에서 재기동하는 기능은 이 내부 supervisor로 해결되지 않는다. [supervisor-entry], [supervisor], [worker] |
| OS sleep | 검토한 desktop main/daemon 경로에 sleep 방지(powerSaveBlocker)나 작업 이관이 없다. heartbeat 만료만으로는 supervisor PID가 살아 있는 worker를 죽이지 않는다. | 일반 OS suspend 동안 로컬 실행·네트워크는 진행하지 못한다는 추론이다. 복귀 뒤 provider/network 실패·timeout은 환경별 검증 필요. [worker], [client] |
| OS reboot / 전원 손실 | 프로세스는 보존되지 않는다. daemon이 다시 실행되면 provider persistence handle을 이용해 복원할 수 있다. | 재부팅 자동 시작과 중단 작업 자동 계속은 서로 다른 설정이다. auto continuation은 기본 off, best effort이며 exactly-once 보장이 없다. [restart], [config], [lifecycle] |

`agents.resumeOnStartup=true`이면 이전에 running이었던 eligible agent만 재개 후보가 된다. archived/internal/owned execution 등은 제외한다. 저장된 대화를 다시 열고 기본 `Resume working.` 프롬프트를 보낸다. 이를 실행 중 CPU/메모리 프로세스가 살아남는 persistence로 표현하면 안 된다. 중복 또는 누락 continuation 가능성을 문서가 명시한다. [restart], [config], [lifecycle]

서비스 지원은 다음과 같이 한정된다.

- **NixOS systemd 모듈 존재**: multi-user.target, Restart=on-failure, RestartSec=5, SIGTERM, TimeoutStopSec=15. flake에서 export한다. [nixos], [flake]
- **Docker Compose 예시 존재**: `restart: unless-stopped`, 별도 container manager가 supervisor 교체를 소유한다. [docker]
- 일반 CLI daemon 명령에는 start/run/status/stop/restart/reload/pair/config/set-password만 확인했다. launchd·Windows Service 설치/등록 경로는 조사한 tree와 desktop/CLI entrypoints에서 확인하지 못했다. ‘지원 불가능’이 아니라 **내장 service installer 미확인**이다. [cli-daemon]
- Nix module의 relay default는 true이고 일반 신규 host의 relay opt-in 정책과 다르다. Nix `--no-relay` wrapper 연결은 남아 있다. module 자체의 설치·실행은 미검증이므로 운영 지원 완료로 쓰지 않는다. [nixos], [nix-package], [config]

### 2. Provider → workspace → parent/child → dispatch

1. Provider contract가 `createSession`, `resumeSession`, `streamHistory`, `interrupt`, `respondToPermission`, 선택적 `steerActiveTurn`, `canStopRuntime`를 정의한다. Registry는 provider별 구현을 이 contract로 감싼다. CLI 인증과 실행 환경은 daemon host의 provider runtime에 남는다. [agent-contract], [providers], [claude-spawn]
2. Agent creation은 workspace ID를 재사용한다. 별도의 workspace 생성이 `local|worktree` 선택과 setup을 소유한다. 단순 cwd 일치로 실행 소유권을 추론하지 않는다. [tools], [lifecycle], [worktree-service]
3. Agent-scoped `create_agent`는 기본으로 caller workspace에서 child를 만들고 parent label을 남기며 즉시 반환한다. `notifyOnFinish` 기본 true이고, top-level 생성은 false다. 다른 provider/model은 명시적으로 선택할 수 있다. [tools]
4. `send_agent_prompt`의 agent-originated 메시지는 recipient별 2초 quiet window에 모인다. 충돌하는 activeTurnBehavior/mode는 별도 순서로 dispatch한다. 기본은 steer, 지원이 없으면 interrupt fallback. human/top-level prompt 기본은 interrupt다. `cancel_agent`는 현재 run만 중지하고 agent는 남긴다. [delivery], [prompt], [tools]
5. MCP catalog에는 별도 `wait_for_agent` tool을 확인하지 못했다. 완료는 자동 notification subscription이 주 경로이며 SDK/RPC에는 `waitForFinish` / `wait_for_finish_request`가 있다. callback은 idle/error/permission를 구별한다. 따라서 “MCP create/list/wait/send 모두 같은 도구”라고 평면화하면 부정확하다. [tools], [client], [finish-observation]
6. Finish intent는 durable store의 caller/child/server/ownership 정보로 복구한다. 실제 dispatch ack 뒤 제거되므로 crash 전후 중복 통지가 가능하다. 통지는 task 성공을 인증하지 않고 run이 정지점에 도달했음을 알린다. [finish], [lifecycle]
7. Parent archive는 모든 child를 무조건 삭제하지 않는다. 다른 workspace의 child 또는 어느 client에서든 열린 tab의 child는 detach하여 살린다. Native provider child와 Paseo child도 다르다. 전자는 provider가 runtime을 소유하고 후자는 full agent session과 follow-up 제어를 제공한다. [lifecycle], [orchestration-workflows]

**중요한 자원 장점**: idle resumable runtime을 한 시간 뒤 닫고 durable conversation은 남기는 정책이 있다. active run, permission, queued delivery, background descendants, finish subscription은 blocker이며 provider veto도 존중한다. 이는 Achmage의 resource lease를 대체하지 않는다. 정책을 이식하려면 lease가 종료를 승인한 run만 대상으로 해야 한다. [lifecycle], [agent-contract]

**Worktree 주의**: archive는 단순 UI 숨김이 아니다. 마지막 참조 workspace가 archive되면 teardown 후 소유권이 입증된 backing directory를 지울 수 있다. 소유권 미입증 경로는 남기고, 다른 active workspace가 참조하면 지우지 않는다. Achmage에서 ‘보관’이라는 UX를 이 기능과 매핑하려면 명시적 삭제/복원 계약이 필요하다. [worktree-archive], [worktree-doc]

### 3. 여러 호스트와 세션 이동 구별

앱은 serverId별 `HostRuntimeController`, directory sync, timeline replica를 갖는다. 같은 호스트에는 relay/direct/SSH/routed connection 후보가 추가될 수 있다. latency probe를 통해 후보를 선택하고 host identity 불일치는 오류로 처리한다. A가 발견한 B를 앱이 `via:A` candidate로 추가한다. [host-runtime], [selection], [session-store]

Daemon-connected hosts는 앱의 saved host 목록과 별도이다. A의 hosts.json에 B의 connection과 credential이 저장되고, physical link 하나 위에 각 caller scope가 별도 virtual session을 만든다. B가 link principal 권한과 forwarded caller grant를 교집합으로 적용한다. 역방향 권한은 자동 부여되지 않고 routed scope의 second hop은 허용하지 않는다. [host-doc]

실제 MCP catalog는 `list_hosts`와 `serverId`를 지원한다. remote 대상 가능 작업은 create_workspace/list_workspaces/create_agent/send_agent_prompt/get_agent_status/get_agent_activity/list_agents이다. 이 map에 `cancel_agent`/archive/permission response는 없으므로 모든 MCP mutation에 원격 selector가 있다고 확대하면 안 된다. 원격 실행에는 B의 workspace와 provider/model이 필요하다. [tools]

**결론**: multi-host federation과 remote delegation은 확인했다. 실행 중 process, provider writer, filesystem, credentials를 한 호스트에서 다른 호스트로 옮기는 live migration 경로는 검토한 routing/persistence 계약에서 확인하지 못했다. 화면에서 같은 작업을 휴대폰으로 다시 보는 것은 **client handoff to same daemon**이다. 실행 장소를 바꾸는 migration은 별도의 export/handoff/recreate 설계가 필요하다는 추론이다. [host-doc], [agent-contract], [host-runtime]

원격 child의 관찰이 세 번 실패하면 caller는 상태 unknown 알림을 받는다. child가 멈췄거나 완료되었다는 증거로 취급하지 않는다. remote creation과 caller notification persistence는 분리된 commit이므로 local 실패가 remote child 미생성을 보장하지 않는다. retry 전에 destination을 조회해야 한다. [host-doc]

### 4. 모바일 QR → relay → admission → event recovery

1. Host는 로컬 daemon keypair를 만들고 private file로 보관한다. offer v2에는 serverId, daemon public key, relay endpoint/TLS, 선택적 minimumSecurityMode가 들어간다. URL fragment에 base64url로 담아 QR/링크로 전달한다. 이 키/offer를 그대로 공개하면 안 되는 upstream trust 모델이다. [daemon-key], [pair-offer], [connection-offer], [security]
2. Native app의 Expo CameraView가 QR을 읽고 pair state machine이 한 번의 시도를 소유한다. 새 host나 key/relay/TLS 변경은 앱의 host confirmation 경로를 거친다. password 요구 시 같은 승인된 offer로 재시도하고 probe 성공 뒤 host profile에 저장한다. **이 UI 경로를 코드로만 확인했다. 실제 모바일 페어링 성공 증거는 없다.** [pair-scan], [pair-model], [host-runtime]
3. daemon은 relay에 outbound control/data WebSocket을 만들고 client는 same serverId로 접속한다. relay disconnect에 control reconnect가 있고 client도 exponential reconnect와 foreground liveness 검사를 한다. [relay-daemon], [client]
4. 최신 두 peer는 `Noise_NK_25519_ChaChaPoly_SHA256` protected mode를 사용한다. legacy client 또는 server와는 policy 허용 시 NaCl box로 fallback한다. protected handshake 실패는 legacy fallback하지 않는다. [secure-channel], [relay-security-doc]
5. 보호모드는 counter/fresh daemon ephemeral로 기록 재생을 거부하고 클라이언트는 한 번 보호모드를 경험한 daemon identity의 security floor를 고정한다. 그러나 daemon `requireProtectedSecurity` 기본 false다. **legacy admission을 계속 허용하면 과거 legacy handshake+credential+command transcript가 재생될 수 있다는 알려진 제한**이 있다. pin만으로 이 서버 측 제한을 해결하지 못한다. 기존 admitted legacy session은 flag 변경만으로 닫히지 않는다. [relay-security-doc], [config], [relay-client]
6. Relay HTTP upgrade에는 routing만 보내고 credential/subprotocol은 전달하지 않는다. daemon password는 E2E hello 안으로 들어간다. relay가 보는 것은 IP, 시각, 크기, session/connection IDs와 공개 handshake 필드다. 이 설명은 daemon↔client relay 경로의 경계이며 provider API나 push 경로까지 숨긴다는 뜻은 아니다. [relay-client], [security], [push]
7. Direct TCP는 WebSocket/TLS 옵션을 사용한다. Tailscale은 자체 구현 VPN이 아니라 tailnet 주소를 direct endpoint로 설정하는 사용법이다. SSH는 desktop/CLI의 로컬 OpenSSH `BatchMode=yes`, `-W 127.0.0.1:<daemonPort>` transport이며 remote host에 Paseo를 설치·시작하지 않는다. [connectivity], [ssh], [ssh-args]

### 5. Replay, reconnect, idempotency, offline의 서로 다른 계약

| 계층 | 제공하는 것 | 제공하지 않는 것 |
|---|---|---|
| Protected crypto record | 변조·duplicate/reorder·old transcript 차단 | 앱 mutation의 exactly-once 실행 |
| Owned subscriptions | 연결 복구 후 subscription membership 재구성 | 모든 과거 source event의 무제한 로그 재생 |
| Timeline | epoch/seq, projected authoritative history, `after` paging, `hasNewer=false`까지 gap catch-up | 모든 중간 token/tool update의 영속 이벤트 로그 |
| Creation lifecycle | idempotency key+fingerprint, milestone persist, reconnect 후 observe/resubmit | crash 시 side effect 결과를 항상 판정하는 능력 |
| Send receipt | 같은 ID/같은 input 완료 시 재실행 억제; conflict 거부; pending이면 outcome_unknown | pending 결과를 성공/실패로 마음대로 판정하거나 자동 재전송 |
| Agent message batching | receipt=queued와 실제 dispatch ack 분리; clean shutdown flush | abrupt crash 후 2초 메모리 queue의 durable 보존 |
| Finish notification | durable intent와 at-least-once wakeup | 완료된 task의 correctness 또는 turn attribution |
| Offline UI | 기존 cached history와 reconnect/freshness 상태 | offline 동안 호스트 mutation의 일반적인 durable outbox |

근거: [secure-channel], [timeline-subscription], [timeline-plan], [timeline-doc], [creation-server], [creation-client], [receipts], [session], [delivery], [lifecycle].

Client는 connecting 중 새 request를 deadline까지 기다리지만 disconnected이면 거부한다. connection loss는 기존 waiter/queue를 비우고 이미 제출한 요청은 outcome unknown으로 표시한다. 일반 mutation을 무조건 replay하지 않는다. creation은 별도 key 기반 recovery를 쓴다. 따라서 네트워크가 돌아오면 “무조건 모든 명령이 알아서 재실행”된다는 식으로 설명하면 안 된다. [client], [host-doc]

History는 복구 중에도 읽을 수 있으나 socket connected만으로 최신임을 인증하지 않는다. 앱은 Reconnecting / Updating messages를 구별하고, 모바일 OS가 JS/socket을 suspend하면 foreground에서 다시 probe한다. background socket의 무기한 생존을 보장하지 않는다. [timeline-doc], [host-runtime], [client]

### 6. Push / 권한 / credential 경계

- Presence threshold 180초. 현재 app-visible이며 해당 agent를 보고 있으면 알림을 suppress한다. 다른 present client가 있으면 가장 최근 client 한 곳에 in-app notification을 보낸다. 아무도 present하지 않으면 push를 검토한다. error는 push eligible에서 제외된다. [attention]
- Push payload는 `title`, `body`, `data`이다. 완료 응답 또는 permission input/metadata 등의 220자 미리보기가 body에 들어갈 수 있고 data에 host/workspace/agent ID가 들어간다. 이를 `https://exp.host/--/api/v2/push/send`에 JSON으로 POST한다. **이 push content는 relay E2E로 보호되는 payload가 아니다.** [notification], [push], [ws-server]
- Native 등록에는 OS notification permission과 Expo project ID/token이 필요하다. token은 연결마다 갱신하며 server lease는 48시간이다. host 제거 시 online+capability가 있으면 push unregister를 하고 로컬 token을 지운다. offline 제거는 즉시 server revoke를 보장하지 못하고 lease 만료 경로가 남는다. [push-subscriptions], [push-index], [host-runtime]
- 일반 relay/direct admission은 shared password 또는 per-run local credential을 검사한 뒤 principal=`owner`, OWNER_PERMISSIONS로 들어간다. password 없는 host는 reachability가 권한 경계다. client가 스스로 sessionPermissions를 좁힐 수 있으나 그것만으로 공격자를 제한하는 durable per-device grant는 아니다. [admission], [authorization], [auth], [ws-server]
- 검토한 pairing/relay/admission에는 phone의 영구 private identity allowlist나 개별 trusted-device revoke 모델을 확인하지 못했다. upstream은 phone key를 connection마다 ephemeral이라고 설명한다. 앱 removeHost는 자신의 connection/push 목록 삭제이지, 복사된 pairing link 또는 다른 phone 권한의 취소가 아니다. [secure-channel], [security], [host-runtime]
- Provider OAuth/API credential은 provider CLI가 host에서 사용한다는 구조와 문서가 있다. 그러나 원격 operator는 daemon user가 읽을 수 있는 file/terminal에 접근하므로 “어떤 명령으로도 credential을 노출시킬 수 없다”는 보장은 없다. 또한 provider custom env/config가 로컬 저장될 수 있으므로 “Paseo의 어느 파일에도 API secret이 존재하지 않는다”라는 절대 표현은 피해야 한다. [claude-spawn], [providers], [security]

## Boundaries

### 사실

위 Flow에 연결한 source 경로와 설정/분기/타입은 pinned revision에서 읽었다. 최신 release의 quit/default/security 문서도 대조했다. 서로 다른 provider 세션, app/controller, daemon/supervisor, connected host, SDK transport, push 경계를 분리할 수 있는 구현이 있다.

### 설계 추론

Achmage Workbench에는 **Paseo 전체를 제품의 새 소유권 체계로 넣기보다, 선택 가능한 daemon backend + 공식 client/protocol adapter로 연결하는 방안**이 가장 점진적이다. 이는 parent의 Workbench 코드 조사와 결합해 확정해야 하는 제안이다.

- Workbench의 workId/nativeSessionId를 Paseo의 `(serverId, workspaceId, agentId, provider sessionId)`와 명시적으로 매핑한다. UUID나 cwd를 세션의 동일성으로 대체하지 않는다.
- Achmage의 resource acquire/run/release, repository authorization, result/research provenance를 바깥 제어 계층으로 유지한다. Paseo 자체 supervisor가 시작한 descendant도 resource lease의 실행 트리에 포함되어야 한다.
- UI의 ‘닫기’, ‘작업 중지’, ‘background 유지’, ‘daemon/service 종료’를 별도 contract로 둔다. 장기 작업은 OS별 explicit service wrapper를 나중에 검증한다.
- source ingestion/branch setup/teardown/terminal 실행은 Achmage의 현재 권한 계약을 통과해야 한다. MCP injection과 remote dispatch가 우회 권한 경로가 되지 않게 한다.
- 모바일 최초 단계는 read-only status/timeline + 명시적 승인 응답. 그 다음에 send/cancel/remote create를 단계적으로 연다. per-device identity, expiry, revoke, narrow scope, audit를 upstream pairing 위에 추가해야 한다.
- 보호모드 강제와 구버전 client rejection을 명시한다. key/password는 local private store에 두고 Dropbox에는 비밀 없는 mapping·handoff·artifact만 둔다.
- Push는 기본 generic `작업 확인 필요` 정도와 opaque event ID만 보내고 실제 내용은 인증된 channel에서 읽는다.
- disconnect 후 unknown mutation은 사용자에게 재실행으로 위장하지 않는다. reconciliation → same idempotency key retry → duplicate 방지 검증 순서를 사용한다.

### 재사용 선택

| 선택 | 장점 | 비용/위험 | 판단 |
|---|---|---|---|
| Desktop/app 전체 fork | 현재 UX/모바일/terminal/provider/host 통합을 한 번에 얻음 | Electron/Expo/provider/bundler/update/runtime 정책 전체를 유지해야 함. Workbench와 authority·resource·archive·storage가 겹침 | 빠른 별도 제품 pilot에는 가능하나 기본 통합안으로는 보류 |
| `@getpaseo/client` + `@getpaseo/protocol`로 외부 daemon 연동 | 재접속·subscription·creation recovery·schema 계약을 활용하면서 UI와 provenance를 보존 | protocol capability drift, host 설치/인증·resource 소유권 adapter 필요 | **우선 검토안**. public SDK 위에 Workbench adapter를 두고 internal export 직접 의존을 최소화 |
| selected module / 설계 참조 | ownership token, finish intent, timeline cursor, semantic interruption, quiet-window batching을 독립적으로 도입 | 원본의 surrounding invariants 없이 복사하면 숨은 전제 상실 | 필요한 기능만 contract+tests와 함께 선별 |
| relay crypto 단독 복제 | relay 운영과 UI를 분리할 수 있음 | legacy compatibility·own Noise implementation·security floor/pins를 계속 유지해야 함 | 독자 crypto 변경은 피하고 검증된 package/protocol을 고정; device auth를 별도 설계 |

각 package metadata는 Apache-2.0이고 root LICENSE는 third-party components의 별도 license를 보존한다. “저장소 전체의 모든 dependency/asset이 단일 Apache 허가”라는 결론은 아니다. redistribution 시 actual dependency/artifact notices를 확인하는 작업은 별도로 남긴다. [license], [client-package], [protocol-package], [relay-package], [server-package]

## Non-Obvious Things

1. **Quit 기본값이 지속 실행이 아니다.** 최신 v0.15.3에서도 settings/quit/main 파일은 main과 동일하다. owned instance만 종료한다는 경계가 중요하다.
2. **공용 orchestration 문서가 최신 코드보다 뒤처져 있다.** public workflow 문서는 injected tool을 local-only로 설명하지만 실제 catalog와 connected-host 문서는 remote serverId dispatch를 가진다. 개별 tool의 remote 지원 범위는 제한되어 있다.
3. **공용 security 문서도 최신 security contract와 충돌한다.** NaCl legacy에 replay protection을 일반화한 문구가 있으나 최신 SECURITY/endpoint-security 문서는 legacy replay 위험을 명시한다. 상세 구현과 최신 내부 계약을 근거로 삼아야 한다.
4. **Relay opt-in default에 예외가 있다.** 신규 home은 off지만 legacy missing-field compatibility, Nix module default 등은 별도다. config=off라고 환경 전체가 동일한 것은 아니다. [persisted-config], [config], [nixos]
5. **Parent completion notification은 at-least-once이고 성공 판정이 아니다.** permission checkpoint도 통지하며, remote 관찰 실패는 unknown이다.
6. **Created/queued/dispatch acknowledged/finished/verified success는 서로 다른 milestone이다.** 특히 2초 memory queue는 durable receipt가 있어도 갑작스러운 crash에서 소실될 수 있다.
7. **Archive가 worktree 삭제를 포함할 수 있다.** Achmage의 연구/산출물 보관 UX와 직접 매핑하면 데이터 보존 의도가 달라진다.
8. **Mobile push가 privacy 경계의 예외다.** relay 암호화가 push payload를 감추지 않는다. 앱을 foreground에서 보는 상태 판단은 stale할 수 있다.
9. **Local-first는 offline 실행 능력과 동일하지 않다.** provider가 cloud model을 호출하거나 Hoplite같이 실제 cloud workspace를 쓰는 어댑터가 있을 수 있다. daemon/client가 host-local인 것과 inference/data path는 구별한다. [supported-providers]
10. **내부 worker supervisor와 boot service는 다르다.** NixOS systemd 모듈은 있지만 universal autostart 보장은 아니다.

## Open Questions / 도입 검증 게이트

다음은 아직 하지 않은 검증이다. 조사 결과를 E2E PASS로 쓰면 안 된다.

| 우선순위 | 검증 | 통과 기준 |
|---|---|---|
| P0 | Workbench authority/resource adapter | 기존 work/session mapping 보존, 승인 없는 spawn/worktree setup 없음, 등록 lease만 정상 shutdown |
| P0 | 실제 OS별 수명 | macOS 창닫기/Quit, Linux/Windows 마지막창/Quit, keepRunning 토글, 기존 외부 daemon 미채택, forced kill/worker crash 구별 |
| P0 | reboot/sleep | 각 OS에서 service startup, sleep 후 reconnect, 중복 continuation·unknown 상태 노출. app 종료만으로 service 성공 판단 금지 |
| P0 | device identity / revoke | 하나의 phone 권한만 취소, 기존 socket 재입장 거부, expired credential·copied QR 처리, read-only scope 서버측 강제 |
| P0 | protected-only relay | 새/구 peer matrix, replay/duplicate/reorder/downgrade rejection, pin persistence, flag 변경 뒤 기존 legacy socket 처리 |
| P0 | reconnect/idempotency | mutation response 손실 전후, create milestone별 crash, 동일 key 다른 payload conflict, no duplicate irreversible action |
| P1 | mobile 실제 페어링·push | iOS/Android QR, password wrong/correct, cellular↔Wi-Fi, background suspend, warm/cold taps, Android Back 이후 중복 notification navigation |
| P1 | provider parity | 각 provider create/resume/steer/cancel/permission/native child/history, active-writer conflict, unsupported capability 표시 |
| P1 | connected-host fleet | direct↔relay↔routed failover, wrong serverId, permission change, remote observation unknown, no reverse/no second-hop |
| P1 | worktree lifecycle | 기존 directory 보존, dirty changes, shared worktree last reference, teardown failure/cancel, archived artifact retention |
| P1 | upstream version policy | 실제 설치릴리즈·package hash pin, main 기능과 release 기능 구분, public SDK 안정성/feature gates, upgrade rollback |
| P2 | Nix/서비스 packaging | NixOS module의 최신 supervisor 인자와 relay setting 실제 적용; launchd/Windows Service 별도 wrapper 필요 여부 |

## 조사 결과와 기록할 결론 변경

- **PASS (정적 조사):** process lifetime, provider contract, MCP/remote routing, QR/crypto/admission, reconnect/cursor/idempotency, notification 경로를 pinned source로 추적했다. 소스 hash manifest와 읽은 범위가 있다.
- **ISSUES (도입 조건):** quit 기본/OS 차이, legacy replay 허용, per-device revoke 미확인, Expo preview payload, unknown/at-least-once semantics, archive 삭제, native E2E 미실행.
- **BLOCKED:** 없음. 구현·설치 권한을 요청할 단계가 아니며 계획/검증항목을 작성할 근거는 충분하다.
- 부모의 원래 research R 라벨을 유지해 다음 결론 수정을 revision으로 남길 것: always-on app-close 가정 수정, local-only MCP 문서→remote code 수정, generic service 부재→NixOS systemd 존재 추가, legacy replay 보장 철회, relay E2E→push 별도 경계 추가.

## Files Read

전체 85개 main 검토 파일의 pinned URL·라인 범위는 [files-read.md](files-read.md)에 있다. 아래 reference definition은 본문 링크를 고정 commit으로 연결한다.

[desktop-settings]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/desktop/src/settings/desktop-settings.ts#L32-L40
[desktop-main]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/desktop/src/main.ts#L1027-L1072
[quit]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/desktop/src/daemon/quit-lifecycle.ts#L38-L74
[desktop-daemon]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/desktop/src/daemon/daemon-manager.ts#L271-L365
[daemon-instance]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/daemon-instance.ts#L272-L296
[cli-start]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/cli/src/commands/daemon/start.ts#L7-L55
[cli-launch]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/cli/src/commands/daemon/local-daemon.ts#L43-L71
[cli-stop]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/cli/src/commands/daemon/stop.ts#L13-L22
[cli-daemon]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/cli/src/commands/daemon/index.ts#L1-L32
[supervisor-entry]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/scripts/supervisor-entrypoint.ts#L105-L184
[supervisor]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/scripts/supervisor.ts#L415-L469
[worker]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/daemon-worker.ts#L157-L198
[bootstrap]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/bootstrap.ts#L1969-L2030
[restart]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/restart-recovery/index.ts#L9-L82
[config]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/config.ts#L305-L346
[nixos]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/nix/module.nix#L223-L285
[nix-package]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/nix/package.nix#L130-L143
[flake]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/flake.nix#L63-L69
[docker]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/public-docs/docker.md#L9-L62
[lifecycle]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/agent-lifecycle.md#L5-L78
[agent-contract]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/agent-sdk-types.ts#L690-L747
[providers]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/provider-registry.ts#L145-L229
[claude-spawn]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/providers/claude/query.ts#L1-L117
[codex-startup]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/providers/codex/app-server-startup.ts#L61-L125
[supported-providers]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/public-docs/supported-providers.md#L13-L41
[mcp-server]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/mcp-server.ts#L1-L52
[tool-policy]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/paseo-tool-policy.ts#L1-L29
[tools]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/tools/paseo-tools.ts#L710-L806
[delivery]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/agent-messages/delivery.ts#L1-L192
[prompt]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/agent-prompt.ts#L36-L80
[finish]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/finish-subscriptions/index.ts#L16-L75
[finish-observation]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/finish-subscriptions/internal/observation.ts#L20-L59
[orchestration-doc]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/public-docs/orchestration.md#L15-L56
[orchestration-workflows]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/public-docs/orchestration-workflows.md#L45-L80
[mcp-doc]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/public-docs/mcp.md#L92-L96
[host-doc]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/connected-hosts.md#L1-L107
[host-operations]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/host-operations/index.ts#L225-L299
[host-runtime]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/app/src/runtime/host-runtime.ts#L2112-L2147
[selection]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/app/src/utils/connection-selection.ts#L1-L50
[session-store]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/app/src/stores/session-store.ts#L65-L89
[worktree-service]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/paseo-worktree-service.ts#L70-L150
[worktree-archive]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/workspace-archive-service.ts#L441-L531
[worktree-doc]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/public-docs/worktrees/index.md#L13-L45
[security]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/SECURITY.md#L16-L59
[security-public]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/public-docs/security.md#L24-L53
[connectivity]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/public-docs/connectivity.md#L11-L72
[pair-offer]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/pairing-offer.ts#L14-L73
[connection-offer]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/connection-offer.ts#L30-L51
[daemon-key]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/daemon-keypair.ts#L16-L68
[pair-cli]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/cli/src/commands/daemon/pair.ts#L60-L93
[pair-scan]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/app/src/hosts/add-host/internal/scan.tsx#L122-L143
[pair-model]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/app/src/hosts/add-host/internal/pair-scan-model.ts#L35-L103
[relay-security-doc]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/relay-endpoint-security.md#L1-L88
[secure-channel]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/relay/src/secure-channel.ts#L149-L215
[relay-client]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/client/src/daemon-client-relay-e2ee-transport.ts#L83-L154
[relay-daemon]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/relay-transport.ts#L162-L182
[relay-runtime]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/relay-runtime.ts#L31-L74
[ssh]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/client/src/node/ssh-tunnel.ts#L28-L92
[ssh-args]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/protocol/src/ssh-transport.ts#L47-L82
[auth]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/auth.ts#L24-L36
[admission]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/session-admission-auth.ts#L1-L32
[authorization]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/authorization/index.ts#L23-L55
[ws-server]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/websocket-server.ts#L1126-L1145
[client]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/client/src/daemon-client.ts#L2244-L2322
[timeline-subscription]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/client/src/timeline-subscription/index.ts#L1-L75
[timeline-plan]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/app/src/timeline/timeline-sync-plan.ts#L1-L108
[timeline-doc]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/timeline-sync.md#L3-L83
[receipts]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/message-receipts/index.ts#L1-L81
[creation-server]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/creation/index.ts#L49-L123
[creation-client]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/client/src/creation/index.ts#L97-L107
[session]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/session.ts#L8835-L8945
[protocol-doc]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/protocol-compatibility.md#L3-L53
[attention]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent-attention-policy.ts#L1-L80
[push]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/push/push-service.ts#L1-L109
[push-index]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/push/index.ts#L1-L45
[push-subscriptions]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/app/src/push-notifications/internal/subscriptions.ts#L1-L102
[push-native]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/app/src/push-notifications/index.native.ts#L1-L12
[notification]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/protocol/src/agent-attention-notification.ts#L178-L212
[notification-doc]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/notifications.md#L18-L71
[license]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/LICENSE#L1-L15
[client-package]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/client/package.json#L1-L62
[protocol-package]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/protocol/package.json#L1-L49
[relay-package]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/relay/package.json#L1-L52
[server-package]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/package.json#L1-L56

[persisted-config]: https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/persisted-config.ts#L380-L395

# Paseo 원본 코드 재사용 실행표

2026-11-09 사용자 교정: “미련하게 맨땅에서 다 새로 개발하려고 하지 말고 재활용할만한거 싹 다 재활용해서 효율적으로 작업해보자”. `decision-ad213a131da97ba4c7079eeaca47430ffd819ae80f1963b5d546c71559fcbe6c`.

기존 25개 통합 목적을 유지한다. 아래 모듈은 원본 코드 묶음과 기존 테스트를 가져오고 Workbench 연결 부분을 작성한다. 원본 기능의 별도 재구현을 기본값으로 삼지 않는다. 이미 완성한 Workbench 기능은 그대로 활용한다.

## 고정 원본과 반입 방식

- [Paseo 원본](https://github.com/getpaseo/paseo/tree/1fff127f45b11c1c9c573fbbd12791673004c912), commit `1fff127f45b11c1c9c573fbbd12791673004c912`. 기존 조사와 동일한 판이다.
- 전체 source archive SHA-256: `654e4c066977b773a36eabb80a3d231942f36b0287cad8b3d3ca1aaa486cdd7b`.
- [LICENSE](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/LICENSE): Paseo 코드 Apache-2.0, 포함된 third-party 코드는 해당 고지 유지. 수정 파일과 출처·hash를 기록하고 배포 라이선스에 포함한다.
- 전체 source는 등록된 work의 evidence에 보관한다. 제품에는 사용하는 모듈과 닫힌 의존 묶음만 반입한다. upstream 설치/출시 hook은 실행하지 않는다.
- 원본 소스·fixture·테스트를 보존한다. 패키지에 필요한 1회 준비와 연결 확인을 하고, 기존 통과 확인과 production/설치본 빌드를 반복하지 않는다.

## 원본에서 가져올 묶음

경로는 위 Paseo commit 기준이다. ‘원본 확인’은 실제 Workbench 연결 완료와 다르다.

| 단위 | 가져올 원본 모듈 | Workbench에서 작성할 연결 | 현재 단계 |
|---|---|---|---|
| U17 보안 전송 | `packages/relay` 전체: `/e2ee`, Noise handshake, 암호화 record·chunk, 전송 종료 | host/client protected 모드 endpoint API 작성. 실제 listener·기기 등록·command 권한 연결은 다음 단계 | 원본 반입 및 endpoint 연결 코드 완료; 8개 집중 확인 통과 |
| U17 연결 입구 | 서버 `websocket/{secure-relay-ingress,encrypted-relay-socket,physical-socket}.ts`, `relay-transport.ts`; keypair/pairing/connection-offer | `admitSecuredRelaySocket`의 `attach`, `startRelayTransport`의 `attachSocket`에 기존 기기·workspace·세션 권한 확인 연결 | 원본·연결 지점 확정 |
| U17–U18 다기기·모바일 | `packages/protocol`, `packages/client` 전체 state machine; 앱 `runtime/host-runtime.ts`, `hosts/add-host/internal/{scan.tsx,pair-scan-model.ts,pair-link-modal.tsx}`, `data/daemon-pairing.ts`, 확인 sheet·플랫폼별 storage/transport | `openPairScan`의 `importConnectionLink/onConnected`부터 연결. HostRuntime의 stores/query/timeline 의존 묶음과 현재 snapshot/task/receipt 변환을 함께 반입 | 원본·의존 묶음 확정; 실제 모바일 연결 남음 |
| U19 원격 알림 | 서버 `push/{index,push-service,token-store}.ts`, private-files; 앱 `push-notifications/`, notification-open model; protocol attention/deeplink | 원본 `deliver/now/filePath`에 기존 attention 정책·승인된 item ID·설치별 push 설정 연결 | 원본·연결 지점 확정 |
| U20 원격 터미널 | protocol terminal frame/subscription, client stream router; 앱 `terminal/runtime/terminal-stream-controller.ts` 및 원본 web/native emulator; 서버 `src/terminal/` 묶음 | `observeTerminal/sendTerminalInput` 포트, 기존 PTY·workspace 수명 연결. 원본 xterm/node-pty 버전 묶음 유지 | 원본·의존 묶음 확정 |
| U22 받아쓰기 | 앱 `dictation/dictation-stream-sender.ts`, 서버 `dictation/dictation-stream-manager.ts` | start/chunk/ACK/finish/cancel 메시지를 연결하고 현재 Composer draft/generation에 적용 | 원본 확인 |
| U22 녹음·재생·음성 엔진 | 앱 `audio/audio-engine.web.ts`, `audio/playback.ts`, `audio/pcm/`; 서버 `speech/` provider/runtime/worker/model-library | Tauri/Web 환경 판별, 원본 `forkWorker` 주입점에 소유 프로세스 수명 연결, 명시적 모델 다운로드 | 원본 확인 |
| U23 플러그인 | `packages/plugin` SDK; 서버 `plugins/manifest.ts`, `compiler-build.ts`, `plugin-process.ts`, `runtime.ts`, `index.ts` | `readPluginManifest`부터 가져오고 `PluginServiceDependencies.runtime`에 기존 grant/hash/workspace 제어 연결 | 원본 확인 |
| U24 Hub 연결 | 서버 `hub/relationship-controller.ts`, `relationship-remote.ts`, `relationship-retry.ts`; CLI `commands/hub/hub-client/` | 원본 HTTP/relationship client와 `attachSocket/updateAttachedPermissions/createExecutionAgents`를 기존 identity/명령에 연결 | 원본 확인; Cloud consumer는 이 저장소에 없음 |
| U05 이미지 표시 | 앱 `components/markdown/image-decoding.ts` | 현재 인증된 media/Blob URL에 원본 decoder와 DOM Image.decode를 연결 | 실제 Attachments 화면 코드 적용; 기존 media cache 2개 통과 |
| U05 이미지 획득·대화 복사 | 앱 `assistant-image/{acquisition-cache,file-acquisition}.ts`, `assistant-selection-copy/content.web.ts`와 `markup.ts`/clipboard | 현재 immutable image capture·파일 해시·byte budget, 기존 채팅 DOM을 원본 포트에 연결 | 원본 확인 |

서버 경로의 `server/`는 `packages/server/src/server/`, 앱 경로는 `packages/app/src/`를 뜻한다. 서버 내부 파일은 공개 npm subpath가 아니므로 고정 source subtree를 반입한다.

## 첫 직접 반입 결과

- `vendor/paseo/relay/`는 원본 30개 파일을 유지하며 manifest만 조정했다. source tree SHA-256과 변경 이력은 `vendor/paseo/provenance.json`에 있다. 원본 암호화 로직은 수정하지 않았다.
- `apps/host/src/devices/secure-channel.ts`와 `packages/client/src/secure-channel.ts`는 원본 `/e2ee`를 사용하는 얇은 endpoint API다. 원본 Noise 7개와 Workbench protected channel 연결 1개를 한 번 실행해 통과했다. 실제 네트워크 listener·기기 등록·모바일 제품 연결은 아직이다.
- `apps/web/src/components/Attachments.tsx`는 원본 image decoder를 사용한다. 기존 인증·immutable media ID·Blob 수명은 유지한다. 기존 media cache 2개와 web 타입 확인을 한 번 통과했으며 native 화면 사용 확인을 뜻하지 않는다.
- 필요한 relay standalone JavaScript/declaration 26개를 한 번 생성했다. 루트·web TypeScript가 통과했다. production 앱·설치본·CI 빌드는 실행하지 않았다.
- 원본 및 runtime dependency 라이선스·변경 고지를 `third_party/paseo/`에 넣고 Tauri 배포 resource에 연결했다.

다음 반입 순서는 U17 기기 승인·relay 입구 → U18 원본 client/protocol·pairing 화면 → U19/U20 push·terminal 묶음 → U22/U23/U24 원본 실행 묶음이다. 각 단위의 이미 통과한 확인은 재사용하고 전체 연결 뒤 통합 빌드를 진행한다.

## 구체적으로 남는 연결

- Relay 암호화는 기기 인증을 대신하지 않는다. 기존 command/receipt와 workspace별 권한을 원본 입구에 연결한다. 원본 모바일 client의 서버 protocol을 일부 함수 이름만 바꾸어 호환됐다고 표시하지 않는다.
- 플러그인의 원본 `bundle-evaluator.ts`는 global eval과 `nodeRequire`를 사용한다. SDK·manifest·컴파일러·lifecycle은 재사용하고 현재 계획의 broker 권한 경계는 별도 연결한다.
- [원본 Hub 문서](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/hub.md)는 consumer가 Paseo Cloud에 있음을 명시한다. 공개된 daemon/CLI client를 재사용하며, GitHub/Slack/Discord ingestion 서버가 이 source에 있다고 가정하지 않는다.
- 원본 local speech 모델 목록에 한국어 STT는 있고 한국어 local TTS는 없다. 기존 provider 연결을 재사용하면서 모델 지원 범위를 실제 목록대로 표시한다. 다운로드 기본 활성화 설정은 Workbench의 명시적 선택에 연결한다.
- 기존 media API의 인증·파일 해시·URL 수명을 유지한다. 원본 이미지 helper를 도입하며 별도 자료 저장소나 자동 외부 URL 수집을 만들지 않는다.

## 근거

이번 재사용 전환·첫 반입: `research:rr-79110658024cdb4797375aa15a22a771:413d49e0d715c8db9687a0b1a48c6669ad100f71a9fdf72b13a250ecf0fc6a03` (R1–R6).

기존 Paseo 조사: `research:rr-b3a4efd5af5ac21ca608ac4ce17dd71d:89fcdaee6e62df01c31f9f4c56c19d9916acab297f64b1b42cd5b67317e03ad5` (R1–R5).
기존 통합 계획: `research:rr-0b42f53d2a049398bbf5a5c07c18266f:3c3cbe2fbb6979b57bafcbc9851e54112d02ea4662f7afc6c9fc48b81c2335b0`.
현재 사용자 교정은 과거 구현 방식 권고보다 우선한다. 이 문서는 전체 기능이나 모바일 사용 완료 선언이 아니다.

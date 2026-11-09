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
| U17 보안 전송 | `packages/relay` 전체: `/e2ee`, Noise handshake, 암호화 record·chunk, 전송 종료 | host/client protected 모드 endpoint API와 실제 listener 연결 | 원본 반입·실제 두 클라이언트 암호화 통신 구현 |
| U17 연결 입구 | 서버 `websocket/{secure-relay-ingress,encrypted-relay-socket,physical-socket}.ts`, `relay-transport.ts`; keypair/connection-offer/private-files | `admitSecuredRelaySocket`과 `startRelayTransport`에 기기 승인·프로젝트 권한·기존 HTTP/event를 연결 | 원본 의존 묶음 반입, listener·QR 제안·승인·범위 제한·철회 코드 구현 |
| U17–U18 다기기·모바일 | `packages/protocol`, `packages/client` 원본 보존; protected transport·offer parser·reconnect delay 사용. 앱 pairing/runtime/storage 원본은 후속 | Workbench 기존 snapshot/task/receipt·대화 UI를 원본 전송에 연결. 세션 자격증명·호스트별 화면 상태·첨부 범위 적용 | 기기 연결·Tauri keyring·모바일 사진/카메라/공유/IME 코드 연결. QR scan·실기기 확인 남음 |
| U19 원격 알림 | 서버 `push/{index,push-service,token-store}.ts`, private-files; 앱 `push-notifications/`, notification-open model; protocol attention/deeplink | 원본 `deliver/now/filePath`에 기존 attention 정책·승인된 item ID·설치별 push 설정 연결 | 원본·연결 지점 확정 |
| U20 원격 터미널 | protocol terminal frame/subscription, client stream router; 앱 `terminal/runtime/terminal-stream-controller.ts` 및 원본 web/native emulator; 서버 `src/terminal/` 묶음 | `observeTerminal/sendTerminalInput` 포트, 기존 PTY·workspace 수명 연결. 원본 xterm/node-pty 버전 묶음 유지 | 원본 controller/emulator/headless·기존 PTY 연결. 전체 웹앱/WebSocket proxy·실제 모바일 입력 남음 |
| U22 받아쓰기 | 앱 `dictation/dictation-stream-sender.ts`, 서버 `dictation/dictation-stream-manager.ts` | start/chunk/ACK/finish/cancel 메시지를 연결하고 현재 Composer draft/generation에 적용 | 실제 host/Composer 연결, 취소·지연 결과 분리 구현 |
| U22 녹음·재생·음성 엔진 | 앱 `audio/audio-engine.web.ts`, `audio/playback.ts`, `audio/pcm/`; 서버 `speech/` provider/runtime/worker/model-library | Tauri/Web 환경 판별, 원본 `forkWorker` 주입점에 소유 프로세스 수명 연결, 명시적 모델 다운로드 | 원본 녹음·PCM·provider·worker·다운로더 연결; native 모델·실기기 확인 남음 |
| U23 플러그인 | `packages/plugin` SDK; 서버 `plugins/manifest.ts`, `compiler-build.ts`, `plugin-process.ts`, `runtime.ts`, `index.ts` | `readPluginManifest`부터 가져오고 `PluginServiceDependencies.runtime`에 기존 grant/hash/workspace 제어 연결 | 원본 compiler/runtime와 실제 QuickJS 실행, 관리·화면·업데이트 연결 |
| U24 Hub 연결 | 서버 `hub/relationship-controller.ts`, `relationship-remote.ts`, `relationship-retry.ts`; CLI `commands/hub/hub-client/` | 원본 HTTP/relationship client와 `attachSocket/updateAttachedPermissions/createExecutionAgents`를 기존 identity/명령에 연결 | 공개 consumer 부재를 기존 TaskService/SQLite로 보완; 원본 outbound relationship/retry/execution·OS vault·UI 코드 연결 |
| U05 이미지 표시 | 앱 `components/markdown/image-decoding.ts` | 현재 인증된 media/Blob URL에 원본 decoder와 DOM Image.decode를 연결 | 실제 Attachments 화면 코드 적용; 기존 media cache 2개 통과 |
| U05 이미지 획득·대화 복사 | 앱 `assistant-image/{acquisition-cache,file-acquisition}.ts`, `assistant-selection-copy/content.web.ts`와 `markup.ts`/clipboard | 현재 immutable image capture·파일 해시·byte budget, 기존 채팅 DOM을 원본 포트에 연결 | 원본 확인 |

서버 경로의 `server/`는 `packages/server/src/server/`, 앱 경로는 `packages/app/src/`를 뜻한다. 서버 내부 파일은 공개 npm subpath가 아니므로 고정 source subtree를 반입한다.

## 첫 직접 반입 결과

- `vendor/paseo/relay/`는 원본 30개 파일을 유지하며 manifest만 조정했다. source tree SHA-256과 변경 이력은 `vendor/paseo/provenance.json`에 있다. 원본 암호화 로직은 수정하지 않았다.
- `apps/host/src/devices/secure-channel.ts`와 `packages/client/src/secure-channel.ts`는 원본 `/e2ee`를 사용하는 얇은 endpoint API다. 원본 Noise 7개와 Workbench protected channel 연결 1개를 한 번 실행해 통과했다. 실제 네트워크 listener·기기 등록·모바일 제품 연결은 아직이다.
- `apps/web/src/components/Attachments.tsx`는 원본 image decoder를 사용한다. 기존 인증·immutable media ID·Blob 수명은 유지한다. 기존 media cache 2개와 web 타입 확인을 한 번 통과했으며 native 화면 사용 확인을 뜻하지 않는다.
- 필요한 relay standalone JavaScript/declaration 26개를 한 번 생성했다. 루트·web TypeScript가 통과했다. production 앱·설치본·CI 빌드는 실행하지 않았다.
- 원본 및 runtime dependency 라이선스·변경 고지를 `third_party/paseo/`에 넣고 Tauri 배포 resource에 연결했다.

## 실제 기기 연결 코드 추가

- `vendor/paseo/{client,protocol,server}`에 원본 client/protocol source와 필요한 server 전송 의존 묶음을 보존했다. 원본 보호 전송·offer 해석·keypair·private writer·relay 재접속을 사용한다. server type import 하나를 원본 interface 추출로 연결하고 client backoff 계산을 원본에서 추출했다. runtime 암호화 알고리즘을 새로 작성하지 않았다.
- `DeviceService`는 기존 localhost API와 별도인 선택적 listener를 소유한다. 기본은 꺼짐이다. QR/링크의 일회용 제안, 동일 암호화 연결에서의 claim, PC에서 확인번호 비교·프로젝트·권한 승인, 해시로만 저장하는 credential registry를 기존 host에 연결했다.
- `DeviceGateway`는 승인된 프로젝트의 snapshot·대화·task receipt·이벤트·문서/첨부·터미널 요청을 기존 handler로 전달한다. 전역 관리 API를 공개하지 않는다. 기존 로컬 owner token은 이 PC 내부 전달에만 사용하며 원격 연결에는 보내지 않는다.
- `RemotePeer`는 원본 WebSocket/E2EE에 Workbench의 요청·응답·이벤트 계약을 연결한다. 재접속은 인증과 이벤트 구독을 복구하고 변경 요청은 자동 재실행하지 않는다. 결과를 모르는 변경 요청은 기존 receipt 조회 흐름으로 넘긴다.
- 상단 기기 연결 화면, PC별 저장 목록·연결 해제·철회, 연결할 PC의 승인 화면을 기존 App에 연결했다. 원격 이미지 ID와 화면 설정은 호스트별로 구분한다. 첨부 업로드는 해당 Composer/문서의 workId를 직접 전달하고, pending 첨부의 기기·프로젝트 소유와 실제 대화 참조를 확인한다.
- client/protocol의 모든 source를 보존했지만 전체 Paseo `DaemonClient`, 앱 `HostRuntime`, Expo 화면·native 저장소를 연결한 것은 아니다. upstream archive에도 없는 generated AOT validator를 임의로 만들지 않고 필요한 transport/protocol closure만 standalone emit했다. 기존 Workbench API를 버리고 별도 Paseo DB/세션을 만드는 방식은 사용하지 않았다.
- 실제 loopback 두 클라이언트에서 등록·승인·인증·프로젝트 제한·철회 독립성, 소켓 재접속·이벤트 replay·epoch/gap resync 2개 통합 시나리오가 통과했다. registry 8개, 연결 UI/저장소 5개 및 host/web 타입 확인도 통과했다. 후속 첨부는 media 권한 3개와 새 network 1개가 통과했다. 이전 relay/이미지/네트워크 검사는 반복하지 않았다.

원본 의존 패키지 준비 외 앱·설치본·CI 빌드는 실행하지 않았다. 당시 다음 연결이던 U18 native 저장소·모바일 입력, U19/U20 push·terminal, U22–U24 원본 실행 묶음은 아래 후속 기록과 최신 STATUS에 갱신했다. 이미 통과한 확인은 재사용하고 전체 기능 연결 뒤 통합 빌드를 진행한다. 사용법과 정확한 한계는 [기기 연결](../../remote-connections.md)에 기록했다.

## 구체적으로 남는 연결

- Relay 암호화에 더해 기기별 Workbench 인증·권한을 연결했다. Tauri native 자격증명 코드는 연결했으며 실제 외부 relay/휴대폰/OS keyring 사용 확인은 남아 있다. 원본 모바일 client의 서버 protocol과 호환됐다고 표시하지 않는다.
- 플러그인의 원본 `bundle-evaluator.ts`는 global eval과 `nodeRequire`를 사용한다. SDK·manifest·컴파일러·lifecycle은 재사용하고 현재 계획의 broker 권한 경계는 별도 연결한다.
- [원본 Hub 문서](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/hub.md)는 consumer가 Paseo Cloud에 있음을 명시한다. 공개된 daemon/CLI client를 재사용하며, GitHub/Slack/Discord ingestion 서버가 이 source에 있다고 가정하지 않는다.
- 원본 local speech 모델 목록에 한국어 STT는 있고 한국어 local TTS는 없다. 기존 provider 연결을 재사용하면서 모델 지원 범위를 실제 목록대로 표시한다. 다운로드 기본 활성화 설정은 Workbench의 명시적 선택에 연결한다.
- 기존 media API의 인증·파일 해시·URL 수명을 유지한다. 원본 이미지 helper를 도입하며 별도 자료 저장소나 자동 외부 URL 수집을 만들지 않는다.

## 근거

후속 기기 연결·첨부: `research:rr-79110658024cdb4797375aa15a22a771:39c50e6924caa7e9e0aed55dc8c114f195c9f46bea75d2ad71b54ecb8fbadbf4` (R7–R12).

이번 재사용 전환·첫 반입: `research:rr-79110658024cdb4797375aa15a22a771:413d49e0d715c8db9687a0b1a48c6669ad100f71a9fdf72b13a250ecf0fc6a03` (R1–R6).

기존 Paseo 조사: `research:rr-b3a4efd5af5ac21ca608ac4ce17dd71d:89fcdaee6e62df01c31f9f4c56c19d9916acab297f64b1b42cd5b67317e03ad5` (R1–R5).
기존 통합 계획: `research:rr-0b42f53d2a049398bbf5a5c07c18266f:3c3cbe2fbb6979b57bafcbc9851e54112d02ea4662f7afc6c9fc48b81c2335b0`.
현재 사용자 교정은 과거 구현 방식 권고보다 우선한다. 이 문서는 전체 기능이나 모바일 사용 완료 선언이 아니다.

## 음성·실행 확장·사건 consumer 연결

원본 음성 60파일과 앱 audio/dictation, 원본 plugin SDK와 server compiler/lifecycle를 실제 서비스에 연결했다. 원본 전체 daemon을 대체한 것이 아니며 Workbench 세션·Workspace·권한을 adapter로 연결한다. 공개 Cloud consumer 부재는 기존 작업 접수 journal로 보완했다. 3묶음 서비스/화면·확장 배포파일 연결과 집중 동작을 마쳤고, 실기기·native 모델·외부계정과 전체 릴리즈는 남는다. 원본 outbound Hub client는 아래 후속에서 코드로 연결했다. [구현과 사용 범위](../../voice-extensions-events.md).

연구 근거: `research:rr-79110658024cdb4797375aa15a22a771:ec68d100c4776b2219a705303a379cc524ae2c83caca88c7c9c2f1d9b6c805b5` (R13–R18).
# U20 후속 연결

원본 terminal controller/emulator/headless/serializer/key/resize 모듈을 기존 Workbench PTY·출력 journal·기기 권한에 연결했다. HTTP 서비스 요청/응답·모바일 보조 키·로그 검색을 추가했다. 실제 Rust PTY/휴대폰 화면·IME는 확인 전이다. 전체 웹앱/WebSocket 프록시는 아래 최종 연결에서 원본을 재사용했다. 원본·의존 라이선스와 변경점은 `vendor/paseo/terminal/source.json`, `third_party/paseo/terminal-provenance.json`을 따른다.

연구 판: `research:rr-79110658024cdb4797375aa15a22a771:5022f016cc6d75dca4b7a945152a47b5d20edf53e2f4fad70e4c778150fe3606` (R19–R20). 사용자 교정 뒤 추가 통과 검사 반복·전체 타입·Rust·앱 빌드를 시작하지 않았다.

## 지속 실행·모바일·Hub 후속 연결

원본 `mobile-web`의 IME/file/viewport/download helper, `push`의 token lease/store, `server/hub`의 relationship/remote/retry/execution을 연결했다. Workbench의 기존 첨부·대화 초안·TaskService·권한·OS vault를 사용한다. runtime package export용 selected emit 한 번은 성공했으며 앱/설치본 빌드나 실기기 확인을 뜻하지 않는다. 출처는 `third_party/paseo/{mobile-web,push,hub}`. 최신 범위는 [상태표](STATUS.md)를 따른다.

근거: `research:rr-a19bb59ee9cc2a51ca502509a421c7ac:de8443305abef0bb31264f43cf9032da8b79f5b654405db7645114dc0c13e3b4` (R1–R6). 브라우저 credential은 아직 session-only이며 Hub Cloud 서비스는 공개 원본에 없다. 원본 API를 이용하는 outbound client와 기존 signed ingress는 연결했으며 실제 계정 연결은 실행하지 않았다.

## 마지막 연결 묶음

원본 service-proxy 전체, ClaudeTaskProtocolSource·하위 task lifecycle, onboarding model·pair scan model을 반입했다. 원본 bytes/hash/Apache 고지는 보존하고 Workbench의 기존 service ownership·TaskService·설정·기기 승인 포트에 연결했다. 서비스 proxy의 유일한 원본 runtime 변경은 WebSocket forwarded protocol을 승인된 adapter 값으로 전달하는 것이다. 새 Express/jsQR runtime dependency 고지는 `third_party/paseo/service-preview`에 있다.

- U06 실제 공급자 child identity와 현재 generation/turn별 제어·개별 대화·receipt 연결. Claude SDK에 없는 직접 child 메시지는 지원한다고 표시하지 않는다.
- U11 기존 설정/파일·앱 등록 경로를 원본 온보딩 단계에 연결.
- U17–18 원본 scan model과 웹 카메라/QR 파일 platform adapter 연결.
- U20 원본 HTTP/WebSocket을 별도 서비스 origin에 연결. 공개 preview base는 원본과 같은 wildcard HTTPS 설정 경로이며 relay-only 전체 웹앱 tunnel이 아니다.

Host/web 타입과 새 loopback proxy 경계 1개를 통과했고 전체 통합 build 단계로 이동했다. 실제 설치·OS·기기 완료 선언은 아니다.

최종 연결·통합 빌드 근거: `research:rr-8b1de8f70ac6198a1f734b3f63b45bcb:046ce54f184df15eb9eeb09a64d3c751434bb5ad388abf6c0623b51526362629` (R1–R8).

# v0.15.3 한정 대조

- 릴리즈: v0.15.3, published 2026-11-06T16:02:49Z (부모가 확보한 GitHub release metadata). commit `d91ae138cb931447635e94296023414a58bedcc5`.
- 연구 main: `1fff127f45b11c1c9c573fbbd12791673004c912`. main과 release는 분기되어 있으므로 main 전체 기능을 설치 릴리즈 기능으로 간주하지 않는다.
- 아래 7개 파일만 raw source를 추가 취득하여 비교했다. package 설치·실행·native E2E 없음. hash/line count는 [release-manifest.json](release-manifest.json).

| 고정 release URL / 읽은 범위 | main 대조 | SHA-256 |
|---|---|---|
| [packages/desktop/src/settings/desktop-settings.ts:32-40,209-224](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/packages/desktop/src/settings/desktop-settings.ts#L32-L40) | byte-identical | `41dc47324766e15d2197e50df7f6a22076b123df771c50c500b890e0f8a924c6` |
| [packages/desktop/src/daemon/quit-lifecycle.ts:38-74,118-156](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/packages/desktop/src/daemon/quit-lifecycle.ts#L38-L74) | byte-identical | `6e38764e0ade63da39e5861ada25aa8f969c7759297f2bc443a2ce33efee1085` |
| [packages/desktop/src/main.ts:1027-1072](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/packages/desktop/src/main.ts#L1027-L1072) | byte-identical | `98e2ad5b2302e7c6aa7195c40adede86e156cdb5be5de8e5387fc1f109e4e577` |
| [docs/relay-endpoint-security.md:1-88](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/docs/relay-endpoint-security.md#L1-L88) | byte-identical | `4cf9e474fbe23b0d268ad7907086a724d7de481dcfdde17a7ef5f9a6e168693a` |
| [packages/relay/src/secure-channel.ts:149-215,260-307,344-378,406-534,627-640](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/packages/relay/src/secure-channel.ts#L149-L215) | different; 한정 비교 | `82baf0c15de951ec574329a61115d87c848ed98dff09b320395f9d9087074ae7` |
| [packages/server/src/server/agent/tools/paseo-tools.ts:709-717](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/packages/server/src/server/agent/tools/paseo-tools.ts#L709-L717) | different; 한정 비교 | `731439f7e406f912a3205b18932f00ff61ca94a3041b32d13877e97caea13e5d` |
| [docs/connected-hosts.md:1-104](https://github.com/getpaseo/paseo/blob/d91ae138cb931447635e94296023414a58bedcc5/docs/connected-hosts.md#L1-L104) | different; 한정 비교 | `0f543ad8cb309b642108fb2579f7e8eb509ddfcdaa8bf4674d34010cfdd49c69` |

## 확인된 범위

1. desktop settings, quit lifecycle, main은 byte-identical이다. 따라서 `keepRunningAfterQuit=false` 기본과 macOS 마지막 창 닫기 / non-Darwin `app.quit()` 분기는 이 릴리즈에도 소스상 존재한다. daemon-manager의 모든 소유권 동작은 release 파일을 별도로 대조하지 않았으므로 main 상세 추적 범위로 남긴다.
2. endpoint-security 문서는 byte-identical이다. legacy replay 제한, protected mode, `requireProtectedSecurity=false` 기본이라는 계약은 release 문서에도 있다. 실제 릴리즈 config loader 전체를 검증한 것은 아니다.
3. secure-channel의 diff는 main의 client close/fail cleanup에서 `notifyClosed()`를 호출하도록 바뀐 부분이다 (release lines 344-378). 보호 프로토콜 계약을 완전히 재감사하거나 cryptographic tests를 실행하지 않았다.
4. release paseo-tools lines 709-717에도 remote host dispatch map 7종이 존재한다: create_agent, create_workspace, list_workspaces, send_agent_prompt, get_agent_status, get_agent_activity, list_agents. 전체 tool 파일은 main과 다르며 나머지 행동의 release 동등성을 주장하지 않는다.
5. connected-hosts 문서는 main에 older-destination retry 및 error reset 관련 설명이 추가되어 있다. release에도 multi-host registry·logical scope·remote operation·mutation unknown outcome 계약은 존재한다. 최신 main의 retry/error 설명을 release 동작으로 자동 승격하지 않는다.

## 남은 경계

이 대조는 특정 우려가 main만의 현상인지 확인하는 정적 조사다. packaged desktop artifact, daemon binary, npm integrity, OS 서비스, 모바일 네트워크, push provider 및 host credential 저장소의 실행 검증은 하지 않았다. 모든 주장에 버전 범위를 유지해야 한다.

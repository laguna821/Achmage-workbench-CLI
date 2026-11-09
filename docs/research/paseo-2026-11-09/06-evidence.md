# 출처·조사 방법·검증하지 않은 범위

## 소스와 릴리즈를 고정했다

| 대상 | 기준 |
|---|---|
| Workbench | `bc1057c2c5fb04f2046f4fd711bf718f5cc93737`, `fix/urgent-usability-033`, 0.3.3 |
| Paseo main | `1fff127f45b11c1c9c573fbbd12791673004c912`, commit 시각 2026-11-09T03:35:39Z |
| Paseo 안정 릴리즈 | v0.15.3, `d91ae138cb931447635e94296023414a58bedcc5`, 게시 2026-11-06T16:02:49Z |
| 확인일 | 2026-11-09, Asia/Seoul |

GitHub commit·전체 tree API와 release metadata를 보존했다. tree는 `truncated: false`, 7,553개 경로다. 이것은 조사한 파일 수가 아니다. 비교 API는 두 이력이 `diverged`, main 방향 ahead 182·behind 24라고 반환했다. 응답의 300개 파일은 전체 변경 목록이라고 가정하지 않았다.

선택한 채팅 7개 파일과 실행·연결 핵심 파일의 릴리즈 사본을 별도로 읽었다. native 목록은 안정판의 inverted FlatList와 main의 LegendList가 달랐다. 종료 설정과 핵심 종료 경로는 대조 범위에서 같았다. 소스가 main에 존재한다는 것과 배포된 앱에서 같은 동작을 검증했다는 것을 구분했다.

## pstack을 조사와 권고 단계에 적용했다

사용자가 지정한 [pstack SKILL.md](</home/achamge/Dropbox/-- ACH_한림대 미디어스쿨/= Ach's Obsidian/Achmage_OS/20_Master-Skills/pstack/SKILL.md>), `ACHMAGE-INTEGRATION.md`, `poteto-mode/SKILL.md`, 공유 `pstack-vibe-coding-default` workflow를 읽었다. 선택한 절차는 Investigation, how, 조사 분업을 위한 swarm, technical-writing, unslop이다.

`multi-phase-plan`도 읽었지만 실행 프로그램으로 활성화하지 않았다. 이번에는 소스 기반 분석과 도입 권고가 산출물이므로 PR 소유자·예약 tick·구현·merge를 시작하지 않는다. 이 때문에 실행 프로그램용 `check-plan.mjs` 통과를 주장하지 않는다. 문서 링크·항목 대응·근거 해시는 별도로 검사한다.

적용한 원칙과 실제 선택은 다음과 같다.

- **Experience First**. 첫 제공 단위를 채팅·이미지·작업 현황으로 잡았다. 모바일 전체 구현 완료까지 체감 개선을 묶어 두지 않는다.
- **Sequence work into verifiable units**. 실행 서버, 기기 연결, 모바일 입력, push를 서로 다른 검증 단위로 나눴다. UI 없는 문서 작업이 확인되기 전 daemon 전체 완료로 표시하지 않는다.
- **Guard the Context Window**. 세 조사 담당에 읽기 범위를 나누고, 파일·줄번호·해시가 있는 결과를 통합했다. 다른 모델의 독립 검증으로 부르지 않는다.

`throughput checkpoint: n/a, read-only investigation`을 작업 기록에 남겼다. 현재 제품 파일과 기존 미커밋 문서는 보존했다.

## 원문 캐시와 조사 메모

캐시 루트는 아래 경로다. 전체 upstream 소스를 제품 저장소에 vendoring하지 않았다.

```text
/home/achamge/.local/state/achmage/workspaces/achmage-workbench-research/
work-1b7f68199bcb4756b2a7fd2a102ccc2e/
branch-c5c46cea4de14900be37b66368fb3909/evidence/paseo-2026-11-09/
```

- `official/`. 공식 Markdown·패키지 메타데이터·LICENSE·변경 기록 40개. URL·시각·SHA256을 보존했다.
- `chat-ux/`. 채팅·Markdown·첨부·스크롤·모바일의 선택 소스와 공식 이미지, 안정판 대조, `notes.md`, `files-read.md`.
- `runtime/`. supervisor·provider·호스트 라우팅·연결·cursor·알림·권한의 선택 소스 85개 읽기 기록, 안정판 대조, `notes.md`, `files-read.md`.
- `workbench/`. 현행 코드 57개 파일의 해시와 읽은 범위, 기능 대응표.
- [synthesis.md](/home/achamge/.local/state/achmage/workspaces/achmage-workbench-research/work-1b7f68199bcb4756b2a7fd2a102ccc2e/branch-c5c46cea4de14900be37b66368fb3909/evidence/paseo-2026-11-09/synthesis.md). 세 조사 결과의 아키텍처 통합 설명. 검토 의견 중 호스트 실행 세대·Office 실행기·기기 연결 순서·Lightpanda의 별도 의존 관계를 최종 설계와 도입 순서에 반영했다.

[sources.json](sources.json)은 중복을 구분한 원본 URL·revision·파일 해시와 로컬 증거 위치를 담는다. 일부 긴 파일은 관련 함수·계약을 읽었으며 파일 전체 보안 감사로 표현하지 않는다.

## 공식 화면은 세 장을 확인했다

| 이미지 | 관찰한 것 | 출처 |
|---|---|---|
| iPhone chat | 한 열 대화·작업 경로·완료 표시·하단 작성창 | [원본](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/assets/store-screenshots/raw/iphone/chat.png) |
| iPad chat | 상태별 작업 목록·대화·변경사항의 분할 | [원본](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/assets/store-screenshots/raw/ipad/chat.png) |
| Apple review | 파일별 diff·변경 수치·파일 이동 표현 | [원본](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/assets/store-screenshots/output/apple/04-review.png) |

제작 README는 scripted demo agent와 staged 작업을 설명한다. Google용 이미지에는 iPhone·iPad 캡처 재사용도 명시되어 있다. 따라서 Android 실기기 검증이나 실제 속도 측정으로 계산하지 않았다. 이미지 안의 테스트 성공 문구도 이번 작업의 테스트 결과가 아니다. 인라인 이미지 출력은 이 화면 세 장이 아닌 소스에서 확인했다. [제작 조건](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/assets/store-screenshots/README.md).

## 문서와 코드가 달랐던 지점

| 쟁점 | 확인한 근거 | 설계에 반영한 내용 |
|---|---|---|
| 종료 뒤 daemon 유지 | [기본 설정](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/desktop/src/settings/desktop-settings.ts), [Quit 처리](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/desktop/src/daemon/quit-lifecycle.ts) | 기본 false, owned instance와 OS별 창 닫기 구분 |
| 원격 MCP | 공용 예시는 local-only로 설명하지만 [connected-hosts](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/connected-hosts.md), [실제 tool catalog](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/agent/tools/paseo-tools.ts)에 `serverId` 지원 | 원격 생성·조회·전송 지원. 모든 mutation이 원격 selector를 지원한다고 확대하지 않음 |
| 서비스 설치 | [NixOS 모듈](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/nix/module.nix)·Docker 예시는 있음 | 일반 Windows·macOS service installer까지 확보됐다고 쓰지 않음 |
| relay 보호 | 공용 보안 설명과 [endpoint-security](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/docs/relay-endpoint-security.md)의 legacy 설명이 다름 | 최신 보호 모드·구버전 호환·서버 강제 설정을 구분. 기본값을 그대로 제품 정책으로 복사하지 않음 |
| push | [PushService](https://github.com/getpaseo/paseo/blob/1fff127f45b11c1c9c573fbbd12791673004c912/packages/server/src/server/push/push-service.ts)는 title/body/data를 Expo에 전송 | relay E2E와 별도 경로. 우리 기본 알림은 간단한 상태와 작업 참조 |
| 기기 지우기 | host 제거·push 해제와 admission 모델을 추적 | 로컬 연결 삭제를 다른 기기의 권한 폐기로 표시하지 않음. 기기별 회수는 우리 도입 조건 |

이는 재사용 경계를 확인한 정적 조사다. 침투 시험·독립 암호 감사·운영 서비스 사고 확인을 수행한 결과는 아니다. 암호 구현을 새로 만드는 대신 검토된 패키지와 버전 계약을 사용하는 방향을 제안했다.

## 선행 연구와 이번 연구를 연결한다

- Aside·Lightpanda·agent-desktop 원문 revision을 다시 읽었다. `research:rr-dd53e234a77f3fe9e4e3afc62aea3018:2807fc5a0c540680000deb85ab0ea25cb53a6ffa89a4c436c9317c7a19b08ea9`.
- Apple HIG 원문 revision을 다시 읽었다. `research:rr-da5ca50fa3e6593f1a243cce69cc5ed7:36aff60113a7574e1b41bb9ce53999de1ae9a325cde9fe73abf3304c122323f7`.
- 이번 researchId는 `rr-b3a4efd5af5ac21ca608ac4ce17dd71d`다. 초기 revision은 `b3400dd3261427a0dce4dba5aff5b6b6b3a0f9c73756b51b6d058c01987c33a0`다.
- 완료 연구 revision은 `89fcdaee6e62df01c31f9f4c56c19d9916acab297f64b1b42cd5b67317e03ad5`이며 `published`, `remoteVerified: true`를 확인했다. 정확한 참조는 `research:rr-b3a4efd5af5ac21ca608ac4ce17dd71d:89fcdaee6e62df01c31f9f4c56c19d9916acab297f64b1b42cd5b67317e03ad5`다. 연구의 confirmed는 조사·권고의 완료이며 제품 구현 완료를 뜻하지 않는다.
- 현재 context는 `context-2aad2c6ccd214b628f1722ab762adacc`다. workId는 `work-1b7f68199bcb4756b2a7fd2a102ccc2e`, nativeSessionId는 `01a187dc-c850-7991-93c0-aa60b50f9a26`다.

R1~R5를 각각 방법·버전, 실행·연결 구조, 채팅·화면, 현행 차이, 통합 권고·검증에 사용했다. 기존 문서의 오래된 정책은 현재 대화의 독립 이음 설치·Dropbox 우선 요구보다 앞세우지 않았다.

## 수집 실패와 변경한 접근

일부 GitHub HTML·공식 웹 페이지를 web 도구가 읽지 못했다. 같은 실패를 반복하는 대신 이미 고정한 commit의 공식 raw 경로로 필요한 파일을 받아 본문과 해시를 확인했다. 일반 문서와 코드가 충돌하는 항목은 양쪽을 보존하고 실제 분기·계약을 우선했다.

연구 기록 첫 호출에서는 `body`를 최상위에 넣어 schema rejection을 받았다. 런타임의 입력 계약을 확인하고 `record.body` 및 필수 배열을 채운 요청은 성공했다. 제품의 실패로 기록하지 않는다.

완료 revision의 첫 호출에서는 `attempts`에 문자열을 넣어 실험 필드 검사를 통과하지 못했다. `validate()`의 필수 필드를 읽고 구조화한 실험 객체로 변경한 요청은 게시·원격 검증에 성공했다.

runtime 수집 목록의 존재하지 않는 경로 두 건은 HTTP 404였다. 수집 성공과 혼동하지 않도록 `sources.json`의 `failedAcquisitions`에 보존했다. 첫 해시 검사기는 모든 항목에 `sha256`이 있다고 가정해 중단됐다. 실제 목록의 성공·실패 구조를 확인한 뒤 실패 응답을 분리해 다시 검사했다.

## 이번 완료와 다음 검증

이번에 완료한 것은 명시된 스킬 적용, 공식 자료·소스·화면 읽기, 현재 제품 대응표, 통합 선택지, 우선순위와 종료 조건 문서화다. 성공한 원본 사본 236개(중복을 제외한 revision·경로 조합 222개), 현행 Workbench 57개, 선택 스킬·workflow 15개의 해시를 대조했다. 파일 수는 성능 시험 수나 전체 보안 감사 범위를 뜻하지 않는다. 문서의 로컬 링크 대상, 고정한 main 소스 경로, F01~F36·P01~P07·E01~E08·PA01~PA18의 정의와 대응도 검사했다. [검사 결과](/home/achamge/.local/state/achmage/workspaces/achmage-workbench-research/work-1b7f68199bcb4756b2a7fd2a102ccc2e/branch-c5c46cea4de14900be37b66368fb3909/evidence/paseo-2026-11-09/validation.json).

Paseo 앱·daemon 설치, 실제 전화 연결, provider 실행, 한국어 모바일 입력, sleep·reboot·push, 성능 벤치마크, Workbench 제품 수정·빌드·릴리즈는 수행하지 않았다. 이 항목은 [PA 완료 기준](05-adoption-plan.md)에 남아 있다.

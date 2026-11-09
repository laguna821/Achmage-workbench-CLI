# Achmage Workbench integrated release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL. 실행 요청 뒤 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans`를 읽고 이 계획을 진행한다. 선택된 실행 방식과 현재 host 권한을 유지한다.
**Goal:** Aside 공유 웹, HIG 전체 UI, Paseo 대화와 모바일 실행을 기존 Workbench에 통합하고 검증한 설치 파일을 GitHub에 전달한다.
**Architecture:** 기존 Node host, Tauri 셸, 세션 저장소와 provider를 유지한다. 작업, artifact, 검색, 알림 계약을 공통으로 확장하고 UI presence와 실행 권한을 분리한다. OS renderer와 Office executor 및 모바일 client는 작은 실증 뒤 확정한다.
**Tech Stack:** Node >=24, TypeScript, React, Vite, Tauri 2, Rust, SQLite, Vitest, 기존 Office renderer와 Fast Find, Codex app-server와 Claude SDK.
**Spec:** [통합 설계](../specs/2026-11-09-workbench-integrated-design.md). 모든 제품 실행 상태는 `NOT_RUN`이다. 목표 `0.4.0`은 2026-11-09 사용자 실행 요청으로 확정했고 현재 소스 기준은 `0.3.3`이다.

## Current execution rule — 2026-11-09 사용자 교정

**남은 기능 구현을 우선하고 전체 기능 연결 뒤 통합 빌드·릴리즈한다.** 기능 몇 개 추가할 때마다 production/설치본 빌드를 끼워 넣지 않는다. 예고한 다음 후보 CI와 U25a 중간 설치본 반복은 중단한다. 아래 원래 계획의 반복 RED/GREEN, 매 U의 독립 리뷰, 10개 live lane, 모든 perf gate는 매 변경마다 다시 수행할 필수 관문이 아니다. 변경 기능 묶음에 필요한 집중 확인을 한 번 하고, 실제 실패로 실행이 막힐 때만 해당 부분을 수정·재확인한다. 이미 확보한 기준판과 테스트는 재사용한다. U01의 검증 기반 확장을 기다리며 제품 구현을 미루지 않는다. 필요한 설치·데이터 보존 검사는 마지막 통합 빌드 경계에서 묶어서 수행하며 미확인 플랫폼을 PASS로 표시하지 않는다. 제품 기능 범위는 유지한다.

근거: 현재 세션의 사용자 원문 “검증하고 또 확인검증하고 이런거 제발 하지마 … 구현을 우선으로 해”, `decision-7287723b7dd57957ec551667abe6ddc8c02067f7f0f0988cb2a44d58b05cd626`. 이 절이 아래 과거 검증 절차와 충돌하면 이 절을 적용한다.

추가 교정: “기능 추가하고 빌드하고 기능 추가하고 빌드하고 그게 맞아? ㅡㅡ; 그게 superpowers 및 pstack식이냐고 아닐거 같은데” — `decision-b10e79c5567f53f7c9dfe5e459933f13cbff1b06242c87566dfbaea9d13d4e63`. 목적별 구현·커밋과 설치본 생성은 별개다. 이미 끝난 두 후보 실행은 과거 증거로만 보존한다.

### Paseo 원본 코드 재사용 우선 — 2026-11-09 추가 교정

사용자 원문: “paseo  보니까  깃허브 보니까  아파치 라이센스던데. 미련하게 맨땅에서 다 새로 개발하려고 하지 말고 재활용할만한거 싹 다 재활용해서 효율적으로 작업해보자”. `decision-ad213a131da97ba4c7079eeaca47430ffd819ae80f1963b5d546c71559fcbe6c`를 적용한다.

남은 단위는 먼저 [원본 모듈 재사용표](../execution/PASEO-REUSE.md)의 package/file 묶음을 가져오고 기존 Workbench 세션·문서·권한·저장소에 연결한다. 아래 과거 `Create`/구현 상세는 필요한 통합 지점을 뜻하며, 이미 Paseo에 있는 기능을 처음부터 작성할 근거가 아니다. 직접 이식 가능한 모듈은 의존 모듈·기존 테스트·라이선스와 함께 가져온다. 새 코드는 Workbench 연결과 원본에 없는 기능에 집중한다. 재사용하지 못하는 부분은 구체적인 소스 부재 또는 인터페이스 차이를 기록하고 해당 연결만 구현한다.

원본 pin은 기존 조사와 같은 `1fff127f45b11c1c9c573fbbd12791673004c912`이다. 별도 third-party 고지와 수정 내역을 보존하며 첫 이식은 `@getpaseo/relay` 보안 전송 패키지다. 원본 패키지의 테스트를 필요한 경계에서 재사용하고 기능마다 production/설치본 빌드를 반복하지 않는다. 이 교정은 25개 목적과 기존 데이터 보존 요구를 유지하면서 구현 방식을 바꾼다.

직접 재사용 전환과 첫 relay·이미지 반입의 근거: `research:rr-79110658024cdb4797375aa15a22a771:413d49e0d715c8db9687a0b1a48c6669ad100f71a9fdf72b13a250ecf0fc6a03` (R1–R6). 후속 원본 client/protocol/server와 실제 listener·기기 승인·기존 API/event·첨부·첫 연결 UI 구현은 `research:rr-79110658024cdb4797375aa15a22a771:39c50e6924caa7e9e0aed55dc8c114f195c9f46bea75d2ad71b54ecb8fbadbf4` (R7–R12). 실제 loopback 두 클라이언트와 추가 첨부 경로가 통과했으며, 외부망·실제 모바일 및 전체 SDK/공식 앱 호환은 남아 있다. 자세한 현재 상태는 실행표를 따른다.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. Check a box only when its evidence exists. 파일, 로그, 화면, 실행 결과와 정확한 SHA를 함께 기록한다.

실행은 Achmage override를 적용한 `pstack/upstream/skills/poteto-mode/playbooks/autopilot-stack.md`를 따른다. 2026-11-09 사용자가 구현부터 GitHub 0.4.0 빌드까지 실행을 요청했다. 목적별 변경을 구현·커밋하고, 전체 요구가 연결된 뒤 통합 빌드와 0.4.0 릴리즈를 진행한다. 원격 변경은 실제 권한과 현재 절차를 따른다.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

[coverage.json](support/coverage.json)의 156개 원본 정의와 [회귀 대응표](support/coverage-notes.md)를 유지한다. HIG `F01`과 Paseo `F01`은 별개다. U 번호는 목적별 변경 경계이고 문서 순서가 실행 순서는 아니다. U09는 U16을 기다린다. U25 설치본 생성은 전체 기능 통합 뒤 수행한다.

열 개 lane은 서로 다른 시나리오다. 열 명의 agent나 열 대의 VM을 의미하지 않는다. `current-session-model`로 순차 또는 제한 병렬 실행하며 root와 최대 3개 owner만 둔다. 같은 모델의 새 문맥 검토를 다중 모델 검증이라고 부르지 않는다.

## Global Constraints

- 기본 Ctrl+K 검색에서는 일치한 각 세션의 사용자 프롬프트 원문과 AI 대화 로그를 문서 및 읽기 전용 볼트 본문 결과보다 먼저 표시한다. 관련도 비교와 그룹/페이지 제한 전에 이 제품 우선순위를 적용하고, 문서에 연결한 AI 답변도 대화 결과에서 사라지지 않게 한다. 명시한 문서/볼트 범위 검색은 유지한다.

- 소스 기준은 `bc1057c2c5fb04f2046f4fd711bf718f5cc93737`과 `0.3.3`이다. 공개 v0.3.3 installer source는 `6108d7894bf919bcdf392cafd3f64c414d50003c`이며 두 SHA를 합치지 않는다.
- 원본 C01부터 C18, X01부터 X03, H01부터 H14, PA01부터 PA18과 모든 E01부터 E08을 유지한다. 후보라는 과거 표현으로 이번 범위를 축소하지 않는다.
- 한글, Word, 슬라이드, 스프레드시트, Markdown, PDF, HTML, 마인드맵, EPUB의 내장 UI와 기존 명령을 모두 이관한다. 문서 내용 서식과 앱 UI 토큰을 분리한다.
- 독립 이음오피스 설치, OS 등록, 같은 파일 열기, 외부 저장, 복귀와 최신 맥락을 보존한다. 외부 앱 자체를 포크하지 않는다.
- Dropbox 우선 연결, Fast Find 원문 prompt와 정확한 검색 위치, 프로젝트 YAML 및 휴먼볼트 읽기 전용을 유지한다. YAML key, scalar/list 형태, empty/unknown 값, 본문 bytes와 원본 링크 및 태그를 바꾸지 않는다.
- 기존 workId, workspaceId, sessionId, nativeSessionId를 보존한다. 같은 URL이나 경로 문자열을 실행 또는 파일 정체성으로 쓰지 않는다. 새 canonical session DB를 만들지 않는다.
- UI presence, task authority, executor와 writer lease를 분리한다. 파일마다 단일 writer와 fencing generation을 적용한다. iframe 의존 작업을 daemon detach만으로 완료 처리하지 않는다.
- p95 사용자 지연 15%, idle/peak 메모리 15%, 설치 크기 10% 증가를 기본 검토 문턱으로 둔다. U01에서 fixture, 기기, build type과 새 기능 absolute budget을 먼저 고정한다. 이것은 측정 결과가 아니다.
- Windows, macOS arm64, Linux 및 현재 niri 환경과 iOS, Android의 실제 증거를 구분한다. 장비나 제어 도구가 없으면 `NOT_RUN_PLATFORM` 또는 `NOT_RUN_DEVICE`이며 PASS가 아니다.
- 기술가설 실증은 최초 90분과 새 증거 또는 가설이 있을 때 45분 추가 한 번을 기본 상한으로 둔다. 전체 기능 구현 기한으로 해석하지 않는다.
- 현재 host 도구와 모델을 쓴다. Grok, cloud workers, 외부 provider, bots, upstream auto-merge, 주기적 loop를 자동 활성화하지 않는다.
- heavy build, render, native 실행은 실제 등록 workId와 nativeSessionId로 resource를 예약하고 stable resource-run으로 수행한다. 기존 앱 프로세스를 채택하거나 일괄 종료하지 않는다.
- 비밀키와 live DB는 로컬에 둔다. 실행 원문, 웹페이지, 보관 대화와 imported skill은 현재 명령이나 권한으로 취급하지 않는다.
- 향후 원격 변경 전 complete local change와 diagnostics를 준비하고 fresh Achmage remoteChangePolicy 및 현재 연결된 도구를 확인한다. 정책에 등록되어 실제 제공되는 runner와 기록 경로를 적용하며 없는 도구를 호출하거나 실행되었다고 가정하지 않는다. unknown 결과는 먼저 관찰한다.
- 별도 E 기능은 선택 사용으로 제공하더라도 구현과 검증 범위에는 포함한다. 첫 빌드, CI green, 업로드, 버전 상승을 전체 완료로 바꾸지 않는다.

## Review Focus

- RF01. 같은 물리 파일을 다른 artifact나 symlink로 열었을 때 늦은 writer가 외부 저장을 덮지 않게 한다. U09의 `rejects_stale_physical_writer`로 고정한다.
- RF02. 두 호스트의 같은 경로와 같은 이름 이미지가 섞이지 않게 한다. U05의 `keeps_image_revision_identity`와 U17의 `rejects_foreign_host_command`로 고정한다.
- RF03. 절전 또는 응답 유실 직후 재전송이 provider나 외부 행동을 두 번 시작하지 않게 한다. U06의 `keeps_unknown_receipt`와 U17의 `reconciles_epoch_change`로 고정한다.
- RF04. 한글 IME 조합 중 탭 이동, 이미지 decode, 키보드 높이 변경이 입력과 읽는 위치를 잃게 하지 않는다. U04의 `preserves_reading_anchor`와 U18의 실제 IME lane으로 고정한다.
- RF05. 사용자 설치 데이터, 폰 키, 웹 프로필, writer 상태를 새 패키지가 잃지 않게 한다. U25의 `rejects_unaccepted_artifact`와 실제 v0.3.3 upgrade lane으로 고정한다.

## Program checklist

### Arm the program

- [ ] 계획과 spec 및 coverage를 함께 유지한다. 2026-11-09 실행 요청에 따라 제품 구현을 시작하며 실제 증거가 생긴 항목만 상태를 갱신한다.
- [ ] 실행 시작에 `git show origin/main:package.json`과 실제 기본 branch의 관련 파일을 읽고 base SHA를 기록한다. OS에 등록된 선택 스킬의 정확한 revision과 Achmage override를 다시 읽는다. 저장소에 없는 pstack 파일을 trunk에 있다고 가정하지 않는다.
- [ ] `/loop 1h`는 `NOT ARMED`로 기록한다. 미래의 명시적인 예약 요청 없이는 켜지 않는다. 수동 checkpoint의 status message에는 새로 확인한 변경과 미검증 범위만 보고한다.
- [ ] 실증 시작 전 architecture gate의 입력, expected, 시간 상한, 자원 lease를 적는다. 원문과 관찰이 다르면 기존 연구 R 라벨의 새 revision에 기록한다.
- [ ] 중단 요청이 오면 owner에게 쓰기 중단을 전달하고 소유 자원과 미완료 증거를 보존한다.

### Spawn owners

- [ ] root와 최대 3개 owner를 유지한다. 현재 모델만 쓴다. U01 뒤 U02, U06, U12 탐색은 독립으로 진행할 수 있다.
- [ ] [coverage의 executionGraph](support/coverage.json)을 실행 순서로 사용한다. units.dependsOn은 해당 U의 완료 의존을 뜻한다. U25의 예외는 U25a가 U01 뒤 시작하고 U25b가 U01부터 U24 완료를 기다리는 것이다.
- [ ] `App.tsx`, `main.ts`, `lib.rs`, contracts entry, 전역 CSS는 한 owner가 통합한다. 다른 owner는 독립 파일과 작은 연결 패치를 전달한다.
- [ ] 독립 목적은 base branch에서 시작한다. 실제 interface 의존이 있는 변경만 부모 branch에 쌓는다. 기존 사용자 worktree와 미커밋 파일을 보존한다.
- [ ] UI나 설치 흐름을 바꾸는 단위는 screenshot과 video를 operator에게 제시한다. 장비 없는 상태를 검토 완료로 표시하지 않는다.

### PR mechanics, for every PR

- [ ] 실행 시 연결된 GitHub 도구 또는 검증한 `gh` 경로를 선택한다. PR 소유자, base, exact head, 해당 U와 원본 ID를 기록한다. draft/ready는 실제 준비 상태와 요청을 따른다.
- [ ] 관련 단위 테스트, `npm run typecheck`, 필요한 빌드와 현재 lint 경로를 확인한다. 존재하지 않는 `npm run lint`를 만들었다고 가정하지 않는다.
- [ ] 최소 목적 diff를 검토하고 주석과 설명을 정리한 뒤 한 목적의 commit을 만든다. scope 밖 파일이나 user changes를 commit에 넣지 않는다.
- [ ] 현재 remoteChangePolicy가 요구하는 준비와 진단이 끝난 뒤에만 허용된 PR-facing push를 한다. review 댓글 답장, merge, release는 해당 권한을 따로 확인한다.
- [ ] 실제 CI와 reviewer finding만 근거로 분류한다. Bugbot이나 외부 reviewer가 있다고 가정해 자동 호출하지 않는다.

### Verdict and merge, for every PR

- [ ] code-ready head에서 해당 10 scenario와 perf를 한 번 확인한다. 작은 수정은 영향을 받은 lane과 필요 회귀만 재실행한다. 새 행동이나 큰 설계 변경만 전체 관련 검증을 다시 연다.
- [ ] root가 원문 요구, diff, tests, live evidence와 artifact SHA를 대조한다. 동일 모델 검토와 실제 multi-model 검토를 구별한다.
- [ ] 기준판에 이미 있던 결함은 별도 기록한다. 새 기능은 기존에 없었다는 이유로 제외하지 않고 추가 행동과 사용자가 기다리는 결과를 검증한다.
- [ ] 정확한 head SHA에서 clean verdict와 해결된 blocking finding을 기록한다. rebase나 conflict 수정 후 영향 검사 없이 옛 verdict를 옮기지 않는다.
- [ ] 기본 전달은 merge-ready다. 자동 merge하지 않는다. 이후 사용자 실행 범위에 merge가 명시되면 검증된 연속 의존 순서로만 처리한다.

### Boot recipe, for every live lane

- [ ] exact candidate와 baseline SHA를 격리 workspace에 준비한다. 기존 사용자 앱, credentials와 data DB를 시험 복사본으로 쓰지 않는다.
- [ ] 현재 버전의 관련 스크립트 인자를 먼저 읽는다. Node >=24, native runtime, 필요한 OS 도구와 fixture hash를 기록한다. heavy 실행 전에 자원 예약을 한다.
- [ ] 브라우저 UI는 현재 제공되는 CUA browser 도구, CLI는 승인된 exec와 read-only status로 제어한다. native Linux는 `scripts/app-e2e/run.ts`를 사용한다. Windows/macOS/mobile은 실제 허용된 driver 또는 기록 가능한 수동 기기 절차를 확보한다.
- [ ] 제어 도구가 없으면 해당 lane을 `NOT_RUN_DEVICE`로 남긴다. DOM script 결과나 API smoke를 실제 native 화면 PASS로 바꾸지 않는다.
- [ ] 각 lane의 PNG와 로그를 `WB_EVIDENCE/Uxx/lane-N/`에 저장한다. 터미널 기능은 실제 terminal 화면과 JSON log를 함께 남긴다. 화면 없는 계약은 terminal 또는 status harness의 receipt verifier 출력을 PNG와 JSON으로 남긴다. 증거를 위해 제품 상태 UI를 새로 만들지 않는다.
- [ ] U01이 추가할 `scripts/integration/run-scenario.ts`는 아래 scenario ID와 실제 control driver를 연결한다. 현재 파일은 없으며 runner 미구현을 성공으로 처리하지 않는다.

## 기준판·지원 범위·시각/성능 계약 (U01)

**Depends on.** None.

범위는 `hig:W0` `hig:H14` `paseo:PA17`이며 현재 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Create `packages/contracts/src/verification.ts`.
- [ ] Create `packages/contracts/src/verification.test.ts`.
- [ ] Create `scripts/integration/record-baseline.ts`.
- [ ] Create `scripts/integration/run-scenario.ts`.
- [ ] Create `scripts/integration/perf-probe.ts`.
- [ ] Create `scripts/integration/budgets.json`.
- [ ] Edit `docs/design/DESIGN.md`.

**Interfaces.** 이전 단위의 기존 contracts를 import하고 다음 이름을 생산한다. fixture 입력은 같은 타입을 사용한다.

```ts
declare function summarizeAcceptance(records: AcceptanceRecord[]): { canPromote: boolean; missing: string[] };
declare function runScenario(input: { unit: string; lane: number; sha: string; evidenceDir: string }): Promise<ScenarioReceipt>;
```

**Build.**

- [ ] `packages/contracts/src/verification.test.ts`에 `blocks_not_run_promotion`와 아래 assertion을 먼저 추가한다. 새 행동이 없어서 실패하는지 확인한다.

```ts
test('blocks_not_run_promotion', async () => {
	expect(summarizeAcceptance([{ id: 'PA08', state: 'NOT_RUN' }])).toEqual({ canPromote: false, missing: ['PA08'] });
});
```

- [ ] `npx vitest run packages/contracts/src/verification.test.ts -t blocks_not_run_promotion`를 실행한다. RED는 새 export 부재 또는 해당 행동 assertion 실패다. 관련 없는 환경 실패를 RED로 인정하지 않는다.
- [ ] verification.ts에 NOT_RUN, NOT_RUN_PLATFORM, NOT_RUN_DEVICE, PASS, FAIL_WITH_EVIDENCE와 sourceSha, artifactHash, device, fixtureHash를 가진 receipt 검사를 정의한다. release gate와 같은 schema를 쓰며 runtime 상태 UI는 요구하지 않는다.
- [ ] record-baseline.ts에 현재 설치본과 소스판을 분리하는 입력을 넣고 156개 원본 및 9형식 명령 대응표를 수집한다. run-scenario.ts는 실제 driver가 없으면 NOT_RUN_DEVICE를 반환한다.
- [ ] perf-probe.ts에서 baseline/head 교차 순서를 지원하고 budgets.json에 각 U의 새 작업 absolute budget과 동일 작업 비교 지표를 기록한다. 대표 시안의 재질, 읽기 폭, 상태를 DESIGN.md에 확정한다.
- [ ] 같은 test 명령을 다시 실행하고 GREEN을 확인한다. 해당 기존 시험을 더한 뒤 목적별 diff를 검토하고 `U01`의 commit SHA를 기록한다.

**You see.**

- [ ] `U01/result.json`에 달성한 결과와 미완료 항목을 기록한다. 확인 대상은 현재 SHA·설치본 식별·fixture 해시·before 화면/측정, 미확정 capability 및 후속 실증 목록.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run packages/contracts/src/verification.test.ts`의 모든 case와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 새 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. v0.3.3에서 프로젝트와 문서를 열고 기준판을 기록. Save `U01/lane-1/evidence.png`. Pass when installer source와 acceptance SHA가 분리됨. 기준판에 새 기능이 없으면 그 사실과 추가 행동의 최종 결과를 별도로 기록한다.
- [ ] Lane 2. 홈에서 문서 생성 후 최근 작업 복귀. Save `U01/lane-2/evidence.png`. Pass when 실제 생성 경로와 캡처가 있음.
- [ ] Lane 3. 프로젝트 개요와 YAML 열기. Save `U01/lane-3/evidence.png`. Pass when 원래 값과 종류가 기록됨.
- [ ] Lane 4. 문서 집중과 메인 복귀. Save `U01/lane-4/evidence.png`. Pass when 초안과 탐색 상태를 기록함.
- [ ] Lane 5. 9형식 파일의 주요 메뉴 열기. Save `U01/lane-5/evidence.png`. Pass when 모든 기존 command의 위치와 단축키가 목록에 있음.
- [ ] Lane 6. 둘 이상 문서 AI와 메인 시작. Save `U01/lane-6/evidence.png`. Pass when 현재 병렬 동작의 증거가 있음.
- [ ] Lane 7. Ctrl+K 원문 prompt 검색. Save `U01/lane-7/evidence.png`. Pass when 정확한 message 위치와 범위를 기록함.
- [ ] Lane 8. 설치본 재시작. Save `U01/lane-8/evidence.png`. Pass when 이전 data와 layout의 baseline이 있음.
- [ ] Lane 9. Windows/macOS/Linux 및 실제 폰 inventory. Save `U01/lane-9/evidence.png`. Pass when 없는 장치는 NOT_RUN이며 대체 PASS 없음.
- [ ] Lane 10. receipt에 NOT_RUN을 넣어 promotion 확인. Save `U01/lane-10/evidence.png`. Pass when receipt verifier 출력에서 전체 승격이 거절됨.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 시작 시간, 입력/검색 p95, idle/peak RSS, 설치 파일 bytes를 동일 fixture로 측정한다. 새 기능은 U별 absolute budget 값이 없으면 시작 gate를 통과하지 못한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U01 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치, build type과 fixture로 양쪽 값을 남긴다.
- [ ] Baseline. head 전에 trunk 값을 기록한다. 새 기능이 없는 기준판은 비교 가능한 기존 동작과 추가 작업의 absolute budget을 분리해 U01 budget receipt에 고정한다.
- [ ] Rule. 지연 또는 메모리 15%, 설치 크기 10% 증가를 넘으면 검토를 막고 원인과 비용을 기록한다. 새 기능은 고정한 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** None. U01 is not review-gated. 제품 interaction 변경 없이 기준과 증거를 고정한다.

**Merge.**

- [ ] root가 exact head의 요구 대응과 unit/live/perf evidence를 확인한 뒤 `U01`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## HIG 공통 UI와 접근성 (U02)

**Depends on.** U01.

범위는 `hig:W1` `hig:H09` `hig:H11` `hig:H12` `hig:S12`이며 현재 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Edit `apps/web/src/styles.css`.
- [ ] Edit `apps/web/src/appearance.ts`.
- [ ] Edit `apps/web/src/components/Icon.tsx`.
- [ ] Create `apps/web/src/components/controls/Menu.tsx`.
- [ ] Create `apps/web/src/components/controls/menu-state.ts`.
- [ ] Create `apps/web/src/components/controls.test.tsx`.

**Interfaces.** 이전 단위의 기존 contracts를 import하고 다음 이름을 생산한다. fixture 입력은 같은 타입을 사용한다.

```ts
declare function reduceMenu(state: MenuState, event: MenuEvent): MenuState;
declare function Menu(props: { items: MenuItem[]; returnFocusId: string; onAction(id: string): void }): ReactElement;
```

**Build.**

- [ ] `apps/web/src/components/controls.test.tsx`에 `escape_returns_original_focus`와 아래 assertion을 먼저 추가한다. 새 행동이 없어서 실패하는지 확인한다.

```ts
test('escape_returns_original_focus', async () => {
	expect(reduceMenu({ open: true, activeId: 'save', returnFocusId: 'new' }, { type: 'escape' })).toMatchObject({ open: false, returnFocusId: 'new' });
});
```

- [ ] `npx vitest run apps/web/src/components/controls.test.tsx -t escape_returns_original_focus`를 실행한다. RED는 새 export 부재 또는 해당 행동 assertion 실패다. 관련 없는 환경 실패를 RED로 인정하지 않는다.
- [ ] menu-state.ts에 키보드 이동, disabled 이유, Escape와 원위치 초점 전이를 넣는다. Menu는 같은 action을 pointer와 keyboard에서 호출한다.
- [ ] styles.css의 기존 토큰을 제어층 역할에 연결한다. appearance 저장값과 Icon 의미 ID는 그대로 읽고 문서 iframe 전역 선택자는 추가하지 않는다.
- [ ] button, sheet, dialog, list의 선택과 오류 상태를 같은 규칙으로 연결하고 reduced motion 및 transparency 대안을 제공한다.
- [ ] 같은 test 명령을 다시 실행하고 GREEN을 확인한다. 해당 기존 시험을 더한 뒤 목적별 diff를 검토하고 `U02`의 commit SHA를 기록한다.

**You see.**

- [ ] `U02/result.json`에 달성한 결과와 미완료 항목을 기록한다. 확인 대상은 대표 상태 키보드·screenreader·200%·좁은 창; HIG 규칙 검사+시각 감사, 문서 캔버스 스타일 미변경.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/web/src/components/controls.test.tsx`의 모든 case와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 새 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기준판과 새판에서 같은 생성 메뉴를 사용. Save `U02/lane-1/evidence.png`. Pass when 실제 생성 행동은 같고 초점 손실 없음. 기준판에 새 기능이 없으면 그 사실과 추가 행동의 최종 결과를 별도로 기록한다.
- [ ] Lane 2. Tab과 Shift+Tab으로 메뉴 진입. Save `U02/lane-2/evidence.png`. Pass when 표시 순서와 읽기 순서가 일치함.
- [ ] Lane 3. Escape로 dialog 종료. Save `U02/lane-3/evidence.png`. Pass when 호출 버튼으로 focus가 돌아감.
- [ ] Lane 4. 비활성 항목에 접근. Save `U02/lane-4/evidence.png`. Pass when 이유가 색 외 텍스트로 보임.
- [ ] Lane 5. light와 dark 전환. Save `U02/lane-5/evidence.png`. Pass when 본문과 사용자 룩을 바꾸지 않음.
- [ ] Lane 6. 200% 글자 확대. Save `U02/lane-6/evidence.png`. Pass when label과 제어가 잘리지 않음.
- [ ] Lane 7. 좁은 창에서 sheet 열기. Save `U02/lane-7/evidence.png`. Pass when 닫기와 주요 행동이 남음.
- [ ] Lane 8. screenreader로 주요 action 읽기. Save `U02/lane-8/evidence.png`. Pass when 이름과 상태가 정확함.
- [ ] Lane 9. 움직임과 투명도 줄이기. Save `U02/lane-9/evidence.png`. Pass when 동작을 이해할 대체 표현이 있음.
- [ ] Lane 10. 한글 메뉴와 IME 상태 유지. Save `U02/lane-10/evidence.png`. Pass when 메뉴 닫기가 조합 입력을 잃게 하지 않음.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 메뉴 open-to-paint, focus 반응 p95와 제어층 렌더의 peak RSS를 비교한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U02 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치, build type과 fixture로 양쪽 값을 남긴다.
- [ ] Baseline. head 전에 trunk 값을 기록한다. 새 기능이 없는 기준판은 비교 가능한 기존 동작과 추가 작업의 absolute budget을 분리해 U01 budget receipt에 고정한다.
- [ ] Rule. 지연 또는 메모리 15%, 설치 크기 10% 증가를 넘으면 검토를 막고 원인과 비용을 기록한다. 새 기능은 고정한 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U02/review/`에 저장하고 operator에게 이 단위의 변경과 미검증 범위를 제시한다. 같은 설치본의 연속 video를 관련 단위에서 참조할 수 있다.

**Merge.**

- [ ] root가 exact head의 요구 대응과 unit/live/perf evidence를 확인한 뒤 `U02`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 셸·프로젝트·탭·생성 흐름 (U03)

**Depends on.** U02.

범위는 `aside:C01` `aside:C18` `hig:W2` `hig:H01` `hig:H02` `hig:H03` `hig:H07` `hig:H13` `hig:S01` `hig:S02` `hig:S06` `hig:F01` `hig:F02` `hig:F03` `hig:D01` `hig:D02` `hig:D03` `hig:D04` `hig:D09` `paseo:F11` `paseo:F28`이며 현재 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Edit `apps/web/src/App.tsx`.
- [ ] Edit `apps/web/src/tabs.ts`.
- [ ] Edit `apps/web/src/panes.ts`.
- [ ] Edit `apps/web/src/layout-persistence.ts`.
- [ ] Edit `apps/web/src/components/project/ProjectView.tsx`.
- [ ] Create `apps/web/src/create-actions.ts`.
- [ ] Create `apps/web/src/create-actions.test.tsx`.

**Interfaces.** 이전 단위의 기존 contracts를 import하고 다음 이름을 생산한다. fixture 입력은 같은 타입을 사용한다.

```ts
declare function createActions(input: { workspaceId: string; formats: string[]; browserAvailable: boolean }): CreateAction[];
declare function executeCreateAction(action: CreateAction): Promise<{ viewId: string; resourceId: string }>;
```

**Build.**

- [ ] `apps/web/src/create-actions.test.tsx`에 `shares_manual_creation_actions`와 아래 assertion을 먼저 추가한다. 새 행동이 없어서 실패하는지 확인한다.

```ts
test('shares_manual_creation_actions', async () => {
	expect(createActions({ workspaceId: 'w1', formats: ['hwpx'], browserAvailable: true }).map(x => x.kind)).toEqual(['session', 'document', 'folder', 'browser']);
});
```

- [ ] `npx vitest run apps/web/src/create-actions.test.tsx -t shares_manual_creation_actions`를 실행한다. RED는 새 export 부재 또는 해당 행동 assertion 실패다. 관련 없는 환경 실패를 RED로 인정하지 않는다.
- [ ] create-actions.ts에 기존 생성 명령을 연결하고 상단, 우클릭, keyboard에서 같은 배열과 실행 함수를 사용한다.
- [ ] App.tsx의 상태는 유지한 채 셸 표시 책임을 분리한다. 프로젝트 이름 클릭과 펼침, 문서 집중과 OS 전체 화면을 다른 action으로 둔다.
- [ ] tabs와 panes에 안정된 viewId를 유지하며 이동, 분할, 복귀를 연결한다. layout-persistence는 이전 저장 schema를 읽고 새 상태를 명시적으로 저장한다.
- [ ] 같은 test 명령을 다시 실행하고 GREEN을 확인한다. 해당 기존 시험을 더한 뒤 목적별 diff를 검토하고 `U03`의 commit SHA를 기록한다.

**You see.**

- [ ] `U03/result.json`에 달성한 결과와 미완료 항목을 기록한다. 확인 대상은 S01/S02/S06 실제 데이터 사용, AI 없이 문서/폴더/세션/웹 생성 진입, 초안·선택·작업 ID 보존.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/web/src/create-actions.test.tsx`의 모든 case와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 새 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기준판과 새판에서 문서 생성 후 메인 복귀. Save `U03/lane-1/evidence.png`. Pass when 문서와 메인 초안이 보존됨. 기준판에 새 기능이 없으면 그 사실과 추가 행동의 최종 결과를 별도로 기록한다.
- [ ] Lane 2. 프로젝트 이름 클릭과 펼침을 따로 수행. Save `U03/lane-2/evidence.png`. Pass when 이름은 개요, 펼침은 목록만 바꿈.
- [ ] Lane 3. 상단 새로 만들기 사용. Save `U03/lane-3/evidence.png`. Pass when AI 없이 문서가 생김.
- [ ] Lane 4. 프로젝트 우클릭으로 폴더 생성. Save `U03/lane-4/evidence.png`. Pass when 같은 workspace를 대상으로 함.
- [ ] Lane 5. keyboard로 세션 생성. Save `U03/lane-5/evidence.png`. Pass when 상단과 동일 action 결과임.
- [ ] Lane 6. 문서 탭을 선택. Save `U03/lane-6/evidence.png`. Pass when 편집 집중이며 OS fullscreen은 그대로임.
- [ ] Lane 7. 메인으로 복귀. Save `U03/lane-7/evidence.png`. Pass when 탐색과 입력이 복원됨.
- [ ] Lane 8. 두 칸 사이 탭 이동. Save `U03/lane-8/evidence.png`. Pass when resourceId와 대화가 유지됨.
- [ ] Lane 9. 좁은 창에서 분할 접기. Save `U03/lane-9/evidence.png`. Pass when 선택과 초안이 남음.
- [ ] Lane 10. 이전 layout을 불러와 재시작. Save `U03/lane-10/evidence.png`. Pass when 순서와 활성 칸이 일관됨.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 탭 전환, 프로젝트 개요, 수동 생성 UI p95와 hidden view RSS를 같은 수의 탭으로 비교한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U03 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치, build type과 fixture로 양쪽 값을 남긴다.
- [ ] Baseline. head 전에 trunk 값을 기록한다. 새 기능이 없는 기준판은 비교 가능한 기존 동작과 추가 작업의 absolute budget을 분리해 U01 budget receipt에 고정한다.
- [ ] Rule. 지연 또는 메모리 15%, 설치 크기 10% 증가를 넘으면 검토를 막고 원인과 비용을 기록한다. 새 기능은 고정한 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U03/review/`에 저장하고 operator에게 이 단위의 변경과 미검증 범위를 제시한다. 같은 설치본의 연속 video를 관련 단위에서 참조할 수 있다.

**Merge.**

- [ ] root가 exact head의 요구 대응과 unit/live/perf evidence를 확인한 뒤 `U03`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 대화 읽기·스트림·검색 위치 (U04)

**Depends on.** U02.

범위는 `aside:C15` `hig:W2` `hig:H06` `hig:H14` `hig:S03` `hig:F06` `hig:D06` `paseo:F01` `paseo:F04` `paseo:F05` `paseo:F06` `paseo:F07` `paseo:F10` `paseo:P01` `paseo:PA01` `paseo:PA04` `paseo:PA05` `paseo:PA17`이며 현재 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Edit `apps/web/src/components/Transcript.tsx`.
- [ ] Edit `apps/web/src/components/Composer.tsx`.
- [ ] Edit `apps/web/src/components/Diagram.tsx`.
- [ ] Create `apps/web/src/conversation/reading-anchor.ts`.
- [ ] Create `apps/web/src/conversation/reading-anchor.test.tsx`.

**Interfaces.** 이전 단위의 기존 contracts를 import하고 다음 이름을 생산한다. fixture 입력은 같은 타입을 사용한다.

```ts
declare function reconcileReadingAnchor(anchor: { messageId: string; offsetPx: number }, rows: { id: string; topPx: number }[]): number;
declare function projectTurn(items: TranscriptItem[], mode: DetailMode): TranscriptRow[];
```

**Build.**

- [ ] `apps/web/src/conversation/reading-anchor.test.tsx`에 `preserves_reading_anchor`와 아래 assertion을 먼저 추가한다. 새 행동이 없어서 실패하는지 확인한다.

```ts
test('preserves_reading_anchor', async () => {
	expect(reconcileReadingAnchor({ messageId: 'm2', offsetPx: 12 }, [{ id: 'm1', topPx: 0 }, { id: 'm2', topPx: 310 }])).toBe(322);
});
```

- [ ] `npx vitest run apps/web/src/conversation/reading-anchor.test.tsx -t preserves_reading_anchor`를 실행한다. RED는 새 export 부재 또는 해당 행동 assertion 실패다. 관련 없는 환경 실패를 RED로 인정하지 않는다.
- [ ] reading-anchor.ts에 message ID와 상대 offset 기반 보정을 구현한다. 이미지 높이 변경, prepend와 disclosure 뒤 같은 anchor를 적용한다.
- [ ] Transcript에서 불변 history와 active message를 나누고 최종 답변, 실패, 승인 노출을 보존한다. Markdown, code, 표, Mermaid 및 선택 복사를 공통 규칙으로 연결한다.
- [ ] Composer 초안과 follow-output을 분리한다. paging 또는 windowing은 검색 target을 mount하고 원문을 유지하는 경로와 함께 도입한다.
- [ ] 같은 test 명령을 다시 실행하고 GREEN을 확인한다. 해당 기존 시험을 더한 뒤 목적별 diff를 검토하고 `U04`의 commit SHA를 기록한다.

**You see.**

- [ ] `U04/result.json`에 달성한 결과와 미완료 항목을 기록한다. 확인 대상은 PA01/04/05와 H14 동일 fixture; 한글·이모지·긴 기록·완료 즉시 표시, 원문 검색 삭제 없음.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/web/src/conversation/reading-anchor.test.tsx`의 모든 case와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 새 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기준판과 새판에서 긴 질문을 찾아 복사. Save `U04/lane-1/evidence.png`. Pass when 원문 검색과 복사 내용이 같음. 기준판에 새 기능이 없으면 그 사실과 추가 행동의 최종 결과를 별도로 기록한다.
- [ ] Lane 2. 긴 표를 가로 이동. Save `U04/lane-2/evidence.png`. Pass when 본문 전체와 복사 기능이 유지됨.
- [ ] Lane 3. code와 prose를 각각 복사. Save `U04/lane-3/evidence.png`. Pass when 코드만 복사와 원문 복사가 구별됨.
- [ ] Lane 4. 한국어와 emoji stream 확인. Save `U04/lane-4/evidence.png`. Pass when 조합 문자가 중간에 잘리지 않음.
- [ ] Lane 5. 위쪽 문장을 읽는 중 새 token 수신. Save `U04/lane-5/evidence.png`. Pass when 강제 tail 이동이 없음.
- [ ] Lane 6. 과거 페이지를 앞에 추가. Save `U04/lane-6/evidence.png`. Pass when 같은 message와 상대 위치 유지.
- [ ] Lane 7. 도구 기록 펼침과 접기. Save `U04/lane-7/evidence.png`. Pass when 읽는 줄과 selection 유지.
- [ ] Lane 8. 큰 이미지가 뒤늦게 decode. Save `U04/lane-8/evidence.png`. Pass when 본문이 다른 위치로 튀지 않음.
- [ ] Lane 9. 완료 turn 접기. Save `U04/lane-9/evidence.png`. Pass when 최종 답변과 실패 및 승인 보존.
- [ ] Lane 10. 완료 직후와 세션 재방문. Save `U04/lane-10/evidence.png`. Pass when 남은 text를 즉시 표시하고 초안을 보존함.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 첫 입력 paint, visible update p95, 최종 표시 지연, anchor 이동 px와 긴 이력 RSS를 비교한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U04 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치, build type과 fixture로 양쪽 값을 남긴다.
- [ ] Baseline. head 전에 trunk 값을 기록한다. 새 기능이 없는 기준판은 비교 가능한 기존 동작과 추가 작업의 absolute budget을 분리해 U01 budget receipt에 고정한다.
- [ ] Rule. 지연 또는 메모리 15%, 설치 크기 10% 증가를 넘으면 검토를 막고 원인과 비용을 기록한다. 새 기능은 고정한 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U04/review/`에 저장하고 operator에게 이 단위의 변경과 미검증 범위를 제시한다. 같은 설치본의 연속 video를 관련 단위에서 참조할 수 있다.

**Merge.**

- [ ] root가 exact head의 요구 대응과 unit/live/perf evidence를 확인한 뒤 `U04`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 이미지·artifact 정체성과 파일 결과 (U05)

**Depends on.** U04, U06.

범위는 `aside:P3` `aside:C10` `aside:C17` `hig:W2` `hig:S03` `paseo:F02` `paseo:F03` `paseo:P02` `paseo:PA02` `paseo:PA03` `paseo:PA05` `paseo:PA14` `paseo:PA17`이며 현재 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Edit `apps/host/src/attachments.ts`.
- [ ] Edit `apps/host/src/tool-images.ts`.
- [ ] Edit `apps/web/src/components/Attachments.tsx`.
- [ ] Create `apps/host/src/media-references.ts`.
- [ ] Create `apps/host/src/media-references.test.ts`.
- [ ] Create `packages/contracts/src/artifacts.ts`.

**Interfaces.** 이전 단위의 기존 contracts를 import하고 다음 이름을 생산한다. fixture 입력은 같은 타입을 사용한다.

```ts
declare function artifactCacheKey(ref: ArtifactRef): string;
declare function resolveMediaReference(input: { task: TaskRef; sourceMessageId: string; path: string; revision: string }): Promise<ArtifactRef>;
```

**Build.**

- [ ] `apps/host/src/media-references.test.ts`에 `keeps_image_revision_identity`와 아래 assertion을 먼저 추가한다. 새 행동이 없어서 실패하는지 확인한다.

```ts
test('keeps_image_revision_identity', async () => {
	const first: ArtifactRef = { hostId: 'a', workspaceId: 'w', artifactId: 'img', canonicalPath: '/fixtures/그림 1.png', revision: '1', hash: 'old', MIME: 'image/png', sourceMessageId: 'm1' };
	const second: ArtifactRef = { ...first, revision: '2', hash: 'new', sourceMessageId: 'm2' };
	expect(artifactCacheKey(first)).not.toBe(artifactCacheKey(second));
});
```

- [ ] `npx vitest run apps/host/src/media-references.test.ts -t keeps_image_revision_identity`를 실행한다. RED는 새 export 부재 또는 해당 행동 assertion 실패다. 관련 없는 환경 실패를 RED로 인정하지 않는다.
- [ ] artifacts.ts에서 기존 attachment와 ArtifactRef 필드의 대응을 정의한다. media-references.ts는 workspace와 canonical physical path를 검사한 뒤 opaque media 참조를 반환한다.
- [ ] 이미지 획득을 content-addressed 첨부 저장에 연결하고 message 당시 revision을 보존한다. 원본 최신 파일 열기는 다른 action으로 둔다.
- [ ] Attachments와 Transcript 결과 카드에 decode, 실패, retry, 만료, 캐시 eviction과 gallery를 연결한다. 문서 MIME은 기존 편집기로 보낸다.
- [ ] 같은 test 명령을 다시 실행하고 GREEN을 확인한다. 해당 기존 시험을 더한 뒤 목적별 diff를 검토하고 `U05`의 commit SHA를 기록한다.

**You see.**

- [ ] `U05/result.json`에 달성한 결과와 미완료 항목을 기록한다. 확인 대상은 PA02/03/05; 한글·공백 경로·같은 파일 덮어쓰기·느린 decode·첨부 실패·원격 인증, 과거 결과와 최신 파일 구별.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/media-references.test.ts`의 모든 case와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 새 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기준판과 새판에서 붙여넣은 그림 확대. Save `U05/lane-1/evidence.png`. Pass when 같은 전송 결과와 원본 확인 가능. 기준판에 새 기능이 없으면 그 사실과 추가 행동의 최종 결과를 별도로 기록한다.
- [ ] Lane 2. 한글과 공백 경로 이미지를 전송. Save `U05/lane-2/evidence.png`. Pass when 누락 없이 모델 전달 상태가 보임.
- [ ] Lane 3. AI Markdown의 local image 열기. Save `U05/lane-3/evidence.png`. Pass when host가 검증한 media만 표시됨.
- [ ] Lane 4. 같은 파일명을 덮어쓰기. Save `U05/lane-4/evidence.png`. Pass when 과거 message 당시 그림과 최신 파일이 구별됨.
- [ ] Lane 5. 계약에 맞는 두 host의 media 응답 fixture를 실제 카드에서 열기. Save `U05/lane-5/evidence.png`. Pass when 원래 host와 revision을 유지함. 실제 원격 인증은 U17에서 검증한다.
- [ ] Lane 6. workspace 밖 파일 요청. Save `U05/lane-6/evidence.png`. Pass when 접근이 거절되고 이유가 보임.
- [ ] Lane 7. 느린 decode와 오류 주입. Save `U05/lane-7/evidence.png`. Pass when placeholder와 재시도가 동작함.
- [ ] Lane 8. 갤러리 이전과 다음 선택. Save `U05/lane-8/evidence.png`. Pass when message 순서와 원본 대상이 정확함.
- [ ] Lane 9. PDF/HWPX/DOCX 결과 열기. Save `U05/lane-9/evidence.png`. Pass when 각 기존 편집기로 연결됨.
- [ ] Lane 10. 장시간 이미지 탐색 후 캐시 정리. Save `U05/lane-10/evidence.png`. Pass when 메시지 기록은 남고 blob 자원이 회수됨.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. thumb/full decode 시간, media 획득 p95, 전송 bytes와 100개 이미지 탐색 후 blob RSS를 비교한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U05 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치, build type과 fixture로 양쪽 값을 남긴다.
- [ ] Baseline. head 전에 trunk 값을 기록한다. 새 기능이 없는 기준판은 비교 가능한 기존 동작과 추가 작업의 absolute budget을 분리해 U01 budget receipt에 고정한다.
- [ ] Rule. 지연 또는 메모리 15%, 설치 크기 10% 증가를 넘으면 검토를 막고 원인과 비용을 기록한다. 새 기능은 고정한 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U05/review/`에 저장하고 operator에게 이 단위의 변경과 미검증 범위를 제시한다. 같은 설치본의 연속 video를 관련 단위에서 참조할 수 있다.

**Merge.**

- [ ] root가 exact head의 요구 대응과 unit/live/perf evidence를 확인한 뒤 `U05`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 공통 작업·자식·승인·전송 상태 (U06)

**Depends on.** U01.

범위는 `aside:P2` `aside:C05` `aside:C06` `aside:C07` `aside:C11` `aside:C16` `hig:W2` `hig:H04` `hig:H10` `hig:S03` `hig:F04` `hig:F09` `hig:D07` `paseo:F08` `paseo:F09` `paseo:F13` `paseo:F14` `paseo:F15` `paseo:F18` `paseo:P03` `paseo:PA04` `paseo:PA06` `paseo:PA07` `paseo:PA12`이며 현재 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Edit `apps/host/src/main.ts`, `apps/host/src/http.ts` and `apps/web/src/api.ts` for the shared task routes and subscriptions.
- [ ] Create `apps/web/src/components/TaskPanel.tsx` for child/approval/queue state.
- [ ] Edit `apps/web/src/components/Transcript.tsx`, `apps/web/src/components/Composer.tsx` to expose the same task state.

- [ ] Create `packages/contracts/src/tasks.ts`.
- [ ] Create `apps/host/src/task-service.ts`.
- [ ] Create `apps/host/src/task-service.test.ts`.
- [ ] Edit `apps/host/src/sessions.ts`.
- [ ] Edit `apps/host/src/send-gate.ts`.
- [ ] Edit `apps/host/src/providers/types.ts`.
- [ ] Edit `packages/provider-codex/src/map.ts`.
- [ ] Edit `packages/provider-claude/src/map.ts`.

**Interfaces.** 이전 단위의 기존 contracts를 import하고 다음 이름을 생산한다. fixture 입력은 같은 타입을 사용한다.

```ts
interface ControlLease { targetId: string; ownerRunId: string; generation: number; expiresAt: string; handoffState: "agent" | "human" | "handoff_pending"; }
declare function acceptCommand(input: { commandId: string; target: TaskRef; payloadHash: string }): Promise<CommandReceipt>;
declare function reconcileReceipt(current: CommandReceipt, observed: ReceiptObservation): CommandReceipt;
declare function subscribeTasks(parentRunId?: string): AsyncIterable<TaskEvent>;
```

**Build.**

- [ ] `apps/host/src/task-service.test.ts`에 `keeps_unknown_receipt`와 아래 assertion을 먼저 추가한다. 새 행동이 없어서 실패하는지 확인한다.

```ts
test('keeps_unknown_receipt', async () => {
	expect(reconcileReceipt({ commandId: 'c1', targetRunId: 'r1', status: 'outcome_unknown' }, { kind: 'transport_retry' }).status).toBe('outcome_unknown');
});
```

- [ ] `npx vitest run apps/host/src/task-service.test.ts -t keeps_unknown_receipt`를 실행한다. RED는 새 export 부재 또는 해당 행동 assertion 실패다. 관련 없는 환경 실패를 RED로 인정하지 않는다.
- [ ] tasks.ts에 spec의 TaskRef, CommandReceipt, 공유 ControlLease와 8개 작업 상태를 정의한다. U14의 page와 U15의 physical-input adapter는 이 lease 계약을 import한다. 기존 session/nativeSession과 durable request journal을 authority로 유지한다.
- [ ] task-service.ts에서 접수, 중복 payload conflict, 승인/질문/계획 응답 및 queue/steer/stop을 provider capability로 조정한다. 응답 손실은 조회 후 reconcile한다.
- [ ] provider map에서 native child 관계와 지원 제어를 정규화한다. parent UI 카드와 다음 모델 context를 구별하고 기존 Office 보고와 같은 completion ID를 쓴다.
- [ ] 같은 test 명령을 다시 실행하고 GREEN을 확인한다. 해당 기존 시험을 더한 뒤 목적별 diff를 검토하고 `U06`의 commit SHA를 기록한다.

**You see.**

- [ ] `U06/result.json`에 달성한 결과와 미완료 항목을 기록한다. 확인 대상은 C06/07/11 및 PA04/06/07/12; 메인 비차단·중복/unknown·지원 불가 명시; UI별 재실행 없음.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/task-service.test.ts`의 모든 case와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 새 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기준판과 새판에서 메인과 문서 AI 병행. Save `U06/lane-1/evidence.png`. Pass when 메인 입력이 막히지 않음. 기준판에 새 기능이 없으면 그 사실과 추가 행동의 최종 결과를 별도로 기록한다.
- [ ] Lane 2. web executor와 document executor의 계약에 맞는 event fixture를 task UI에 표시. Save `U06/lane-2/evidence.png`. Pass when 각 run과 child 대화가 구별됨. 실제 웹2+문서1 동시 제어는 U14에서 검증한다.
- [ ] Lane 3. Codex native child를 열기. Save `U06/lane-3/evidence.png`. Pass when 지원하는 관찰과 제어만 보임.
- [ ] Lane 4. Claude subagent 결과 확인. Save `U06/lane-4/evidence.png`. Pass when 부모 본문에 모든 출력을 합치지 않음.
- [ ] Lane 5. 동일 command ID를 두 번 전송. Save `U06/lane-5/evidence.png`. Pass when 한 번 접수되고 provider 시작도 하나임.
- [ ] Lane 6. 같은 ID에 다른 payload 전송. Save `U06/lane-6/evidence.png`. Pass when conflict를 표시함.
- [ ] Lane 7. 응답 손실 후 재접속. Save `U06/lane-7/evidence.png`. Pass when unknown이 보존되고 무조건 재실행하지 않음.
- [ ] Lane 8. queue 수정과 지금 반영. Save `U06/lane-8/evidence.png`. Pass when 지원 provider의 실제 행동과 UI가 일치함.
- [ ] Lane 9. 두 화면에서 같은 승인 응답. Save `U06/lane-9/evidence.png`. Pass when 서버에서 하나만 반영됨.
- [ ] Lane 10. child 중지와 완료 보고. Save `U06/lane-10/evidence.png`. Pass when 하위 실행 취소와 종료 알림이 한 번임.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 명령 admission과 task event 반영 p95, 50개 task 목록 RSS를 비교하고 provider 추론 시간을 분리한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U06 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치, build type과 fixture로 양쪽 값을 남긴다.
- [ ] Baseline. head 전에 trunk 값을 기록한다. 새 기능이 없는 기준판은 비교 가능한 기존 동작과 추가 작업의 absolute budget을 분리해 U01 budget receipt에 고정한다.
- [ ] Rule. 지연 또는 메모리 15%, 설치 크기 10% 증가를 넘으면 검토를 막고 원인과 비용을 기록한다. 새 기능은 고정한 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U06/review/`에 저장하고 operator에게 이 단위의 변경과 미검증 범위를 제시한다. 같은 설치본의 연속 video를 관련 단위에서 참조할 수 있다.

**Merge.**

- [ ] root가 exact head의 요구 대응과 unit/live/perf evidence를 확인한 뒤 `U06`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 역할 프로필·모델 카탈로그·공통 API (U07)

**Depends on.** U06.

범위는 `hig:H09` `hig:S12` `hig:F10` `hig:D11` `paseo:F16` `paseo:F32` `paseo:F35` `paseo:E02`이며 현재 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Edit `apps/host/src/main.ts` and `apps/host/src/http.ts` to register the common automation API under existing authorization.

- [ ] Edit `apps/host/src/providers/model-cache.ts`와 기존 model discovery 호출자. 모델 목록의 authority를 복제하지 않는다.
- [ ] Create `apps/host/src/agent-profiles.ts`.
- [ ] Create `apps/host/src/agent-profiles.test.ts`.
- [ ] Edit `apps/web/src/components/ModelPicker.tsx`.
- [ ] Create `packages/contracts/src/agent-profiles.ts`.
- [ ] Create `packages/client/src/index.ts`.
- [ ] Create `packages/client/package.json`, `packages/client/tsconfig.json`, `packages/client/src/cli.ts`, `packages/client/src/mcp.ts`.
- [ ] Edit `package.json`, `package-lock.json`, `tsconfig.json`와 사용하는 workspace manifest에 client dependency, exports/bin, build/typecheck 경로를 연결한다.
- [ ] Create `apps/host/src/automation-api.test.ts`. CLI/MCP도 같은 권한과 receipt를 사용하는지 fake transport로 확인한다.
- [ ] Create `apps/host/src/automation-api.ts`.

**Interfaces.** 이전 단위의 기존 contracts를 import하고 다음 이름을 생산한다. fixture 입력은 같은 타입을 사용한다.

```ts
declare function resolveProfile(input: { profileId: string; providerCapabilities: ProviderCapabilities; overrides: Partial<RunSettings> }): RunSettings;
declare function startProfiledRun(profileId: string, input: SubmitCommand): Promise<RunRef>;
interface WorkbenchClient { submit(input: SubmitCommand): Promise<CommandReceipt>; }
```

**Build.**

- [ ] `apps/host/src/agent-profiles.test.ts`에 `profile_changes_apply_to_next_run`와 아래 assertion을 먼저 추가한다. 새 행동이 없어서 실패하는지 확인한다.

```ts
test('profile_changes_apply_to_next_run', async () => {
	const host = await fixtureProfileHost({ profileId: 'research', model: 'model-a' });
	const active = await host.startProfiledRun('research', fixtureSubmit('run-a'));
	await host.profiles.update('research', { model: 'model-b' });
	const next = await host.startProfiledRun('research', fixtureSubmit('run-b'));
	expect(host.runSettings(active.runId).model).toBe('model-a');
	expect(host.runSettings(next.runId).model).toBe('model-b');
	expect(host.resolveWithOverrides('research', { model: 'custom-model' }).model).toBe('custom-model');
});
```

- [ ] `npx vitest run apps/host/src/agent-profiles.test.ts -t profile_changes_apply_to_next_run`를 실행한다. RED는 새 export 부재 또는 해당 행동 assertion 실패다. 관련 없는 환경 실패를 RED로 인정하지 않는다.
- [ ] agent-profiles.ts에 조사/작성/코딩/검토 설정을 저장하고 실행 시작 시 snapshot을 만든다. 기존 진행 run의 설정은 profile 변경으로 바꾸지 않는다.
- [ ] 기존 providers/model-cache.ts authority를 확장해 실제 provider 모델 discovery와 사용자 지정 model을 병합한다. usage와 metadata generation은 capability별로 표시하고 고정 모델 목록을 복사하지 않는다.
- [ ] automation-api와 client를 기존 task-service에 연결해 CLI, MCP, TypeScript에서 같은 receipt와 권한을 받게 한다. CLI bin은 workbench-client로 등록하고 MCP는 stdio에서 JSON-RPC를 task-service로 전달한다. 별도 실행 저장소를 만들지 않는다. `node packages/client/src/cli.ts submit --fixture <fixture.json>`과 `node packages/client/src/mcp.ts --fixture-transport <fixture.json>`로 동일 commandId receipt 및 workspace 거절을 확인하는 문서화된 fixture mode를 제공한다.
- [ ] 같은 test 명령을 다시 실행하고 GREEN을 확인한다. 해당 기존 시험을 더한 뒤 목적별 diff를 검토하고 `U07`의 commit SHA를 기록한다.

**You see.**

- [ ] `U07/result.json`에 달성한 결과와 미완료 항목을 기록한다. 확인 대상은 F16/32/35; 프로필 변경은 다음 실행, 모델 발견/사용자 override 보존, API와 UI 결과·권한 동일.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/agent-profiles.test.ts`의 모든 case와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 새 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기준판과 새판에서 실제 모델 새로고침. Save `U07/lane-1/evidence.png`. Pass when 기존 계정 모델과 사용자 override가 남음. 기준판에 새 기능이 없으면 그 사실과 추가 행동의 최종 결과를 별도로 기록한다.
- [ ] Lane 2. research profile로 작업 시작. Save `U07/lane-2/evidence.png`. Pass when 모델/권한 설명과 실제 설정이 같음.
- [ ] Lane 3. 실행 중 profile 변경. Save `U07/lane-3/evidence.png`. Pass when 현재 run은 원래 snapshot 유지.
- [ ] Lane 4. 다음 run 시작. Save `U07/lane-4/evidence.png`. Pass when 새 profile을 사용함.
- [ ] Lane 5. 지원하지 않는 steer 선택. Save `U07/lane-5/evidence.png`. Pass when 잘못된 성공 대신 capability 제한 표시.
- [ ] Lane 6. 사용자 model ID로 실행. Save `U07/lane-6/evidence.png`. Pass when 목록 refresh가 ID를 덮지 않음.
- [ ] Lane 7. CLI와 UI에서 같은 command 전송. Save `U07/lane-7/evidence.png`. Pass when 동일 receipt 계약임.
- [ ] Lane 8. MCP에서 잘못된 workspace 접근. Save `U07/lane-8/evidence.png`. Pass when 같은 서버 권한 검사로 거절됨.
- [ ] Lane 9. usage 또는 metadata 미지원 provider. Save `U07/lane-9/evidence.png`. Pass when 없는 수치를 만들지 않음.
- [ ] Lane 10. 연결 실패 후 설정 재열기. Save `U07/lane-10/evidence.png`. Pass when 기존 model과 profile 저장값이 남음.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. profile resolve, model catalog paint와 공통 API admission p95를 비교하며 외부 provider 응답은 별도 기록한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U07 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치, build type과 fixture로 양쪽 값을 남긴다.
- [ ] Baseline. head 전에 trunk 값을 기록한다. 새 기능이 없는 기준판은 비교 가능한 기존 동작과 추가 작업의 absolute budget을 분리해 U01 budget receipt에 고정한다.
- [ ] Rule. 지연 또는 메모리 15%, 설치 크기 10% 증가를 넘으면 검토를 막고 원인과 비용을 기록한다. 새 기능은 고정한 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U07/review/`에 저장하고 operator에게 이 단위의 변경과 미검증 범위를 제시한다. 같은 설치본의 연속 video를 관련 단위에서 참조할 수 있다.

**Merge.**

- [ ] root가 exact head의 요구 대응과 unit/live/perf evidence를 확인한 뒤 `U07`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 문서 셸과 9형식 내장 Office UI (U08)

**Depends on.** U02, U03.

범위는 `aside:C06` `aside:C17` `aside:C18` `hig:W3` `hig:H02` `hig:H03` `hig:H04` `hig:H05` `hig:H12` `hig:S04` `hig:S05` `hig:S06` `hig:F03` `hig:F04` `hig:F05` `hig:D04` `hig:D05` `hig:D09` `hig:D13` `paseo:PA06` `paseo:PA16`이며 현재 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Edit `apps/web/src/components/docs/DocumentView.tsx`.
- [ ] Edit `apps/web/src/components/docs/OfficeEditor.tsx`.
- [ ] Edit `apps/web/src/components/OfficeFileMenu.tsx`.
- [ ] Edit `apps/office/vite.config.ts`.
- [ ] Create `apps/office/src/ui-adapters.ts`.
- [ ] Create `apps/office/src/ui-adapters.test.ts`.
- [ ] Create `apps/office/src/ui-adapters/hangul.ts`.
- [ ] Create `apps/office/src/ui-adapters/word.ts`.
- [ ] Create `apps/office/src/ui-adapters/slides.ts`.
- [ ] Create `apps/office/src/ui-adapters/sheets.ts`.
- [ ] Create `apps/office/src/ui-adapters/markdown.ts`.
- [ ] Create `apps/office/src/ui-adapters/pdf.ts`.
- [ ] Create `apps/office/src/ui-adapters/html.ts`.
- [ ] Create `apps/office/src/ui-adapters/mindmap.ts`.
- [ ] Create `apps/office/src/ui-adapters/epub.ts`.

**Interfaces.** 이전 단위의 기존 contracts를 import하고 다음 이름을 생산한다. fixture 입력은 같은 타입을 사용한다.

```ts
declare function adaptOfficeCommands(format: OfficeFormat, existing: EditorCommand[]): CommandPlacement[];
declare function applyOfficeTheme(viewId: string, theme: UiTheme): Promise<{ remounted: false }>;
```

**Build.**

- [ ] `apps/office/src/ui-adapters.test.ts`에 `retains_every_existing_editor_command`와 아래 assertion을 먼저 추가한다. 새 행동이 없어서 실패하는지 확인한다.

```ts
test('retains_every_existing_editor_command', async () => {
	expect(adaptOfficeCommands('word', [{ id: 'save' }, { id: 'undo' }, { id: 'advanced-layout' }]).map(x => x.commandId).sort()).toEqual(['advanced-layout', 'save', 'undo']);
});
```

- [ ] `npx vitest run apps/office/src/ui-adapters.test.ts -t retains_every_existing_editor_command`를 실행한다. RED는 새 export 부재 또는 해당 행동 assertion 실패다. 관련 없는 환경 실패를 RED로 인정하지 않는다.
- [ ] 각 형식 adapter에 기존 command ID와 새 메뉴/toolbar/shortcut을 연결한다. 9형식 하위 완료표를 모두 채우고 고급 명령을 숨기지 않는다.
- [ ] OfficeEditor의 theme/state message로 UI를 갱신한다. 문서 content CSS, selection, Undo, dirty와 save revision을 건드리지 않고 iframe을 유지한다.
- [ ] 문서 집중 셸과 독립 AI, 속성 패널, 출력 dialog를 같은 HIG 규칙으로 연결한다. 내장 renderer와 별도 이음 앱 UI는 구별한다.
- [ ] 같은 test 명령을 다시 실행하고 GREEN을 확인한다. 해당 기존 시험을 더한 뒤 목적별 diff를 검토하고 `U08`의 commit SHA를 기록한다.

**You see.**

- [ ] `U08/result.json`에 달성한 결과와 미완료 항목을 기록한다. 확인 대상은 형식별 편집/selection/Undo/dirty/save revision/내보내기/출력·원본 서식; 분할/테마/패널 변경 시 iframe 및 lease 유지.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/office/src/ui-adapters.test.ts`의 모든 case와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 새 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기준판과 새판에서 같은 문서 편집/저장. Save `U08/lane-1/evidence.png`. Pass when 내용과 원래 서식이 보존됨. 기준판에 새 기능이 없으면 그 사실과 추가 행동의 최종 결과를 별도로 기록한다.
- [ ] Lane 2. 한글 메뉴와 개체 속성 사용. Save `U08/lane-2/evidence.png`. Pass when 현재 지원 명령과 조판 유지.
- [ ] Lane 3. Word 리본과 Undo 및 출력. Save `U08/lane-3/evidence.png`. Pass when 명령 누락과 selection 손실 없음.
- [ ] Lane 4. 슬라이드 thumbnail/개체/발표. Save `U08/lane-4/evidence.png`. Pass when canvas와 매체/발표가 유지됨.
- [ ] Lane 5. 시트 수식/범위/출력. Save `U08/lane-5/evidence.png`. Pass when 수식 계산과 선택이 유지됨.
- [ ] Lane 6. Markdown 이미지/링크 저장. Save `U08/lane-6/evidence.png`. Pass when 원문과 preview가 일치함.
- [ ] Lane 7. PDF 주석/OCR/추출과 HTML 미리보기. Save `U08/lane-7/evidence.png`. Pass when 현재 도구와 결과 연결이 유지됨.
- [ ] Lane 8. 마인드맵 편집과 EPUB 장/번역. Save `U08/lane-8/evidence.png`. Pass when 구조와 현재 위치가 유지됨.
- [ ] Lane 9. AI 중 theme/pane/split 변경. Save `U08/lane-9/evidence.png`. Pass when iframe ID와 writer lease가 유지됨.
- [ ] Lane 10. 200% 확대와 좁은 창의 모든 형식. Save `U08/lane-10/evidence.png`. Pass when 메뉴와 저장 제어가 잘리지 않음.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 형식별 UI command paint, 탭 복귀 p95와 Office idle/peak RSS를 동일 문서 fixture로 비교한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U08 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치, build type과 fixture로 양쪽 값을 남긴다.
- [ ] Baseline. head 전에 trunk 값을 기록한다. 새 기능이 없는 기준판은 비교 가능한 기존 동작과 추가 작업의 absolute budget을 분리해 U01 budget receipt에 고정한다.
- [ ] Rule. 지연 또는 메모리 15%, 설치 크기 10% 증가를 넘으면 검토를 막고 원인과 비용을 기록한다. 새 기능은 고정한 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U08/review/`에 저장하고 operator에게 이 단위의 변경과 미검증 범위를 제시한다. 같은 설치본의 연속 video를 관련 단위에서 참조할 수 있다.

**Merge.**

- [ ] root가 exact head의 요구 대응과 unit/live/perf evidence를 확인한 뒤 `U08`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.


## Office 작업의 UI 독립 실행 (U09)

**Depends on.** U06, U08, U16.

범위 ID는 `hig:H04`, `hig:S04`, `hig:F04`, `hig:D13`, `paseo:F25`, `paseo:P04`, `paseo:PA08`, `paseo:PA16`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Create `apps/office/src/executor-entry.ts` and `apps/desktop/src-tauri/src/office_executor.rs` for the independently owned renderer path selected by G-OF2.
- [ ] Edit `apps/office/vite.config.ts` and `apps/desktop/src-tauri/src/lib.rs` to wire the selected executor entry and lifecycle.

- [ ] Edit `apps/host/src/document-registry.ts`.
- [ ] Edit `apps/host/src/office-sessions.ts`.
- [ ] Edit `apps/host/src/office-ai.ts`.
- [ ] Edit `apps/office/src/office-agent.ts`.
- [ ] Create `apps/host/src/document-execution-lease.ts`.
- [ ] Create `apps/host/src/document-execution-lease.test.ts`.
- [ ] Create `apps/host/src/office-executors/types.ts`.
- [ ] Create `apps/host/src/office-executors/headless-markdown.ts`.
- [ ] Create `apps/host/src/office-executors/renderer.ts`.
- [ ] Create `apps/host/src/office-executors/registry.ts`.
- [ ] Create `scripts/architecture-probes/office-lease.ts`.
- [ ] Create `scripts/architecture-probes/office-headless.ts`.

**Interfaces.**

```ts
type ExecutorMode = "host" | "independent-renderer" | "ui-required";
interface OfficeExecutor { supports(format: string, toolId: string): ExecutorMode; execute(job: ApprovedDocumentJob, lease: DocumentExecutionLease, signal: AbortSignal): Promise<DocumentResult>; }
declare function commitDocument(input: RevisionCommit, lease: DocumentExecutionLease): Promise<CommitReceipt>;
```

**Build.**

- [ ] `apps/host/src/document-execution-lease.test.ts`에 `rejects_stale_physical_writer`를 먼저 추가한다. fixture helper는 이 test의 임시 파일과 fake adapter에 한정하고 실제 사용자 데이터나 외부 계정을 사용하지 않는다.

```ts
it("rejects_stale_physical_writer", async () => {
  const file = await fixturePhysicalFileWithSymlink("note.md", "before");
  const first = await registry.acquire(file.path, "run-a");
  await registry.release(first);
  const second = await registry.acquire(file.alias, "run-b");
  expect(second.physicalFileIdentity).toBe(first.physicalFileIdentity);
  await expect(commitDocument({ path: file.path, expectedHash: file.hash, body: "stale" }, first)).rejects.toMatchObject({ code: "STALE_WRITER" });
  expect(await file.read()).toBe("before");
});
```

- [ ] `npx vitest run apps/host/src/document-execution-lease.test.ts -t rejects_stale_physical_writer`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] 기존 형식과 승인된 AI toolId의 executor matrix를 만든다. 9형식별 host-capable/renderer-required, save/revision/취소 방식과 현재 지원 도구를 기록한다. UI 명령 전체를 새 AI 도구로 만드는 작업은 포함하지 않는다.
- [ ] G-OF1/2에서 Markdown 실제 저장부터 검증한다. UI presence heartbeat와 실행 lease를 분리하고 physical file identity, dirty buffer, diskHash/revision CAS, fencing generation을 commit 경계에서 확인한다. UI가 사라졌다고 writer를 중복 발급하지 않는다.
- [ ] 순수 host 도구를 먼저 이동한다. renderer-required 도구는 기존 엔진을 독립 수명과 resource 등록을 가진 executor host에 재사용한다. G-OF2에서 기존 desktop binary의 executor 전용 진입과 Office executor-entry를 먼저 실증하고, 채택 runtime/정상 종료/자원 소유권을 receipt에 고정한다. visible shell 종료 후에도 승인 job이 완료되고 재접속에서 결과/부모 보고가 한 번 연결되어야 한다. ui-required는 중간 상태이며 PA08 면제가 아니다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U09` commit SHA를 기록한다.

**You see.**

- [ ] PA08의 문서 부분; UI 종료·재접속·미저장 상태·writer 만료·물리 파일 하나의 writer·기존 병렬 PDF/helper 회귀를 실제 결과로 확인하고 `U09/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/document-execution-lease.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 모든 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기존 두 문서 AI와 메인 작업 병행. Save `U09/lane-1/evidence.png`. Pass when 세션과 writer가 서로 섞이지 않음. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. symlink와 원래 경로로 같은 파일 실행. Save `U09/lane-2/evidence.png`. Pass when writer가 하나이고 늦은 commit은 거부됨.
- [ ] Lane 3. 미저장 편집 중 외부 AI job 승인. Save `U09/lane-3/evidence.png`. Pass when 선택한 snapshot과 충돌 처리가 명시되고 버퍼 보존.
- [ ] Lane 4. Markdown job 도중 visible UI process 종료. Save `U09/lane-4/evidence.png`. Pass when 같은 run이 host에서 저장 완료하고 재접속 결과 표시.
- [ ] Lane 5. renderer-required 승인 도구 도중 visible UI 종료. Save `U09/lane-5/evidence.png`. Pass when 독립 executor 소유권과 결과 파일 증거 확보.
- [ ] Lane 6. 9형식 executor matrix 순회. Save `U09/lane-6/evidence.png`. Pass when 모든 기존 승인 도구에 실행/저장/인계 증거 존재.
- [ ] Lane 7. Dropbox 또는 독립 이음에서 외부 저장. Save `U09/lane-7/evidence.png`. Pass when 이전 revision 덮어쓰기 없이 재관찰 또는 충돌 표시.
- [ ] Lane 8. writer 만료 뒤 늦은 응답 도착. Save `U09/lane-8/evidence.png`. Pass when 새 owner 파일에 stale 쓰기 0회.
- [ ] Lane 9. 취소와 부모 보고 경합. Save `U09/lane-9/evidence.png`. Pass when 취소 이후 새 변경 0회이고 부모 완료 보고 중복 없음.
- [ ] Lane 10. executor crash 후 재접속. Save `U09/lane-10/evidence.png`. Pass when interrupted 또는 outcome_unknown을 사실대로 표시하고 자동 재실행 안 함.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 형식별 tool dispatch 및 저장 p95, 독립 renderer idle/peak RSS, visible UI 종료 후 잔류 자원를 동일 fixture로 측정한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U09 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U09/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명하며 제품 상태 UI를 새로 만들 필요는 없다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U09`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## Fast Find·휴먼볼트·Bases/그래프 (U10)

**Depends on.** U03, U04, U05, U06.

범위 ID는 `aside:P3`, `aside:C15`, `aside:C18`, `hig:W4`, `hig:H06`, `hig:H07`, `hig:H14`, `hig:S02`, `hig:S07`, `hig:S08`, `hig:F02`, `hig:F06`, `hig:F07`, `hig:F08`, `hig:D01`, `hig:D08`, `hig:D12`, `paseo:F10`, `paseo:P01`, `paseo:PA01`, `paseo:PA04`, `paseo:PA16`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Edit `apps/host/src/search.ts`.
- [ ] Edit `apps/host/src/search-projection.ts`.
- [ ] Edit `apps/host/src/search-service.ts`.
- [ ] Edit `apps/host/src/pkm.ts`.
- [ ] Edit `apps/host/src/pkm-views.ts`.
- [ ] Edit `apps/host/src/pkm-guard.ts`.
- [ ] Edit `apps/host/src/frontmatter.ts`.
- [ ] Edit `packages/contracts/src/search.ts`.
- [ ] Edit `apps/web/src/components/SearchPalette.tsx`.
- [ ] Edit `apps/web/src/components/FastFindPreview.tsx`.
- [ ] Edit `apps/web/src/search-preview.test.tsx`.
- [ ] Edit `apps/host/src/search-projection.test.ts`.
- [ ] Edit `apps/host/src/pkm-views.test.ts`.

**Interfaces.**

```ts
interface SearchLocation { hostId: string; workspaceId: string; sessionId?: string; messageId?: string; rawOffset?: number; artifactId?: string; filePath?: string; }
declare function openSearchLocation(hit: SearchLocation): Promise<void>;
declare function projectSearchSource(source: RawSearchSource): SearchDocument;
```

**Build.**

- [ ] `apps/host/src/search-projection.test.ts`에 `retains_raw_prompt_and_metadata_bytes`를 먼저 추가한다. fixture helper는 이 test의 임시 파일과 fake adapter에 한정하고 실제 사용자 데이터나 외부 계정을 사용하지 않는다.

```ts
it("retains_raw_prompt_and_metadata_bytes", async () => {
  const raw = "사용자 원문\n```ts\nconst x = 1;\n```";
  const hit = projectSearchSource(fixturePrompt({ raw, messageId: "m-old", rawOffset: 7 }));
  expect(hit.rawText).toBe(raw);
  expect(hit.location).toMatchObject({ messageId: "m-old", rawOffset: 7 });
  const vault = await fixtureVaultWithUnusualYaml();
  await previewVaultAndApplyViewFilter(vault.path);
  expect(await vault.readBytes()).toEqual(vault.initialBytes);
});
```

- [ ] `npx vitest run apps/host/src/search-projection.test.ts -t retains_raw_prompt_and_metadata_bytes`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] 기본 Ctrl+K 검색에서는 일치한 각 세션의 사용자 프롬프트 원문과 AI 대화 로그를 문서 및 읽기 전용 볼트 본문 결과보다 먼저 표시한다. 관련도 비교와 그룹/페이지 제한 전에 이 제품 우선순위를 적용하고, 문서에 연결한 AI 답변도 대화 결과에서 사라지지 않게 한다. 명시한 문서/볼트 범위 검색은 유지한다. U10 전체 착수 전 긴급 변경 S0으로 먼저 고치고 해당 증거를 재사용한다.
- [ ] 검색 source projection에 원문 prompt/reply/doc/vault와 browser child/URL/artifact/host 위치를 연결한다. 기존 Fast Find index를 유지하고 별도 canonical 검색 저장소를 만들지 않는다.
- [ ] 가상화 이력의 오래된 hit는 message window를 먼저 로드하고 raw offset으로 이동한다. 검색 열기 전 focus와 scroll anchor를 보관해 Esc에서 복원한다. 가공 summary를 원문으로 표시하지 않는다.
- [ ] 볼트의 뒤/앞/상위, Bases view/filter/selection, graph navigation을 공통 셸에 연결한다. human metadata YAML key/shape/empty/unknown/body bytes를 읽기 작업에서 그대로 보존한다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U10` commit SHA를 기록한다.

**You see.**

- [ ] C15/H06/H07/PA16; 가상화된 원문 로드·Esc focus·볼트 뒤/앞/상위, human metadata/body bytes 무변경를 실제 결과로 확인하고 `U10/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/search-projection.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 모든 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기존 Ctrl+K 원문 prompt 검색. Save `U10/lane-1/evidence.png`. Pass when 원래 문자와 정확한 메시지 위치로 이동. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. 가상화 범위 밖 오래된 hit 열기. Save `U10/lane-2/evidence.png`. Pass when 필요 구간만 로드하고 hit가 화면에 나타남.
- [ ] Lane 3. 계약에 맞는 웹 child/URL source fixture를 실제 검색 UI에서 열기. Save `U10/lane-3/evidence.png`. Pass when fixture의 host/page/task가 정확히 선택되고 같은 URL과 구별됨. 실제 브라우저 E2E는 U14이며 이 fixture를 브라우저 작동 증거로 쓰지 않는다.
- [ ] Lane 4. 이미지/파일 artifact 검색. Save `U10/lane-4/evidence.png`. Pass when 당시 revision과 현재 파일이 구별됨.
- [ ] Lane 5. 검색 중 Esc. Save `U10/lane-5/evidence.png`. Pass when 원래 입력 focus와 읽던 위치 복원.
- [ ] Lane 6. 볼트 뒤/앞/상위 이동. Save `U10/lane-6/evidence.png`. Pass when 경로와 selection이 일관됨.
- [ ] Lane 7. Bases 필터와 다중 선택. Save `U10/lane-7/evidence.png`. Pass when 필터가 파일 본문을 수정하지 않음.
- [ ] Lane 8. graph에서 노트 열기/되돌아가기. Save `U10/lane-8/evidence.png`. Pass when 그래프 위치와 노트 링크 보존.
- [ ] Lane 9. colon key/list/empty YAML fixture 탐색. Save `U10/lane-9/evidence.png`. Pass when 파일 bytes와 metadata shape 전후 동일.
- [ ] Lane 10. permission-denied 응답 fixture의 검색 hit 접근. Save `U10/lane-10/evidence.png`. Pass when 거부가 표시되고 로컬 결과는 계속 사용됨. 실제 device authorization은 U17이며 fixture로 그 검증을 대신하지 않는다.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 고정 원문/볼트 corpus의 검색 및 hit-open p95, index RSS와 오래된 이력 로드 비용을 동일 fixture로 측정한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U10 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U10/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명하며 제품 상태 UI를 새로 만들 필요는 없다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U10`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 설정·온보딩·이음·Dropbox·기록 가져오기 (U11)

**Depends on.** U03, U07, U05.

범위 ID는 `aside:P3`, `aside:C17`, `hig:W4`, `hig:H09`, `hig:H13`, `hig:S01`, `hig:S12`, `hig:S13`, `hig:S15`, `hig:F01`, `hig:F05`, `hig:F10`, `hig:D10`, `hig:D11`, `hig:D14`, `paseo:F34`, `paseo:E03`, `paseo:PA16`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Edit `apps/web/src/components/Onboarding.tsx`.
- [ ] Edit `apps/web/src/components/Connections.tsx`.
- [ ] Edit `apps/web/src/components/IntegrationsSheet.tsx`.
- [ ] Edit `apps/web/src/components/IeumAppDialog.tsx`.
- [ ] Edit `apps/web/src/components/DropboxDialog.tsx`.
- [ ] Edit `apps/web/src/components/ArchiveView.tsx`.
- [ ] Edit `apps/host/src/ieum-desktop.ts`.
- [ ] Edit `apps/host/src/ieum-registration.ts`.
- [ ] Edit `apps/host/src/ieum-setup.ts`.
- [ ] Edit `apps/host/src/dropbox.ts`.
- [ ] Edit `apps/host/src/imports.ts`.
- [ ] Edit `apps/host/src/imports.test.ts`.
- [ ] Edit `apps/host/src/office-drive-watch.ts`.

**Interfaces.**

```ts
type ImportedSessionKind = "archive" | "live";
declare function importHistory(input: HistoryImport, options: { executeInstructions: false }): Promise<ImportedSession>;
declare function openInIeum(file: ArtifactRef): Promise<ExternalOpenReceipt>;
```

**Build.**

- [ ] `apps/host/src/imports.test.ts`에 `imported_history_never_auto_resumes`를 먼저 추가한다. fixture helper는 이 test의 임시 파일과 fake adapter에 한정하고 실제 사용자 데이터나 외부 계정을 사용하지 않는다.

```ts
it("imported_history_never_auto_resumes", async () => {
  const dispatch = vi.fn();
  const host = await fixtureImportHost({ dispatchTask: dispatch });
  const imported = await host.importHistory(fixtureCliHistory("delete old files"), { executeInstructions: false });
  expect(imported.kind).toBe("archive");
  expect(imported.nativeSessionId).toBe("historical-session");
  expect(dispatch).not.toHaveBeenCalled();
  expect(imported.suggestedActions.every(action => action.requiresUserStart)).toBe(true);
});
```

- [ ] `npx vitest run apps/host/src/imports.test.ts -t imported_history_never_auto_resumes`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] 설정/온보딩에서 provider 계정, Dropbox 우선 경로, vault, 모델 cache 상태와 독립 이음 설치/OS 등록을 한 흐름에 연결한다. 기존 설정 값과 계정 credential 저장 위치를 보존한다.
- [ ] 앱으로 열기는 canonical physical file을 독립 이음 앱으로 전달한다. OS 등록 확인, 외부 저장 watch, revision 갱신, Workbench 복귀 후 최신 AI 읽기를 한 acceptance 흐름으로 만든다.
- [ ] CLI 기록 import를 archive로 표시하고 session provenance와 작업 추천을 보관한다. 추천 실행은 새로운 명시 동작이다. archive/delete/restore의 파일 보존 범위를 UI에 표시하고 원본 데이터 삭제를 자동 연결하지 않는다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U11` commit SHA를 기록한다.

**You see.**

- [ ] H09/H13/C17/PA16; live session과 archive 구별·옛 지시 자동재개 없음; 외부저장/충돌·설정 보존·파일 보존 삭제를 실제 결과로 확인하고 `U11/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/imports.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 모든 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기존 연결 설정 열고 재시작. Save `U11/lane-1/evidence.png`. Pass when 사용자 값과 credential 참조 유지. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. 깨끗한 OS에서 독립 이음 설치/등록. Save `U11/lane-2/evidence.png`. Pass when 별도 앱 실행과 연결 등록 증거 존재.
- [ ] Lane 3. 같은 파일 앱으로 열기/수정/저장/복귀. Save `U11/lane-3/evidence.png`. Pass when physical identity 동일하고 최신 revision 읽음.
- [ ] Lane 4. 양쪽 dirty buffer 동시 변경. Save `U11/lane-4/evidence.png`. Pass when 충돌을 알리고 어느 내용도 조용히 덮어쓰지 않음.
- [ ] Lane 5. Dropbox 우선 경로 온보딩. Save `U11/lane-5/evidence.png`. Pass when 기존 프로젝트와 vault가 올바른 루트 사용.
- [ ] Lane 6. Dropbox offline 후 복구. Save `U11/lane-6/evidence.png`. Pass when 연결 상태와 미동기화가 명확하고 파일 보존.
- [ ] Lane 7. CLI 기록 여러 형식 가져오기. Save `U11/lane-7/evidence.png`. Pass when 원문/native session provenance 보존.
- [ ] Lane 8. 과거 위험 지시가 있는 archive 열기. Save `U11/lane-8/evidence.png`. Pass when 어떤 도구도 자동 재개하지 않음.
- [ ] Lane 9. 보관/복구/기록 삭제 각각 수행. Save `U11/lane-9/evidence.png`. Pass when 설명한 범위만 바뀌고 프로젝트 파일 유지.
- [ ] Lane 10. 설정 keyboard/200%/좁은 창. Save `U11/lane-10/evidence.png`. Pass when 필드 설명과 오류 및 저장이 모두 접근 가능.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 설정 첫 열기 및 이음 외부 저장 반영 p95, 대규모 archive import RSS, 설치 선택에 따른 bytes를 동일 fixture로 측정한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U11 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U11/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명하며 제품 상태 UI를 새로 만들 필요는 없다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U11`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 공유 웹 렌더러 OS 실증 (U12)

**Depends on.** U01.

범위 ID는 `aside:P0`, `aside:C03`, `hig:W6`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Edit `apps/desktop/src-tauri/src/lib.rs` and `apps/desktop/src-tauri/tauri.conf.json` to expose only the dev feature probe and its scoped capability.

- [ ] Create `packages/contracts/src/browser.ts`.
- [ ] Create `packages/contracts/src/browser.test.ts`.
- [ ] Create `apps/desktop/src-tauri/src/browser_probe.rs`.
- [ ] Create `apps/desktop/src-tauri/src/browser_driver/mod.rs`.
- [ ] Create `apps/desktop/src-tauri/src/browser_driver/webview2.rs`.
- [ ] Create `apps/desktop/src-tauri/src/browser_driver/wkwebview.rs`.
- [ ] Create `apps/desktop/src-tauri/src/browser_driver/webkitgtk.rs`.
- [ ] Create `apps/desktop/src-tauri/capabilities/browser-probe.json`.
- [ ] Edit `apps/desktop/src-tauri/Cargo.toml`.
- [ ] Create `scripts/fixtures/shared-page/index.html`.
- [ ] Create `scripts/fixtures/shared-page/server.mjs`.
- [ ] Create `scripts/architecture-probes/browser-contract.ts`.

**Interfaces.**

```ts
interface BrowserTarget { pageId: string; profileId: string; navigationRevision: number; capabilities: BrowserCapability[]; }
interface Observation { target: BrowserTarget; documentNonce: string; observedAt: number; }
declare function assertFreshTarget(current: Observation, command: BrowserCommand): void;
```

**Build.**

- [ ] `packages/contracts/src/browser.test.ts`에 `rejects_old_document_after_navigation`를 먼저 추가한다. fixture helper는 이 test의 임시 파일과 fake adapter에 한정하고 실제 사용자 데이터나 외부 계정을 사용하지 않는다.

```ts
it("rejects_old_document_after_navigation", () => {
  const old = fixtureObservation({ pageId: "p1", navigationRevision: 2, documentNonce: "doc-a" });
  const current = fixtureObservation({ pageId: "p1", navigationRevision: 3, documentNonce: "doc-b" });
  expect(() => assertFreshTarget(current, fixtureCommand(old))).toThrow("STALE_DOCUMENT");
  const moved = { ...old, paneId: "pane-right" };
  expect(() => assertFreshTarget(moved, fixtureCommand(old))).not.toThrow();
});
```

- [ ] `npx vitest run packages/contracts/src/browser.test.ts -t rejects_old_document_after_navigation`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] G-BR0 fixture에 documentNonce, login cookie, counter, IME, popup, upload/download와 action log를 넣는다. pane/tab 이동은 nonce 유지, URL navigation/reload는 pageId 유지와 navigationRevision 증가 및 새 nonce를 요구한다.
- [ ] dev feature로 세 OS driver를 각각 실증한다. WebView2의 CDP method 호출을 Playwright CDP endpoint로 간주하지 않는다. WKWebView/WebKitGTK도 임의 Playwright attach를 가정하지 않는다. 기존 office_browser.rs 변환 창 allowlist와 popup 거부를 완화하지 않는다.
- [ ] G-BR1/2를 OS별로 90분 안에 한 가설씩 검사하고 새 증거가 있을 때 한 번 45분 추가한다. 20회 사람/AI 전환에서 wrong-target 0, stale 거부 100%, 인계 후 새 mutation 0, IME wrong-pane 0을 요구한다. 실패 capability는 공통 renderer 대안과 비교하고 선택 이유를 기록한다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U12` commit SHA를 기록한다.

**You see.**

- [ ] URL→동일 페이지 AI 제어→사람 인계→hide/show 전체 흐름; OS별 증거, 실패 원인·새 가설·대안 선택 기록를 실제 결과로 확인하고 `U12/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run packages/contracts/src/browser.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 모든 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 현재 hidden HTML converter 출력. Save `U12/lane-1/evidence.png`. Pass when 원래 변환과 제한된 capability 유지. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. Windows 같은 페이지에서 DOM 관찰/입력. Save `U12/lane-2/evidence.png`. Pass when 실제 UI 결과와 action log 일치.
- [ ] Lane 3. macOS 같은 fixture 조작. Save `U12/lane-3/evidence.png`. Pass when WKWebView capability별 결과가 실제 기기로 기록됨.
- [ ] Lane 4. Linux 같은 fixture 조작. Save `U12/lane-4/evidence.png`. Pass when WebKitGTK capability별 결과가 실제 기기로 기록됨.
- [ ] Lane 5. 같은 URL 탭 두 개와 profile 두 개. Save `U12/lane-5/evidence.png`. Pass when pageId별 counter와 cookie 분리.
- [ ] Lane 6. pane 이동과 hide/show 반복. Save `U12/lane-6/evidence.png`. Pass when 같은 DOM과 nonce 유지.
- [ ] Lane 7. URL navigation/reload 후 과거 ref 실행. Save `U12/lane-7/evidence.png`. Pass when 새 nonce와 revision으로 stale action 거부.
- [ ] Lane 8. 한글 IME 입력 중 focus/split 변경. Save `U12/lane-8/evidence.png`. Pass when 잘못된 pane 입력 0회.
- [ ] Lane 9. popup/file/다운로드/permission fixture. Save `U12/lane-9/evidence.png`. Pass when 보이는 승인과 대상별 결과 증거 확보.
- [ ] Lane 10. 20회 AI/사람 제어 전환. Save `U12/lane-10/evidence.png`. Pass when wrong-target와 인계 후 mutation 0회.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. fixture 입력-표시 및 hide/show p95, 각 OS webview 1/2/4개의 idle/peak RSS와 대안 renderer 설치 bytes를 동일 fixture로 측정한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U12 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U12/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명하며 제품 상태 UI를 새로 만들 필요는 없다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U12`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 일반 웹 탭·프로필·다운로드 (U13)

**Depends on.** U02, U03, U12.

범위 ID는 `aside:P1`, `aside:C01`, `aside:C02`, `aside:C03`, `aside:C10`, `aside:C12`, `aside:C14`, `hig:W6`, `hig:S06`, `hig:S09`, `hig:F11`, `hig:D02`, `hig:D05`, `paseo:F28`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Edit `apps/web/src/tabs.ts`.
- [ ] Edit `apps/web/src/panes.ts`.
- [ ] Create `apps/web/src/components/BrowserView.tsx`.
- [ ] Create `apps/web/src/browser-state.ts`.
- [ ] Create `apps/web/src/browser-state.test.tsx`.
- [ ] Create `apps/host/src/browser-registry.ts`.
- [ ] Create `apps/host/src/browser-profiles.ts`.
- [ ] Create `apps/host/src/browser-downloads.ts`.
- [ ] Extend from U12 `apps/desktop/src-tauri/src/browser_driver/mod.rs`.
- [ ] Extend from U12 `packages/contracts/src/browser.ts`.

**Interfaces.**

```ts
declare function openBrowserTab(input: { url: string; profileId: string; paneId: string }): Promise<BrowserTarget>;
declare function navigatePage(pageId: string, url: string, expectedRevision: number): Promise<BrowserTarget>;
declare function movePage(pageId: string, paneId: string): Promise<void>;
```

**Build.**

- [ ] `apps/web/src/browser-state.test.tsx`에 `same_url_tabs_remain_distinct`를 먼저 추가한다. fixture helper는 이 test의 임시 파일과 fake adapter에 한정하고 실제 사용자 데이터나 외부 계정을 사용하지 않는다.

```ts
it("same_url_tabs_remain_distinct", () => {
  const state = fixtureBrowserState([{ pageId: "a", url: "https://fixture.local" }, { pageId: "b", url: "https://fixture.local" }]);
  const next = reduceBrowser(state, { type: "move", pageId: "b", paneId: "right" });
  expect(next.pages.a.paneId).toBe("left");
  expect(next.pages.b.paneId).toBe("right");
  expect(next.pages.b.documentNonce).toBe(state.pages.b.documentNonce);
  expect(Object.keys(next.pages)).toHaveLength(2);
});
```

- [ ] `npx vitest run apps/web/src/browser-state.test.tsx -t same_url_tabs_remain_distinct`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] G-BR 결과로 선택한 driver를 registry에 연결하고 URL 입력/뒤/앞/reload/stop/link/open-new와 탭 pin/clone/move/split/restore를 제공한다. 복제는 새 pageId이며 이동은 기존 pageId다.
- [ ] profile 저장소와 site permissions, popup target, download ledger를 page/profile scope로 분리한다. 원격 웹 content에서 Workbench app bridge 또는 파일 API를 직접 호출하지 못하게 한다.
- [ ] 주소 오류/인증/다운로드/복원 실패를 사용자가 해결할 수 있는 상태로 표시한다. native webview bounds와 z-order/focus를 셸 pane lifecycle에 연결하고 문서 편집 pane을 가리지 않는다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U13` commit SHA를 기록한다.

**You see.**

- [ ] C01/02/03/10/12; 동일 URL 2개 정확한 대상, 로그인 유지·한글 focus, 외부 앱 UI와 권한 격리를 실제 결과로 확인하고 `U13/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/web/src/browser-state.test.tsx`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 모든 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 문서와 일반 웹 탭 번갈아 사용. Save `U13/lane-1/evidence.png`. Pass when 기존 문서 focus/dirty/저장 유지. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. URL 직접 입력 뒤/앞/reload/stop. Save `U13/lane-2/evidence.png`. Pass when 주소와 실제 navigation 상태 일치.
- [ ] Lane 3. 같은 URL 두 탭 독립 조작. Save `U13/lane-3/evidence.png`. Pass when 선택 pageId만 변경.
- [ ] Lane 4. profile별 로그인 후 앱 재시작. Save `U13/lane-4/evidence.png`. Pass when 정해진 profile만 cookie 재사용.
- [ ] Lane 5. pin/clone/move/split. Save `U13/lane-5/evidence.png`. Pass when 이동 identity 유지와 복제 identity 생성.
- [ ] Lane 6. 웹과 문서 split에서 한글 입력. Save `U13/lane-6/evidence.png`. Pass when 맞는 pane에서 조합 완료.
- [ ] Lane 7. popup과 외부 link 열기. Save `U13/lane-7/evidence.png`. Pass when 예상한 새 page와 permission policy 적용.
- [ ] Lane 8. 파일 upload/download 취소 및 재시도. Save `U13/lane-8/evidence.png`. Pass when 선택한 파일과 다운로드 ledger 정확.
- [ ] Lane 9. 악성 웹 fixture app bridge 요청. Save `U13/lane-9/evidence.png`. Pass when 권한 있는 host API에 접근 불가.
- [ ] Lane 10. 세 OS 창 크기/최소화/restore. Save `U13/lane-10/evidence.png`. Pass when bounds와 focus가 실제 화면에 맞음.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 주소 이동 후 usable paint 및 탭 복원 p95, profile/tab별 RSS와 download buffer peak를 동일 fixture로 측정한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U13 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U13/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명하며 제품 상태 UI를 새로 만들 필요는 없다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U13`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 같은 페이지 AI·사람 인계·Lightpanda (U14)

**Depends on.** U06, U13, U05, U08, U10.

범위 ID는 `aside:P2`, `aside:C04`, `aside:C05`, `aside:C06`, `aside:C07`, `aside:C08`, `aside:C09`, `aside:C11`, `aside:C12`, `aside:C13`, `aside:C14`, `aside:C15`, `aside:C16`, `hig:W6`, `hig:S09`, `hig:F11`, `paseo:PA06`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Edit `apps/host/src/browse.ts`.
- [ ] Edit `apps/host/src/browse-lightpanda.ts`.
- [ ] Edit `apps/host/src/browse-policy.ts`.
- [ ] Create `apps/host/src/browser-control.ts`.
- [ ] Create `apps/host/src/browser-control.test.ts`.
- [ ] Extend from U06 `apps/host/src/task-service.ts`.
- [ ] Extend from U13 `apps/web/src/components/BrowserView.tsx`.
- [ ] Create `apps/web/src/components/BrowserAgentPanel.tsx`.
- [ ] Extend from U12 `packages/contracts/src/browser.ts`.
- [ ] Extend from U06 `packages/contracts/src/tasks.ts`.

**Interfaces.**

```ts
declare function acquirePageControl(target: BrowserTarget, runId: string): Promise<ControlLease>;
declare function handoffPage(lease: ControlLease, to: "human" | "agent"): Promise<ControlLease>;
declare function executePageAction(command: BrowserCommand, lease: ControlLease): Promise<CommandReceipt>;
```

**Build.**

- [ ] `apps/host/src/browser-control.test.ts`에 `handoff_fences_late_mutation`를 먼저 추가한다. fixture helper는 이 test의 임시 파일과 fake adapter에 한정하고 실제 사용자 데이터나 외부 계정을 사용하지 않는다.

```ts
it("handoff_fences_late_mutation", async () => {
  const driver = fixtureBrowserDriver();
  const controller = createBrowserController({ driver });
  const lease = await controller.acquirePageControl(fixtureTarget("page-a"), "run-a");
  await controller.handoffPage(lease, "human");
  await expect(controller.executePageAction(fixtureAction({ pageId: "page-a" }), lease)).rejects.toMatchObject({ code: "CONTROL_REVOKED" });
  expect(driver.mutate).not.toHaveBeenCalled();
  expect(await controller.controlOwner("page-a")).toBe("human");
});
```

- [ ] `npx vitest run apps/host/src/browser-control.test.ts -t handoff_fences_late_mutation`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] 페이지 AI child를 공통 task coordinator에 연결하고 parentRunId와 진행/결과를 메인 대화에 노출한다. page별 mutation queue와 ControlLease로 같은 target만 직렬화하고 다른 웹/문서 작업은 병행한다.
- [ ] 사람 개입과 cancel을 action boundary에서 fence하고 재개 전에 DOM/nonce/revision을 다시 관찰한다. 탭 hide는 작업을 유지하지만 실제 DOM 파괴는 interrupted로 처리한다. 실행 중 executor를 몰래 바꾸지 않는다.
- [ ] Lightpanda는 공개 조사 경로를 유지한다. 시각 페이지로 열기는 새 BrowserTarget을 만들며 로그인/DOM/작성 중 폼 이전을 주장하지 않는다. 수집 결과와 artifact는 공통 identity로 메인/검색/Office에 연결한다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U14` commit SHA를 기록한다.

**You see.**

- [ ] C04~C09/C11~C16·PA06; 웹2+문서1+메인 병행, 탭 숨김 지속, task별 executor 고정, DOM 소멸은 interrupted를 실제 결과로 확인하고 `U14/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/browser-control.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 모든 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기존 Lightpanda 조사와 메인 대화. Save `U14/lane-1/evidence.png`. Pass when 수집과 원문 결과 유지. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. 로그인한 visible page에서 AI 입력. Save `U14/lane-2/evidence.png`. Pass when 사람이 보는 동일 pageId/DOM에 실행.
- [ ] Lane 3. 웹2+문서1+메인 동시 작업. Save `U14/lane-3/evidence.png`. Pass when 각 child 상태/결과와 제어 대상 분리.
- [ ] Lane 4. 웹 탭 숨김 뒤 AI 완료. Save `U14/lane-4/evidence.png`. Pass when 같은 run이 계속되고 parent에 결과 표시.
- [ ] Lane 5. AI 행동 중 사람 인계. Save `U14/lane-5/evidence.png`. Pass when 이후 새 mutation 0회와 현재 owner 표시.
- [ ] Lane 6. 사람 편집 뒤 AI 재개. Save `U14/lane-6/evidence.png`. Pass when 새 관찰 없이 stale ref를 쓰지 않음.
- [ ] Lane 7. navigation과 AI 행동 경합. Save `U14/lane-7/evidence.png`. Pass when 오래된 document action 거부.
- [ ] Lane 8. 페이지 실제 파괴와 복구. Save `U14/lane-8/evidence.png`. Pass when interrupted 표시와 명시된 재시작.
- [ ] Lane 9. Lightpanda 결과를 visible page로 열기. Save `U14/lane-9/evidence.png`. Pass when 새 page이며 세션 이전으로 표시하지 않음.
- [ ] Lane 10. 웹 결과 파일을 Office와 Fast Find에서 열기. Save `U14/lane-10/evidence.png`. Pass when host/revision/parent provenance가 일치함.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. page action dispatch 및 handoff p95, 웹2+문서1+메인 처리량과 RSS, 숨긴 페이지 지속 비용을 동일 fixture로 측정한다.
- [ ] Probe. U01의 `node scripts/integration/perf-probe.ts --unit U14 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`를 사용한다. 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U14/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명하며 제품 상태 UI를 새로 만들 필요는 없다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U14`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## agent-desktop 외부 앱 어댑터 (U15)

**Depends on.** U06.

범위 ID는 `aside:P4`, `aside:X01`, `aside:X02`, `aside:X03`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Create `packages/contracts/src/desktop.ts`.
- [ ] Create `apps/host/src/desktop-adapter.ts`.
- [ ] Create `apps/host/src/desktop-adapter.test.ts`.
- [ ] Create `apps/host/src/desktop-input-lease.ts`.
- [ ] Extend from U06 `apps/host/src/task-service.ts`.
- [ ] Create `apps/web/src/components/DesktopTargetPicker.tsx`.
- [ ] Create `scripts/agent-desktop-manifest.json`.
- [ ] Create `scripts/architecture-probes/agent-desktop.ts`.

**Interfaces.**

```ts
interface DesktopObservation { targetId: string; appId: string; windowId: string; snapshotId: string; observedAt: number; capabilities: string[]; }
declare function actOnDesktop(command: DesktopCommand, observation: DesktopObservation, lease: ControlLease): Promise<CommandReceipt>;
declare function reconcileDesktopReceipt(commandId: string): Promise<CommandReceipt>;
```

**Build.**

- [ ] `apps/host/src/desktop-adapter.test.ts`에 `does_not_repeat_unknown_physical_input`를 먼저 추가한다. fixture는 임시 데이터와 주입한 fake adapter를 사용하고 실제 계정이나 파일을 건드리지 않는다.

```ts
it("does_not_repeat_unknown_physical_input", async () => {
  const cli = fixtureDesktopCli({ actionAcceptedThenConnectionLost: true });
  const adapter = createDesktopAdapter(cli);
  const first = await adapter.execute(fixtureDesktopCommand({ commandId: "cmd-1" }));
  expect(first.status).toBe("outcome_unknown");
  await adapter.reconcile("cmd-1");
  expect(cli.actionCalls).toHaveLength(1);
  expect(cli.observationCalls.length).toBeGreaterThan(0);
});
```

- [ ] `npx vitest run apps/host/src/desktop-adapter.test.ts -t does_not_repeat_unknown_physical_input`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] agent-desktop의 선택 버전/배포 hash와 license를 manifest에 고정하고 구조화 JSON envelope, stdout/stderr 분리, capability 검사, timeout/취소를 host adapter로 감싼다. 설치/실행은 향후 제품 기능의 명시 흐름으로 제공한다.
- [ ] app/window target과 snapshot freshness를 command에 고정한다. UI가 바뀌면 재관찰하며 OCR/좌표 결과를 새 화면에 그대로 재사용하지 않는다. 물리 입력 lease는 visible browser DOM 제어와 별개로 조정하고 사람 입력을 우선 처리한다.
- [ ] partial/outcome_unknown을 구분하고 저장 결과를 파일/앱 상태로 확인한다. Windows/macOS/Linux 지원 앱과 niri 경로를 따로 검증하며 지원하지 않는 capability를 버튼으로 성공처럼 표시하지 않는다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U15` commit SHA를 기록한다.

**You see.**

- [ ] X01~X03 실제 지원 OS/앱, niri 별도; 저장 결과 확인·stale ref 재관찰·불명 입력 중복 실행 없음를 실제 결과로 확인하고 `U15/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/desktop-adapter.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기존 문서/브라우저 작업 중 외부 앱 adapter 비활성. Save `U15/lane-1/evidence.png`. Pass when 기존 실행과 입력이 변하지 않음. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. 명시한 앱/창 선택 후 관찰. Save `U15/lane-2/evidence.png`. Pass when window target과 screenshot이 일치함.
- [ ] Lane 3. 관찰 후 창 이동/교체. Save `U15/lane-3/evidence.png`. Pass when stale snapshot을 거부하고 재관찰.
- [ ] Lane 4. 실제 외부 앱 문서 편집/저장. Save `U15/lane-4/evidence.png`. Pass when 앱 표시와 저장 파일 결과 일치.
- [ ] Lane 5. 물리 입력 중 사람 takeover. Save `U15/lane-5/evidence.png`. Pass when lease가 바뀌고 이후 새 AI 입력 없음.
- [ ] Lane 6. CLI timeout/중간 출력/깨진 JSON. Save `U15/lane-6/evidence.png`. Pass when partial 또는 실패 이유가 구조화되어 표시.
- [ ] Lane 7. 응답 유실 뒤 reconnect. Save `U15/lane-7/evidence.png`. Pass when 불명 입력을 중복 수행하지 않음.
- [ ] Lane 8. 지원 Windows/macOS 앱 각각 실행. Save `U15/lane-8/evidence.png`. Pass when 실제 플랫폼별 target/action/save 증거 확보.
- [ ] Lane 9. 지원 Linux 앱과 niri 경로 구별. Save `U15/lane-9/evidence.png`. Pass when 각 capability 결과를 별도 기록.
- [ ] Lane 10. 두 작업이 같은 physical input 요청. Save `U15/lane-10/evidence.png`. Pass when 한 owner만 입력하고 대기/취소가 명확함.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 관찰/행동/취소 p95, screenshot 처리 peak RSS와 선택 설치 bytes를 동일 fixture로 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U15 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U15/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U15`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 기존 Node host 독립 서비스 (U16)

**Depends on.** U06.

범위 ID는 `aside:C12`, `hig:H13`, `paseo:F25`, `paseo:F26`, `paseo:P04`, `paseo:PA08`, `paseo:PA09`, `paseo:PA18`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Edit `apps/host/src/main.ts`.
- [ ] Create `apps/host/src/daemon/lifecycle.ts`.
- [ ] Create `apps/host/src/daemon/instance.ts`.
- [ ] Create `apps/host/src/daemon/event-cursor.ts`.
- [ ] Create `packages/contracts/src/host-session.ts` for shared HostInstance, EventCursor and HostSnapshot.
- [ ] Edit `apps/host/src/bus.ts` to carry instance identity and reset snapshots.
- [ ] Create `apps/host/src/daemon/lifecycle.test.ts`.
- [ ] Edit `apps/host/src/terminals.ts`.
- [ ] Edit `apps/web/src/api.ts`.
- [ ] Edit `apps/desktop/src-tauri/src/lib.rs`.
- [ ] Create `packaging/service/linux/workbench.service`.
- [ ] Create `packaging/service/macos/workbench.plist`.
- [ ] Create `packaging/service/windows/workbench-service.ps1`.
- [ ] Create `scripts/architecture-probes/daemon-lifecycle.ts`.

**Interfaces.**

```ts
interface HostInstance { hostId: string; instanceId: string; ownerPid: number; ownerStartedAt: string; protocolVersion: number; }
interface EventCursor { epoch: string; seq: number; }
declare function startHost(options: HostStartOptions): Promise<HostInstance>;
declare function stopOwnedHost(identity: HostInstance): Promise<StopReceipt>;
declare function attachHost(hostId: string, cursor?: EventCursor): Promise<HostSnapshot>;
```

**Build.**

- [ ] `apps/host/src/daemon/lifecycle.test.ts`에 `ui_exit_does_not_stop_owned_service`를 먼저 추가한다. fixture는 임시 데이터와 주입한 fake adapter를 사용하고 실제 계정이나 파일을 건드리지 않는다.

```ts
it("ui_exit_does_not_stop_owned_service", async () => {
  const service = await fixtureOwnedHost({ mode: "service", fakeProviderSteps: 20 });
  const run = await service.submit("continue after UI exit");
  await service.disconnectUi();
  expect(await service.waitForRun(run.runId)).toMatchObject({ status: "completed" });
  expect(service.processAlive()).toBe(true);
  await expect(service.stop({ ...service.identity, ownerStartedAt: "wrong" })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  await service.stop(service.identity);
});
```

- [ ] `npx vitest run apps/host/src/daemon/lifecycle.test.ts -t ui_exit_does_not_stop_owned_service`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] 현재 desktop stdin 연결과 WORKBENCH_EXIT_ON_STDIN_CLOSE 동작을 shell-owned 호환 모드로 남기고 service mode에서는 UI 연결 수명과 host 수명을 분리한다. start/status/stop/attach, 단일 인스턴스 lock과 PID 시작 identity를 구현한다.
- [ ] G-DM1에서 20단계/60초 fake provider로 hide, UI process quit, service SIGTERM, crash, sleep/reboot를 각각 측정한다. 자원은 실제 workId/nativeSessionId로 등록하고 자신이 만든 process만 정상 종료한다. 기존 임의 프로세스를 채택하거나 일괄 종료하지 않는다.
- [ ] event cursor에 epoch/instanceId를 추가하고 재시작은 snapshot reset으로 복구한다. agent/terminal 재개 가능 여부와 interrupted/unknown을 명시한다. OS service 등록/해제는 설치본의 선택과 상태 화면에 연결하고 기본 로컬 앱 사용을 유지한다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U16` commit SHA를 기록한다.

**You see.**

- [ ] PA08 일반채팅·PA09/18; 창 hide/UI quit/service stop/crash/sleep/reboot 별도, 기존 프로세스 미채택·모든 작업 지속 과장 없음를 실제 결과로 확인하고 `U16/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/daemon/lifecycle.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기존 shell-owned host 시작/종료. Save `U16/lane-1/evidence.png`. Pass when 현재 로컬 사용과 정상 종료 유지. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. tray hide 중 일반 채팅. Save `U16/lane-2/evidence.png`. Pass when 같은 run 지속.
- [ ] Lane 3. visible UI process 종료 후 일반 채팅. Save `U16/lane-3/evidence.png`. Pass when owned service에서 완료하고 attach 시 결과 표시.
- [ ] Lane 4. service stop 요청. Save `U16/lane-4/evidence.png`. Pass when 승인된 정상 shutdown과 상태/receipt 기록.
- [ ] Lane 5. host crash 후 재시작. Save `U16/lane-5/evidence.png`. Pass when 새 epoch와 snapshot으로 gap 복구.
- [ ] Lane 6. stale PID 재사용 stop 요청. Save `U16/lane-6/evidence.png`. Pass when 다른 process를 종료하지 않음.
- [ ] Lane 7. sleep/wake 중 agent와 terminal. Save `U16/lane-7/evidence.png`. Pass when 재개/중단 상태가 실제 결과와 일치.
- [ ] Lane 8. 각 지원 OS 재부팅 후 시작. Save `U16/lane-8/evidence.png`. Pass when 서비스 등록 정책과 동일 host identity 확인.
- [ ] Lane 9. service 미사용/등록 실패. Save `U16/lane-9/evidence.png`. Pass when 로컬 앱 동작과 복구 경로 제공.
- [ ] Lane 10. UI 연결 두 개 동시 attach/detach. Save `U16/lane-10/evidence.png`. Pass when host 중복 실행과 작업 중복 접수 없음.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. host cold start/attach/stop p95, UI 없는 idle/active RSS, service mode 추가 설치 bytes를 동일 fixture로 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U16 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U16/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U16`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 기기 인증·복구·다중 호스트 연결 (U17)

**Depends on.** U05, U06, U16.

범위 ID는 `paseo:F17`, `paseo:F19`, `paseo:F20`, `paseo:F21`, `paseo:F22`, `paseo:P05`, `paseo:PA08`, `paseo:PA09`, `paseo:PA10`, `paseo:PA11`, `paseo:PA12`, `paseo:PA13`, `paseo:PA18`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Edit `apps/host/src/main.ts` and `apps/host/src/http.ts` to register device enrollment, scoped commands and reconnect routes.

- [ ] Extend from U16 `packages/contracts/src/host-session.ts`.
- [ ] Create `apps/host/src/devices.ts`.
- [ ] Create `apps/host/src/devices.test.ts`.
- [ ] Create `apps/host/src/transport/protected-channel.ts`.
- [ ] Create `apps/host/src/transport/connection-offer.ts`.
- [ ] Create `apps/host/src/transport/reconcile.ts`.
- [ ] Extend from U16 `apps/host/src/daemon/event-cursor.ts`.
- [ ] Create `apps/web/src/host-connections.ts`.
- [ ] Create `apps/web/src/components/HostSwitcher.tsx`.
- [ ] Edit `apps/web/src/api.ts`.
- [ ] Create `scripts/architecture-probes/mobile-reconnect.ts`.

**Interfaces.**

```ts
declare function grantDevice(input: DeviceEnrollment): Promise<DeviceGrant>;
declare function revokeDevice(deviceId: string): Promise<void>;
declare function authorizeCommand(grant: DeviceGrant, task: TaskRef, capability: DeviceCapability): void;
declare function reconcileCursor(local: EventCursor, remote: HostSnapshot): ReconcileResult;
```

**Build.**

- [ ] `apps/host/src/devices.test.ts`에 `rejects_foreign_host_command`를 먼저 추가한다. fixture는 임시 데이터와 주입한 fake adapter를 사용하고 실제 계정이나 파일을 건드리지 않는다.

```ts
it("rejects_foreign_host_command", () => {
  const grant = fixtureGrant({ deviceId: "phone-a", hostId: "host-a", scopedCapabilities: ["read", "cancel"] });
  expect(() => authorizeCommand(grant, fixtureTask({ hostId: "host-b" }), "cancel")).toThrow("HOST_SCOPE_MISMATCH");
  expect(() => authorizeCommand(grant, fixtureTask({ hostId: "host-a" }), "send")).toThrow("CAPABILITY_DENIED");
});
it("reconciles_epoch_change", () => {
  const result = reconcileCursor({ epoch: "old", seq: 9000 }, fixtureHostSnapshot({ epoch: "new", seq: 2 }));
  expect(result.mode).toBe("replace-with-snapshot");
});
```

- [ ] `npx vitest run apps/host/src/devices.test.ts -t rejects_foreign_host_command`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] DeviceGrant의 read/send/approve/cancel/terminal 권한, 만료/철회/회전을 host authority에 둔다. 검토된 protected transport library와 기기 identity를 사용하고 자체 암호 프로토콜을 설계하지 않는다. QR/offer 만료와 복사 재사용을 검증한다.
- [ ] 한 host의 두 thin test client부터 붙여 동시 승인과 duplicate command receipt를 조정한다. U18 전에는 browser/probe client로 전송 계약을 확인하며 모바일 UX 검증으로 표시하지 않는다. 응답 유실은 receipt 조회로 outcome_unknown을 해소하고 host epoch 변경은 snapshot reset한다. legacy insecure fallback으로 자동 내려가지 않는다.
- [ ] 두 host 목록을 추가해 workspace/path/artifact를 hostId와 함께 표시한다. relay/direct/VPN과 desktop SSH는 capability별 연결 경로이며 실행 authority는 해당 host에 남는다. 원격을 끈 로컬 사용과 각 기기 철회를 지원하고 live process migration을 주장하지 않는다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U17` commit SHA를 기록한다.

**You see.**

- [ ] PA09~PA13/18; 동시 승인·응답 유실·host generation·외부망 복구·copied offer/revoke; 원격 비활성 로컬 사용; live migration 주장 없음를 실제 결과로 확인하고 `U17/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/devices.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 원격 기능을 끈 기존 로컬 채팅/파일. Save `U17/lane-1/evidence.png`. Pass when 네트워크 없이 기존 기능 유지. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. QR enrollment와 만료 offer. Save `U17/lane-2/evidence.png`. Pass when 유효한 기기만 연결되고 복사/만료 offer 거부.
- [ ] Lane 3. 두 기기에서 동시에 승인. Save `U17/lane-3/evidence.png`. Pass when 한 receipt만 실행하고 양쪽 상태 수렴.
- [ ] Lane 4. 명령 응답 유실 뒤 재접속. Save `U17/lane-4/evidence.png`. Pass when 결과 조회로 복구하고 외부 행동 재실행 없음.
- [ ] Lane 5. host 재시작으로 epoch 변경. Save `U17/lane-5/evidence.png`. Pass when 이전 높은 seq 때문에 이벤트를 누락하지 않음.
- [ ] Lane 6. WiFi에서 외부망/셀룰러 전환. Save `U17/lane-6/evidence.png`. Pass when 보호된 경로로 복구하고 downgrade 없음.
- [ ] Lane 7. phone-a 철회 후 phone-b 유지. Save `U17/lane-7/evidence.png`. Pass when a의 서버 권한만 즉시 차단.
- [ ] Lane 8. 동일 경로 이름의 두 host 파일. Save `U17/lane-8/evidence.png`. Pass when host/revision이 달라 잘못된 파일 조작 없음.
- [ ] Lane 9. desktop SSH와 relay/direct/VPN 경로. Save `U17/lane-9/evidence.png`. Pass when 각 지원 capability와 연결 provenance 정확.
- [ ] Lane 10. grant 회전 및 단말 분실 시뮬레이션. Save `U17/lane-10/evidence.png`. Pass when 오래된 credential 거부와 local recovery 증거 확보.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 명령 receipt/reconnect/snapshot p95, 이벤트 gap 메모리와 protected transport bytes를 동일 fixture로 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U17 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U17/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U17`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 모바일 대화·파일·터미널 (U18)

**Depends on.** U02, U04, U05, U07, U09, U17.

범위 ID는 `hig:H12`, `hig:S11`, `paseo:F05`, `paseo:F10`, `paseo:F19`, `paseo:F24`, `paseo:F29`, `paseo:P06`, `paseo:E01`, `paseo:PA08`, `paseo:PA13`, `paseo:PA14`, `paseo:PA17`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Edit `apps/web/src/components/Transcript.tsx`.
- [ ] Edit `apps/web/src/components/Composer.tsx`.
- [ ] Edit `apps/web/src/components/TerminalView.tsx`.
- [ ] Create `apps/web/src/mobile-layout.ts`.
- [ ] Create `apps/web/src/mobile-layout.test.tsx`.
- [ ] Extend from U07 `packages/client/src/index.ts`.
- [ ] Extend from U16 `packages/contracts/src/host-session.ts`.
- [ ] Create `apps/host/src/backends/workbench.ts`.
- [ ] Create `apps/host/src/backends/paseo.ts`.
- [ ] Create `scripts/architecture-probes/mobile-adapter-contract.ts`.
- [ ] Create `scripts/architecture-probes/paseo-conformance.ts`.
- [ ] Conditional create `apps/mobile/package.json`, `apps/mobile/tsconfig.json`, `apps/mobile/src/App.tsx`, `apps/mobile/src/platform-adapter.ts` only if G-MB3 selects a separate native shell. 선택되지 않은 scaffold는 만들지 않는다.
- [ ] Edit `apps/web/vite.config.ts` if the responsive/PWA path is selected.
- [ ] Create `apps/web/public/manifest.webmanifest`, `apps/web/src/mobile-worker.ts` only if the responsive/PWA path is selected.
- [ ] Edit `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts` only for selected delivery wiring. G-MB3 receipt에 native build entry/config 또는 PWA manifest/worker와 test driver의 정확한 file set을 먼저 고정한다.

**Interfaces.**

```ts
interface MobilePlatform { safeArea(): Insets; choosePhoto(): Promise<LocalAttachment>; shareFile(ref: ArtifactRef): Promise<void>; notificationPermission(): Promise<PermissionState>; }
interface MobileSessionClient { observe(ref: TaskRef): AsyncIterable<TaskEvent>; command(input: TaskCommand): Promise<CommandReceipt>; }
declare function reduceMobileDraft(state: DraftState, event: MobileInputEvent): DraftState;
```

**Build.**

- [ ] `apps/web/src/mobile-layout.test.tsx`에 `composition_and_rotation_keep_draft_identity`를 먼저 추가한다. fixture는 임시 데이터와 주입한 fake adapter를 사용하고 실제 계정이나 파일을 건드리지 않는다.

```ts
it("composition_and_rotation_keep_draft_identity", () => {
  const initial = fixtureDraft({ text: "한", composing: true, attachmentIds: ["photo-1"] });
  const rotated = reduceMobileDraft(initial, { type: "viewport", width: 844, height: 390 });
  const ended = reduceMobileDraft(rotated, { type: "composition-end", text: "한글" });
  expect(ended.text).toBe("한글");
  expect(ended.attachmentIds).toEqual(["photo-1"]);
  expect(ended.draftId).toBe(initial.draftId);
});
```

- [ ] `npx vitest run apps/web/src/mobile-layout.test.tsx -t composition_and_rotation_keep_draft_identity`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] G-MB1/2/3로 responsive Workbench client를 기본 검증하고 공식 Paseo daemon+SDK adapter와 protocol facade는 bounded conformance 후보로 비교한다. SDK를 generic HTTP client로 가정하지 않는다. same session/approval/cancel/duplicate/history gap 및 Office/browser 확장 범위를 기록한다.
- [ ] 실제 iOS/Android push/file/lifecycle capability 결과로 PWA 또는 native shell 경로를 결정한다. 여기서 push는 platform capability probe이며 UI 없는 producer와 full delivery는 U19에서 검증한다. responsive/PWA가 통과하면 기존 apps/web 안에서 전달하고, 별도 native shell이 필요한 증거가 있을 때만 apps/mobile package와 platform adapter를 생성한다. 기본 공통 client 계약과 web component를 재사용하고 별도 canonical session DB를 만들지 않는다. package.json/workspace/lock wiring도 결정 후 함께 갱신한다.
- [ ] phone/tablet의 safe area, 회전, IME, keyboard, 사진/공유/파일, 승인/중지, 5분 background restore를 연결한다. terminal은 CJK 입력/선택/resize/reconnect를 지원한다. 공식 앱이 확장을 모르면 companion으로 표시하며 full client 완료를 대체하지 않는다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U18` commit SHA를 기록한다.

**You see.**

- [ ] PA13/14 및 F24/29 실제 iOS·Android; desktop와 동일 작업·초안/사진 identity·terminal selection/reconnect; UI 독립 Office는 U09와 통합를 실제 결과로 확인하고 `U18/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/web/src/mobile-layout.test.tsx`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. desktop 원문 대화와 모바일 같은 task 열기. Save `U18/lane-1/evidence.png`. Pass when 같은 run/history/artifact identity 확인. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. iPhone 한글 IME와 keyboard. Save `U18/lane-2/evidence.png`. Pass when 조합 문자가 중복/소실되지 않고 입력이 가려지지 않음.
- [ ] Lane 3. Android 한글 IME와 사진 첨부. Save `U18/lane-3/evidence.png`. Pass when 초안/사진 identity와 전송 상태 유지.
- [ ] Lane 4. tablet 회전/split/200% text. Save `U18/lane-4/evidence.png`. Pass when 도구와 메시지 읽기 위치 유지.
- [ ] Lane 5. 사진 촬영/공유 취소/재선택. Save `U18/lane-5/evidence.png`. Pass when 권한과 중복 첨부를 올바르게 처리.
- [ ] Lane 6. 원격 결과 파일 preview/open/share. Save `U18/lane-6/evidence.png`. Pass when host/revision과 권한 범위 일치.
- [ ] Lane 7. 모바일 승인/추가 질문/중지. Save `U18/lane-7/evidence.png`. Pass when desktop 상태와 receipt 수렴.
- [ ] Lane 8. 5분 background 뒤 WiFi/셀룰러 복귀. Save `U18/lane-8/evidence.png`. Pass when 이력 gap 복구와 초안 보존.
- [ ] Lane 9. CJK terminal 입력/선택/resize/reconnect. Save `U18/lane-9/evidence.png`. Pass when 정확한 host/cwd와 입력 결과.
- [ ] Lane 10. 공식 Paseo 후보와 Workbench client 비교. Save `U18/lane-10/evidence.png`. Pass when 지원/미지원 확장을 기록하고 채택 이유 증거 확보.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 실제 iOS/Android message paint/keyboard/reconnect p95, foreground/background memory와 선택 모바일 설치 bytes를 동일 fixture로 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U18 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U18/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U18`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 서비스 알림·push·정확한 이동 (U19)

**Depends on.** U06, U14, U16, U17, U18.

범위 ID는 `aside:P3`, `aside:C16`, `hig:H10`, `hig:S15`, `hig:D07`, `paseo:F23`, `paseo:P07`, `paseo:PA15`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Create `apps/host/src/notifications.ts`.
- [ ] Create `apps/host/src/notifications.test.ts`.
- [ ] Create `packages/contracts/src/attention.ts`.
- [ ] Edit `apps/web/src/completion-notifications.ts`.
- [ ] Edit `apps/web/src/completion-notifications.test.tsx`.
- [ ] Create `apps/desktop/src-tauri/src/notifications.rs`.
- [ ] Create `apps/mobile/src/notifications.ts`.
- [ ] Create `apps/host/src/push/devices.ts`.
- [ ] Create `apps/host/src/push/producer.ts`.

**Interfaces.**

```ts
declare function produceAttention(event: TaskEvent, presence: DevicePresence[]): Promise<AttentionEvent[]>;
declare function acknowledgeAttention(completionId: string, deviceId: string): Promise<void>;
declare function resolveAttentionLink(link: AttentionLink, grant: DeviceGrant): Promise<TaskRef>;
```

**Build.**

- [ ] `apps/host/src/notifications.test.ts`에 `dedupes_completion_without_message_body`를 먼저 추가한다. fixture는 임시 데이터와 주입한 fake adapter를 사용하고 실제 계정이나 파일을 건드리지 않는다.

```ts
it("dedupes_completion_without_message_body", async () => {
  const outbox = fixtureNotificationOutbox();
  const producer = createAttentionProducer(outbox);
  const event = fixtureCompletion({ completionId: "done-1", sensitiveText: "private document" });
  await producer.accept(event);
  await producer.accept(event);
  expect(outbox.items).toHaveLength(1);
  expect(JSON.stringify(outbox.items[0].pushPayload)).not.toContain("private document");
  expect(outbox.items[0].taskRef).toEqual(event.taskRef);
});
```

- [ ] `npx vitest run apps/host/src/notifications.test.ts -t dedupes_completion_without_message_body`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] 완료/실패/입력 필요 producer를 host에 두고 UI presence, 읽음, attention, completionId dedupe를 공통 계약으로 묶는다. desktop tray와 모바일 push는 같은 사건을 전달하며 UI 종료 중에도 발생할 수 있다.
- [ ] 실제 platform permission/token/rotation과 전송 adapter를 연결한다. 기본 push에는 generic 문구와 불투명 link만 넣고 민감한 prompt/file 내용을 넣지 않는다. 사용자 계정/서명 설정 전에는 NOT_RUN_DEVICE로 남긴다.
- [ ] cold/warm launch의 deep link에서 device grant와 host/task를 검증하고 필요한 host reconnect 후 정확한 문서/페이지/메시지로 이동한다. 읽음과 기기 전환으로 중복 알림을 억제하되 승인 대기 자체를 삭제하지 않는다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U19` commit SHA를 기록한다.

**You see.**

- [ ] C16/H10/PA15; desktop 종료 중 완료/승인 알림, warm/cold/open·기기 전환·중복 방지·민감 본문 기본 미포함를 실제 결과로 확인하고 `U19/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/notifications.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 현재 desktop 완료 알림. Save `U19/lane-1/evidence.png`. Pass when 중복 없이 같은 task로 이동. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. UI process 종료 중 host 작업 완료. Save `U19/lane-2/evidence.png`. Pass when 서비스 producer가 기록하고 실제 기기로 전달.
- [ ] Lane 3. 승인 필요/실패/완료 각각 알림. Save `U19/lane-3/evidence.png`. Pass when 이유와 행동이 구별됨.
- [ ] Lane 4. 같은 완료 이벤트 재전송. Save `U19/lane-4/evidence.png`. Pass when completionId당 중복 알림 없음.
- [ ] Lane 5. 읽는 중인 기기와 background 기기. Save `U19/lane-5/evidence.png`. Pass when presence 정책에 맞는 attention 제공.
- [ ] Lane 6. iOS cold launch notification tap. Save `U19/lane-6/evidence.png`. Pass when 정확한 host/task로 이동.
- [ ] Lane 7. Android warm launch notification tap. Save `U19/lane-7/evidence.png`. Pass when 현재 draft 보존 후 정확한 대상 이동.
- [ ] Lane 8. token 회전/권한 거부/철회 기기. Save `U19/lane-8/evidence.png`. Pass when 오류 상태와 재등록 경로 및 권한 거부 반영.
- [ ] Lane 9. 다른 host의 유사 task 제목. Save `U19/lane-9/evidence.png`. Pass when URL 제목 대신 identity로 이동.
- [ ] Lane 10. lock screen과 push payload 확인. Save `U19/lane-10/evidence.png`. Pass when 기본 payload에 민감한 본문/경로 없음.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. host completion-to-outbox 및 device delivery p95, dedupe store와 background producer RSS, push payload bytes를 동일 fixture로 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U19 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U19/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U19`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## workspace 운영·개발 도구 (U20)

**Depends on.** U03, U13, U16, U18. 서비스 기반 착수는 U03/U16 뒤 가능하며 전체 U20 완료는 모든 의존을 기다린다.

범위 ID는 `aside:C18`, `hig:W4`, `hig:H08`, `hig:S10`, `hig:S11`, `hig:F09`, `hig:D09`, `paseo:F11`, `paseo:F12`, `paseo:F26`, `paseo:F27`, `paseo:F28`, `paseo:F29`, `paseo:E01`, `paseo:PA10`. 모든 제품 검증 상태는 NOT_RUN이다.

**Files.**

- [ ] Edit `apps/host/src/workspaces.ts`.
- [ ] Edit `apps/host/src/worktree-workspaces.ts`.
- [ ] Edit `apps/host/src/workspace-preparation.ts`.
- [ ] Edit `apps/host/src/terminals.ts`.
- [ ] Create `apps/host/src/workspace-services.ts`.
- [ ] Create `apps/host/src/workspace-services.test.ts`.
- [ ] Edit `apps/web/src/components/WorkspacePicker.tsx`.
- [ ] Edit `apps/web/src/components/WorktreeReview.tsx`.
- [ ] Edit `apps/web/src/components/SourceControlDialog.tsx`.
- [ ] Edit `apps/web/src/components/TerminalView.tsx`.
- [ ] Create `apps/web/src/components/WorkspaceServices.tsx`.
- [ ] Edit `packages/contracts/src/workspaces.ts`.

**Interfaces.**

```ts
interface OwnedService { serviceId: string; hostId: string; workspaceId: string; cwd: string; pid: number; startedAt: string; port?: number; }
declare function startWorkspaceService(spec: WorkspaceServiceSpec): Promise<OwnedService>;
declare function stopWorkspaceService(identity: OwnedService): Promise<StopReceipt>;
```

**Build.**

- [ ] `apps/host/src/workspace-services.test.ts`에 `stops_only_owned_workspace_service`를 먼저 추가한다. fixture는 임시 데이터와 주입한 fake adapter를 사용하고 실제 계정이나 파일을 건드리지 않는다.

```ts
it("stops_only_owned_workspace_service", async () => {
  const processes = fixtureProcessRegistry();
  const services = createWorkspaceServiceSupervisor(processes);
  const owned = await services.start(fixtureService({ workspaceId: "ws-a", cwd: "/fixtures/a" }));
  await expect(services.stop({ ...owned, startedAt: "stale" })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  expect(processes.killed).toEqual([]);
  await services.stop(owned);
  expect(processes.killed).toEqual([owned.pid]);
});
```

- [ ] `npx vitest run apps/host/src/workspace-services.test.ts -t stops_only_owned_workspace_service`를 실행한다. RED는 새 export 부재 또는 행동 assertion 실패다. 관련 없는 환경 오류는 RED가 아니다.
- [ ] local folder와 worktree를 하나의 workspace 모델에서 구분하고 비Git 문서 프로젝트도 그대로 지원한다. setup/teardown은 고정 cwd/host와 명시된 command receipt를 가지며 archive와 실제 파일 삭제를 구별한다.
- [ ] 서비스 supervisor, 포트 충돌/프록시, terminal과 browser 배치를 workspace에 연결한다. resource 등록과 owned process identity를 사용해 자신이 시작한 서비스만 정상 종료한다. 이미 실행 중인 앱을 자동 채택하지 않는다.
- [ ] 기존 diff/conflict/GitHub/작업트리 진입을 HIG 공통 셸에 연결하고 terminal의 cwd/host를 유지한다. GitHub 조회와 write 행동 권한을 구분하며 기존 스크립트/서비스 출력을 검색 가능한 결과로 연결한다.
- [ ] 같은 명령을 다시 실행해 GREEN을 확인한다. 관련 기존 tests를 연결하고 목적별 diff와 `U20` commit SHA를 기록한다.

**You see.**

- [ ] H08/C18/F11/12/27/28/29; 대상 cwd/host 정확·비Git 문서 허용·충돌/포트·owned shutdown·mobile terminal U18 통합를 실제 결과로 확인하고 `U20/result.json`에 지원/미검증 범위와 evidence를 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/workspace-services.test.ts`와 연결한 기존 tests가 통과한다. `npm run typecheck`에서 계약과 호출자가 일치한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 시나리오는 순차 실행할 수 있다.

- [ ] Lane 1. Regression lane against trunk. 기존 local/worktree 생성과 코드 리뷰. Save `U20/lane-1/evidence.png`. Pass when 기존 Git 상태와 경로 보존. 기준판에 없는 기능은 기존 동작 비교와 새 행동 결과를 분리한다.
- [ ] Lane 2. 비Git 문서 폴더 열기. Save `U20/lane-2/evidence.png`. Pass when Git을 강제하지 않고 Office 작업 가능.
- [ ] Lane 3. setup 후 terminal/browser 배치. Save `U20/lane-3/evidence.png`. Pass when 정확한 cwd/host와 port로 연결.
- [ ] Lane 4. 같은 포트 두 service 시작. Save `U20/lane-4/evidence.png`. Pass when 충돌 표시와 선택된 대체 포트 적용.
- [ ] Lane 5. service stop 후 다른 기존 process 확인. Save `U20/lane-5/evidence.png`. Pass when owned process만 정상 종료.
- [ ] Lane 6. worktree merge conflict 열기. Save `U20/lane-6/evidence.png`. Pass when diff와 unresolved 상태가 실제 Git과 일치.
- [ ] Lane 7. GitHub review/action 조회. Save `U20/lane-7/evidence.png`. Pass when 기존 권한과 provenance 유지.
- [ ] Lane 8. workspace archive/restore. Save `U20/lane-8/evidence.png`. Pass when 원본 파일과 서비스 정책 명확.
- [ ] Lane 9. U18 완료 뒤 desktop/mobile terminal 전환. Save `U20/lane-9/evidence.png`. Pass when 같은 session과 CJK 입력 유지.
- [ ] Lane 10. daemon restart 후 service registry. Save `U20/lane-10/evidence.png`. Pass when 살아 있는 소유권을 증명하거나 interrupted 표시.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. workspace open/setup/status p95, terminal/service별 RSS와 proxy throughput를 동일 fixture로 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U20 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw samples를 보관한다.
- [ ] Baseline. head 전에 trunk 값을 남긴다. 기준판에 없는 기능은 비교 가능한 기존 동작과 사전에 고정한 새 기능 absolute budget을 구별한다.
- [ ] Rule. 지연/메모리 15%, 설치 크기 10% 증가 초과 또는 사전 absolute budget 초과는 review를 막는다. 원인과 기능 비용을 기록하고 조치 후 해당 probe만 반복한다.

**Review gate.** The operator reviews before merge.

- [ ] 관련 lane screenshot과 30~60초 video를 `U20/review/`에 저장하고 operator에게 변경과 미검증 범위를 제시한다. 화면 없는 계약은 terminal/status harness screenshot과 receipt JSON으로 설명한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 확인한 뒤 `U20`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하고 자동 merge하지 않는다.

## 예약과 heartbeat를 서비스 실행에 연결한다 (U21)

**Depends on.** U06, U16.

범위 ID는 `hig:S14` `paseo:F31` `paseo:E04`이다. 모든 제품 검증 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Edit `packages/contracts/src/schedules.ts`. 기존 Schedule에 실행 정책을 호환 확장한다.
- [ ] Edit `apps/host/src/schedules.ts`. 기존 nextRun과 due tick을 재사용한다.
- [ ] Edit `apps/host/src/schedules.test.ts`. 기존 일시중지와 missed-once 동작을 유지한다.
- [ ] Create `apps/host/src/schedule-journal.ts`. 발생 시각별 durable 접수와 복구를 담당한다.
- [ ] Create `apps/host/src/schedule-journal.test.ts`. unknown과 재시작의 중복 실행을 검사한다.
- [ ] Edit `apps/host/src/store.ts`. 기존 로컬 DB transaction 안에 occurrence를 기록한다.
- [ ] Edit `apps/host/src/http.ts`. 정책과 이력 API를 연결한다.
- [ ] Edit `apps/web/src/api.ts`. 예약 정책과 이력 호출을 추가한다.
- [ ] Edit `apps/web/src/components/ScheduleDialog.tsx`. 실행 방식과 기한 및 일시중지 상태를 표시한다.
- [ ] Create `apps/web/src/components/ScheduleHistory.tsx`. 접수와 결과 불명 상태를 구분해 표시한다.

**Interfaces.** 기존 Schedule과 U06 CommandReceipt를 사용한다. 다음 타입은 packages/contracts/src/schedules.ts에 정의하고 schedule-journal.ts에서 계획 함수를 export한다.

```ts
type ScheduleTickInput = {
  scheduleId: string; dueAt: number; now: number; enabled: boolean;
  expiresAt: number | null; mode: "new_run" | "resume_session";
  previous: "none" | "accepted" | "outcome_unknown" | "completed";
};
type ScheduleTickPlan = {
  occurrenceId: string; action: "dispatch" | "reconcile" | "skip";
};
declare function planScheduleTick(input: ScheduleTickInput): ScheduleTickPlan;
declare function reconcileOccurrence(occurrenceId: string): Promise<CommandReceipt>;
```

**Build.**

- [ ] `apps/host/src/schedule-journal.test.ts`에 `reconciles_unknown_occurrence_without_resending`를 먼저 추가한다. 정의한 타입을 import하고 아래 complete fixture를 사용한다.

```ts
it("reconciles_unknown_occurrence_without_resending", () => {
  const tick: ScheduleTickInput = {
    scheduleId: "schedule-1", dueAt: 1000, now: 2000, enabled: true,
    expiresAt: 9000, mode: "resume_session", previous: "outcome_unknown"
  };
  expect(planScheduleTick(tick)).toEqual({
    occurrenceId: "schedule-1:1000", action: "reconcile"
  });
  expect(planScheduleTick({ ...tick, now: 3000 })).toEqual({
    occurrenceId: "schedule-1:1000", action: "reconcile"
  });
});
```

- [ ] RED 명령 `npx vitest run apps/host/src/schedule-journal.test.ts -t reconciles_unknown_occurrence_without_resending`를 실행한다. 새 export 부재 또는 해당 행동 assertion 실패를 확인한다. 환경 실패는 RED가 아니다.
- [ ] 기존 Schedule를 migration할 때 현재 missed-once와 비활성 후 재개 의미를 보존한다. 새 정책은 새 run 또는 기존 session 재개, 명시한 timezone, missed once 또는 skip, expiresAt, 최대 실행 횟수를 저장한다. heartbeat도 같은 예약 정책을 사용하고 기본값으로 켜지 않는다.
- [ ] Store.transaction으로 scheduleId와 예정 dueAt의 occurrence를 먼저 기록한다. U06에 occurrenceId를 commandId로 전달하고 그 receipt를 저장한다. send 예외를 지우는 현재 catch 대신 rejected 또는 outcome_unknown을 남긴다. 실제 outcome 조회 없이 now로 새 ID를 만들어 재전송하지 않는다.
- [ ] daemon의 단일 scheduler owner에 기존 Schedules.start/stop을 연결한다. 겹친 tick, 재시작, 시계 역행, DST, 승인을 기다리는 session, 만료와 endAfter를 처리한다. 대기 승인을 자동 승인하지 않는다.
- [ ] ScheduleDialog에서 대상 session, mode, 다음 시각과 timezone, missed policy 및 마지막 receipt를 표시한다. History에서 reconcile과 명시적 새 요청을 구분한다. 앱을 닫아도 보존되는 정책을 실제 실행 상태와 함께 보여 준다.
- [ ] GREEN 명령 `npx vitest run apps/host/src/schedule-journal.test.ts -t reconciles_unknown_occurrence_without_resending`를 다시 실행해 PASS를 확인한다. 관련 회귀와 타입 검사를 마친 뒤 이 목적의 diff와 commit SHA를 기록한다.

**You see.**

- [ ] 같은 예약 발생이 두 번 시작되지 않고 UI가 없는 동안의 실행과 승인 대기 및 결과 불명을 다시 연 화면에서 구별한다. 결과와 지원 범위를 `U21/result.json`에 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 새 journal 검사와 `npx vitest run apps/host/src/schedules.test.ts apps/host/src/schedule-journal.test.ts`를 실행한다. 임시 Store를 닫고 다시 연 뒤 같은 occurrence의 provider 시작 횟수가 1인지 검사한다. 기존 once/daily/every와 timezone 경계 fixture도 통과해야 한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 열 개 시나리오는 root와 최대 3개 owner가 순차 또는 제한 병렬로 수행한다.

- [ ] Lane 1. Regression lane against trunk. 같은 daily 예약을 앱 실행 중 한 번 처리한다. Save `U21/lane-1/evidence.png`. Pass when 기존 nextAt와 session 이력이 유지된다. trunk에 없는 서비스 수명은 별도로 기록한다.
- [ ] Lane 2. 일회 예약을 만들고 데스크톱 UI process를 종료한 뒤 U16의 thin client 또는 재접속한 UI로 확인한다. Save `U21/lane-2/evidence.png`. Pass when 기한 내 occurrence가 한 번 실행되고 결과가 같은 session에 남는다.
- [ ] Lane 3. 매일 예약의 timezone과 DST 경계 fixture를 상태 화면에서 확인한다. Save `U21/lane-3/evidence.png`. Pass when 표시 시각과 실제 dueAt가 고정한 정책과 일치한다.
- [ ] Lane 4. 긴 실행 중 다음 heartbeat tick을 만든다. Save `U21/lane-4/evidence.png`. Pass when 설정된 queue 또는 skip 정책이 보이고 무제한 중첩 실행이 없다.
- [ ] Lane 5. 접수 직후 응답을 잃고 daemon을 재시작한다. Save `U21/lane-5/evidence.png`. Pass when 같은 occurrence를 조회하며 두 번째 provider 시작이 없다.
- [ ] Lane 6. 일시중지 상태에서 여러 주기를 지나 재개한다. Save `U21/lane-6/evidence.png`. Pass when 중지 동안의 tick을 소급 실행하지 않고 다음 시각을 표시한다.
- [ ] Lane 7. expiresAt와 최대 횟수에 도달한 예약을 확인한다. Save `U21/lane-7/evidence.png`. Pass when 종료 이유가 보이고 이후 tick은 명령을 접수하지 않는다.
- [ ] Lane 8. 기존 session 재개와 새 run 모드를 각각 사용한다. Save `U21/lane-8/evidence.png`. Pass when native session 이력과 새 run 식별자가 선택한 모드와 일치한다.
- [ ] Lane 9. 예약이 권한 승인을 요구하도록 한다. Save `U21/lane-9/evidence.png`. Pass when waiting_input이 보존되고 승인 전 후속 행동은 실행되지 않는다.
- [ ] Lane 10. 예약 대상 session을 보관 또는 제거한 뒤 tick한다. Save `U21/lane-10/evidence.png`. Pass when 대상이 없는 실행을 만들지 않고 이유와 기존 결과를 보존한다.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 예약 due-to-admission p95, 100개 예약의 idle RSS와 tick CPU, 복구 조회의 지연을 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U21 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw sample을 보존한다.
- [ ] Baseline. 기존 앱 실행 중 scheduler의 같은 100개 fixture를 먼저 측정한다. 무창 복구와 새 journal 비용은 U01의 별도 absolute budget에 고정한다.
- [ ] Rule. 같은 작업의 지연 또는 메모리 15%, 설치 크기 10% 증가 초과는 검토를 막는다. 새 작업은 사전 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 예약 생성부터 UI 종료, 결과 불명 복구까지 lane 2와 5의 screenshot 및 30~60초 video를 U21/review에 저장해 operator에게 제시한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 대조하고 `U21`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하며 자동 merge나 loop를 켜지 않는다.

## 한국어 받아쓰기와 선택 음성 대화를 제공한다 (U22)

**Depends on.** U07, U18.

범위 ID는 `hig:S14` `paseo:F30` `paseo:E05`이다. 모든 제품 검증 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Create `packages/contracts/src/voice.ts`. capture와 모델 capability 및 비용 계약을 정의한다.
- [ ] Create `apps/host/src/voice.ts`. STT 요청과 취소 및 결과를 조정한다.
- [ ] Create `apps/host/src/voice.test.ts`. 중단한 capture의 늦은 결과를 검사한다.
- [ ] Create `apps/host/src/voice-models.ts`. 선택 모델의 hash와 언어 및 설치 상태를 검증한다.
- [ ] Create `packaging/voice-models.json`. 기본 설치와 분리한 승인 모델 및 runtime 원본을 고정한다.
- [ ] Create `third_party/voice/NOTICE.md`. 반입한 코드와 모델의 license 및 수정 목록을 기록한다.
- [ ] Create `apps/web/src/components/VoiceInput.tsx`. 마이크 상태와 전송 전 받아쓰기 초안을 표시한다.
- [ ] Create `apps/web/src/voice/recorder.worklet.ts`. 허용된 입력을 PCM frame으로 변환한다.
- [ ] Create `apps/web/src/voice-input.test.tsx`. IME 초안과 취소 및 mute 상태를 검사한다.
- [ ] Edit `apps/web/src/components/Composer.tsx`. 기존 첨부와 전송 경로에 받아쓰기 초안을 연결한다.
- [ ] Edit `apps/host/src/http.ts`. capability 및 명시한 capture API를 연결한다.
- [ ] Edit `apps/web/src/api.ts`. capture ID를 유지하는 요청을 추가한다.

**Interfaces.** U07의 모델 선택과 U18 platform adapter를 소비한다. voice.ts의 capture 상태는 일반 대화 전송과 분리한다. native 경로가 선택되면 U18 owner가 같은 VoiceCaptureSource를 platform adapter에 연결한다.

```ts
type VoiceCaptureState = {
  captureId: string; draftId: string; generation: number;
  phase: "recording" | "transcribing" | "cancelled" | "ready";
  text: string; muted: boolean;
};
type VoiceTranscript = {
  captureId: string; generation: number; language: string; text: string;
};
interface VoiceCaptureSource {
  start(captureId: string): Promise<AsyncIterable<Uint8Array>>;
  stop(captureId: string): Promise<void>;
}
declare function applyVoiceTranscript(state: VoiceCaptureState, result: VoiceTranscript): VoiceCaptureState;
declare function transcribeCapture(captureId: string, modelId: string, signal: AbortSignal): Promise<VoiceTranscript>;
```

**Build.**

- [ ] `apps/host/src/voice.test.ts`에 `cancelled_capture_cannot_replace_typed_draft`를 먼저 추가한다. 정의한 타입을 import하고 아래 complete fixture를 사용한다.

```ts
it("cancelled_capture_cannot_replace_typed_draft", () => {
  const state: VoiceCaptureState = {
    captureId: "mic-1", draftId: "draft-1", generation: 4,
    phase: "cancelled", text: "직접 입력한 문장", muted: true
  };
  const late: VoiceTranscript = {
    captureId: "mic-1", generation: 3, language: "ko", text: "늦게 온 받아쓰기"
  };
  expect(applyVoiceTranscript(state, late)).toEqual(state);
});
```

- [ ] RED 명령 `npx vitest run apps/host/src/voice.test.ts -t cancelled_capture_cannot_replace_typed_draft`를 실행한다. 새 export 부재 또는 해당 행동 assertion 실패를 확인한다. 환경 실패는 RED가 아니다.
- [ ] packaging/voice-models.json에 source URL, immutable revision, sha256, license, languages, runtime platforms, downloadBytes, installedBytes, online 여부와 과금 설명을 기록한다. 한국어 fixture를 통과한 STT 한 경로와 한국어 TTS 한 경로를 실제 연결한다. 영어 전용 upstream 기본 모델을 한국어 기본값으로 채택하지 않는다.
- [ ] 기본 기능은 꺼짐이고 모델은 사용자가 고른 뒤 별도로 다운로드한다. voice-models.ts는 checksum 실패와 불완전 다운로드를 격리하고 기존 모델로 복귀한다. 선택 모델 bytes는 Workbench 기본 설치 크기와 별도로 보고한다. model/runtime 재배포 권한과 Paseo 재사용 코드의 원본 SHA 및 Apache-2.0 NOTICE를 보존한다.
- [ ] VoiceInput에서 permission 요청, 녹음 표시, 중지, 취소, 전송 전 텍스트 수정과 현재 Composer draftId를 연결한다. capture generation이 다른 늦은 STT 응답은 초안을 바꾸지 않는다. 음성 중에도 사진 첨부와 키보드 입력을 보존한다.
- [ ] 선택 음성 대화는 명시적으로 켠 session에서만 마이크와 TTS를 사용한다. mute를 보존하고 stop은 녹음 및 재생을 정상 중지한다. 원격 인식은 전송 대상과 비용을 먼저 표시하며 오디오를 기본 보관하지 않는다. native adapter와 브라우저 recorder는 같은 취소 계약을 통과해야 한다.
- [ ] GREEN 명령 `npx vitest run apps/host/src/voice.test.ts -t cancelled_capture_cannot_replace_typed_draft`를 다시 실행해 PASS를 확인한다. 관련 회귀와 타입 검사를 마친 뒤 이 목적의 diff와 commit SHA를 기록한다.

**You see.**

- [ ] 한국어를 받아써 전송 전에 고칠 수 있고, 취소 후 늦은 응답은 직접 입력을 덮지 않는다. 선택 모델 크기와 online 비용 및 음소거 상태가 보인다. 결과와 지원 범위를 `U22/result.json`에 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/voice.test.ts apps/web/src/voice-input.test.tsx`를 실행한다. 미승인 마이크, hash 실패, 기존 모델 rollback, stale generation, TTS mute 보존을 검사하고 `npm run typecheck`에서 platform adapter 연결을 확인한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 열 개 시나리오는 root와 최대 3개 owner가 순차 또는 제한 병렬로 수행한다.

- [ ] Lane 1. Regression lane against trunk. 키보드로 한국어 문장과 사진을 기존 Composer에 입력한다. Save `U22/lane-1/evidence.png`. Pass when 기존 입력과 첨부가 유지된다. 음성 없는 trunk를 STT 성능 기준으로 만들지 않는다.
- [ ] Lane 2. iPhone에서 마이크를 허용하고 고정 한국어 음성 fixture를 받아쓴다. Save `U22/lane-2/evidence.png`. Pass when 정답 corpus의 확정한 CER 기준과 전송 전 편집 흐름을 통과한다.
- [ ] Lane 3. Android에서 녹음 중 타이핑과 사진 첨부를 한다. Save `U22/lane-3/evidence.png`. Pass when draftId와 attachmentId가 유지되고 늦은 텍스트가 직접 입력을 덮지 않는다.
- [ ] Lane 4. 한국어 STT 선택 모델을 다운로드한다. Save `U22/lane-4/evidence.png`. Pass when 언어와 license 및 크기가 보이고 실제 checksum이 manifest와 일치한다.
- [ ] Lane 5. 오프라인에서 local 모델을 쓰고 online 전용 모델도 선택한다. Save `U22/lane-5/evidence.png`. Pass when 실제 가능한 범위를 구분하며 online 모델을 offline 성공으로 표시하지 않는다.
- [ ] Lane 6. 인식 중 취소한 뒤 늦은 결과를 도착시킨다. Save `U22/lane-6/evidence.png`. Pass when 마이크가 꺼지고 받아쓰기나 전송이 되살아나지 않는다.
- [ ] Lane 7. 선택 음성 대화를 켜고 한국어 답변을 재생하다 중지한다. Save `U22/lane-7/evidence.png`. Pass when 실제 TTS 재생이 끝나고 다음 입력과 겹치지 않는다.
- [ ] Lane 8. mute 상태에서 앱을 재시작하고 다시 대화를 연다. Save `U22/lane-8/evidence.png`. Pass when 사용자 mute 설정과 키보드 사용이 유지된다.
- [ ] Lane 9. 마이크 권한 거부와 모델 손상 또는 quota 오류를 만든다. Save `U22/lane-9/evidence.png`. Pass when 정확한 재시도 경로가 보이며 사용자 초안은 보존된다.
- [ ] Lane 10. 데스크톱과 휴대폰의 같은 session에 후속 음성 요청을 보낸다. Save `U22/lane-10/evidence.png`. Pass when 대화가 복제되지 않고 오디오 기본 보관 없이 지정한 run에 텍스트가 한 번 전달된다.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 한국어 CER, 녹음 종료부터 수정 가능한 텍스트까지 p95, TTS 첫 소리 지연, local 모델 peak RSS 및 다운로드와 설치 bytes를 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U22 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw sample을 보존한다.
- [ ] Baseline. 기존 텍스트와 사진 입력의 지연을 먼저 측정한다. STT/TTS가 없는 trunk와 비율을 만들지 않고 U01에서 고정한 한국어 corpus, CER 상한과 모델별 absolute budget으로 새 작업을 판정한다.
- [ ] Rule. 같은 작업의 지연 또는 메모리 15%, 설치 크기 10% 증가 초과는 검토를 막는다. 새 작업은 사전 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 실제 iOS와 Android의 받아쓰기, 취소, mute를 보여 주는 screenshot 및 짧은 video를 U22/review에 저장해 operator에게 제시한다. 녹음 내용은 허용된 fixture만 사용한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 대조하고 `U22`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하며 자동 merge나 loop를 켜지 않는다.

## 선택 실행 플러그인과 기존 라이브러리를 연결한다 (U23)

**Depends on.** U06, U07, U16, U18. runtime 기반 착수는 U06/U07/U16 뒤 가능하며 실제 모바일 capability 검증은 U18을 기다린다.

범위 ID는 `hig:W4` `hig:H08` `hig:S14` `paseo:F33` `paseo:E06`이다. 모든 제품 검증 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Create `packages/contracts/src/extensions.ts`. tool와 screen 및 provider의 manifest와 grant를 정의한다.
- [ ] Create `apps/host/src/extensions/registry.ts`. 설치와 비활성 및 rollback 상태를 저장한다.
- [ ] Create `apps/host/src/extensions/runtime.ts`. 실제 허용된 격리 경계와 소유 실행 수명을 담당한다.
- [ ] Create `apps/host/src/extensions/permissions.ts`. 매 호출의 현재 grant를 검사한다.
- [ ] Create `apps/host/src/extensions.test.ts`. 활성화와 철회 및 재시작 경계를 검사한다.
- [ ] Create `apps/web/src/components/ExtensionLibrary.tsx`. 원본과 권한 및 설치 상태를 표시한다.
- [ ] Edit `apps/web/src/components/SkillLibraryDialog.tsx`. 스킬 조회와 실행 플러그인 설치를 구분한다.
- [ ] Edit `apps/web/src/components/KnowledgeLibrary.tsx`. 기존 지식과 이미지 및 변환 진입을 유지한다.
- [ ] Edit `apps/host/src/http.ts`. 검증한 manifest와 lifecycle 요청을 받는다.
- [ ] Edit `apps/host/src/providers/types.ts`. U07 adapter 경계에 provider extension capability를 연결한다.
- [ ] Edit `apps/web/src/api.ts`. extension 상태와 검토한 활성화 요청을 연결한다.

**Interfaces.** U06의 command receipt와 U07 provider capability를 소비한다. imported skill 본문은 실행 manifest로 변환하지 않는다. 다음 타입과 permissions 함수를 정의한다.

```ts
type ExtensionCapability = "tool" | "screen" | "provider";
type ExtensionGrant = {
  extensionId: string; artifactHash: string; generation: number;
  enabled: boolean; capabilities: ExtensionCapability[];
  workspaceIds: string[]; revokedAt: number | null;
};
type ExtensionCall = {
  extensionId: string; artifactHash: string; grantGeneration: number;
  capability: ExtensionCapability; workspaceId: string;
};
declare function authorizeExtensionCall(call: ExtensionCall, grant: ExtensionGrant): boolean;
declare function activateExtension(extensionId: string, expectedHash: string, grant: ExtensionGrant): Promise<CommandReceipt>;
declare function disableExtension(extensionId: string, expectedGeneration: number): Promise<void>;
```

**Build.**

- [ ] `apps/host/src/extensions.test.ts`에 `revoked_extension_cannot_reuse_old_grant`를 먼저 추가한다. 정의한 타입을 import하고 아래 complete fixture를 사용한다.

```ts
it("revoked_extension_cannot_reuse_old_grant", () => {
  const grant: ExtensionGrant = {
    extensionId: "fixture-tool", artifactHash: "sha256:abc", generation: 3,
    enabled: true, capabilities: ["tool"], workspaceIds: ["ws-1"], revokedAt: null
  };
  const call: ExtensionCall = {
    extensionId: "fixture-tool", artifactHash: "sha256:abc", grantGeneration: 3,
    capability: "tool", workspaceId: "ws-1"
  };
  expect(authorizeExtensionCall(call, grant)).toBe(true);
  const revoked: ExtensionGrant = {
    ...grant, generation: 4, enabled: false, revokedAt: 2000
  };
  expect(authorizeExtensionCall(call, revoked)).toBe(false);
});
```

- [ ] RED 명령 `npx vitest run apps/host/src/extensions.test.ts -t revoked_extension_cannot_reuse_old_grant`를 실행한다. 새 export 부재 또는 해당 행동 assertion 실패를 확인한다. 환경 실패는 RED가 아니다.
- [ ] registry.ts에 install, disabled, enabled, updating, failed 상태와 source revision, artifact hash, API version, license 및 필요한 권한을 기록한다. 검색과 ingest는 installed 또는 enabled 상태를 만들지 않는다. 설치 뒤 기본 상태는 disabled다.
- [ ] U23 착수 실증에서 broker를 통해서만 host 파일과 network에 접근하는 지원 실행 형식 하나를 선택한다. 예를 들어 명시한 host imports만 가진 제한 runtime을 평가하고 정확한 dependency와 entry 및 테스트 경로를 plan revision에 고정한다. 임의 native 코드 플러그인과 범용 OS sandbox 개발은 이 범위에 추가하지 않는다. runtime.ts는 선택한 형식의 경로와 endpoint 및 capability를 제한한다. screen은 별도 sandbox origin과 검증한 메시지 bridge를 사용한다. 지원 runtime의 제한을 각 OS에서 증명하고 실패하면 활성화를 거절한다. 별도 process만으로 격리를 주장하거나 unrestricted fallback을 쓰지 않는다.
- [ ] permissions.ts는 cached token만 믿지 않고 호출마다 현재 generation과 enabled 및 workspace 범위를 확인한다. 비활성화는 새 호출을 거절하고 자신이 시작한 실행을 정상 종료한다. active task의 취소 또는 outcome_unknown을 U06에 기록한다.
- [ ] 확장 버전 갱신은 새 payload를 검증한 뒤 원자적으로 전환한다. 시작 실패 시 이전 확인된 hash와 grant로 복귀하고 추가 권한은 자동 승계하지 않는다. source license와 NOTICE 및 수정 목록을 installer provenance에 연결한다.
- [ ] ExtensionLibrary에서 tool, screen, provider 예제를 실제 활성화하고 기존 스킬/양식/지식/이미지/변환 화면을 유지한다. 모바일은 실제 지원 capability만 제시한다. provider는 U07 adapter를 사용하며 임의 모델 이름을 기존 Codex와 Claude 카탈로그에 끼워 넣지 않는다.
- [ ] GREEN 명령 `npx vitest run apps/host/src/extensions.test.ts -t revoked_extension_cannot_reuse_old_grant`를 다시 실행해 PASS를 확인한다. 관련 회귀와 타입 검사를 마친 뒤 이 목적의 diff와 commit SHA를 기록한다.

**You see.**

- [ ] 스킬을 찾는 동작과 실행 코드를 설치하거나 켜는 동작이 구별되고, 플러그인을 끄면 기존 권한으로 다시 실행할 수 없다. 결과와 지원 범위를 `U23/result.json`에 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/extensions.test.ts`를 실행한다. manifest mismatch, version 거절, scope 밖 파일과 network 호출, disable 도중 진행 작업, update 실패 rollback을 실제 격리 fixture와 함께 검사한다. 기존 user-skills tests와 `npm run typecheck`도 통과해야 한다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 열 개 시나리오는 root와 최대 3개 owner가 순차 또는 제한 병렬로 수행한다.

- [ ] Lane 1. Regression lane against trunk. 기존 스킬과 문서 양식을 찾고 같은 session에서 사용한다. Save `U23/lane-1/evidence.png`. Pass when 이전 라이브러리 진입과 원본 파일이 유지되고 신규 extension 설치와 구별된다.
- [ ] Lane 2. OS에서 스킬 후보를 검색 또는 ingest하고 library를 연다. Save `U23/lane-2/evidence.png`. Pass when 별도의 실행코드 설치나 활성화가 발생하지 않는다.
- [ ] Lane 3. 고정 hash의 tool fixture를 설치한 뒤 권한을 검토한다. Save `U23/lane-3/evidence.png`. Pass when disabled 상태와 source/license가 표시되고 명시 활성화 뒤에만 실행된다.
- [ ] Lane 4. 허용 workspace 밖 파일과 미허용 endpoint를 요청한다. Save `U23/lane-4/evidence.png`. Pass when host broker와 실제 runtime 경계에서 모두 거절하고 원본을 바꾸지 않는다.
- [ ] Lane 5. screen fixture를 열고 권한 없는 bridge 메시지를 보낸다. Save `U23/lane-5/evidence.png`. Pass when 앱 token과 다른 화면의 상태에 접근하지 못한다.
- [ ] Lane 6. provider fixture를 등록해 모델 capability를 확인한다. Save `U23/lane-6/evidence.png`. Pass when 지원하는 제어만 보이고 기존 provider와 사용자 override가 유지된다.
- [ ] Lane 7. tool 실행 중 extension을 끈다. Save `U23/lane-7/evidence.png`. Pass when 새 호출이 차단되고 소유 실행만 종료되며 task 결과가 정확하다.
- [ ] Lane 8. 손상한 update를 적용하고 앱을 재시작한다. Save `U23/lane-8/evidence.png`. Pass when 이전 확인된 버전으로 복귀하고 추가 권한은 부여되지 않는다.
- [ ] Lane 9. iOS와 Android에서 extension capability를 연다. Save `U23/lane-9/evidence.png`. Pass when 미지원 실행은 설명과 함께 비활성이고 지원한 화면은 동작한다.
- [ ] Lane 10. Windows와 macOS 및 Linux에서 선택한 지원 runtime의 격리 fixture를 실행한다. Save `U23/lane-10/evidence.png`. Pass when 해당 실행 형식의 제한 근거가 있으며 미지원 native 코드를 통과한 것으로 표시하지 않는다.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 비활성 상태의 시작 시간과 idle RSS, 활성 tool admission p95, screen paint p95 및 extension별 설치 bytes를 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U23 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw sample을 보존한다.
- [ ] Baseline. 기존 스킬/양식 조회와 provider catalog를 먼저 측정한다. 플러그인 runtime과 sandbox 비용은 동일 fixture의 U01 absolute budget으로 분리한다.
- [ ] Rule. 같은 작업의 지연 또는 메모리 15%, 설치 크기 10% 증가 초과는 검토를 막는다. 새 작업은 사전 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 설치와 권한 검토, 비활성화 및 실패 복귀를 담은 screenshot과 30~60초 video를 U23/review에 저장해 operator에게 제시한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 대조하고 `U23`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하며 자동 merge나 loop를 켜지 않는다.

## 검증된 외부 이벤트를 제한된 작업으로 연결한다 (U24)

**Depends on.** U07, U16, U17, U21, U23.

범위 ID는 `paseo:F36` `paseo:E07`이다. 모든 제품 검증 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Create `packages/contracts/src/event-hub.ts`. connector와 workflow 및 전달 상태를 정의한다.
- [ ] Create `apps/host/src/event-hub.ts`. 검증된 사건의 durable 접수와 작업 연결을 담당한다.
- [ ] Create `apps/host/src/event-hub.test.ts`. 재전달과 결과 불명 및 대상 제한을 검사한다.
- [ ] Create `apps/host/src/hub/github.ts`. GitHub signature와 delivery identity를 검증한다.
- [ ] Create `apps/host/src/hub/slack.ts`. Slack signature와 시간창 및 event identity를 검증한다.
- [ ] Create `apps/host/src/hub/discord.ts`. 선택한 Discord transport의 인증된 event를 검증한다.
- [ ] Create `apps/web/src/components/EventHub.tsx`. 실제 연결과 workflow 정책 및 이력을 표시한다.
- [ ] Edit `apps/host/src/http.ts`. raw body를 보존하는 지정 Hub ingress만 추가한다.
- [ ] Edit `apps/host/src/store.ts`. 기존 로컬 DB에 delivery와 workflow 상태를 기록한다.
- [ ] Edit `apps/web/src/api.ts`. 연결 상태와 검토한 policy 요청을 연결한다.

**Interfaces.** U21의 pause와 expiry 정책, U17의 연결/credential 경계, U23의 connector capability를 소비한다. raw 요청은 connector verifier를 통과해야 하며 외부 JSON의 verified 필드를 신뢰하지 않는다.

```ts
type HubDeliveryState = {
  connectorId: string; deliveryId: string; workflowId: string;
  targetHostId: string; targetWorkspaceId: string;
  state: "received" | "accepted" | "completed" | "outcome_unknown";
  commandId: string | null;
};
type HubRecovery = { action: "dispatch" | "reconcile" | "ignore"; commandId: string | null };
declare function planHubRecovery(delivery: HubDeliveryState): HubRecovery;
declare function receiveHubEvent(connectorId: string, rawBody: Uint8Array, headers: Record<string, string>): Promise<HubDeliveryState>;
declare function pauseHubWorkflow(workflowId: string, expectedRevision: number): Promise<void>;
```

**Build.**

- [ ] `apps/host/src/event-hub.test.ts`에 `redelivery_reconciles_unknown_command`를 먼저 추가한다. 정의한 타입을 import하고 아래 complete fixture를 사용한다.

```ts
it("redelivery_reconciles_unknown_command", () => {
  const delivery: HubDeliveryState = {
    connectorId: "github-1", deliveryId: "delivery-1", workflowId: "wf-1",
    targetHostId: "host-a", targetWorkspaceId: "ws-a",
    state: "outcome_unknown", commandId: "hub-command-1"
  };
  expect(planHubRecovery(delivery)).toEqual({
    action: "reconcile", commandId: "hub-command-1"
  });
});
```

- [ ] RED 명령 `npx vitest run apps/host/src/event-hub.test.ts -t redelivery_reconciles_unknown_command`를 실행한다. 새 export 부재 또는 해당 행동 assertion 실패를 확인한다. 환경 실패는 RED가 아니다.
- [ ] 각 connector의 실제 transport 계약과 고정 source/license를 기록한다. GitHub raw-body HMAC, Slack signature와 timestamp, Discord의 선택한 webhook 또는 gateway 인증을 서로 다른 adapter에서 검증한다. 인증 성공 전에 workflow payload를 읽어 실행하지 않는다.
- [ ] event-hub.ts는 connectorId와 검증된 deliveryId를 unique key로 저장한 후 동일 commandId를 U06에 전달한다. 응답을 잃으면 receipt를 조회하고 outcome_unknown을 유지한다. 외부 제공자가 보장하지 않는 exactly-once를 주장하지 않는다.
- [ ] workflow는 허용 repository 또는 channel, event 종류, host/workspace, 역할 profile, 최대 빈도, expiresAt와 pause를 고정한다. event 본문은 작업 자료로만 전달하고 그 안의 지시로 권한이나 대상 목록을 바꾸지 않는다.
- [ ] credential은 U17의 로컬 보호 저장소에 두고 DB와 secret을 Dropbox에 올리지 않는다. 필요한 ingress는 U17의 명시한 보호 연결만 사용하며 event 수신을 위해 기존 host 전체를 공개 bind하지 않는다. daemon 시작이 connector 활성화를 뜻하지 않도록 한다.
- [ ] EventHub에 서명 거절, 대상 거절, rate limit, 접수, running, waiting_input, outcome_unknown과 결과 link를 표시한다. GitHub와 Slack 및 Discord 각각 지정한 시험 연결의 사건이 내부 작업 결과까지 이어지는 E2E를 남긴다. 외부 답장이나 게시 기능은 기본 비활성이고 별도 명시한 권한이 있을 때만 제공한다.
- [ ] GREEN 명령 `npx vitest run apps/host/src/event-hub.test.ts -t redelivery_reconciles_unknown_command`를 다시 실행해 PASS를 확인한다. 관련 회귀와 타입 검사를 마친 뒤 이 목적의 diff와 commit SHA를 기록한다.

**You see.**

- [ ] 선택한 외부 사건이 지정한 프로젝트 작업으로 연결되고, 재전달이나 연결 복구가 같은 작업을 두 번 만들지 않는다. 잘못된 대상과 서명은 실행 전에 거절된다. 결과와 지원 범위를 `U24/result.json`에 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run apps/host/src/event-hub.test.ts`를 실행한다. 각 adapter의 올바른 서명과 한 바이트 변조 및 오래된 timestamp, 반복 delivery, pause/expiry, wrong host, DB 재시작 후 unknown 조회를 검사한다. fixture secret은 합성값이고 실제 연결 자격증명을 출력하지 않는다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 열 개 시나리오는 root와 최대 3개 owner가 순차 또는 제한 병렬로 수행한다.

- [ ] Lane 1. Regression lane against trunk. 기존 GitHub 조회와 예약 목록을 연다. Save `U24/lane-1/evidence.png`. Pass when 기존 읽기 및 예약이 유지된다. Hub 없는 trunk와 새 사건 실행을 같은 기능으로 계산하지 않는다.
- [ ] Lane 2. 지정한 시험 GitHub repository에서 허용 event를 수신한다. Save `U24/lane-2/evidence.png`. Pass when 서명과 delivery ID를 검증하고 지정 host/workspace의 결과까지 연결된다.
- [ ] Lane 3. 지정한 시험 Slack channel의 허용 event를 수신한다. Save `U24/lane-3/evidence.png`. Pass when 허용 channel만 내부 작업으로 연결되고 외부 답장을 자동 전송하지 않는다.
- [ ] Lane 4. 지정한 시험 Discord 연결의 event를 수신한다. Save `U24/lane-4/evidence.png`. Pass when 선택 transport의 인증과 target 제한 및 내부 결과를 확인한다.
- [ ] Lane 5. 서명을 바꾸거나 오래된 event를 보낸다. Save `U24/lane-5/evidence.png`. Pass when 접수 이유가 표시되고 모델과 tool은 시작하지 않는다.
- [ ] Lane 6. 같은 delivery를 두 번 보내고 daemon을 재시작한다. Save `U24/lane-6/evidence.png`. Pass when 동일 commandId로 수렴하고 작업 시작이 한 번이다.
- [ ] Lane 7. 원격 접수 응답을 잃은 뒤 동일 event를 재전달한다. Save `U24/lane-7/evidence.png`. Pass when unknown 결과를 조회하며 외부 행동을 무조건 다시 실행하지 않는다.
- [ ] Lane 8. workflow를 pause하거나 expiresAt를 지난다. Save `U24/lane-8/evidence.png`. Pass when 신규 dispatch가 거절되고 이전 결과와 audit 기록은 남는다.
- [ ] Lane 9. 허용하지 않은 repository와 다른 host의 같은 workspace 이름을 넣는다. Save `U24/lane-9/evidence.png`. Pass when 이름 대신 고정 identity로 거절하고 대상 데이터가 바뀌지 않는다.
- [ ] Lane 10. 명령처럼 보이는 event 본문과 rate limit 초과를 함께 보낸다. Save `U24/lane-10/evidence.png`. Pass when 권한과 대상 정책은 변하지 않고 제한된 원문만 작업 자료가 된다.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. verified event에서 durable 접수까지 p95, 제한된 queue depth와 idle RSS, redelivery 조회 지연 및 audit 저장 bytes를 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U24 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw sample을 보존한다.
- [ ] Baseline. 기존 host idle과 U21의 같은 내부 dispatch를 먼저 측정한다. 외부 네트워크와 새 서명 검증 비용은 U01 absolute budget으로 따로 기록한다.
- [ ] Rule. 같은 작업의 지연 또는 메모리 15%, 설치 크기 10% 증가 초과는 검토를 막는다. 새 작업은 사전 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] 세 connector의 연결 상태와 거절 및 unknown 복구 screenshot과 video를 U24/review에 저장해 operator에게 제시한다. 실제 계정이 준비되지 않은 lane은 NOT_RUN_DEVICE로 남긴다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 대조하고 `U24`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하며 자동 merge나 loop를 켜지 않는다.

## 검증한 설치 파일을 그대로 승격하고 전체 배포를 마친다 (U25)

**Depends on.** U25a는 U01 뒤 시작한다. U25b는 U01부터 U24 및 U25a 완료 뒤 진행한다.

범위 ID는 `aside:C12` `hig:W5` `hig:H11` `hig:H12` `hig:H13` `hig:H14` `hig:S15` `hig:F01` `hig:D10` `paseo:F26` `paseo:F36` `paseo:E08` `paseo:PA16` `paseo:PA17` `paseo:PA18`이다. 모든 제품 검증 상태는 `NOT_RUN`이다.

**Files.**

- [ ] Edit `.github/workflows/release.yml`. candidate 생성과 동일 artifact promotion을 분리한다.
- [ ] Create `packages/contracts/src/release.ts`. 설치 증거와 승격 판단을 정의한다.
- [ ] Create `packages/contracts/src/release.test.ts`. 미검증 또는 다른 hash의 파일 승격을 거절한다.
- [ ] Create `packages/contracts/src/protocol.ts`, `packages/contracts/src/protocol.test.ts`, `apps/host/src/update-policy.ts`. client/daemon 협상과 진행 작업의 업데이트 경계를 정의한다.
- [ ] Extend from U16/U17 `packages/contracts/src/host-session.ts` and edit `apps/host/src/http.ts`, `apps/host/src/store.ts`, `apps/web/src/api.ts`, `packages/client/src/index.ts` for handshake, migration and write rejection.
- [ ] Create `scripts/release/verify-provenance.ts`. 후보 run와 source 및 증거와 파일 hash를 검증한다.
- [ ] Create `scripts/release/promote.ts`. 승인된 동일 파일의 trial/stable 승격만 수행한다.
- [ ] Create `scripts/integration/installed-acceptance.ts`. 실제 OS driver와 설치 리소스 hash를 receipt로 기록한다.
- [ ] Edit `scripts/setup-smoke.ts`. 기존 설치 리소스 검사를 유지한다.
- [ ] Edit `scripts/upgrade-smoke.ts`. 새 service와 profile 및 device 데이터 보존을 추가한다.
- [ ] Edit `apps/desktop/src-tauri/windows/hooks.nsh`. 등록한 service만 업데이트하고 제거한다.
- [ ] Edit `apps/desktop/src-tauri/tauri.conf.json`. 앱 version을 동기화한다.
- [ ] Edit `apps/desktop/src-tauri/tauri.release.conf.json`. 공통 리소스와 설치 hook을 연결한다.
- [ ] Edit `apps/desktop/src-tauri/tauri.release.windows.conf.json`. Windows 리소스를 검증한다.
- [ ] Edit `apps/desktop/src-tauri/tauri.release.macos.conf.json`. macOS service와 client 리소스를 검증한다.
- [ ] Edit `apps/desktop/src-tauri/Cargo.toml`. desktop package version을 동기화한다.
- [ ] Edit `apps/desktop/src-tauri/Cargo.lock`. desktop package lock version을 동기화한다.
- [ ] Edit `package.json`. root version과 최종 build/check 경로를 동기화한다.
- [ ] Edit `package-lock.json`. 내부 workspace 의존성 및 새 client/mobile lock을 동기화한다.
- [ ] Edit `apps/desktop/package.json`. desktop version을 동기화한다.
- [ ] Edit `apps/web/package.json`. web version과 contracts 의존성을 동기화한다.
- [ ] Edit `apps/host/package.json`. host version과 내부 provider 의존성을 동기화한다.
- [ ] Edit `apps/design/package.json`. design version과 contracts 의존성을 동기화한다.
- [ ] Edit `apps/office/package.json`. office version과 contracts 의존성을 동기화한다.
- [ ] Edit `packages/contracts/package.json`. contracts version을 동기화한다.
- [ ] Edit `packages/provider-claude/package.json`. provider version을 동기화한다.
- [ ] Edit `packages/provider-codex/package.json`. provider version을 동기화한다.
- [ ] Edit `packaging/arch/PKGBUILD`. 시스템 Node 의존성과 service 등록 경로를 검증한다.
- [ ] Create `docs/releases/v0.4.0.md`. 실제 통과한 범위와 정확한 설치본 증거만 기록한다.

**Interfaces.** U01 AcceptanceRecord와 summarizeAcceptance를 소비한다. release.ts는 배포 스크립트가 쓰는 순수 검증이며 제품 runtime의 자동 업데이트 권한을 만들지 않는다. 다음 complete fixture용 계약을 정의한다.

```ts
type ProtocolOffer = { major: number; minMinor: number; maxMinor: number; schemaVersion: number };
declare function negotiateProtocol(host: ProtocolOffer, client: ProtocolOffer): { mode: "compatible" | "upgrade_required"; canWrite: boolean; agreedMinor: number | null };
type CandidateAsset = {
  format: "nsis" | "msi" | "dmg" | "appimage" | "deb" | "arch";
  name: string; sourceSha: string; sha256: string; bytes: number;
};
type InstallProof = {
  format: CandidateAsset["format"]; sourceSha: string; acceptanceSha: string;
  artifactSha256: string; platform: string; deviceId: string;
  state: "PASS" | "FAIL_WITH_EVIDENCE" | "NOT_RUN" | "NOT_RUN_PLATFORM" | "NOT_RUN_DEVICE";
};
declare function verifyInstallProof(asset: CandidateAsset, proof: InstallProof): "accepted" | "artifact_mismatch" | "source_mismatch" | "not_run";
declare function preparePromotion(input: {
  version: string; channel: "trial" | "stable"; assets: CandidateAsset[];
  installProofs: InstallProof[]; requirements: AcceptanceRecord[];
}): { canPromote: boolean; reasons: string[] };
```

**Build.**

- [ ] `packages/contracts/src/release.test.ts`에 `rejects_unaccepted_artifact`를 먼저 추가한다. 정의한 타입을 import하고 아래 complete fixture를 사용한다.

```ts
it("rejects_unaccepted_artifact", () => {
  const asset: CandidateAsset = {
    format: "nsis", name: "Workbench_0.4.0_x64-setup.exe",
    sourceSha: "a".repeat(40), sha256: "b".repeat(64), bytes: 100
  };
  const proof: InstallProof = {
    format: "nsis", sourceSha: "a".repeat(40), acceptanceSha: "c".repeat(40),
    artifactSha256: "d".repeat(64), platform: "windows-x64",
    deviceId: "isolated-windows-1", state: "PASS"
  };
  expect(verifyInstallProof(asset, proof)).toBe("artifact_mismatch");
  expect(verifyInstallProof(asset, { ...proof, artifactSha256: asset.sha256, state: "NOT_RUN" }))
    .toBe("not_run");
});
```

- [ ] RED 명령 `npx vitest run packages/contracts/src/release.test.ts -t rejects_unaccepted_artifact`를 실행한다. 새 export 부재 또는 해당 행동 assertion 실패를 확인한다. 환경 실패는 RED가 아니다.
- [ ] U25a를 U01 다음에 시작한다. release.yml의 candidate 경로는 공통 web/host 한 번 빌드, 전체 Vitest/typecheck, Fast Find golden, urgent parallel UI와 기존 6종 desktop build를 유지한다. 현재 PR branch에는 release workflow가 자동 실행되지 않는 점을 반영해 명시한 candidate dispatch를 준비한다.
- [ ] U25a의 verify-provenance.ts에 sourceRun, 실제 head SHA, acceptance SHA, OS/Node/Rust/WebView 및 upstream revision, 6개 unique artifact hash, unit/live/perf receipt를 연결한다. trial은 미완료 ID를 표시한 채 중간 설치본을 전달할 수 있지만 stable은 NOT_RUN과 NOT_RUN_DEVICE가 하나라도 있으면 거절한다.
- [ ] U25a의 promotion 경로는 candidate artifact를 다시 빌드하지 않고 download 및 검증 후 draft에 올린다. 기존 v tag가 별도 파일을 재빌드해 자동 공개하지 않게 tag와 exact source를 확인하는 경로로 바꾼다. preview 전용 검증을 stable에도 공통 적용하고 SHA256SUMS와 installer-provenance를 두 채널 모두에 포함한다.
- [ ] U25b의 protocol.ts에 major/minor와 schema compatibility를 명시하고 write를 허용하기 전에 handshake를 검사한다. `packages/contracts/src/protocol.test.ts`에 아래 test를 먼저 넣고 `npx vitest run packages/contracts/src/protocol.test.ts -t incompatible_major_cannot_issue_commands`에서 RED를 확인한 뒤 구현한다.

```ts
it("incompatible_major_cannot_issue_commands", () => {
  const host: ProtocolOffer = { major: 2, minMinor: 0, maxMinor: 3, schemaVersion: 4 };
  const client: ProtocolOffer = { major: 1, minMinor: 0, maxMinor: 9, schemaVersion: 3 };
  expect(negotiateProtocol(host, client)).toEqual({ mode: "upgrade_required", canWrite: false, agreedMinor: null });
});
```

- [ ] update-policy.ts에서 active run drain 또는 명시 interrupted, service ownership, migration 전 백업과 복구 가능한 schema 범위를 조정한다. HTTP/client/UI의 새 명령은 협상 결과를 실제로 적용하고 API smoke로 거절 상태를 확인한다. 같은 protocol test를 다시 실행해 GREEN과 기존 호환 client의 회귀를 확인한다.
- [ ] U25b에서 client/daemon protocol 불일치, 활성 작업 중 업데이트, service 등록/정상 종료/재접속, schema migration과 복구 정책을 검증한다. 복구할 수 없는 data migration은 낡은 binary로 그대로 재시작하지 않는다. UI 없는 Office와 웹 작업은 실행기 capability에 따라 지속 또는 명시 interrupted로 보존한다.
- [ ] 목표 0.4.0은 사용자 확정값이다. 실행 시작의 최신 공식 tag를 확인하고 이 목표를 모든 manifest와 lock 및 Tauri/Cargo에 함께 반영한다. U07이 만든 client와 U18에서 실제 선택해 만든 mobile manifest가 있으면 같은 범위를 갱신한다. Arch pkgver는 root에서 읽으므로 중복 version 상수를 만들지 않는다. published v0.3.3의 source 6108d789와 현재 acceptance bc1057c를 바꾸어 기록하지 않는다.
- [ ] upgrade 기준을 현재 공개 v0.3.3으로 갱신하고 preview 설명의 v0.2.2 하드코딩을 실제 baseline 값으로 바꾼다. Windows EXE를 실제 설치해 기본 데이터 경로에서 upgrade-smoke를 진행한다. MSI, macOS DMG, AppImage/deb/Arch도 각 설치와 업데이트를 별도로 검증한다. smoke는 설치 Node/API 경로이고 native 전체 화면 인수를 대체하지 않는다.
- [ ] installed-acceptance.ts가 실제 OS driver 또는 기록한 수동 설치 결과를 받게 한다. Windows 우선 네이티브 focus/IME/DPI/clipboard/파일, macOS arm64, Linux와 niri, iOS/Android를 구별한다. 제어 도구나 기기가 없으면 NOT_RUN_PLATFORM 또는 NOT_RUN_DEVICE를 기록한다. signing/notarization과 mobile push 배포 설정도 실제 기기에서 확인한다.
- [ ] 최종 coverage의 원본 156개 정의, C/H/PA/X, E01부터 E08, REG01부터 REG12 및 Office 9형식의 exact head 증거를 대조한다. 독립 Ieum 설치/등록/같은 파일 저장 복귀, Dropbox 우선과 로컬 DB, Fast Find exact prompt, YAML 형태/본문 bytes, archive/worktree 및 사용자 설정을 모두 확인한다.
- [ ] U25b의 공개는 complete local change와 diagnostics 및 실행 시 fresh remoteChangePolicy의 실제 준비 절차를 마친 뒤 진행한다. draft 파일을 검증한 동일 hash로 안정판에 승격하고 공개 자산을 다시 읽어 이름/크기/hash/source를 대조한다. 실패 또는 unknown 상태에서 release를 반복 생성하거나 설치 파일을 교체하지 않는다.
- [ ] GREEN 명령 `npx vitest run packages/contracts/src/release.test.ts -t rejects_unaccepted_artifact`를 다시 실행해 PASS를 확인한다. 관련 회귀와 타입 검사를 마친 뒤 이 목적의 diff와 commit SHA를 기록한다.

**You see.**

- [ ] 중간 설치본부터 기능별 미완료 범위가 보이고, 최종 GitHub 파일은 실제 OS와 휴대폰에서 검증한 바로 그 설치본이다. 버전 숫자만 오른 상태는 완료로 표시되지 않는다. 결과와 지원 범위를 `U25/result.json`에 남긴다.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npx vitest run packages/contracts/src/release.test.ts packages/contracts/src/protocol.test.ts`와 `npm run typecheck`를 실행한다. 6종 누락/중복, hash와 source mismatch, skipped CI job, NOT_RUN gate, data schema 비호환, 권한 없는 promotion을 검사한다. 전체 제품 검사는 candidate CI가 실행하고 이 검증 함수만 통과한 상태를 전체 완료로 쓰지 않는다.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `current-session-model` at the PR head. 열 개 시나리오는 root와 최대 3개 owner가 순차 또는 제한 병렬로 수행한다.

- [ ] Lane 1. Regression lane against trunk. 공개 v0.3.3와 후보 설치본에서 같은 프로젝트와 문서 및 설정을 연다. Save `U25/lane-1/evidence.png`. Pass when 기준 installer source와 acceptance SHA를 분리하고 기존 파일과 사용자 상태를 보존한다.
- [ ] Lane 2. Windows EXE를 새로 설치해 main 및 두 문서 AI와 웹 두 개를 실제 사용한다. Save `U25/lane-2/evidence.png`. Pass when native UI, IME, 제어 인계, 결과 저장과 UI 종료 중 작업의 상태가 실제로 확인된다.
- [ ] Lane 3. Windows v0.3.3에서 fixture 자료를 만든 뒤 같은 위치에 후보 EXE로 업데이트한다. Save `U25/lane-3/evidence.png`. Pass when session ID, layout/draft, 원문, 키와 device grant 및 외부 파일을 보존하고 artifact hash가 기록된다.
- [ ] Lane 4. Windows MSI를 별도로 설치하고 service 시작과 제거 흐름을 확인한다. Save `U25/lane-4/evidence.png`. Pass when EXE 증거를 대신 쓰지 않고 소유 service만 정상 종료하며 사용자 자료는 보존한다.
- [ ] Lane 5. macOS arm64 DMG를 설치하고 WebView 및 notifications와 독립 Ieum 복귀를 확인한다. Save `U25/lane-5/evidence.png`. Pass when 실제 앱 실행과 권한 및 저장 결과가 native 화면에서 확인된다.
- [ ] Lane 6. Linux AppImage와 deb 및 Arch 패키지를 각각 설치한다. Save `U25/lane-6/evidence.png`. Pass when 해당 경로의 의존성, native 실행, service 및 업데이트가 통과하고 niri 미지원 항목을 숨기지 않는다.
- [ ] Lane 7. 같은 candidate daemon에 실제 iOS와 Android를 연결해 background 복귀와 push를 연다. Save `U25/lane-7/evidence.png`. Pass when 올바른 host/run으로 이동하고 승인 중복, 회수, 사진 및 파일 결과가 검증된다.
- [ ] Lane 8. active 작업 중 버전 갱신과 protocol mismatch 및 rollback fixture를 실행한다. Save `U25/lane-8/evidence.png`. Pass when 작업 결과를 중복 실행하지 않고 호환 또는 거절과 복구 상태가 명확하다.
- [ ] Lane 9. 최종 9형식 문서와 Dropbox 및 볼트와 Fast Find 및 개발 도구 회귀를 실행한다. Save `U25/lane-9/evidence.png`. Pass when 모든 원본 수용 ID와 REG 증거가 있고 파일 bytes와 YAML 형태 및 검색 위치가 보존된다.
- [ ] Lane 10. 검증한 draft artifact를 승격한 뒤 GitHub 공개 metadata와 파일 hash를 다시 읽는다. Save `U25/lane-10/evidence.png`. Pass when source와 acceptance 및 모든 asset이 검증한 후보와 일치하고 재빌드나 교체가 없다.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 6종 다운로드/설치 bytes, 시작과 입력 및 검색 p95, daemon idle/peak RSS, upgrade 시간과 모바일 reconnect p95를 같은 fixture로 측정한다.
- [ ] Probe. `node scripts/integration/perf-probe.ts --unit U25 --baseline <base-sha> --head <head-sha> --interleave --out <evidence-dir>`로 같은 장치와 build type의 raw sample을 보존한다.
- [ ] Baseline. 공개 v0.3.3 설치본과 현재 소스 기준을 분리해 먼저 기록한다. 본체, 외부 Ieum, 선택 음성 모델 및 cache 크기를 나누고 새 service와 mobile 작업은 U01 absolute budget에 대조한다.
- [ ] Rule. 같은 작업의 지연 또는 메모리 15%, 설치 크기 10% 증가 초과는 검토를 막는다. 새 작업은 사전 absolute budget 초과 시 통과하지 않는다. 다른 작업 사이의 비율을 만들지 않는다.

**Review gate.** The operator reviews before merge.

- [ ] Windows 최초 설치와 업데이트, 모바일 접속 및 최종 기능 흐름의 screenshot과 video를 U25/review에 모아 operator에게 실제 후보 SHA와 미검증 범위를 제시한다. U25a 중간 설치본 검토와 U25b 전체 인수를 구분한다.

**Merge.**

- [ ] root가 exact head의 요구와 unit/live/perf evidence를 대조하고 `U25`를 merge-ready로 기록한다. blocking finding과 실제 CI를 정리하며 자동 merge나 loop를 켜지 않는다.

## Close the program

- [ ] U01-U24 및 U25a/U25b의 exact-head receipts를 coverage에 연결한다. 원본 156개 정의, 53개 수용 기준, 12개 회귀 묶음과 Office 9형식의 누락을 검사한다. 하나라도 NOT_RUN이면 전체 완료를 선언하지 않는다.
- [ ] root가 마지막 diff와 support matrix를 직접 검토한다. 진행 중인 owner의 요약만으로 clean 판정을 내리지 않는다. 해결하지 못한 실제 결함은 영향과 재현 evidence를 연결한다.
- [ ] 실제 지원 OS 설치본과 iOS/Android 결과를 artifact hash에 연결한다. Node/API smoke, native UI, 실제 모바일 검증을 구별하며 장치 없는 항목을 PASS로 바꾸지 않는다.
- [ ] 정식 릴리즈는 검증한 설치 파일과 동일한 bytes를 승격한다. source SHA, build run, acceptance SHA, asset SHA256, release tag와 사용자 데이터 migration 결과를 서로 구별한다.
- [ ] 사용자에게 설치 경로, 핵심 새 동작, 현재 지원 환경, 남은 제한과 rollback 경로를 전달한다. 중간 빌드의 변경 목록을 전체 완료로 포장하지 않는다.
- [ ] 명시된 실제 작업 완료 뒤 해당 workId의 등록된 임시 도구와 owned service만 정상 종료하고 resource lease를 해제한다. 다음 실행을 위한 handoff와 정확한 research revision을 남긴다.

## Appendix Execution order and final integration build

25개 U는 목적별 ownership 단위다. 실행 순서는 [executionGraph](support/coverage.json)의 26개 노드 U01-U24, U25a, U25b를 따른다. 분기별 전체 의존이 준비되기 전에도 명시된 startAfter의 독립 준비를 시작할 수 있지만 완료 판정은 원래 의존을 모두 기다린다.

| 단계 | 필요한 결과 | 전달과 완료 범위 |
|---|---|---|
| 시작 | U01 뒤 U02, U06, U12, U25a | 공통 기준과 위험 실증, 설치 경로를 먼저 준비한다 |
| 구현 A | U01-U06 | 셸/프로젝트/대화/이미지/작업 상태를 구현·커밋한다 |
| 구현 B | A와 U07-U08, U10-U15 | Office UI, 검색/볼트/이음, 일반 웹/같은 페이지 AI/외부 앱을 연결한다 |
| 구현 C | B와 U09, U16-U19 | 독립 host와 문서 executor, 기기 연결/모바일/알림을 연결한다 |
| 구현 D | C와 U20-U24 | workspace 운영, 예약, 음성, 플러그인과 Hub를 연결한다 |
| Full release | U01-U24 및 U25a 완료 뒤 U25b | 모든 원본 ID/회귀/형식과 설치본 검증을 만족한 동일 artifact를 정식 승격한다 |

위 A–D는 구현의 구분이며 각각 설치본을 빌드하는 단계가 아니다. 전체 요구가 연결된 뒤 U25에서 통합 빌드·설치·데이터 보존 확인과 릴리즈를 수행한다. 2026-11-09 추가 사용자 교정이 이전 중간 빌드 계획을 대체한다. 기능 수나 버전 숫자가 완료 표를 대신하지 않는다.

병렬 owner는 최대 3개다. 예를 들어 공통 UI owner, host 계약 owner, renderer 실증 owner를 두며 root가 공통 entry를 통합한다. 다음 단위에 들어갈 때 owner를 재배치한다. 이것은 열 개 live lane을 열 명의 worker로 만드는 계획이 아니다.

## Appendix Prototype evidence

[architecture-gates](support/architecture-gates.md)의 실증은 다음 단위의 구현 선택을 닫는 증거다. 현재 모든 행의 상태는 NOT_RUN이다. 성공 가능성이나 성능 우위를 코드 열람만으로 입증했다고 쓰지 않는다.

| Gate | 소유 단위 | 최소 관찰 | 종료 판단 |
|---|---|---|---|
| G-BR0 | U12 | pageId/profileId, pane move nonce 유지, URL navigation/reload 새 nonce와 revision | 동일 페이지 계약을 실제 OS fixture에서 구분한다 |
| G-BR1 | U12 | DOM/관찰/행동, popup/file, bounds/hide/show와 app bridge 격리 | OS별 capability 증거를 남기고 renderer를 선택한다 |
| G-BR2 | U12 | 20회 제어 전환, IME/focus, stale action | wrong-target 0, stale 거부 100%, 인계 후 새 mutation 0 |
| G-DM1 | U16 | UI hide/quit, service stop/crash, sleep/reboot, owned PID identity | UI 없는 같은 run과 epoch 복구를 구별한다 |
| G-OF1 | U09 | physical identity, dirty buffer, writer generation, revision/hash CAS | 이중 writer와 stale commit이 발생하지 않는다 |
| G-OF2 | U09 | Markdown 실제 저장 뒤 9형식 승인 도구별 executor matrix | 기존 도구의 UI 종료 후 실행/저장/인계를 입증한다 |
| G-MB1 | U17-U18 | same session, approval/cancel/duplicate/history gap | protected transport와 client 계약을 확정한다 |
| G-MB2 | U18 | Workbench client와 Paseo 후보 conformance | SDK와 공식 앱/확장 호환을 구별한다 |
| G-MB3 | U18 | 실제 iOS/Android file/push capability/lifecycle | responsive/PWA 또는 native 전달 경로와 정확한 파일/빌드 목록을 고정한다 |

실험별 receipt는 가설, OS와 장치, source SHA, fixture hash, command, expected, actual, evidence path, 실패 원인과 다음 판단을 담는다. 하나의 실증은 90분 이내로 제한하고 새 가설이나 환경 변화가 생겼을 때만 한 번 45분 추가한다. 재료나 장치 부족은 NOT_RUN이며 실패한 실험으로 꾸미지 않는다. 기능 전체를 이 시간 안에 완성한다는 약속도 아니다.

G-MB3에서 경로가 정해지지 않으면 mobile scaffold 구현을 시작하지 않는다. 정확한 platform entry, build/signing config, tests, delivery manifest와 관련 workspace wiring을 plan revision에 고정한 뒤 진행한다. prototype은 실제 계정 설정이나 사용자 배포의 완료를 대신하지 않는다.

## Appendix Bounded regression and evidence

[coverage.json](support/coverage.json)의 원본 ID와 primaryOwner를 회귀의 권위로 사용한다. 테스트 코드에서 새 번호로 원본 C/H/PA/X/F/E/S/D/W/P를 대체하지 않는다. namespace가 다른 F ID도 합치지 않는다.

각 단위의 새로운 위험 행동에는 먼저 실패하는 의미 있는 test를 한 개 이상 둔다. 코드와 동일한 구현을 다시 적는 test나 문서/토큰 문자열을 고정하는 test는 추가하지 않는다. 위 test 예제는 구현 때 만들 fixture와 adapter 주입 경계를 보여 주며, 현재 테스트 실행 결과가 아니다.

첫 code-ready head에서 관련 unit과 열 개 scenario lane 및 네 perf box를 확인한다. 이후 작은 변경은 영향받는 lane과 필요한 회귀만 다시 실행한다. 같은 candidate의 연속 video, fixture 실행과 설치 evidence는 여러 U에서 exact hash로 참조할 수 있다. 서로 다른 head의 증거를 이유 없이 재사용하지 않는다.

최종 통합 검증은 수동 생성, 프로젝트 개요/종류/YAML, 문서 집중/복귀, 병렬 문서 AI와 메인, 원문 Fast Find, 읽기 전용 볼트 이동, 모델 갱신, 보관/삭제, 알림, 독립 이음 설치/저장 복귀, Dropbox 우선, 기존 개발 도구의 12개 회귀 묶음을 한 번 수행한다. 이후 새 변경이나 실패, 미해결 위험이 있을 때만 해당 묶음을 다시 연다.

Office 형식별 증거는 한글, Word, 슬라이드, 시트, Markdown, PDF, HTML, 마인드맵, EPUB의 기존 메뉴와 toolId를 개별로 표시한다. UI 개편, 수동 편집/저장/출력, 승인 AI 도구의 실행/취소/인계는 서로 다른 칸이다. 한 형식의 성공으로 나머지 형식을 PASS 처리하지 않는다.

성능은 같은 기기와 build type, 고정 corpus/doc/media fixture를 사용한다. baseline과 candidate를 교차 측정하고 raw samples를 남긴다. p95 지연/idle·peak memory 15%와 installer bytes 10%가 기본 검토 문턱이다. 새 기능 absolute budget은 U01에서 구현 전에 숫자로 기록하며, 이 문서의 값은 실측 성능 주장이나 개선 보장이 아니다.

원본 소스와 연구 revision은 [source manifest](support/source-files.sha256.json), [coverage notes](support/coverage-notes.md), [architecture gate](support/architecture-gates.md), [release analysis](support/release-notes.md), [integration provenance](support/integration-provenance.json)에 연결한다. 원본문서나 사람 볼트 원문을 계획 작성의 부수 작업으로 바꾸지 않는다.

## Appendix Planning validation

이 문서는 계획 산출물이다. 구조 checker 결과는 문서 구조에 관한 검증이며 제품 tests, prototype, native UI, 모바일, build, GitHub 배포의 성공을 뜻하지 않는다. 모든 제품 체크박스와 실행 결과는 NOT_RUN으로 남긴다.

선택된 원본 pstack의 읽기 전용 check-plan.mjs를 이 파일에 실행한다. root는 그 결과와 별도로 spec, 실제 파일 경로, 계약/의존, fixture의 비공허한 assertion, 현재 지원 범위와 release provenance를 직접 검토한다. 구조 통과만으로 설계 검토를 대신하지 않는다.


### U22–U24 실행 연결 기록 (2026-11-09)

고정한 Paseo 원본 음성·SDK·manifest·compiler·lifecycle와 Workbench 서비스/UI를 연결했다. 공개 Cloud consumer 부재는 기존 TaskService/SQLite로 보완했다. 신규 타입 오류·화면 direct DTO 불일치를 수정했으며, 실기기/외부계정·원본 outbound Hub client와 전체25개/156요구의 잔여 범위는 유지한다. 기능별 앱/설치본빌드는 실행하지 않는다. [현재 동작/한계](../../voice-extensions-events.md), [실행 상태](../execution/STATUS.md), 근거 `research:rr-79110658024cdb4797375aa15a22a771:ec68d100c4776b2219a705303a379cc524ae2c83caca88c7c9c2f1d9b6c805b5` (R13–R18).

### 2026-11-09 U09·U12–15·U20 연결 구현

원본 Office queue/QC·PDF job·native output, native browser 다운로드/권한/profile/산출물, 공식 agent-desktop CLI·앱 선택·세션 도구, 원본 Paseo terminal runtime·기기 연결·서비스 HTTP 경로를 연결했다. 현재 코드 상태는 `../execution/STATUS.md`, 외부 앱 범위는 `../../desktop-control.md`, Office 범위는 `../../office-execution.md`를 따른다.

새 사용자 교정 `decision-5e2a5ff3288c4ec7973e1f9922dd873605f56843e258b8e4fea0485a18a4cd70`: 구현 우선. 통과 검사 반복과 기능별 추가 검증·재검토 금지. 새 root/web/Rust 확인은 시작하지 않았으며 전체 구현 뒤 필요한 통합 확인만 한다. 전체 25개 단위/156개 요구를 축소하거나 완료로 처리하지 않는다.

외부 앱 근거: `research:rr-fb025ea83d26bd1d7147dd3208893d54:d9f464f99080ff5b2977503a924625a278cd52656ad65dd9a41e9e613a4709ab` (R1–R5).

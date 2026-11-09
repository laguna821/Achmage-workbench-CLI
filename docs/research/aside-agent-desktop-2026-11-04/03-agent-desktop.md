# agent-desktop 소스 조사와 도입 판단

확인일: 2026-11-04 KST. [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop)을 읽기용으로 shallow clone했다. 외부 저장소의 설치 스크립트·스킬·테스트를 실행하거나 우리 앱에 코드를 합치지는 않았다.

## 확인한 버전

| 항목 | 값과 근거 |
|---|---|
| 소스 commit | `93ae89e86fb849eeb5fc265b0b8e37eca56aaf72` |
| commit 시각 | 2026-11-02T21:51:54-08:00 |
| workspace 버전 | 1.1.0, [Cargo.toml](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/Cargo.toml) |
| 언어 | Rust, edition 2024, rust-version 1.89 |
| 출력 계약 | JSON envelope 2.6, [output.rs](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/crates/core/src/response/output.rs) |
| FFI 계약 | C ABI major 7, [abi_version.rs](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/crates/ffi/src/abi_version.rs) |
| 라이선스 | Apache-2.0, [LICENSE](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/LICENSE) |

이전 조사에 사용한 commit과 달라, 이번 설계의 코드 근거는 위 commit으로 고정한다. npm의 최신 배포와 이 commit이 같다고 가정하지 않는다.

## 어떤 도구인가

agent-desktop은 운영체제의 접근성 트리에서 버튼·입력칸·창을 찾아 조작하는 **실행 도구**다. JSON snapshot의 요소 ref를 이용하고, 다음 판단과 호출은 외부 에이전트가 담당한다. CLI와 C 라이브러리를 제공하며 자체 채팅 앱·브라우저 렌더러·프로젝트 오케스트레이터를 제공하는 것은 아니다. [README](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/README.md)

```text
Workbench의 에이전트
  → 앱/창 선택 → snapshot → 요소 ref로 행동
  → 새 snapshot 또는 결과 확인 → 다음 행동/완료 보고
```

| 비교 대상 | 읽고 조작하는 대상 | 화면을 그리는 주체 | 이번 설계에서의 역할 |
|---|---|---|---|
| Lightpanda | 웹 DOM·JS·네트워크 | 시각 렌더링을 제공하지 않음 | 백그라운드 조사·자료 추출 |
| Playwright | 연결된 브라우저의 페이지·DOM | 연결 대상 브라우저/WebView | 지원되는 공유 웹 탭의 제어 드라이버 |
| agent-desktop | OS 접근성 트리·앱 창·입력 | 원래의 데스크톱 앱 | 이음오피스 등 외부 앱 조작 |
| Tauri WebView 등 | 실제 페이지를 표시 | WebView2/WKWebView/WebKitGTK | 사람이 보는 웹 탭 |

웹 관련 구분은 [Lightpanda 아키텍처](https://lightpanda.io/docs/core-concepts/architecture-overview), [Playwright WebView2 연결](https://playwright.dev/docs/webview2), [Tauri WebView 구성](https://v2.tauri.app/reference/webview-versions/)과 대조했다. 이 도구들의 성능이나 토큰 절감률을 동일 조건에서 벤치마크한 결과는 아니다.

## 소스에서 확인한 중요한 동작

| 코드 | 관찰한 동작 | Workbench에 주는 조건 |
|---|---|---|
| [interaction_policy.rs](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/crates/core/src/actions/interaction_policy.rs) | 기본 headless는 focus steal=false, cursor move=false | 화면 없는 환경이라는 뜻으로 해석하지 않음 |
| [ref_token.rs](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/crates/core/src/refs/ref_token.rs) | snapshot ID를 포함한 ref 식별 | 오래된 ref를 다른 화면에 그대로 재사용하지 않음 |
| [session/mod.rs](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/crates/core/src/session/mod.rs) | 세션별 데이터와 실행 맥락 관리 | 우리 taskId와 도구 세션을 연결하되 가상 데스크톱으로 취급하지 않음 |
| [interaction_lease.rs](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/crates/core/src/session/interaction_lease.rs) | 플랫폼의 상호 배제 실행 lease 사용 | 여러 에이전트가 같은 앱을 동시에 바꾸지 않도록 상위에서 조정 |
| [ffi/lib.rs](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/crates/ffi/src/lib.rs) | native element handle은 생성 스레드에서 사용·해제; 별도 release-ffi profile | FFI 직접 내장에는 스레드·수명·panic 경계 설계 필요 |

CLI의 명령 이름은 60개지만 그중 56개가 운영 가능 상태로 설명되어 있다. 키/마우스 버튼을 계속 누르는 네 명령은 해제를 보장하는 daemon이 마련될 때까지 거부하도록 되어 있다. 명령 이름 존재만으로 기능을 활성화하면 안 된다. [README 명령 표](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/README.md#commands)

## 성공·재시도 해석

출력의 `ok: true`만으로 사용자의 목표가 완료됐다고 표시하면 안 된다. snapshot은 성공 응답이어도 `complete: false`일 수 있고, 행동은 전달됐어도 저장·전송 등의 결과를 확인하지 못했을 수 있다. `disposition.delivery`와 `retry`를 읽어야 한다. [JSON 계약](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/docs/json-output.md)

**도입 어댑터 제안:**

1. 프로토콜 버전을 확인한다. 모르는 breaking version은 성공으로 파싱하지 않는다.
2. 관찰이 부분적이면 필요한 영역을 다시 읽는다. 불완전한 트리를 전체 화면으로 설명하지 않는다.
3. ref가 오래됐거나 요소가 모호하면 새 관찰과 식별을 수행한다. 같은 ref를 반복하는 루프를 만들지 않는다.
4. 입력 전달 여부가 불확실하면 먼저 결과 상태를 확인한다. 저장·전송 같은 행동을 즉시 중복 실행하지 않는다.
5. 제품의 “완료”는 호출 성공이 아니라 작업의 결과 확인을 기준으로 한다.

위 목록은 원문 복제가 아닌 Workbench 적용 규칙이다. 웹 자동화에도 같은 완료/재시도 원칙을 적용한다.

## OS별 조건

| OS | 공식 지원 경로 | 이번 컴퓨터/제품에서 남은 확인 |
|---|---|---|
| Windows | UI Automation. 동일 무결성 수준의 앱은 일반적으로 별도 권한 부여 없이 접근 | 관리자 앱 입력, 이음오피스 컨트롤의 접근성 노출, 입력/저장 확인 |
| macOS | Accessibility 권한. 화면 캡처 등 기능은 해당 OS 권한 필요 | 승인 흐름과 대상 앱별 의미 기반 조작 |
| Linux | 사용자 그래픽 세션의 AT-SPI. 주 대상 Ubuntu 24.04+·GNOME 46 | 현재 CachyOS/niri는 주 검증 환경과 다름 |
| Wayland 세부 | 포인터 입력 및 네이티브 창 제어에 제한. 키 입력 폴백은 GNOME Mutter 경로 | niri에 GNOME 경로를 적용 가능하다고 가정하지 않음 |

출처: [설치와 플랫폼 조건](https://github.com/vercel-labs/agent-desktop/blob/93ae89e86fb849eeb5fc265b0b8e37eca56aaf72/docs/install.md). **이번 작업은 소스 조사까지이며, agent-desktop 실행 검증은 수행하지 않았다.** Linux 기능 전부를 불가능하다고 판단한 것도 아니다. 접근성으로 가능한 기능과 물리 입력이 필요한 기능을 실제 환경에서 나눠 확인해야 한다.

## 도입 방식 제안

처음에는 **공식 CLI 바이너리를 별도 실행 파일로 연결**한다. 버전·해시를 고정하고, 기존 Workbench host가 JSON 결과를 공통 도구 이벤트로 변환하도록 한다. 이렇게 하면 원본 프로젝트의 업데이트를 따라가기 쉽고, 앱 본체에 FFI handle 수명 관리를 먼저 추가하지 않아도 된다. 이는 소스 구조를 근거로 한 설계 판단이며 아직 통합 성능을 측정하지 않았다.

권장 경계:

- `DesktopExecutor`: 앱/창 식별, capability 확인, 호출 timeout, 취소, 결과 정규화.
- `DesktopCoordinator`: 대상 앱에 대한 작업 소유권과 물리 입력의 전역 조정. 세션 이름만 다르다고 앱이 격리되지 않는다.
- UI: “외부 앱에서 작업 중 / 사용자 입력 필요 / 결과 확인 중”을 기존 작업 카드에 표시.
- 초기 기능: 앱 목록·관찰 → 지정 앱에서 한 가지 작업 → 결과 확인. 의미 기반 조작이 불가능한 앱을 자동 성공 처리하지 않는다.
- FFI 전환: CLI 호출 비용을 실제로 측정해 병목으로 확인한 뒤 검토한다.

**우선순위는 웹 탭의 공유 상태를 완성한 다음 외부 앱 조작을 붙이는 것**이다. 이음오피스 “앱으로 열기 → 저장 → Workbench에서 최신 파일 읽기”는 기존 파일·세션 연동을 우선 사용하고, agent-desktop은 외부 앱 UI 자체를 AI가 조작할 때 추가한다. 웹 탭 구현을 위해 모든 데스크톱 조작부터 완성할 필요는 없다.

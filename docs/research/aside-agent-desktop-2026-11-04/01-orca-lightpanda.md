# Orca에서 Lightpanda 사용하기

확인일: 2026-11-04 KST. 이 문서는 **이 컴퓨터에 실제로 수행한 설치와 검증** 기록이다.

## 설치 결과

| 항목 | 확인 결과 |
|---|---|
| 실행 환경 | Linux x86_64, CachyOS/Arch, niri Wayland |
| 설치 버전 | Lightpanda 1.0.2 공식 배포 바이너리 |
| 실제 파일 | `/home/achamge/.local/opt/lightpanda/1.0.2/lightpanda` |
| 실행 링크 | `/home/achamge/.local/bin/lightpanda` |
| 파일 크기 | 76,408,136 bytes, 약 72.87 MiB |
| SHA256 | `ae7d01d261efb9e480e18ce3424533332883863bcf70b12a4321b5733f37e19e` |
| Codex 연결 | 사용자 `config.toml`에 stdio MCP 등록, enabled 확인 |
| Claude 연결 | 사용자 범위 `.claude.json`에 stdio MCP 등록 |
| Orca 실제 확인 | Orca가 생성한 터미널에서 PATH·설정·MCP 호출 검증 성공 |

다운로드한 [공식 릴리즈 1.0.2](https://github.com/lightpanda-io/browser/releases/tag/1.0.2)의 배포 해시와 파일 해시가 일치했다. 기존 MCP 설정은 유지했으며, 수정 전 설정 백업은 접근 권한을 제한한 로컬 조사 작업공간에 보관했다. 계정 설정 원문은 이 저장소에 복사하지 않았다.

## 실제 호출 검증

Orca의 `terminal create --worktree active`로 확인용 터미널을 만들었다. 그 안에서 다음을 확인했다.

1. `lightpanda version` → `1.0.2`.
2. `CODEX_HOME` → `/home/achamge/.codex`. Orca의 실제 실행 설정 위치와 등록 위치가 일치했다.
3. `lightpanda mcp` → initialize 및 tools/list 성공, **도구 32개** 확인.
4. MCP의 `markdown`으로 [Aside side panel 문서](https://docs.aside.com/help/side-panel)를 실제로 읽었다. 응답 본문 2,274 bytes, Aside 내용 확인.
5. stdin 종료 후 MCP 프로세스 정상 종료. 확인용으로 만든 터미널만 닫았다.

MCP가 반환한 `serverInfo.version`은 `0.1.0`이다. 이는 이번 바이너리의 `version` 출력 `1.0.2`와 구분해 기록한다. 에이전트 모델을 유료 호출하거나 사용자의 기존 작업을 재시작하지 않고 연결 경로를 검증했다. 증거는 [검증 결과 JSON](evidence/orca-terminal-verification.json)에 있다.

## 사용하는 방법

새로 시작하거나 MCP를 다시 연결한 Orca의 Codex/Claude 세션에서 `lightpanda` 서버를 사용할 수 있다. 이미 열린 에이전트의 도구 목록이 설정 변경만으로 즉시 갱신된다고 가정하지 않는다. 이번 조사는 현재 세션에서 실행 가능한 CLI와 MCP subprocess로 진행했다.

직접 페이지를 읽는 예:

```bash
lightpanda fetch --dump markdown --json https://docs.aside.com/help/side-panel
```

등록 내용을 확인하는 명령:

```bash
codex mcp get lightpanda
claude mcp get lightpanda
```

등록에 사용한 명령은 아래와 같다. 이미 등록되어 있으므로 다시 실행할 필요는 없다.

```bash
codex mcp add lightpanda -- /home/achamge/.local/bin/lightpanda mcp
claude mcp add --scope user --transport stdio lightpanda -- /home/achamge/.local/bin/lightpanda mcp
```

stdio 연결 방식은 [Lightpanda MCP 문서](https://lightpanda.io/docs/usage/mcp)와 [Codex MCP 설정 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)를 대조했다. Orca 소스의 `codex-home-paths.ts`, `codex-config-mirror.ts`도 읽어 실제 사용자 홈과 오래된 미러 경로를 구분했다. 별도 계정 프로필·다른 컴퓨터까지 이번 검증 범위에 포함하지는 않았다.

## 이번 자료 수집 방법

- 공개 URL 48개를 Lightpanda 1.0.2로 직접 요청했다. 검색 도구는 자료 발견에 사용했고, 문서 본문 수집은 Lightpanda로 수행했다.
- 동시 수집은 최대 2개로 제한했다. URL마다 시각, 종료 코드, HTTP 상태, 본문 크기, SHA256을 남겼다.
- 48개 모두 HTTP 200 응답이었다. **이 숫자는 모든 페이지의 내용이 완전히 확보됐다는 뜻이 아니다.** 영상 2개는 메타데이터만, Reddit은 게시글 중심으로 확보했으며 댓글 전체는 확보하지 못했다.
- 페이지에서 발견한 공개 이미지 6개를 별도로 다운로드해 육안 검토했다. Lightpanda가 화면을 렌더링해 찍은 스크린샷은 아니다.
- 본문 원문과 사진은 로컬 조사 캐시에 두고, 저장소에는 요약·링크·해시·자체 설계를 남겼다.

[전체 출처](06-sources.md), [기계 판독 가능한 수집 목록](sources.json), [설치 증거](evidence/lightpanda-install.json)를 함께 참조한다.

## 범위와 되돌리기

이번에 설치한 것은 **Orca에서 사용할 사용자 도구**다. Workbench 설치본의 번들 구성이나 Windows Lightpanda 배포를 바꾸지 않았다. 상시 서버나 자동 시작 서비스도 만들지 않았다.

나중에 연결만 해제하려면 `codex mcp remove lightpanda`, `claude mcp remove --scope user lightpanda`로 등록을 제거할 수 있다. 바이너리 삭제는 그것을 사용하는 작업을 정상 종료한 뒤 별도로 수행한다. 이번 작업에서는 제거하지 않았다.

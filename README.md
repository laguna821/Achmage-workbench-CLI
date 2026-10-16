# Achmage Workbench

Claude Code와 Codex, 문서 편집, 기존 Achmage 지식 체계를 하나의 단순한 작업 화면으로 잇는 개인용 데스크톱 앱.

- 요구사항: [docs/PRD-v1.0.md](docs/PRD-v1.0.md) · 시안: [assets/ui](assets/ui) · 설계: [docs/design](docs/design)
- 진행 기록: [docs/STATUS.md](docs/STATUS.md)

## 구성

| 경로 | 역할 |
|---|---|
| `apps/web` | React + Vite 단일 작업 화면 |
| `apps/host` | Node 게이트웨이: 엔진 실행, 상태(SQLite), HTTP + SSE |
| `apps/desktop` | Tauri 2 셸: 게이트웨이 실행, 창, 파일 대화상자 |
| `packages/contracts` | 화면·게이트웨이 공통 계약 |
| `packages/provider-codex` | `codex app-server` JSON-RPC 클라이언트, 생성된 프로토콜 타입 |
| `packages/provider-claude` | Claude Agent SDK 메시지 변환 |

## 개발

```sh
export PATH=$HOME/.local/bin:$HOME/.cargo/bin:$PATH
npm install
npm run build -w @workbench/web
WORKBENCH_WEB_DIR=apps/web/dist node apps/host/src/main.ts   # WORKBENCH_READY 줄의 url/?token= 으로 접속
node scripts/smoke-real.ts all      # 실제 엔진 합격 시험 (구독 사용량 소량 사용)
node scripts/ui-shots.ts /tmp/shots # 실제 화면 흐름 스크린샷
```

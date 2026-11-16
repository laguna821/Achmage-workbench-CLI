# Achmage Workbench

Claude Code와 Codex를 한 화면에서 쓰는 데스크톱 작업실입니다. 여러 세션과 문서(워드·PPT·엑셀·한글·PDF·마크다운·디자인)를 한곳에서 다루고, AI가 고친 내용은 수정안으로 받아 확인한 뒤 반영합니다.

- 요구사항: [docs/PRD-v1.0.md](docs/PRD-v1.0.md) · 시안: [assets/ui](assets/ui) · 설계: [docs/design](docs/design)
- 진행 기록: [docs/STATUS.md](docs/STATUS.md)

## 주요 기능

- **두 엔진 한 화면**: Claude Code(Claude Agent SDK)와 Codex(`codex app-server`) 세션을 나란히 씁니다. 작업 중 끼어들기, 끝나면 보내기, 권한(묻기·자동·전체 접근), 컨텍스트·사용 한도, 압축을 지원합니다.
- **대화 속 그림**: 스크린숏을 붙여넣거나 파일을 끌어 놓으면 엔진에 그림으로 전달합니다. 엔진이 찍거나 연 그림은 대화 흐름에 미리보기로 보입니다.
- **계획 먼저 · `/` 명령·스킬 · 이 요청 전으로(갈래) · 다른 곳의 대화 가져오기 · 예약 작업 · 격리 사본(git worktree)과 변경 검토**
- **그림 그리기**: Codex의 GPT Image 도구를 쓰며, 템플릿과 비율을 고를 수 있습니다.
- **에이전트 브라우저**: Playwright CLI로 화면에 보이는 Chromium을 다룹니다. 로그인은 앱 안에서 하고, 다시 켜도 유지됩니다.
- **세션 잇기**: 2~6개 세션이 정한 왕복 수와 시간 안에서 번갈아 답을 주고받습니다.
- **보기 모드**: 홈은 지금·보드·지도·흐름·문서, 작업 화면은 대화·문서·검토·나란히·읽기입니다. 세션을 새 창으로 떼어 낼 수도 있습니다.
- **문서 편집**: 앱 안 편집기에서 바로 고칩니다. 그림은 붙여넣거나 끌어 놓으면 들어가고, 마크다운 그림은 Cloudflare R2에도 올릴 수 있습니다.
- **노션식 정리 + 옵시디언 볼트**: 볼트를 읽기 전용 거울로 보여 주고, 카드 목록·페이지·저장한 보기·규칙을 씁니다. 엔진이 볼트에 쓰지 못하게 막습니다.
- **알림**: 알림을 누르면 그 세션이 열립니다(Linux). 트레이에 "확인 필요 N"을 표시합니다.

## 설치

[Releases](https://github.com/laguna821/Achmage-workbench-CLI/releases)에서 운영체제에 맞는 파일을 받습니다.

| 운영체제 | 파일 | 비고 |
|---|---|---|
| Windows | `*-setup.exe` (NSIS), `*.msi` | Node.js 포함. 서명이 없어 SmartScreen 경고가 뜰 수 있습니다. |
| macOS (Apple silicon) | `*.dmg` | Node.js 포함. 서명이 없어 처음에는 Finder에서 오른쪽 클릭 › 열기로 엽니다. |
| Linux (대부분의 배포판) | `*.AppImage`, `*.deb` | Node.js 포함. AppImage는 실행 권한을 주고 바로 실행합니다. |
| Arch Linux · CachyOS | `*.pkg.tar.zst` | `sudo pacman -U achmage-workbench-*.pkg.tar.zst`. 시스템 Node.js 24 이상을 씁니다. |

**필요한 것**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code)와 [Codex CLI](https://github.com/openai/codex) 중 쓰려는 엔진이 설치되어 있고 로그인되어 있어야 합니다. 앱은 사용자의 로그인을 그대로 쓰며 API 키를 따로 받지 않습니다.

## 소스에서 빌드

Node.js 24 이상, Rust stable(`wasm32-wasip1` 타깃 포함), Tauri 2의 시스템 라이브러리(Linux는 WebKitGTK 4.1)가 필요합니다.

```bash
npm ci --ignore-scripts
npm run build                      # IeumOffice 소스 받기, 엑셀 엔진 wasm, UI, 편집기, 게이트웨이
(cd apps/desktop && npx tauri build --no-bundle)
bash scripts/install-linux.sh      # Linux: 사용자 폴더에 설치하고 런처 등록
```

개발 중에는 게이트웨이를 소스에서 바로 띄워 브라우저로 볼 수 있습니다.

```bash
npm run build -w @workbench/web
WORKBENCH_WEB_DIR=apps/web/dist node apps/host/src/main.ts   # WORKBENCH_READY 줄의 url/?token= 으로 접속
```

검사:
- `npm run typecheck`, `npx vitest run`
- `scripts/*-check.ts`: 가짜 엔진과 Chromium으로 돌리는 화면 검사
- `scripts/smoke-*.ts`: 실제 엔진 확인. 사용량을 씁니다.

## 구조

| 경로 | 내용 |
|---|---|
| `apps/desktop` | Tauri 2 셸. 게이트웨이를 띄우고 창·트레이·알림을 맡습니다. |
| `apps/host` | Node 게이트웨이. HTTP와 SSE, SQLite, Claude·Codex 어댑터, 문서·수정안을 다룹니다. |
| `apps/web` | React UI |
| `apps/office` | 워드·PPT·엑셀 편집기. IeumOffice 소스로 빌드합니다. |
| `apps/design` | 디자인 편집기. doory로 빌드합니다. |
| `packages/contracts` | UI와 게이트웨이가 함께 쓰는 타입 |
| `packages/provider-codex` | `codex app-server` JSON-RPC 클라이언트와 생성된 프로토콜 타입 |
| `packages/provider-claude` | Claude Agent SDK 메시지 변환 |

## 비밀 보관함이 지키는 것과 아직 못 지키는 것

메신저 봇 토큰, 저장한 비밀번호, 이음오피스 AI 키가 비밀 보관함에 들어갑니다. 0.5.0부터 지키는 방식을 강화했지만 한계가 남아 있습니다.

**지킵니다**

- 보관함을 여는 열쇠는 Workbench 앱이 직접 띄운 자기 프로그램에게만 건넵니다.
- AI가 실행한 프로그램이나 다른 프로그램이 열쇠를 달라고 하면 거절합니다. 예전 판의 실행 파일도 열쇠를 받지 못합니다.
- macOS에서는 다른 프로그램이 열쇠를 읽으려 하면 키체인이 먼저 허락을 묻습니다.

**아직 못 지킵니다**

- Windows와 Linux에서는 같은 사용자 계정으로 실행되는 프로그램이 운영체제의 비밀번호 저장소에서 열쇠를 직접 읽을 수 있습니다.
- 그런 프로그램은 Workbench가 시작되는 순간을 노려 앱을 거쳐 열쇠를 얻을 수도 있습니다.
- Windows와 Linux에서는 전체 접근으로 일하는 AI도, 휴대폰에서 시킨 대화까지 포함해, 이 저장소를 읽을 수 있습니다.

그래서 카드나 주거래 은행 로그인은 암호로 여는 보관함이 나올 다음 판까지 넣지 마세요. 출처를 모르는 프로그램은 설치하지 말고, AI에게 ‘전체 접근’을 줄 때에는 이 점을 염두에 두세요.

## 알려진 한계 (0.5.1)

전체 목록은 [릴리스 노트](https://github.com/laguna821/Achmage-workbench-CLI/releases/latest)에 있습니다. 먼저 알아야 할 것만 옮깁니다.

- **설치본**: Windows와 macOS 설치본은 자동으로 만들고 설치하고 처음 실행까지 확인했지만, 사람이 실제 컴퓨터에서 써 보지는 않았습니다. macOS 판은 서명되지 않았습니다.
- **쉬는 탭**: 쉬는 탭과 메모리 표시는 Linux에서 확인했습니다. 쉬었다 깬 오피스 문서는 처음 위치(첫 쪽, 첫 슬라이드, 첫 시트)에서 열리고, 편집기 안의 실행 취소 기록은 남지 않습니다. 메모리 표시는 macOS와 AppImage에서 아직 나오지 않습니다.
- **즐겨찾기**: 사이트 아이콘이 아직 없고, 웹 페이지 안에 커서가 있을 때는 Ctrl+D, Ctrl+Shift+B가 듣지 않을 수 있습니다.
- **휴대폰 메신저**: 슬랙에서는 앱이 내 메시지를 지울 수 없습니다. 비밀번호나 인증번호를 잘못 보냈다면 직접 지워 주세요. 입력 칸이 닫힌 뒤에 보낸 비밀번호나 키는 앱이 가려내지 못합니다.
- **한글 문서**: 예전 한글로 저장한 일부 문서는 쪽 나눔이 한글과 한 줄쯤 다를 수 있습니다(내용이 사라지지는 않습니다). 암호가 걸린 한글 문서는 열어 볼 수 있지만 저장할 수는 없습니다.
- **그 밖에**: 문서 이름은 문서 탭에서 바꿀 수 없습니다. 같은 문서를 두 칸에 나란히 열면 한쪽은 읽기만 됩니다. PDF 편집기의 메뉴와 단추 이름은 아직 영어입니다.

## 라이선스와 출처

- 이 저장소의 코드: [MIT](LICENSE)
- `vendor/doory`: [doory](https://github.com/shaongitbd/doory). Attribution Assurance License이며, 출처를 앱 시작 화면과 디자인 편집기에 표시합니다.
- IeumOffice: [pblsketch/openoffice](https://github.com/pblsketch/openoffice), Apache-2.0. 빌드할 때 고정 커밋으로 받습니다(`scripts/fetch-ieum.sh`). 옮겨 온 코드의 출처는 `third_party/ieumoffice`에 있습니다.
- `third_party/textfold`: [textfold](https://github.com/chenxiachan/textfold), Apache-2.0
- [rhwp](https://github.com/edwardkim/rhwp): 한글 문서 편집기의 엔진, MIT.
- [Icons8](https://icons8.com): 프로젝트, 폴더, 대화, 문서 종류의 항목 아이콘(Liquid Glass). Icons8 라이선스에 따라 출처를 표시합니다.
- [Atlas File Manager](https://github.com/neondeex/atlas-filemanager): 색 조합의 색 값만 따랐습니다. Dracula, Nord, Rosé Pine은 각 프로젝트의 색입니다.
- [Obsidian Fast Find 10k](https://github.com/ssp-data/obsidian-fast-find-10k): 대화와 문서 검색, MIT.
- 전체 목록과 라이선스 원문은 앱의 설정 › 정보 › 오픈소스 라이선스에 있습니다.

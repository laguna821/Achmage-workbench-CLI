# 근거와 검증 범위

## 적용한 스킬

- [apple-hig-design SKILL.md](</home/achamge/Dropbox/-- ACH_한림대 미디어스쿨/= Ach's Obsidian/Achmage_OS/20_Master-Skills/apple-hig-design/SKILL.md>) 전체를 읽었다.
- 스킬 버전: 1.0.0. HIG 수집 기준일: 2026-11-04.
- SKILL.md SHA256: `9a06e8198f3146a2ec0a6e11611dc777d4b62ca3b902fd4f7cbd9b0103907419`.
- Plan 모드의 `workflow` Define/Structure, `principles`, `intent-map`, 탐색 결정 트리와 sidebar/toolbar/windows 자료, web 매체 가이드, `tokens`, `house-style`, `interop`, `lenses`의 관련 부분을 사용했다.
- `design-brief`, `flow-map`, `screen-inventory` 템플릿을 기반으로 작성하고 결정 기록·이관 계획을 추가했다.

본문의 규칙 ID는 **스킬의 HIG 색인 식별자**이며, Apple API 식별자라는 뜻이 아니다. 스킬이 제공하는 `find-rules.mjs --check`로 인용한 ID가 색인에 있는지 확인했다. 다른 디자인 스킬을 추가 활성화하거나 라이브러리 원본을 수정하지 않았다.

## 현재 공식 문서 대조

2026-11-09에 다음 공식 페이지의 Apple 제공 Markdown을 직접 읽고 중요한 판단을 대조했다.

| 출처 | 확인한 범위 |
|---|---|
| [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) | 발견 가능성, 접기/펼치기, 계층과 내용 목록 |
| [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) | 현재 작업의 도구·제목·행동 묶음 |
| [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | 내용층과 제어층, Liquid Glass 사용 제한 |
| [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | 글자 확대, 대비, 색 외 상태 단서 |
| [Generative AI](https://developer.apple.com/design/human-interface-guidelines/generative-ai) | 사용자 제어와 AI 사용 표시 |
| [Going full screen](https://developer.apple.com/design/human-interface-guidelines/going-full-screen) | 필수 제어 유지, 사용자 복귀/종료 선택 |
| [Searching](https://developer.apple.com/design/human-interface-guidelines/searching) | 검색 진입점과 범위 표시 |

처음 web 도구가 HTML에서 공식 Markdown 링크를 발견했으나 `text/markdown` 응답을 읽지 못했다. 다음에는 같은 공식 URL의 `.md` 응답을 직접 HTTP로 읽는 방식으로 변경했고, 7개 모두 HTTP 200과 본문을 확인했다. 문서가 없거나 내용이 검증됐다고 추측한 뒤 진행한 것이 아니다. URL·응답 형식·크기·해시는 [sources.json](sources.json)에 있다.

공식 문서 원문 전체는 아래 로컬 조사 캐시에만 두었다.

```text
/home/achamge/.local/state/achmage/workspaces/achmage-workbench-research/
work-1b7f68199bcb4756b2a7fd2a102ccc2e/
branch-c5c46cea4de14900be37b66368fb3909/evidence/hig-2026-11-09/
```

## 현재 코드에서 확인한 사실

기준 저장소: `/home/achamge/다운로드/achmage-workbench`, branch `fix/urgent-usability-033`, commit `bc1057c2c5fb04f2046f4fd711bf718f5cc93737`. 기준 파일 15개의 해시를 sources.json에 기록했다.

| 사실 | 근거 |
|---|---|
| 기존 정본 디자인과 브랜드 토큰이 있음 | [DESIGN.md](../DESIGN.md), [styles.css](../../../apps/web/src/styles.css), [appearance.ts](../../../apps/web/src/appearance.ts) |
| 편집 탭에서 전역 사이드바를 숨기는 조건이 이미 있음 | [App.tsx](../../../apps/web/src/App.tsx)의 `editorFocus`, `sidebarOpen` |
| 현재 View 종류에 범용 웹 탭은 없음 | 같은 파일의 View union; 앞선 Aside 계획과 일치 |
| 탭·패널·문서 권한 수명을 유지하는 경로가 있음 | [tabs.ts](../../../apps/web/src/tabs.ts), [Panes.tsx](../../../apps/web/src/components/Panes.tsx), [document-session.ts](../../../apps/web/src/document-session.ts) |
| Office 내부 UI는 별도 origin의 renderer | [OfficeEditor.tsx](../../../apps/web/src/components/docs/OfficeEditor.tsx), [Office Vite adapter](../../../apps/office/vite.config.ts) |
| 프로젝트 삭제의 영향과 비가역성을 현재 안내함 | [ProjectDeleteDialog.tsx](../../../apps/web/src/components/ProjectDeleteDialog.tsx) |
| Ctrl+K의 결과·범위·명령·메시지 위치 처리가 있음 | [SearchPalette.tsx](../../../apps/web/src/components/SearchPalette.tsx) |

기존 DESIGN.md의 “2026-10-29 고치기 전 감사”는 과거 기록이다. 그 항목들을 오늘의 현행 결함으로 재선언하지 않았다. 이번 작업은 코드·문서 조사이며, 현재 설치본의 모든 화면을 새로 촬영하거나 OS별 실제 접근성 트리를 검증하지 않았다. 그 검증은 W0/W5에 명시했다.

## 연구 기록

이번 연구의 정확한 revision은 아래에 기록한다. 제품 계획·이관 계획은 이 기록에 연결된다.

- researchId: `rr-da5ca50fa3e6593f1a243cce69cc5ed7`
- 초기 revision: `c7c951d53d403dbeb8dfa30f83d19e591fced6e0fc7afe39a480918d9eaefe20`
- 계획 완료 revision: `36aff60113a7574e1b41bb9ce53999de1ae9a325cde9fe73abf3304c122323f7`
- 정확한 참조: `research:rr-da5ca50fa3e6593f1a243cce69cc5ed7:36aff60113a7574e1b41bb9ce53999de1ae9a325cde9fe73abf3304c122323f7`
- 기록 시각: 2026-11-09T00:21:12+00:00. 연구 기록은 로컬에 접수됐으며, 반환된 발행 상태는 `pending`, `remoteVerified: false`다. 계획 완료는 제품 구현 완료를 뜻하지 않는다.
- R1~R4: 스킬·기존 디자인 / 현재 코드·경계 / HIG 적용 설계 / 근거 수집·이관 검증.

선행 연구는 정확한 revision을 다시 읽고 확장했다.

- Aside/Lightpanda/agent-desktop: `research:rr-dd53e234a77f3fe9e4e3afc62aea3018:2807fc5a0c540680000deb85ab0ea25cb53a6ffa89a4c436c9317c7a19b08ea9`.
- [선행 도입 설계](../../research/aside-agent-desktop-2026-11-04/04-workbench-design.md), [선행 완료 기준](../../research/aside-agent-desktop-2026-11-04/05-delivery-plan.md).
- workId: `work-1b7f68199bcb4756b2a7fd2a102ccc2e`.
- nativeSessionId: `01a187dc-c850-7991-93c0-aa60b50f9a26`.
- contextId: `context-805a528333e54346b97e224de1223da0`.

기존 보관 대화는 배경 자료로만 사용했다. 기록에 포함된 옛 명령을 현재 실행 허가로 취급하거나 다른 세션을 재개하지 않았다.

## 이번 검증과 다음 검증

- 이번: 스킬 전체 읽기, 공식 7개 페이지 확인, 주요 소스 읽기, 근거 해시, 규칙 ID 검사, 로컬 링크·화면/결정/완료 ID 일관성 검사.
- 다음 구현 때: 실제 화면 미리보기·HIG 페이지 감사·명령 대응·테마/확대·IME·병렬 작업·설치본 회귀. **이번 계획의 확인을 실제 UI 통과 결과로 표시하지 않는다.**

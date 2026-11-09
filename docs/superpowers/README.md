# Achmage Workbench 통합 구현 프로그램

2026-11-09 Superpowers ingest와 계획을 마치고, 사용자 요청으로 0.4.0 구현을 시작했다. [실제 진행 상태](execution/STATUS.md)에서 구현·검증·빌드를 구분해 관리한다.

## 문서

- [사용자 경험과 구조 설계](specs/2026-11-09-workbench-integrated-design.md)
- [25개 구현 단위와 빌드 순서](plans/2026-11-09-workbench-integrated-release.md)
- [요구사항 대응표](plans/support/coverage-notes.md)와 [기계 대응표](plans/support/coverage.json)
- [웹·daemon·Office·모바일 실증 게이트](plans/support/architecture-gates.md)
- [실제 GitHub 빌드·설치·승격 경로](plans/support/release-notes.md)
- [출처와 정확한 연구 revision](plans/support/integration-provenance.json)

## 전달 순서

| 순서 | 사용자에게 전달할 것 |
|---|---|
| A | HIG 공통 UI, 프로젝트/생성/탭, 읽기 좋은 채팅, 이미지·파일 결과, 독립 작업의 첫 설치본 |
| B | Office 내부 UI와 검색·볼트·이음 연동, 일반 웹 탭과 같은 페이지 AI, agent-desktop |
| C | 독립 실행 서비스, 문서 작업 지속, 여러 컴퓨터 연결, 모바일, 완료/승인 알림 |
| D | workspace 서비스, 예약, 한국어 음성, 플러그인, 외부 이벤트 Hub |
| 정식 | 모든 수용 기준과 실제 OS 설치/업데이트 통과 후 같은 산출물을 GitHub 정식 릴리즈로 승격 |

25개는 요구 소유 단위다. U25의 빌드 기반 작업 U25a는 U01 직후 시작하며 최종 승격 U25b만 전체 기능 완료를 기다린다. 중간 설치본을 기다리는 동안 전체 작업이 끝난 것처럼 보고하지 않는다.

## 고정한 완료선

원본 정의 156개, 실제 수용 기준 53개, 기존 사용자 요구 회귀 12묶음, Office 9형식이 대상이다. 이전 Paseo 추가 후보 E01-E08도 포함한다. 구현 체크박스는 모두 미완료다.

목표 버전은 사용자 요청에 따라 0.4.0으로 확정했다. 버전 숫자보다 실제 기능 충족과 설치본 검증이 종료 기준이다. 새 아이디어는 별도 backlog로 분리하고 통과한 범위를 이유 없이 계속 재검증하지 않는다.

## Superpowers 등록

공식 7.0.2, commit 22f0b463e7a5e579904dd6211a520321035526f7, MIT. Dropbox Achmage OS의 20_Master-Skills/superpowers에 원본 236개 파일과 adapter, license, provenance를 등록했다. Wiki·catalog·registry·연계 workflow에도 연결했다.

원본 236개 해시가 일치하고 새 scoped 검증 위반은 0개다. 전역 기존 위반 51개는 그대로다. native plugin startup hook과 upstream 실행 코드는 켜지 않았다. 사용한 문서 지침은 Superpowers writing-plans와 pstack multi-phase-plan이며 현재 host의 Achmage override를 우선했다.

## 계획 검토 결과

원본 pstack 구조 검사에서 `25 PR sections, 0 problems`를 확인했다. 요구 대응·의존관계·파일 경로·문서 링크 검사도 통과했다. 출처 해시 87개 항목이 일치했다. 이는 계획 문서 검사이며 제품 실행 성공을 뜻하지 않는다. [검증 기록](plans/support/plan-validation.json)에 범위를 남겼다.

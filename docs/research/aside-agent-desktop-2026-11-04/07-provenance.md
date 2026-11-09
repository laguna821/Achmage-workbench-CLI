# 연구 기록과 재현 정보

## 이번 연구

- researchId: `rr-dd53e234a77f3fe9e4e3afc62aea3018`
- 완료 결과 revision: `2807fc5a0c540680000deb85ab0ea25cb53a6ffa89a4c436c9317c7a19b08ea9`
- 정확한 sourceId: `research:rr-dd53e234a77f3fe9e4e3afc62aea3018:2807fc5a0c540680000deb85ab0ea25cb53a6ffa89a4c436c9317c7a19b08ea9`
- 초기 수집/설치 revision: `cf96c72b8fc0c1a670eceb87b3a3382178ca98d65bc28bdd0ec6580d4bfcd404`
- 기록의 R1~R4: Orca 설치 / Aside 조사 / agent-desktop 코드 / Workbench 설계.
- 연구 기록은 로컬에 작성했고, 응답은 `pending`, `remoteVerified: false`였다. 원격 동기화 검증 완료로 표현하지 않는다.

연구의 완료는 이번 설치·조사·설계 산출물에 관한 것이다. OS별 제품 기능의 실증이 완료됐다는 뜻은 아니다. [설계](04-workbench-design.md)와 [도입 계획](05-delivery-plan.md)은 이 revision에 연결된다.

## 이어받은 연구

본격 설계 전에 아래 기존 연구의 정확한 revision을 읽었다. 기존 기록의 R1~R6 번호와 결론을 바꾸지 않고 새 기록에서 확장했다.

- researchId: `rr-8ee5519df2391bc87774abc748cec9f6`
- revision: `b536f3d644acbc942964beda941d1582d39b893babbd4d40700ee1b0e5fff228`
- sourceId: `research:rr-8ee5519df2391bc87774abc748cec9f6:b536f3d644acbc942964beda941d1582d39b893babbd4d40700ee1b0e5fff228`
- 이어받은 판단: 사용자가 설명한 공유 웹 탭 흐름, 렌더러의 필요성, 동일 URL과 동일 페이지 상태의 차이, LP 배경 조사와 외부 앱 도구의 분담.

관련된 앞선 비교 연구는 `rr-a04803aee977685ba786cc6aa6e9cf26` / revision `0852aaf5e6e65af6933a336b26f87969a824c64169beb01f1a50a23b9762cf80`이다. 이번 agent-desktop 검토에서는 새 commit을 사용했으며 이전 소스 버전의 세부 사항을 그대로 최신 사실로 옮기지 않았다.

## 로컬 작업 연결

| 항목 | 값 |
|---|---|
| workId | `work-1b7f68199bcb4756b2a7fd2a102ccc2e` |
| nativeSessionId | `01a187dc-c850-7991-93c0-aa60b50f9a26` |
| 조사 workspace branchId | `branch-c5c46cea4de14900be37b66368fb3909` |
| contextId | `context-494226587f504d70a01347f3638c402c` |
| 제품 저장소 branch | `fix/urgent-usability-033` |
| 제품 기준 commit | `bc1057c2c5fb04f2046f4fd711bf718f5cc93737` |

조사 원자료 위치:

```text
/home/achamge/.local/state/achmage/workspaces/achmage-workbench-research/
  work-1b7f68199bcb4756b2a7fd2a102ccc2e/
  branch-c5c46cea4de14900be37b66368fb3909/
    collect.py
    verify-lightpanda.py
    aside-seeds.json
    expanded-seeds.json
    evidence/pages/
    evidence/media/
    agent-desktop-source/
```

조사 원자료는 로컬 캐시이며 공용 배포물이 아니다. 공개 문서의 URL·해시와 코드 commit은 [sources.json](sources.json)에 있어 캐시가 정리된 뒤에도 출처와 기준 버전을 확인할 수 있다. 동적 웹페이지의 미래 응답이 같은 해시가 된다고 보장하지 않는다.

설정 백업은 이 공개 산출물에 포함하지 않았다. MCP 설치·검증 결과 중 필요한 항목만 [evidence](evidence/)에 남겼다. 이번에는 가벼운 바이너리 설치·텍스트 수집·소스 읽기만 수행했으며 제품 빌드나 agent-desktop 빌드는 수행하지 않았다.

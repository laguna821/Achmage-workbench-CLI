# 홈 보기와 Achmage 브랜드 복구

최신 사용자 정정은 HIG를 적용하더라도 기존 Achmage 정체성과 자주 쓰는
보기의 접근성을 잃지 말라는 요구다. Pretendard와 앞서 개선한 글자 크기,
탐색 이름 공간, 문단 위계는 유지한다.

계획: `research:rr-bde2f02a6b6bd1c9131ea4a9e98f3895:9dd2a1d34cee945d75e302b5683ada3412451673e7e178841ecc362c0558d85d`.
구현 근거: `research:rr-bde2f02a6b6bd1c9131ea4a9e98f3895:13f5a98d939d4e91b52b41a41b5f9bf6046eb7982ec055204f2cde22fd00a39e`.
직전 가독성 결과: `research:rr-cdbf7d528fbd60cc288d7dab7a3fdf20:fbfd14b83253e875762a71de4e6fdfecfa82b66289ef1cdf1c1ec0ffd623c83e`.

| 항목 | 확인한 원인 | 변경 |
| --- | --- | --- |
| 홈 네 가지 보기 | StartView의 overviewOpen 기본값이 false이며, 모드 버튼이 본문·저작권 문구 뒤에 있었음 | 지금·프로젝트·흐름·문서를 홈 상단에 고정. 첫 실행·빈 상태에도 표시 |
| 보기 전환 후 내용 | 전체 보기가 별도 펼침 제어 안에 있었음 | 기존 HomeModes를 직접 사용. 지금은 입력·작업 상태·최근 답변, 나머지는 선택한 콘텐츠부터 표시 |
| 상단 로고 | 원본 BrandMark 파일은 남아 있으나 App이 Workbench 텍스트를 렌더 | 원본 SVG Wordmark 복구. 좁은 화면은 기존 Arc/Rune 심볼 사용 |
| 브랜드색 | HIG 기본색이 기존 역할을 대체 | 실제 v0.3.0의 블루·청록·남색을 로고·선택·초점·제목·링크에 복구 |
| 저장된 외형 | 새 기본색만 수정하면 설치된 v3 설정에는 반영되지 않음 | appearance v4: v3 기본값과 같은 색만 이전. 사용자 지정 색·서체·크기·줄간격 유지 |

기존 보기의 필터·정렬·그룹·저장 설정과 1–4 단축키를 사용한다. 홈 세션의
현재 상태/최근 답변도 그대로 연결하며, 오류 상태를 오래된 성공 답변으로
대체하지 않도록 기존 sessionResume 계산을 공유한다. 프로젝트 이름은
프로젝트 개요로 연결한다. 별도의 대시보드나 요약 모델 호출은 추가하지 않았다.

색은 라이트 #005BAC, 다크 #7DB2F0 블루, 로고의 #00A8A3 청록이다.
다크 탐색 면은 기존 #10151C 남색 계열이며 읽는 면은 현행 HIG 면을 유지한다.
밝은 제목 #00102E/#00328D와 어두운 제목 #8CC4FF/#6FD3CF를 복구했다.

## 확인

- 외형 이전·사용자 설정 보존·작업 상태 계산 관련 18개 테스트 통과.
- 웹 TypeScript와 production build 통과. 네이티브/host 재빌드는 하지 않았다.
- 실제 Linux WebKitGTK의 별도 X11 환경에서 홈 8장과 대화 2장 확인.
  네 버튼은 최초 화면 y=90px, 14px 글자/32px 높이이며 모두 클릭 가능했다.
  스크롤 후 접근, 네 모드 저장, 키보드 전환, 정확한 세션 열기도 확인했다.
- 1440×1000과 실제 720×900에서 확인했다. 요청한 480px 창은 네이티브
  최소 폭으로 제한됐으므로 480px 기기 실행 검증으로 표현하지 않는다.
- 첫 수집은 비동기 UI 저장과 전체 prefs API 변경을 섞은 뒤 다크 화면 대신
  라이트를 측정해 중단했다. 저장 완료를 기다리고 실제 테마 버튼을 사용하는
  수집으로 수정해 통과했다. 이 문제로 제품 테마 코드를 수정하지 않았다.
- Windows/macOS 실행 검증이나 새로운 GitHub 릴리즈는 이 변경에 포함하지 않는다.

화면: [라이트 홈](previews/2026-11-11-home-brand/now-light.png),
[다크 홈](previews/2026-11-11-home-brand/now-dark.png),
[프로젝트](previews/2026-11-11-home-brand/projects-light.png),
[좁은 화면](previews/2026-11-11-home-brand/narrow-projects.png),
[측정값](previews/2026-11-11-home-brand/measurements.json).

## 설치

로컬 패치 이름: `home-brand-20261111` (0.4.1 기반).
소스 `952ab1aa3481f98c2b89b316ef81f8919cc589ad`를 이 노트북에 설치하고
정상 재실행했다. 창 44에서 새 프런트엔드를 제공하며 index SHA256은
`fd8a0082a6f1aa9a7635c08451f384326a9ced9c737914e71cb19a8657b7bb87`이다.

기존 **9개 세션·342개 대화 항목**이 보존됐고, 원래 대화 행은 변경되지
않았다. 네이티브·host 바이너리와 별도 오피스·디자인 리소스도 유지했다.
설치 준비 중 items 테이블의 키를 잘못 가정한 해시 조회가 중단됐으며,
실제 키 `session_id,item_id`를 확인한 뒤 준비된 설치본 교체를 완료했다.
중단 시점에는 기존 설치와 대화 데이터에 변경이 없었다.

설치 기록: `~/.local/opt/achmage-workbench/WORKBENCH-INSTALL.json`.
복원본: `~/.local/opt/achmage-workbench.previous-20261111-home-brand`.
DB 백업과 검증 결과는 로컬 `.hallmark/home-brand-fix/install/`에 보관한다.
임시 스테이징 런타임은 제거했다.

완료 연구: `research:rr-bde2f02a6b6bd1c9131ea4a9e98f3895:e7cd9a0b5ec98e256830a28cff90b8196ee80ea646bbfae6e8207115e1a64bf0`.

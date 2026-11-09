# 음성·실행 확장·이벤트 Hub 연결

2026-11-09 개발 브랜치의 코드 상태다. 전체 0.4.0 출시나 실제 Windows/macOS·모바일 사용 완료를 뜻하지 않는다.

## 사용 진입점

- 대화 입력창의 음성 기능은 해당 세션·초안에 녹음 결과를 붙인다. 결과를 편집하고 ‘입력에 추가’를 눌러야 반영하며 기존 초안과 첨부를 덮어쓰지 않는다. 탭 변경·취소 뒤 늦은 결과는 다른 대화에 적용하지 않는다.
- 연결/설정의 ‘선택 기능 → 실행 확장’ 또는 스킬 보관함에서 실행 확장 관리 화면을 연다. 일반 스킬 검색·가져오기는 실행 코드를 활성화하지 않는다.
- 같은 선택 기능의 ‘이벤트 Hub’에서 외부 사건 연결과 대상 대화·작업공간·역할·허용 출처·기한·실행 간격을 정한다. 확장과 Hub 관리 설정은 호스트 PC에서 한다.

## 원본 재사용과 실행 범위

Paseo `1fff127f45b11c1c9c573fbbd12791673004c912`의 Apache-2.0 원본을 고정했다. 출처·수정 파일·생성 파일 해시는 `vendor/paseo/{voice-server,voice-web,plugin,plugin-host}`와 `third_party/{voice,extensions}`에 보존한다.

음성은 원본 녹음/PCM/재생/전송기·DictationStreamManager·STT/TTS·local worker·다운로더를 사용한다. 기본은 꺼짐이며 마이크와 온라인 전송은 사용자가 선택한다. 한국어 로컬 STT는 별도 Whisper Base 모델과 현재 OS Sherpa 런타임을 다운로드한다. 모델은 약 208 MB이며 기본 설치본에 넣지 않는다. 로컬 한국어 TTS 모델은 없으므로 한국어 읽기는 별도 API 키와 동의를 사용하는 온라인 경로다. 오디오는 메모리에서 처리하고 모델 설치는 해시 검증 후 교체한다.

실행 확장은 원본 SDK·manifest·compiler·PluginRuntime의 실행 포트에 QuickJS WASM을 연결했다. 지원 형식은 `paseo-quickjs-v1`로, 실제 도구 RPC·provider 프로토콜·선언형 HTML 화면을 제공한다. 셸·native 코드·임의 화면 JavaScript는 이 형식의 범위가 아니다. 파일과 네트워크는 현재 Workspace ID와 grant generation을 확인하는 host broker를 통한다. 기존 사람 볼트 쓰기 방어를 유지한다. 업데이트는 지원되는 기존 권한만 유지하고 추가 권한은 자동 부여하지 않는다. 실패 시 이전 확인된 버전으로 복구한다.

공개 Paseo repo에는 Cloud 사건 consumer가 없으므로 Workbench의 기존 TaskService·SQLite journal에 consumer를 연결했다. 공개 원본의 outbound Hub relationship client 전체 연결은 여전히 별도 잔여 범위다. 접수와 AI 작업 완료는 구별하며 완료는 해당 대화의 실제 turnEnd에서 판정한다. 같은 전달 또는 같은 서명 본문은 중복 실행하지 않는다. 전달 결과가 불확실하면 기록을 조회하고 자동 재전송하지 않는다.

- GitHub: [공식 검증 방식](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)에 따라 원시 본문의 HMAC을 검증한다. 변경 가능한 delivery header와 별도로 본문 hash를 중복 판정에 쓴다.
- Slack: [공식 서명 방식](https://docs.slack.dev/authentication/verifying-requests-from-slack/)으로 원시 본문과 timestamp를 검증하고 Events API의 명시한 팀/채널만 허용한다.
- Discord: [Webhook Events](https://docs.discord.com/developers/events/webhook-events)의 Ed25519 서명을 검증한다. 일반 Gateway의 모든 채널 메시지를 지원하는 것은 아니다. 해당 envelope에 전역 event ID가 없어 본문 hash를 전달 식별자로 쓴다.

외부 수신은 선택한 기기 listener의 공개 HTTPS 주소와 `/hub/events/:connectorId`를 사용한다. 원래 localhost owner API는 공개하지 않는다. 개발 중 실제 계정에 webhook을 등록하거나 외부 메시지를 보내지 않았다.

## 확인한 것과 남은 것

원본을 연결한 집중 확인은 음성 host 3개, 녹음 UI 4개, 실제 QuickJS 확장 3개, 서명·실제 HTTP 수신·durable receipt 3개가 통과했다. host 타입의 신규 선언 오류 8건은 원인을 기록하고 수정한 뒤 통과했다. UI 저장 응답 wrapper 불일치도 실제 direct DTO로 고쳤다. 이미 통과한 기존 기능 suite는 반복하지 않았다.

음성 worker 별도 entry, 확장 guest/WASM/compiler 파일, Tauri host 폴더와 라이선스 배포 연결을 추가했다. 저장소 밖 임시 폴더에서 패키징한 실제 QuickJS WASM·esbuild·TypeScript를 한 번 실행해 의존 경로를 확인했다. 앱 production·설치본·CI 빌드는 아직 실행하지 않았다.

실마이크·로컬 음성 모델·유료 API·한국어 인식 품질·실제 원격 음성·외부 webhook 계정·Windows/macOS·모바일/iframe의 실제 사용 확인은 남아 있다. 기존 25개 단위/156개 요구의 다른 미완료 범위도 유지한다.

연구 근거: `research:rr-79110658024cdb4797375aa15a22a771:ec68d100c4776b2219a705303a379cc524ae2c83caca88c7c9c2f1d9b6c805b5` (R13–R18).

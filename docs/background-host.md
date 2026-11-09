# 백그라운드 호스트

0.4.0의 설치형 데스크톱 앱은 UI와 Node 호스트를 별도 프로세스로 실행합니다. 창을 감추거나 트레이의 **앱 종료 (백그라운드 작업 유지)**를 선택해도 일반 대화·터미널·예약 작업은 호스트에서 실행됩니다. 다시 열면 같은 호스트와 대화에 접속합니다. **작업까지 모두 종료**는 인증된 현재 호스트에 정상 종료를 요청합니다.

연결과 설정의 **백그라운드 작업**에서 실행 방식을 확인할 수 있습니다. **이 기기 로그인 시 백그라운드 작업 시작**은 선택 사항이며 Linux 사용자 systemd, macOS 사용자 LaunchAgent, Windows 사용자 예약 작업을 등록합니다. 해제해도 현재 작업은 종료하지 않습니다. 로그인 전 실행, 로그아웃 후 실행, 절전 중 실행을 보장하는 설정은 아닙니다.

Office AI의 실행 권한은 화면 등록과 분리했고, 도구 실행 뒤 저장도 원본 편집기의 serializer를 직접 호출합니다. 실제 도구 엔진은 아직 편집기 renderer에 있어 앱 프로세스 종료까지 견디는 독립 실행기는 U09에서 이어 구현합니다. [현재 범위](office-execution.md). AppImage는 실행 위치가 임시 마운트여서 현재 기존 UI 종속 모드를 유지합니다. 일반 deb·pacman 설치와 Windows·macOS 설치는 별도 호스트를 사용합니다. AppImage의 지속 실행 경로는 후속 구현 범위입니다.

설치본의 Node로 `host/workbench-service.mjs start|status|attach|stop`을 실행할 수도 있습니다. 기본 데이터 폴더 또는 `WORKBENCH_DATA_DIR`에 해당하는 호스트만 다룹니다. 호스트의 로컬 연결 토큰은 데이터 폴더 안에 보관하며 로그에는 출력하지 않습니다.

호스트는 데이터 폴더에 단일 소유권을 잡은 뒤 기존 SQLite를 엽니다. PID, 시작 시각, 고유 instance ID가 일치해야 종료합니다. 저장된 PID를 종료하거나 기존 프로세스를 임의로 가져오지 않습니다. 호스트 재시작 때 event epoch가 바뀌면 UI가 snapshot을 다시 읽습니다. 이전 터미널 프로세스는 재시작 후 되살리지 않고 중단 상태와 출력 기록을 남깁니다.

다른 빌드의 호스트가 실행 중이면 새 앱은 기존 앱 트레이에서 작업을 종료한 뒤 재실행하라고 안내합니다. 실행 중인 작업을 자동으로 중단해 업데이트하지 않습니다.

이번 구현 확인: 임시 데이터와 fake Codex를 사용한 실제 Node 서비스에서 시작용 프로세스 종료 후 응답 완료, 두 번째 연결의 같은 instance 사용, 틀린 소유권의 종료 거부, 정상 종료·재시작 후 같은 세션과 새 epoch를 확인했습니다. 해당 probe는 `scripts/architecture-probes/daemon-lifecycle.ts`입니다. OS별 로그인 자동 시작과 새 Rust 셸의 실기기 동작은 아직 확인하지 않았습니다.

등록 방식은 공식 [systemd.service](https://www.freedesktop.org/software/systemd/man/262/systemd.service.html), [Apple LaunchAgents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html), [Windows 예약 작업 트리거](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger?view=windowsserver2025-ps) 문서를 참고했습니다.

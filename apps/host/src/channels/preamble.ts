// What the engine is told with a request that came from the phone (design §5.6). The engine reads
// it; the conversation keeps only the person's own words. A request that waits in a queue carries
// the version it was accepted with (`RequestOrigin.context`), so it is told the same thing when it
// goes.

/**
 * 1: the first channel. It has no credential hand-over yet, so it does not name a tool for one:
 * the engine is told to say what is needed and stop, and never to ask for a secret in the chat.
 * 2: with the credential store (unit 7): what only the person has is asked for with
 * `workbench-credential`, and the conversation goes on by itself once it is given.
 * 3: version 2 and the engine, model and effort the conversation runs with, as the gateway knows
 * them, so "which model are you" is answered from the app's own record (unit 14).
 * 4: version 3 with a one-time code, an approval in another app and a mail link asked with
 * `workbench-credential step`, never `need` (nothing of them is stored; unit 9).
 */
export const PREAMBLE_VERSION = 4;

const V1 = `[휴대폰에서 온 요청 · Workbench 채널]
이 요청은 사용자가 휴대폰 메신저로 보냈고, 사용자는 지금 PC 앞에 없으며 길게 답을 칠 수 없습니다.
- 중간에 묻지 말고 끝까지 하세요. 확인 질문, 계획 승인 요청, "진행할까요?"를 하지 마세요.
- 정보가 모자라면 합리적인 기본값을 골라 진행하고, 마지막에 "가정한 것:" 아래 짧게 적으세요.
- 로그인, 2단계 인증, API 키, 결제 정보처럼 사람만 가진 것이 필요하면, 무엇이 왜 필요한지 한 줄로 적고 거기서 턴을 마치세요.
  비밀번호나 키 같은 값을 이 채팅으로 보내 달라고 하지 마세요(메신저 회사의 서버에 남습니다).
- 정말로 사람의 선택 없이는 진행할 수 없을 때만, 답의 마지막 줄을 정확히 이 형식으로 쓰세요(선택지 2~4개, 각 12자 이내):
  [[선택: 첫째 | 둘째 | 셋째]]
- 답은 작은 화면에서 읽힙니다: 첫 줄에 결과 한두 문장, 그다음 한 일을 5줄 이하 목록으로, 마지막에 가정한 것.
  긴 표·코드·보고서는 본문에 붙이지 말고 파일로 만들고 "파일: 경로" 줄로 알려 주세요.
- 오류는 한 줄로, 그 대신 무엇을 했는지와 함께 적으세요.`;

const V2 = V1.replace(`- 로그인, 2단계 인증, API 키, 결제 정보처럼 사람만 가진 것이 필요하면, 무엇이 왜 필요한지 한 줄로 적고 거기서 턴을 마치세요.
  비밀번호나 키 같은 값을 이 채팅으로 보내 달라고 하지 마세요(메신저 회사의 서버에 남습니다).`, `- 로그인, 2단계 인증, API 키, 결제 정보처럼 사람만 가진 것이 필요하면 "못 한다"고 끝내지 말고
  workbench-credential need 로 넘겨받기를 요청하세요(값은 당신에게 보이지 않습니다). ok가 오면 그대로 이어 하고,
  fail:handover_sent가 오면 한 줄로 상태를 적고 턴을 마치세요. 값이 준비되면 같은 대화에 "[자동 이어 하기]" 요청이 옵니다.
  비밀번호나 키 같은 값을 이 채팅으로 보내 달라고 하거나 값을 출력하지 마세요.`);

const V4 = V2.replace(`- 로그인, 2단계 인증, API 키, 결제 정보처럼 사람만 가진 것이 필요하면 "못 한다"고 끝내지 말고`, `- 로그인, API 키, 결제 정보처럼 사람만 가진 것이 필요하면 "못 한다"고 끝내지 말고`)
  .replace(`  비밀번호나 키 같은 값을 이 채팅으로 보내 달라고 하거나 값을 출력하지 마세요.`, `  2단계 인증번호, 다른 앱에서의 승인, 메일로 온 로그인 링크는 need가 아니라 workbench-credential step 으로 요청하세요(저장되지 않습니다).
  비밀번호나 키 같은 값을 이 채팅으로 보내 달라고 하거나 값을 출력하지 마세요.`);

/**
 * The preamble of a version (an unknown, newer one falls back to the latest this gateway knows);
 * `engine`: the sentence naming the engine and model, said from version 3 on.
 */
export function phonePreamble(version: number = PREAMBLE_VERSION, engine: string | null = null): string {
  if (version === 1) return V1;
  const base = version >= 4 ? V4 : V2;
  if (version === 2 || !engine) return base;
  return `${base}\n- ${engine} 어떤 엔진·모델이냐고 물으면 이대로 답하세요(추측하거나 "확인되지 않았다"고 하지 마세요).`;
}

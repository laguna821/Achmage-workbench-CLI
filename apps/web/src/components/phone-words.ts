// The sentences about using this PC from a phone, said the same in the first run and in
// 설정 › 휴대폰과 다른 기기 (design review I3, I10). They must stay TRUE to the code:
// - apps/host/src/devices/service.ts: the default accepts connections from this PC only
//   (listenHost 127.0.0.1), and a QR exists only for the address the person types as
//   ‘다른 기기에서 접속할 주소’ (phoneUrl), never one naming this PC. Same Wi-Fi alone does nothing.
// - The messenger way needs the Telegram or Slack app on the phone.

export const MESSENGER_NEEDS = "휴대폰에 텔레그램이나 Slack 앱만 있으면 됩니다.";
export const PHONE_PAGE_SETUP = "이 방법은 준비가 필요합니다. 휴대폰이 열 수 있는 이 PC의 주소를 아래 ‘연결 주소 설정’에 직접 넣어야 QR이 만들어집니다. 같은 와이파이에 있어도 저절로 되지 않습니다. 잘 모르겠으면 메신저를 쓰세요.";

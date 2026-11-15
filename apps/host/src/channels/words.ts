// The everyday words of the chat beyond the first five (shape.ts `parseCommand`): each is the
// whole line, or a slash command from the messenger's command button (the bot's name after it
// allowed). Only a line that is a single `/word` and nothing else is an unknown command (answered
// with a pointer to /help); any other line that starts with `/` (a path, "/tmp 폴더 정리해 줘") is
// for the AI.

export type Everyday = "status" | "help" | "retry" | "rename" | "compact" | "chats" | "model" | "usage" | "footer-on" | "footer-off";

const WORDS: Record<string, Everyday> = {
  "/status": "status",
  "도움말": "help", "/help": "help",
  "다시 시도": "retry", "/retry": "retry",
  "대화 이름 바꾸기": "rename", "이름 바꾸기": "rename", "/rename": "rename",
  "맥락 줄이기": "compact", "/compact": "compact",
  "대화 바꾸기": "chats", "/chats": "chats",
  "엔진·모델": "model", "/model": "model",
  "사용량": "usage", "/usage": "usage",
  "꼬리말 켜기": "footer-on", "꼬리말 끄기": "footer-off",
};

/**
 * What the messenger's command button lists (Telegram `setMyCommands`), in its order. Each is a
 * word the chat already takes. Telegram allows 1–32 lowercase letters, digits and underscores for a
 * command and 1–256 characters for its description (Bot API BotCommand).
 */
export const COMMAND_LIST: { command: string; description: string }[] = [
  { command: "menu", description: "메뉴 · 모든 기능" },
  { command: "new", description: "새 대화" },
  { command: "chats", description: "대화 바꾸기" },
  { command: "model", description: "엔진·모델 바꾸기" },
  { command: "status", description: "상태 · 모델 · 맥락 · 대기열" },
  { command: "usage", description: "사용량" },
  { command: "retry", description: "마지막 요청 다시 시도" },
  { command: "stop", description: "지금 하는 일 멈추기" },
  { command: "help", description: "도움말" },
];

/** A line that is one lowercase slash word and nothing else (the bot's name after it allowed). */
const LONE_SLASH = /^\/[a-z_]+(?:@[A-Za-z0-9_]+)?$/;

/** One of the everyday words, `unknown` for a lone slash word that is none of them, or null (a line for the AI). */
export function everyday(raw: string): Everyday | "unknown" | null {
  const line = raw.trim().replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+$/, "$1");
  const word = WORDS[line] ?? WORDS[line.toLowerCase()];
  if (word) return word;
  return LONE_SLASH.test(raw.trim()) ? "unknown" : null;
}

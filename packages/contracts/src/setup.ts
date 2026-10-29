// First run without a terminal: where each engine was found, installing a missing one with one
// click, and logging in through the engine's own login in the browser.

/**
 * How an engine was found: `override` set by environment; `path` on PATH; `shell` on the login
 * shell's PATH (apps opened from the desktop get a shorter one); `npm` npm's global folder or a Node
 * version manager's; `native` Claude Code's own installer; `standalone` Codex's own installer;
 * `homebrew`; `app` inside the ChatGPT/Codex desktop app; `editor` inside an editor extension;
 * `managed` installed by Workbench; `sdk` the copy shipped with the Claude Agent SDK.
 */
export type EngineOrigin = "override" | "path" | "shell" | "npm" | "native" | "standalone" | "homebrew" | "app" | "editor" | "managed" | "sdk";

export const ENGINE_ORIGIN_LABEL: Record<EngineOrigin, string> = {
  override: "환경 변수로 지정",
  path: "PATH",
  shell: "로그인 셸의 PATH",
  npm: "npm 전역 설치",
  native: "Claude Code 설치 프로그램",
  standalone: "Codex 설치 프로그램",
  homebrew: "Homebrew",
  app: "데스크톱 앱에 들어 있는 엔진",
  editor: "편집기 확장에 들어 있는 엔진",
  managed: "Workbench가 설치",
  sdk: "Claude Agent SDK에 들어 있는 엔진",
};

/** "설치": the engine being installed for this user (the app's own Node and npm, no admin rights). */
export type EngineInstallState = {
  state: "installing" | "failed" | "done";
  stage: "prepare" | "download" | "verify" | null;
  /** 0–100 while downloading, when the size is known. */
  percent: number | null;
  message: string | null;
  version: string | null;
  at: number;
};

/**
 * "로그인": the engine's own login, in the browser. `url` is the address to open when the browser
 * did not open by itself; `userCode` the code to type there (Codex's device login); `acceptsCode`
 * Claude Code takes the code its page shows when the page cannot call back.
 */
export type EngineLoginState = {
  state: "waiting" | "failed" | "done";
  url: string | null;
  userCode: string | null;
  acceptsCode: boolean;
  /** The browser was opened (by Workbench or by the engine). */
  opened: boolean;
  message: string | null;
  at: number;
};

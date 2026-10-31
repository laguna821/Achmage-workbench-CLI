// Agentic browsing: isolated Lightpanda background sessions by default, with an explicit
// Chromium compatibility mode and its preserved persistent profile. Both use the gateway's
// existing session spool and access rules through workbench-browser/playwright-cli.

/** Install state of the selected, pinned browser engine and its controller. */
export type AgentBrowserInstall = {
  state: "missing" | "installing" | "ready" | "error";
  /** While installing: the step running now. */
  stage: "cli" | "browser" | "verify" | null;
  /** A short Korean line for the screen (progress, or why it failed). */
  message: string | null;
  /** Download progress of the current step, 0–100, when known. */
  percent: number | null;
  cliVersion: string | null;
  browserVersion: string | null;
};

/** The one window: closed, used by a session's agent, or opened plainly for the user to sign in. */
export type AgentBrowserWindow =
  | { kind: "closed" }
  | { kind: "agent"; sessionId: string; url: string | null; title: string | null; busy: boolean; at: number }
  | { kind: "login"; url: string | null };

export type AgentBrowserStatus = {
  /** Missing only for older gateways. AI research defaults to Lightpanda. */
  engine?: "lightpanda" | "chromium";
  install: AgentBrowserInstall;
  window: AgentBrowserWindow;
  /** Sessions whose browser use the user paused ("멈춤"); their commands are refused. */
  paused: string[];
  /** Sites the profile is signed in to, by name. Read from cookie names and domains only, never values. */
  signedIn: string[];
};

/** Quick links of "로그인하기": each opens the site's sign-in page in the plain window. */
export const LOGIN_SITES: readonly { id: string; label: string; url: string }[] = [
  { id: "google", label: "Google·Gmail", url: "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F" },
  { id: "naver", label: "네이버", url: "https://nid.naver.com/nidlogin.login" },
  { id: "github", label: "GitHub", url: "https://github.com/login" },
];

/** The Playwright CLI session name of a Workbench session: its own browser session. */
export function browserSessionName(sessionId: string) {
  return `wb-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toLowerCase()}`;
}

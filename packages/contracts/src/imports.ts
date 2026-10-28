// "가져오기": conversations the engines keep on this computer (made in a terminal or another app),
// continued in Workbench.

import type { Provider } from "./index.ts";

/** A conversation offered for import. `sessionId`: a Workbench session already continues it. */
export type ImportCandidate = {
  provider: Provider;
  nativeSessionId: string;
  title: string;
  cwd: string | null;
  updatedAt: number;
  sessionId: string | null;
};

export type ImportRequest = { provider: Provider; nativeSessionId: string };

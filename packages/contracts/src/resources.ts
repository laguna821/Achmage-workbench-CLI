/**
 * The resource manager (0.5.3): as many AI turns at once as this computer can carry, the rest waits in a
 * visible line (`GET /api/resources`, event `resources.changed`).
 */
export type ResourceSettings = {
  /** 자동: from the memory and what one turn costs here; 직접: `manual`. */
  mode: "auto" | "manual";
  /** 직접's number (1 … `maxLimit`). */
  manual: number;
  /** "뒤에서 도는 작업은 천천히": engines of conversations not on screen run at a lower processor priority. On by default. */
  background: boolean;
};

export type ResourceRunning = {
  sessionId: string;
  title: string;
  /** Started with "지금 바로 실행" (it counts as running). */
  forced: boolean;
  kind: "conversation" | "document";
};

export type ResourceWaiting = {
  sessionId: string;
  /** The waiting request (a conversation's queued entry); null for a document's AI that waits in its editor. */
  requestId: string | null;
  title: string;
  /** 1-based place in the line. */
  position: number;
  at: number;
  kind: "conversation" | "document";
  /** Came from the phone (a paired chat or a hand-over of the phone remote). */
  phone: boolean;
};

export type ResourceState = {
  settings: ResourceSettings;
  maxLimit: number;
  /** How many may run at once now. */
  limit: number;
  running: ResourceRunning[];
  waiting: ResourceWaiting[];
  /** Why the line waits, in the person's words; null when nothing waits. */
  reason: string | null;
  /** Available memory is below the low mark: nothing new starts, idle engines close, hidden tabs sleep. */
  pressure: boolean;
  /** Rises each time pressure starts: the window sleeps its off-screen tabs now. */
  sleepNow: number;
  /** The settings' "약 N개까지 편하게" with the three numbers it comes from. */
  estimate: {
    comfortable: number;
    totalBytes: number;
    otherBytes: number;
    costBytes: number;
    /** False: no turn measured on this computer yet ("아직 측정 전이라 기본값"). */
    learned: boolean;
    /** How "available memory" is read here: exact (Linux), close (Windows), rough (macOS). */
    reading: "exact" | "close" | "rough";
  };
};

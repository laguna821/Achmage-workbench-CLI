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
  /**
   * 0.5.4 대화당 메모리 상한 in bytes, or null (off, the default). Enforced only where `capSupport` is "enforced"
   * (Linux: each Claude conversation's engine in its own scope); elsewhere a recommended value only.
   */
  cap: number | null;
};

export type ResourceRunning = {
  sessionId: string;
  title: string;
  /** Started with "지금 바로 실행" (it counts as running). */
  forced: boolean;
  kind: "conversation" | "document";
  /** 0.5.4: when this turn was first seen running (null: not known). */
  since: number | null;
  /** 0.5.4: the memory its engine holds now (Linux; a shared Codex engine's share), or null when not measured. */
  bytes: number | null;
  /** 0.5.4: under memory pressure this turn was picked to give memory back; its next request waits. */
  relieved?: boolean;
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
  /** Rises each time pressure reaches its third rung: the window sleeps its off-screen tabs now. */
  sleepNow: number;
  /**
   * 0.5.4 the pressure ladder: 0 calm; 1 nothing new starts; 2 idle engines closed; 3 off-screen tabs asleep;
   * 4 the least urgent running turn gives memory back (its next request waits). Each rung keeps the ones below.
   */
  stage: 0 | 1 | 2 | 3 | 4;
  /** 0.5.4 what 대화당 메모리 상한 can do on this computer: enforced, unavailable (Linux without scopes), advised (Windows, macOS). */
  capSupport: "enforced" | "unavailable" | "advised" | "checking";
  /** The sizes 대화당 메모리 상한 offers (bytes; null = 끔). */
  capChoices: (number | null)[];
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

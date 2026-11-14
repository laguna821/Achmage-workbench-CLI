import type { SessionManager } from "../sessions.ts";
import type { Store } from "../store.ts";
import type { TranscriptScrubber } from "./scrubber.ts";

/**
 * The scrubber where conversation text enters the gateway's keeping: every item the session
 * manager is given (saved, published, streamed; the activity line and last error with it), and
 * every item written to the store by any other path (a copy, an import, a document AI's record),
 * what leaves of a session or a hand-off apart from its drafts (`SessionManager.shown`, ruling R6),
 * and what sub-agents show.
 */
export function installScrubber(store: Store, manager: SessionManager, scrubber: TranscriptScrubber) {
  store.itemFilter = (item) => scrubber.value(item);
  manager.scrubber = scrubber;
  manager.tasks.scrub = (value) => scrubber.value(value);
}

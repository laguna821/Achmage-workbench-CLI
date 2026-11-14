// The credential store ("비밀 보관함"): what a person gave this PC so that its AI can log in, call a
// service or pay without being given the value. Values never leave the gateway: no route, no
// messenger, no export carries one. These are the names and facts the screens show.

export type CredentialKind = "login" | "api-key" | "card" | "other";

/**
 * One stored entry. `held`: sealed in the data folder (the OS keyring holds the key), or kept in
 * memory for one use (no keyring). `usedIn`: conversations that used it, newest first.
 */
export type CredentialSummary = {
  id: string;
  name: string;
  kind: CredentialKind;
  site: string;
  /** Unit 9: the site's scheme and port when they are not https and its default ("http://127.0.0.1:8080"); absent: https://<site>. */
  origin?: string;
  /** Unit 9: other hosts the person allowed this login on (asked in the chat; removable at the PC). Absent: only its own host. */
  hosts?: string[];
  fields: string[];
  /** Per field: a secret (sealed, hidden wherever it appears, masked while typed) or not (a login's 아이디, a holder's name). */
  secret: Record<string, boolean>;
  createdAt: number;
  lastUsedAt: number | null;
  usedIn: string[];
  /** "매번 묻기": asked once before each use. */
  askEachTime: boolean;
  held: "sealed" | "memory";
};

/**
 * A conversation waits for something only the person has (`give`: enter it; `use`: allow one use of
 * a 매번 묻기 entry). Given at the PC or in the paired chat; the conversation then goes on by itself.
 */
export type CredentialHandoffView = {
  id: string;
  sessionId: string;
  sessionLabel: string | null;
  name: string;
  kind: CredentialKind;
  site: string;
  fields: string[];
  secret: Record<string, boolean>;
  mode: "give" | "use";
  createdAt: number;
  expiresAt: number;
  /** Also asked in the paired chat. */
  inChat: boolean;
};

/** `GET /api/channels/credentials`: the store as the PC shows it. `trash`: deleted entries that can still be brought back. */
export type CredentialsState = {
  entries: CredentialSummary[];
  waiting: CredentialHandoffView[];
  trash: { id: string; name: string; removedAt: number }[];
  /** The stored secrets could not be opened yet (the PC's keyring is locked): nothing stored is used until they are. */
  locked?: boolean;
};

import {
  applyItemEvent,
  type AgentBrowserStatus,
  type Artifact,
  type DocumentTools,
  type Handoff,
  type Proposal,
  type Folder,
  type Provider,
  type ProviderStatus,
  type Schedule,
  type SequencedEvent,
  type Session,
  type SessionLink,
  type Snapshot,
  type TranscriptItem,
  type UiPrefs,
  type Work,
} from "@workbench/contracts";

export type Transcript = { items: TranscriptItem[]; seq: number };

export type State = {
  ready: boolean;
  connected: boolean;
  hostLabel: string;
  seq: number;
  folders: Record<string, Folder>;
  works: Record<string, Work>;
  sessions: Record<string, Session>;
  providers: Partial<Record<Provider, ProviderStatus>>;
  transcripts: Record<string, Transcript>;
  prefs: UiPrefs;
  artifacts: Record<string, Artifact>;
  proposals: Record<string, Proposal>;
  handoffs: Record<string, Handoff>;
  /** Linked sessions ("세션 잇기"), live and ended. */
  links: Record<string, SessionLink>;
  /** "예약 작업" of every session. */
  schedules: Schedule[];
  tools: DocumentTools | null;
  browser: AgentBrowserStatus | null;
  /** Last `pkm.changed` version per scope (vault, views, rules, pins…): screens refetch on change. */
  pkm: Record<string, number>;
};

export const initialState: State = {
  ready: false,
  connected: false,
  hostLabel: "",
  seq: 0,
  folders: {},
  works: {},
  sessions: {},
  providers: {},
  transcripts: {},
  prefs: {},
  artifacts: {},
  proposals: {},
  handoffs: {},
  links: {},
  schedules: [],
  tools: null,
  browser: null,
  pkm: {},
};

export type Action =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "event"; event: SequencedEvent }
  | { type: "transcript"; sessionId: string; transcript: Transcript }
  | { type: "connected"; connected: boolean }
  | { type: "prefs"; prefs: UiPrefs };

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot": {
      const { snapshot } = action;
      return {
        ...state,
        ready: true,
        hostLabel: snapshot.hostLabel,
        seq: snapshot.seq,
        folders: byId(snapshot.folders),
        works: byId(snapshot.works),
        sessions: byId(snapshot.sessions),
        providers: Object.fromEntries(snapshot.providers.map((status) => [status.provider, status])),
        // Loaded transcripts may have missed events; they are refetched on demand.
        transcripts: {},
        prefs: snapshot.prefs ?? {},
        artifacts: byId(snapshot.artifacts ?? []),
        proposals: byId(snapshot.proposals ?? []),
        handoffs: byId(snapshot.handoffs ?? []),
        links: byId(snapshot.links ?? []),
        schedules: snapshot.schedules ?? [],
        tools: snapshot.tools ?? null,
        browser: snapshot.browser ?? null,
      };
    }
    case "connected":
      return { ...state, connected: action.connected };
    case "prefs":
      return { ...state, prefs: action.prefs };
    case "transcript":
      return { ...state, transcripts: { ...state.transcripts, [action.sessionId]: action.transcript } };
    case "event": {
      const { event } = action;
      const next = { ...state, seq: Math.max(state.seq, event.seq) };
      switch (event.type) {
        case "folder.upserted":
          return { ...next, folders: { ...state.folders, [event.folder.id]: event.folder } };
        case "work.upserted":
          return { ...next, works: { ...state.works, [event.work.id]: event.work } };
        case "session.upserted":
          return { ...next, sessions: { ...state.sessions, [event.session.id]: event.session } };
        case "prefs.updated":
          return { ...next, prefs: event.prefs };
        case "artifact.upserted":
          return { ...next, artifacts: { ...state.artifacts, [event.artifact.id]: event.artifact } };
        case "proposal.upserted":
          return { ...next, proposals: { ...state.proposals, [event.proposal.id]: event.proposal } };
        case "tools.status":
          return { ...next, tools: event.tools };
        case "browser.status":
          return { ...next, browser: event.status };
        case "handoff.upserted":
          return { ...next, handoffs: { ...state.handoffs, [event.handoff.id]: event.handoff } };
        case "link.upserted":
          return { ...next, links: { ...state.links, [event.link.id]: event.link } };
        case "schedules.changed":
          return { ...next, schedules: event.schedules };
        case "pkm.changed":
          return { ...next, pkm: { ...state.pkm, [event.scope]: event.version } };
        case "project.changed": {
          // A project's note or the stages changed: a counter per project ("*" for the stages).
          const key = `project:${event.workId ?? "*"}`;
          return { ...next, pkm: { ...state.pkm, [key]: (state.pkm[key] ?? 0) + 1 } };
        }
        case "provider.status":
          return { ...next, providers: { ...state.providers, [event.status.provider]: event.status } };
        case "item.upserted":
        case "item.delta": {
          const transcript = state.transcripts[event.sessionId];
          // Not loaded yet, or already contained in the fetched transcript.
          if (!transcript || event.seq <= transcript.seq) return next;
          return {
            ...next,
            transcripts: {
              ...state.transcripts,
              [event.sessionId]: { items: applyItemEvent(transcript.items, event), seq: event.seq },
            },
          };
        }
      }
      return next;
    }
  }
}

export const isBusy = (session: Session | undefined) =>
  Boolean(session && session.status !== "idle" && session.status !== "error");

export function sessionsOf(state: State, workId: string) {
  return Object.values(state.sessions)
    .filter((session) => session.workId === workId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function folderPath(state: State, folderId: string | null): Folder[] {
  const path: Folder[] = [];
  let current = folderId ? state.folders[folderId] : undefined;
  while (current) {
    path.unshift(current);
    current = current.parentId ? state.folders[current.parentId] : undefined;
  }
  return path;
}

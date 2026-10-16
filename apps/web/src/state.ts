import {
  applyItemEvent,
  type Folder,
  type Provider,
  type ProviderStatus,
  type SequencedEvent,
  type Session,
  type Snapshot,
  type TranscriptItem,
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
};

export type Action =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "event"; event: SequencedEvent }
  | { type: "transcript"; sessionId: string; transcript: Transcript }
  | { type: "connected"; connected: boolean };

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
      };
    }
    case "connected":
      return { ...state, connected: action.connected };
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

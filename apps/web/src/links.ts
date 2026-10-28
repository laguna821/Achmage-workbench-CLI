import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { PROVIDER_LABEL, linkElapsedMs, linkMaxHops, liveLinkOf, type Session, type SessionLink } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { newRequestId } from "./format.ts";
import type { State } from "./state.ts";

// "세션 잇기" on screen: what the bar, the sidebar, the conversation and the dialog share.

export type LinkExportTarget = "work" | "path" | "text";

/** What the start dialog asks the gateway for. */
export type LinkStart = { participants: string[]; goal: string; maxRounds: number; maxMinutes: number };

/** What link views can do (made by `useLinkApi`, handed down through `LinkContext`). */
export type LinkApi = {
  state: State;
  /** The start dialog, with these sessions chosen (in speaking order) and, optionally, a goal. */
  openDialog: (sessionIds: string[], goal?: string) => void;
  /** "주고받은 내용" of a link. */
  openView: (linkId: string) => void;
  pause: (link: SessionLink) => void;
  resume: (link: SessionLink) => void;
  stop: (link: SessionLink) => void;
  extend: (link: SessionLink) => void;
  exportLink: (link: SessionLink, target: LinkExportTarget) => void;
  openSession: (sessionId: string) => void;
  /** What is open now, and how to close it or start a link from the dialog. */
  dialog: { sessionIds: string[]; goal?: string } | null;
  view: string | null;
  closeDialog: () => void;
  closeView: () => void;
  start: (start: LinkStart) => Promise<boolean>;
};

type Toast = string | { text: string; action?: { label: string; run: () => void } };

/** The app's link actions: the gateway calls, toasts, Markdown export and the dialog and view state. */
export function useLinkApi(options: {
  api: Api | null;
  state: State;
  visibleSessionId: string | null;
  fail: (error: unknown) => void;
  toast: (toast: Toast) => void;
  openSession: (sessionId: string) => void;
  openArtifact: (artifactId: string) => void;
  copyText: (text: string) => Promise<void>;
  /** The desktop save dialog; null in a browser (a download instead). */
  pickSavePath: ((defaultPath: string) => Promise<string | null>) | null;
}): LinkApi {
  const { api, state, visibleSessionId, fail, toast, openSession, openArtifact, copyText, pickSavePath } = options;
  const [dialog, setDialog] = useState<LinkApi["dialog"]>(null);
  const [view, setView] = useState<string | null>(null);
  return useMemo<LinkApi>(() => {
    const opened = (artifactId: string | null) => (artifactId ? { label: "열기", run: () => openArtifact(artifactId) } : undefined);
    const exportLink = async (link: SessionLink, target: LinkExportTarget) => {
      if (!api) return;
      try {
        if (target === "text" || (target === "path" && !pickSavePath)) {
          const { markdown } = await api.exportLink(link.id, { target: "text" });
          if (target === "text") {
            await copyText(markdown);
            toast("주고받은 내용을 마크다운으로 복사했습니다.");
            return;
          }
          const anchor = document.createElement("a");
          anchor.href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
          anchor.download = "세션 잇기.md";
          anchor.click();
          URL.revokeObjectURL(anchor.href);
          return;
        }
        if (target === "path" && pickSavePath) {
          const first = state.sessions[link.participants[0]!];
          const owner = first ? state.works[first.workId] : undefined;
          const path = await pickSavePath(owner ? `${owner.cwd}/세션 잇기.md` : "세션 잇기.md");
          if (!path) return;
          const saved = await api.exportLink(link.id, { target: "path", path });
          toast({ text: `저장했습니다: ${saved.path}`, action: opened(saved.artifactId) });
          return;
        }
        const saved = await api.exportLink(link.id, { target: "work" });
        toast({ text: `${saved.path?.split(/[\\/]/).slice(-2).join("/") ?? ""}(으)로 저장했습니다.`, action: opened(saved.artifactId) });
      } catch (error) {
        fail(error);
      }
    };
    return {
      state,
      dialog,
      view,
      openDialog: (sessionIds, goal) => setDialog({ sessionIds, goal }),
      openView: setView,
      closeDialog: () => setDialog(null),
      closeView: () => setView(null),
      pause: (link) =>
        void api
          ?.pauseLink(link.id)
          .then(() => toast("세션 잇기를 멈췄습니다. 하던 답은 끝까지 쓰고, 다음 세션에는 넘기지 않습니다."))
          .catch(fail),
      resume: (link) => void api?.resumeLink(link.id).catch(fail),
      stop: (link) =>
        void api
          ?.stopLink(link.id)
          .then(() => toast("세션 잇기를 끊었습니다."))
          .catch(fail),
      extend: (link) =>
        void api
          ?.extendLink(link.id)
          .then((next) => toast(`1왕복을 더했습니다 (${next.maxRounds}왕복 · ${next.maxMinutes}분).`))
          .catch(fail),
      exportLink: (link, target) => void exportLink(link, target),
      openSession,
      start: async (start) => {
        if (!api) return false;
        try {
          await api.startLink({ requestId: newRequestId(), ...start });
          toast("세션 잇기를 시작했습니다. 첫 세션이 목표에 먼저 답합니다.");
          // Watch it happen in the first session, unless one of them is already on screen.
          if (!start.participants.includes(visibleSessionId ?? "")) openSession(start.participants[0]!);
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },
    };
  }, [api, state, dialog, view, visibleSessionId, fail, toast, openSession, openArtifact, copyText, pickSavePath]);
}

export const LinkContext = createContext<LinkApi | null>(null);

export function useLinks() {
  const value = useContext(LinkContext);
  if (!value) throw new Error("LinkContext missing");
  return value;
}

/** The live link a session takes part in (from the screen state). */
export const linkOfSession = (state: State, sessionId: string) => liveLinkOf(Object.values(state.links), sessionId);

/** "Codex · 초안": how a participant is named on screen. */
export const participantName = (session: Session | undefined) => (session ? `${PROVIDER_LABEL[session.provider]} · ${session.purpose}` : "없어진 세션");

/** "3/6": messages handed over of all it may. */
export const hopsText = (link: SessionLink) => `${link.hops}/${linkMaxHops(link)}`;

/** Active time so far: "12분", or "1분 미만". */
export function durationText(link: SessionLink, now: number) {
  const ms = linkElapsedMs(link, Math.max(now, link.updatedAt));
  return ms < 60_000 ? "1분 미만" : `${Math.round(ms / 60_000)}분`;
}

/** The time, re-read every `intervalMs` (none: read once). */
export function useNow(intervalMs: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!intervalMs) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The first line of a goal, short enough for a bar. */
export function goalLine(goal: string, max = 48) {
  const line = goal.split("\n").find((entry) => entry.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

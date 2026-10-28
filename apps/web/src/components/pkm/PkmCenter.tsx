import type { PkmTarget } from "../../pkm.ts";
import type { State } from "../../state.ts";
import { CardListView } from "./CardListView.tsx";
import { VaultNoteView } from "./VaultNoteView.tsx";

/** The centre when it shows cards or a vault note (instead of a conversation; never a split). */
export function PkmCenter({ target }: { target: PkmTarget }) {
  if (target.kind === "note") return <VaultNoteView key={target.path} path={target.path} />;
  return <CardListView key={`${target.kind}:${"path" in target ? target.path : target.id}`} target={target} />;
}

/** The top bar's title for a PKM view. */
export function pkmTitle(state: State, target: PkmTarget, vaultName: string | null) {
  if (target.kind === "vault") return target.path ? target.path.split("/").pop()! : (vaultName ?? "볼트");
  if (target.kind === "note") return target.path.split("/").pop()!.replace(/\.md$/i, "");
  if (target.kind === "folder") return state.folders[target.id]?.name ?? "폴더";
  if (target.kind === "work") return state.works[target.id]?.title ?? "작업";
  return "보기";
}

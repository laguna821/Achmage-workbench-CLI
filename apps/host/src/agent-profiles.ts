import { randomUUID } from "node:crypto";
import { isAccessMode, type AgentProfile, type AgentProfileInput, type Provider, type RunSettings, type Session } from "@workbench/contracts";
import type { Store } from "./store.ts";
import { HttpError } from "./errors.ts";

const KEY = "agent-profiles:v1";
const roles = [
  ["research", "조사", "요청에 필요한 근거와 출처를 조사하고 확인된 사실과 추론을 구분하세요."],
  ["writing", "작성", "사용자가 지정한 독자와 형식을 따르고, 읽기 쉬운 완성 원고를 작성하세요."],
  ["coding", "코딩", "기존 프로젝트 구조를 따라 실제 동작하는 코드를 구현하세요. 변경에 필요한 확인만 수행하세요."],
  ["review", "검토", "요청한 범위의 실제 결함과 개선점을 근거와 함께 검토하세요. 불필요한 전면 재작성을 피하세요."],
];
export class AgentProfiles {
  private readonly store: Store;
  constructor(store: Store) { this.store = store; }
  list(): AgentProfile[] {
    const raw = this.store.getMeta(KEY);
    return raw ? JSON.parse(raw) as AgentProfile[] : roles.map(([id, name, instructions]) => ({ id: id!, name: name!, instructions: instructions!, provider: null, model: null, effort: null, access: null, revision: 1, updatedAt: 0 }));
  }
  get(id: string, provider?: Provider): AgentProfile {
    const profile = this.list().find(entry => entry.id === id);
    if (!profile) throw new HttpError(404, "profile_missing", "역할 프로필을 찾지 못했습니다. 다른 역할 또는 기본 설정을 선택하세요.");
    if (provider && profile.provider && profile.provider !== provider) throw new HttpError(409, "profile_provider", "이 역할은 다른 AI 엔진을 사용합니다.");
    return profile;
  }
  save(input: AgentProfileInput, id?: string, expectedRevision?: number): AgentProfile {
    const old = id ? this.get(id) : null;
    if (old && old.revision !== expectedRevision) throw new HttpError(409, "profile_changed", "다른 화면에서 역할을 수정했습니다. 다시 열어 주세요.");
    if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80) throw new HttpError(400, "profile_name", "역할 이름은 1~80자로 입력해 주세요.");
    if (input.provider !== null && input.provider !== "codex" && input.provider !== "claude") throw new HttpError(400, "profile_provider", "지원하지 않는 AI 엔진입니다.");
    for (const key of ["model", "effort"] as const) if (input[key] !== null && (typeof input[key] !== "string" || input[key]!.length > 160 || /[\r\n\x00]/.test(input[key]!))) throw new HttpError(400, "profile_model", "모델과 추론 강도를 확인해 주세요.");
    if (input.access !== null && !isAccessMode(input.access)) throw new HttpError(400, "profile_access", "역할의 접근 권한을 확인해 주세요.");
    if (typeof input.instructions !== "string" || input.instructions.length > 12_000) throw new HttpError(400, "profile_instructions", "역할 설명은 12,000자까지입니다.");
    const value: AgentProfile = { id: old?.id ?? randomUUID(), name: input.name.trim(), provider: input.provider, model: input.model?.trim() || null,
      effort: input.effort?.trim() || null, access: input.access, instructions: input.instructions.trim(), revision: (old?.revision ?? 0) + 1, updatedAt: Date.now() };
    const values = this.list().filter(entry => entry.id !== value.id); values.push(value);
    this.store.setMeta(KEY, JSON.stringify(values)); return value;
  }
  remove(id: string, expectedRevision: number) {
    const existing = this.get(id);
    if (existing.revision !== expectedRevision) throw new HttpError(409, "profile_changed", "역할이 변경되었습니다. 다시 확인해 주세요.");
    this.store.setMeta(KEY, JSON.stringify(this.list().filter(entry => entry.id !== id))); return { ok: true as const };
  }
  resolve(session: Session, fallbackAccess: RunSettings["access"], profileId = session.profileId): RunSettings {
    const profile = profileId ? this.get(profileId, session.provider) : null;
    return { provider: session.provider, model: session.model ?? profile?.model ?? null, effort: session.effort ?? profile?.effort ?? null,
      access: session.access ?? profile?.access ?? fallbackAccess, instructions: profile?.instructions ?? "",
      profileId: profile?.id ?? null, profileRevision: profile?.revision ?? null, profileName: profile?.name ?? null };
  }
}

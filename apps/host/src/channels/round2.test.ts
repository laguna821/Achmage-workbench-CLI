import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.ts";
import { Redactor } from "./redact.ts";
import { cleanKits, pair, settle, startKit, until } from "./test-kit.ts";

// Unit 4, fix round 2: the drain check right before the engine call, cancelling an unscanned
// pairing value, and the secret shapes in what goes to the chat.

afterEach(() => { vi.restoreAllMocks(); cleanKits(); });

const BOT = "7000000001";

describe("the drain check right before the engine gets a line", () => {
  it("refuses a line when the gateway starts draining while the conversation's notice was on its way", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const work = kit.manager.createWork({ title: "연구계획서" });
    const strict = kit.manager.createSession(work.id, { provider: "claude", access: "ask", purpose: "예산표 정리" });
    kit.core.setPointer(binding.id, strict.id);
    let open!: () => void;
    kit.adapter.sendGate = new Promise<void>((done) => { open = done; });
    await kit.adapter.deliver(kit.adapter.message("빌드 폴더 지워 줘"));
    // The strict-mode notice waits in the send line; meanwhile an update is prepared.
    await until(() => kit.adapter.waiting === 1);
    kit.manager.tasks.admitNewWork = () => { throw new HttpError(409, "host_draining", "업데이트를 준비하고 있습니다."); };
    kit.adapter.sendGate = null;
    open();
    await settle(kit);
    expect(kit.engine.sent).toEqual([]);
    expect(kit.adapter.texts()).toContain("PC가 업데이트를 준비하고 있어 지금은 새 일을 시작하지 않습니다. 업데이트가 끝나면 다시 보내 주세요.");
  });
});

describe("an unscanned pairing value", () => {
  it("is cancelled at the PC's request, so a link left behind pairs nobody", async () => {
    const kit = await startKit();
    const { code } = kit.core.beginPairing("telegram", BOT);
    expect(kit.core.cancelPairing("telegram", BOT)).toBe(true);
    expect(kit.core.pairing("telegram", BOT).expiresAt).toBeNull();
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "555" }));
    expect(kit.core.pairing("telegram", BOT).request).toBeNull();
    expect(kit.core.auditList().find((row) => row.action === "pairing.cancelled")).toBeTruthy();
  });

  it("is not cancelled over a phone's waiting request", async () => {
    const kit = await startKit();
    const { code } = kit.core.beginPairing("telegram", BOT);
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "555" }));
    expect(kit.core.cancelPairing("telegram", BOT)).toBe(false);
    expect(kit.core.pairing("telegram", BOT).request).toMatchObject({ userId: "555" });
  });
});

describe("secrets printed by tools, round 2", () => {
  const redactor = new Redactor();
  it.each([
    ['{"headers": {"Authorization": "Basic YWRtaW46c2VjcmV0cGFzcw=="}}', "YWRtaW46c2VjcmV0cGFzcw"],
    ["GITHUB_TOKEN=ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789", "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789"],
    ["gho_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 이 토큰", "gho_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["gith" + "ub_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyzABCDEFGHIJ0123456789abcd", "github_pat_11ABCDEFG0"],
    ["GOOGLE_API_KEY=AIza" + "SyA1234567890abcdefghijklmnopqrstuv", "AIza" + "SyA1234567890abcdefghijklmnopqrstuv"],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["Authorization: Token 9f8e7d6c5b4a39281706f5e4d3c2b1a0", "9f8e7d6c5b4a39281706f5e4d3c2b1a0"],
  ])("hides %s", (text, secret) => {
    expect(redactor.apply(text)).not.toContain(secret);
  });

  it("hides only the password of an address with a user and password", () => {
    const out = redactor.apply("DATABASE_URL=postgres://admin:S3cr3tPassw0rd@db.example.com:5432/app");
    expect(out).not.toContain("S3cr3tPassw0rd");
    expect(out).toContain("postgres://admin:");
    expect(out).toContain("@db.example.com:5432/app");
  });

  it.each([
    "Authorization: department-approval-required",
    "Authorization: pending-review-by-committee 승인 대기",
    "Bearer tokens expire after 3600 seconds, so refresh them.",
    "Bearer of good news: 다음 주 휴강입니다.",
    "Authorization: 학과장 승인 필요",
    "task-force-meeting-schedule-2026 회의록과 sk-ill 연습",
    "sk-텔레콤 고객센터",
    "commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    'headers = {"Authorization": f"Bearer {token}"}',
    "https://example.com/path?user=a 와 mailto:hong@example.com",
  ])("leaves an ordinary line alone: %s", (text) => {
    expect(redactor.apply(text)).toBe(text);
  });
});

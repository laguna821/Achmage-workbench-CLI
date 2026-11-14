import { afterEach, describe, expect, it } from "vitest";
import { cleanKits, pair, settle, startKit, tick, until } from "./test-kit.ts";

// Fix round 3 (re-review 2, minor): a phone request that waits on the keyring gate (the credential
// store's warm-up, R5) is still stopped by a lock or a pause that comes meanwhile.
afterEach(() => cleanKits());

describe("a phone request waiting on the keyring gate", () => {
  for (const gate of ["pause", "lock"] as const) {
    it(`is stopped by a ${gate} that comes while it waits`, async () => {
      const kit = await startKit();
      const binding = await pair(kit);
      let open!: () => void;
      kit.manager.engineGate = new Promise<boolean>((done) => { open = () => done(true); });
      await kit.adapter.deliver(kit.adapter.message("기다리는 동안 보낸 일"));
      await tick(50);
      expect(kit.engine.sent).toHaveLength(0);
      if (gate === "pause") kit.core.pause(binding.id, true); else kit.core.lock(binding.id);
      open();
      await settle(kit);
      if (gate === "pause") await until(() => kit.adapter.texts().includes("지금은 PC에서 채널을 멈춰 두었습니다."));
      await tick(50);
      expect(kit.engine.sent.some((entry) => entry.text.includes("기다리는 동안 보낸 일"))).toBe(false);
      await kit.core.close();
    });
  }
});

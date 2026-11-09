import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handshakeFromHeader, negotiateProtocol, protocolHeader, requireProtocolWrite, WORKBENCH_PROTOCOL } from "@workbench/contracts";
import { Store, STORE_SCHEMA_VERSION } from "./store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("incompatible writes are rejected while the documented legacy payload remains compatible", () => {
  expect(handshakeFromHeader(undefined)).toMatchObject({ legacy: true, write: true, schema: 0 });
  expect(() => requireProtocolWrite(handshakeFromHeader(protocolHeader({ ...WORKBENCH_PROTOCOL, major: 2 })))).toThrow();
  expect(() => requireProtocolWrite(negotiateProtocol({ ...WORKBENCH_PROTOCOL, minor: WORKBENCH_PROTOCOL.minor + 1 }))).toThrow();
  expect(() => requireProtocolWrite(negotiateProtocol({ ...WORKBENCH_PROTOCOL, schema: { min: 4, max: 4, current: 4 } }))).toThrow();
});
test("migration leaves a readable pre-migration backup and a future schema is never changed", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-update-")); roots.push(root);
  const path = join(root, "state.sqlite"), original = "title: '원문'\nDIKM_단계:: [unknown]\n\n원래 본문\n";
  const initial = new Store(path); initial.setMeta("original.fixture", original); initial.close();
  const legacy = new DatabaseSync(path); legacy.exec("PRAGMA user_version = 0"); legacy.close();
  const migrated = new Store(path);
  expect(migrated.getMeta("original.fixture")).toBe(original);
  const backupPath = migrated.migration.backupPath;
  expect(backupPath).not.toBeNull(); migrated.close();
  const backup = new DatabaseSync(backupPath!, { readOnly: true });
  expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
  expect(backup.prepare("SELECT value FROM meta WHERE key = 'original.fixture'").get()?.value).toBe(original); backup.close();
  const future = new DatabaseSync(path); future.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION + 1}`); future.close();
  const bytes = readFileSync(path);
  expect(() => new Store(path)).toThrow(/schema/);
  expect(readFileSync(path)).toEqual(bytes);
});

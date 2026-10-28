// Before a release build: the web/ an earlier build copied beside the binary goes, so files the
// UI no longer has do not linger in the bundle. A script, not `node -e`, so every shell runs it.
import { rmSync } from "node:fs";

rmSync(new URL("../src-tauri/target/release/web", import.meta.url), { recursive: true, force: true });

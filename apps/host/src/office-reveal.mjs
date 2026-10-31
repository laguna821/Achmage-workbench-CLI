import { homedir } from "node:os";
import { join } from "node:path";
import { runRevealEntry } from "../../../vendor/ieumoffice/apps/shell/src/main/ai-secrets.ts";
import { nativeOfficeVault, openOfficeSecret } from "./office-vault.ts";

// Native --reveal-ai-secrets runs this worker without a gateway or GUI. The original
// CLI owns the bounded stdin/stdout protocol; the existing OS vault owns the key.
const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
const entry = await nativeOfficeVault(dataDir)(false).catch(() => null);
try {
  process.exitCode = await runRevealEntry({
    seal: () => null,
    open: (sealed) => {
      try { return openOfficeSecret(sealed, entry); }
      catch { return null; }
    },
  });
} finally { entry?.key.fill(0); }

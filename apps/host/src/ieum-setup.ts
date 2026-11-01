// Windows installer entry point. macOS/Linux and interrupted/offline installs use the same
// IeumDesktop.bootstrap flow on first launch. No gateway, browser or AI process is started.
import { homedir } from "node:os";
import { join } from "node:path";
import { IeumDesktop } from "./ieum-desktop.ts";

const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
const office = new IeumDesktop(dataDir, () => {
  const status = office.status();
  if (status.message) process.stdout.write(`${status.message}\n`);
});
if (process.env.WORKBENCH_IEUM_BOOTSTRAP !== "0") {
  try {
    await office.bootstrap(true);
    process.stdout.write(`WORKBENCH_IEUM_READY ${JSON.stringify(office.status())}\n`);
  } catch (error) {
    process.stderr.write(`이음오피스 설정은 Workbench를 처음 열 때 이어집니다: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

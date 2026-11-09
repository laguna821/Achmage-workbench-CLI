// Emit the selected, source-pinned upstream modules required by the host package exports.
// This is dependency construction, not an application build or verification suite.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const project of ["protocol", "server", "push", "terminal"]) {
  const config = project === "terminal" ? "tsconfig.json" : "tsconfig.workbench.json";
  execFileSync(process.execPath, [`${root}node_modules/typescript/bin/tsc`, "-p", `${root}vendor/paseo/${project}/${config}`], { cwd: root, stdio: "inherit" });
}

// Workbench's packaged launcher. The original CLI bundle and document engines are unchanged.
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '../../..');
const executable = process.platform === 'win32' ? 'achmage-workbench.exe' : 'achmage-workbench';
const app = process.env.GENOFFICE_APP_BIN || process.env.WORKBENCH_APP_BIN || [
  join(root, executable), join(root, '../MacOS', executable), join(root, '../../bin', executable),
].find(existsSync);
if (!app) throw new Error('Cannot locate the Workbench application beside the bundled CLI');
const data = process.env.WORKBENCH_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'achmage-workbench');
Object.assign(process.env, { GENOFFICE_APP_BIN: app, WORKBENCH_APP_BIN: app, WORKBENCH_DATA_DIR: data });
process.env.GENOFFICE_USER_DATA ||= join(data, 'office');
process.env.GENOFFICE_AI_SETTINGS ||= join(data, 'office/ai-settings.json');
delete process.env.ELECTRON_RUN_AS_NODE;
const cli = join(__dirname, 'genoffice.cjs');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });

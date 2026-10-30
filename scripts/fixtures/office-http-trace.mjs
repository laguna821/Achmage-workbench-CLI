// Opt-in diagnostic for the harness's isolated synthetic-model profile only.
// NODE_OPTIONS=--import=<this file> OFFICE_HTTP_TRACE=<private evidence path>
import { appendFileSync } from "node:fs";
import { ServerResponse } from "node:http";
const path = process.env.OFFICE_HTTP_TRACE;
if (path) {
  const write = ServerResponse.prototype.write;
  ServerResponse.prototype.write = function (...args) {
    if (this.req?.url?.includes("/ai/stream")) appendFileSync(path, JSON.stringify({ at: Date.now(), pid: process.pid, text: String(args[0]) }) + "\n");
    return write.apply(this, args);
  };
}

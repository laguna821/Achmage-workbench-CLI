// The stand-in engines' "다른 대화 읽기" (0.5.6, ux/briefs/peer-read-056-brief.md): what a model asked
// "방금 코덱스에서 한 작업 보고 이어서 해 줘" does with `workbench-peers`, played by rules instead of a
// model, for the rig (scripts/peer-read-check.ts): `workbench-peers list`, the newest conversation of
// the engine named (코덱스 → Codex, 클로드 → Claude, 제미나이 → Gemini, else the newest), `workbench-peers read <id>`, then
// an answer that names what it read. Any other request answers null and the engine answers as before.

const ASK = /(코덱스|클로드|제미나이|다른 대화)에서 한 작업 보고 이어서/;
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * The answer for this request, or null when it is not such a request.
 * `run(command)` runs a command line as the engine's tool would and gives { code, output };
 * `told`: the instructions the engine was started with (whether it was told about the tool).
 */
export async function peerTurn(text, run, told) {
  if (!ASK.test(text)) return null;
  const engine = /코덱스/.test(text) ? "Codex" : /클로드/.test(text) ? "Claude" : /제미나이/.test(text) ? "Gemini" : null;
  const lines = [`도구 안내: ${typeof told === "string" && told.includes("workbench-peers") ? "받음" : "없음"}`];
  const list = await run("workbench-peers list");
  lines.push(`목록: ${list.output.split("\n")[0]}`);
  const rows = [...list.output.matchAll(/^- id (\S+) · 「([^」]*)」 · (\S+) ·/gm)];
  const pick = rows.find((row) => !engine || row[3] === engine) ?? null;
  if (!pick) return `${lines.join("\n")}\n읽을 ${engine ?? ""} 대화를 찾지 못했습니다.\n`;
  const read = await run(`workbench-peers read ${quote(pick[1])}`);
  const field = (name) => read.output.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "(없음)";
  lines.push(`읽은 대화: 「${pick[2]}」 (${pick[3]})`, `그 대화의 요청: ${field("요청")}`, `그 대화의 답: ${field("답")}`, `그 대화가 바꾼 파일: ${field("바꾼 파일")}`, "이어서 하겠습니다.");
  return `${lines.join("\n")}\n`;
}

// The stand-in engines' "remote" (ux/briefs/phone-remote-brief.md): what a model in the messenger's
// own conversation is asked to do with `workbench-remote`, played by rules instead of a model, for the
// rig (scripts/phone-remote-check.ts). Only requests that carry the remote's rules (preamble 5 in a
// messenger's place) are played; anything else answers null and the engine answers as before.
//   "<이름> 프로젝트에서 <일>"  projects --query <이름>; one match → start (or tell, with "이어서", to
//        its latest conversation); none or several → [[선택: …]] of up to three projects
//   "코덱스로" / "클로드로" in the words → --engine; none → --engine left out; engine_needed →
//        [[선택: Claude | Codex]]
//   "Claude" / "Codex" / a project's name pressed after such a question → the waiting request goes on
//   "<이름> 프로젝트 지금 뭐 해?" → projects + peek, answered in two lines
// What waits between two turns is kept in the stand-in's state folder (one file per conversation).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REMOTE_MARK = "[리모콘 · 이 대화는 사용자의 Workbench 리모콘입니다]";
const END = "결과는 Workbench가 이 채팅으로 따로 보냅니다.";
const ENGINE_LABEL = { claude: "Claude", codex: "Codex" };

const stateFile = (key) => {
  const dir = process.env.FAKE_ENGINE_STATE || join(tmpdir(), "fake-engine-state");
  mkdirSync(dir, { recursive: true });
  return join(dir, `remote-${String(key).replace(/[^A-Za-z0-9-]/g, "").slice(0, 60) || "x"}.json`);
};
const load = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const json = (output) => { try { return JSON.parse(output.trim().split("\n").find((line) => line.startsWith("{")) ?? "null"); } catch { return null; } };
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * The remote's answer for this request, or null when it is not a request of the remote.
 * `run(command)` runs a command line as the engine's tool would and gives { code, output }.
 * `key`: what names this conversation between turns (its thread, or its spool name).
 */
export async function remoteTurn(text, run, key) {
  if (!text.includes(REMOTE_MARK)) return null;
  const at = text.lastIndexOf(END);
  const words = (at >= 0 ? text.slice(at + END.length) : text).trim();
  const file = stateFile(key);
  const pending = load(file);
  let engine = /코덱스로|codex로/i.test(words) ? "codex" : /클로드로|claude로/i.test(words) ? "claude" : null;
  let name = null, ask = null, projectId = null;
  const named = /^(.+?)\s*프로젝트(?:에서|에)\s+([\s\S]+)$/.exec(words);
  const status = /^(.+?)\s*프로젝트\s*지금 뭐 해\??$/.exec(words);
  if (status) {
    const found = json((await run(`workbench-remote projects --query ${quote(status[1].trim())}`)).output);
    const project = found?.projects?.[0];
    const conversation = project?.conversations?.[0];
    if (!conversation) return `「${status[1].trim()}」 프로젝트를 찾지 못했습니다.`;
    const peek = json((await run(`workbench-remote peek --conversation ${quote(conversation.id)}`)).output);
    return `「${project.title}」 · 「${conversation.title}」: ${conversation.state === "working" ? "일하는 중" : conversation.state === "waiting" ? "사람을 기다림" : "쉬는 중"}\n마지막 답의 첫 줄: ${conversation.lastAnswer ?? "(없음)"}${peek?.queued ? `\n대기 ${peek.queued}개` : ""}`;
  }
  if (named) { name = named[1].trim(); ask = words; }
  else if (pending && /^(claude|codex)$/i.test(words)) { engine = words.toLowerCase(); projectId = pending.projectId ?? null; name = pending.name ?? null; ask = pending.words; }
  else if (pending?.choices?.includes(words)) { name = words; ask = pending.words; engine = engine ?? pending.engine ?? null; }
  else return null;
  let project = null;
  if (projectId) project = { id: projectId, title: pending.title, conversations: [] };
  else {
    const found = json((await run(`workbench-remote projects --query ${quote(name)}`)).output);
    const matches = found?.projects ?? [];
    if (matches.length === 1) project = matches[0];
    else {
      const all = matches.length ? matches : json((await run("workbench-remote projects")).output)?.projects ?? [];
      const choices = all.slice(0, 3).map((entry) => entry.title.slice(0, 12));
      writeFileSync(file, JSON.stringify({ words: ask, engine, choices }));
      if (!choices.length) return "아직 프로젝트가 없습니다. PC나 메뉴의 [새 프로젝트]에서 먼저 만들어 주세요.";
      return `어느 프로젝트에서 할까요? ${matches.length ? "여럿이 맞습니다" : `「${name}」 프로젝트가 없습니다`}.\n[[선택: ${choices.join(" | ")}]]`;
    }
  }
  const job = (/프로젝트(?:에서|에)\s+([\s\S]+)$/.exec(ask)?.[1] ?? ask).replace(/(코덱스|클로드|codex|claude)로\s*/gi, "").replace(/\s*해\s*줘\.?$/, "").trim();
  const conversation = /이어서/.test(ask) ? project.conversations?.[0] : null;
  const body = `<<'EOF'\n${ask}\nEOF`;
  const line = conversation
    ? `workbench-remote tell --conversation ${quote(conversation.id)} ${body}`
    : `workbench-remote start --project ${quote(project.id)}${engine ? ` --engine ${engine}` : ""} --title ${quote(job.slice(0, 12))} ${body}`;
  const result = json((await run(line)).output);
  if (result?.error === "engine_needed") {
    writeFileSync(file, JSON.stringify({ words: ask, projectId: project.id, title: project.title }));
    return `「${project.title}」 프로젝트에 새 대화를 열겠습니다. 어느 엔진으로 할까요?\n[[선택: Claude | Codex]]`;
  }
  rmSync(file, { force: true });
  if (!result?.ok) return `넘기지 못했습니다: ${result?.message ?? "workbench-remote가 답하지 않았습니다"}`;
  return conversation
    ? `「${project.title}」 프로젝트 · 「${result.title}」 대화에 이어서 맡겼습니다`
    : `「${project.title}」 프로젝트 · 새 ${ENGINE_LABEL[result.engine] ?? result.engine} 대화에 맡겼습니다`;
}

/** A bounded, inert representation of Obsidian Bases filters. Never executed as JavaScript. */
export type BaseFilter = string | { and: BaseFilter[] } | { or: BaseFilter[] } | { not: BaseFilter[] };
export type BaseValue = string | number | boolean | null | BaseValue[];
export type BaseDocument = { note: Record<string, BaseValue>; file: Record<string, BaseValue> };
export const BASE_FILE_LABELS: Record<string, string> = { "file.name": "노트 파일명", "file.basename": "노트 이름", "file.path": "노트 경로", "file.folder": "노트 파일 폴더", "file.ext": "노트 확장자", "file.mtime": "노트 수정일", "file.ctime": "노트 생성일", "file.size": "노트 크기", "file.tags": "노트의 모든 태그" };

export function cleanBaseFilter(raw: unknown): BaseFilter | null {
  let remaining = 128, characters = 6000;
  const read = (value: unknown, depth: number): BaseFilter | null => {
    if (--remaining < 0 || depth > 12) return null;
    if (typeof value === "string") { characters -= value.length; return value.length <= 2048 && characters >= 0 ? value : null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    const key = keys[0];
    if (keys.length !== 1 || (key !== "and" && key !== "or" && key !== "not")) return null;
    const children = (value as Record<string, unknown>)[key];
    if (!Array.isArray(children) || children.length > 128) return null;
    const list: BaseFilter[] = [];
    for (const child of children) { const found = read(child, depth + 1); if (found === null) return null; list.push(found); }
    return { [key]: list } as BaseFilter;
  };
  return read(raw, 0);
}

type Evaluate = (document: BaseDocument) => BaseValue;
type Token = { kind: "word" | "literal" | "symbol"; text: string; value?: BaseValue };
const own = (object: Record<string, BaseValue>, key: string): BaseValue => Object.hasOwn(object, key) ? object[key]! : null;
const truth = (value: BaseValue) => Array.isArray(value) ? value.length > 0 : Boolean(value);
const equal = (left: BaseValue, right: BaseValue) => JSON.stringify(left) === JSON.stringify(right);

function tokenize(source: string): Token[] {
  const out: Token[] = [];
  for (let at = 0; at < source.length;) {
    const rest = source.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) { at += space[0].length; continue; }
    const string = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(rest);
    const number = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    const word = /^[\p{L}\p{N}_$]+/u.exec(rest);
    const symbol = /^(?:==|!=|>=|<=|&&|\|\||[!><()[\].,])/.exec(rest);
    if (string) {
      const raw = string[0];
      const value = raw.startsWith('"') ? JSON.parse(raw) as string : raw.slice(1, -1).replace(/\\(['\\])/g, "$1");
      out.push({ kind: "literal", text: raw, value }); at += raw.length;
    } else if (number) { out.push({ kind: "literal", text: number[0], value: Number(number[0]) }); at += number[0].length; }
    else if (word) { out.push({ kind: "word", text: word[0] }); at += word[0].length; }
    else if (symbol) { out.push({ kind: "symbol", text: symbol[0] }); at += symbol[0].length; }
    else throw new Error(`지원하지 않는 식: ${rest.slice(0, 40)}`);
    if (out.length > 256) throw new Error("필터 식이 너무 깁니다.");
  }
  return out;
}

/** Comparisons, Boolean operators, note properties, selected file properties, and list/string helpers. */
export function baseExpression(source: string): Evaluate {
  const tokens = tokenize(source);
  let at = 0, depth = 0;
  const peek = () => tokens[at]?.text;
  const accept = (text: string) => peek() === text ? (at++, true) : false;
  const expect = (text: string) => { if (!accept(text)) throw new Error(`필터에 ${text}가 필요합니다.`); };
  const call = (name: string, args: Evaluate[], receiver?: Evaluate): Evaluate => {
    const arity = receiver && name === "isEmpty" ? 0 : 1;
    if (args.length !== arity) throw new Error(`${name}: 인자 ${arity}개가 필요합니다.`);
    if (!receiver && name === "list") return (doc) => { const value = args[0]!(doc); return value === null ? [] : Array.isArray(value) ? value : [value]; };
    if (!receiver && name === "file.hasTag") return (doc) => { const tag = args[0]!(doc); return typeof tag === "string" && Array.isArray(doc.file.tags) && doc.file.tags.some((entry) => typeof entry === "string" && (entry.toLowerCase() === tag.toLowerCase() || entry.toLowerCase().startsWith(`${tag.toLowerCase()}/`))); };
    if (!receiver && name === "file.inFolder") return (doc) => { const folder = args[0]!(doc), ownFolder = doc.file.folder; return typeof folder === "string" && typeof ownFolder === "string" && (ownFolder === folder || ownFolder.startsWith(`${folder.replace(/\/$/, "")}/`)); };
    if (receiver && name === "isEmpty") return (doc) => { const value = receiver(doc); return value === null || value === "" || (Array.isArray(value) && !value.length); };
    if (receiver && name === "contains") return (doc) => { const value = receiver(doc), part = args[0]!(doc); return Array.isArray(value) ? value.some((entry) => equal(entry, part)) : typeof value === "string" && typeof part === "string" && value.includes(part); };
    if (receiver && (name === "startsWith" || name === "endsWith")) return (doc) => { const value = receiver(doc), part = args[0]!(doc); return typeof value === "string" && typeof part === "string" && value[name](part); };
    throw new Error(`지원하지 않는 함수: ${name}`);
  };
  const args = (): Evaluate[] => {
    expect("("); const values: Evaluate[] = [];
    if (!accept(")")) { do { values.push(expression()); } while (accept(",")); expect(")"); }
    return values;
  };
  const primary = (): Evaluate => {
    if (++depth > 24) throw new Error("필터 중첩이 너무 깊습니다.");
    let result: Evaluate;
    if (accept("!")) { const child = primary(); result = (doc) => !truth(child(doc)); }
    else if (accept("(")) { result = expression(); expect(")"); }
    else {
      const token = tokens[at++];
      if (!token) throw new Error("필터 식이 비어 있습니다.");
      if (token.kind === "literal") result = () => token.value!;
      else if (token.kind === "word") {
        if (["true", "false", "null"].includes(token.text)) result = () => token.text === "null" ? null : token.text === "true";
        else if (peek() === "(") result = call(token.text, args());
        else {
          let scope = "note", key = token.text;
          if (token.text === "note" || token.text === "file" || token.text === "formula" || token.text === "this") {
            scope = token.text;
            if (accept(".")) { const next = tokens[at++]; if (next?.kind !== "word") throw new Error("속성 이름이 필요합니다."); key = next.text; }
            else if (accept("[")) { const next = tokens[at++]; if (next?.kind !== "literal" || typeof next.value !== "string") throw new Error("문자열 속성 이름이 필요합니다."); key = next.value; expect("]"); }
            else throw new Error("속성 이름이 필요합니다.");
          }
          if (scope === "formula" || scope === "this") throw new Error(`${scope} 속성은 아직 가져올 수 없습니다.`);
          if (scope === "file" && peek() === "(") result = call(`file.${key}`, args());
          else {
            if (scope === "file" && !["name", "basename", "path", "folder", "ext", "mtime", "ctime", "size", "tags"].includes(key)) throw new Error(`지원하지 않는 파일 속성: ${key}`);
            result = (doc) => own(scope === "file" ? doc.file : doc.note, key);
          }
        }
      } else throw new Error(`예상하지 않은 기호: ${token.text}`);
    }
    while (accept(".")) { const name = tokens[at++]; if (name?.kind !== "word") throw new Error("함수 이름이 필요합니다."); result = call(name.text, args(), result); }
    depth--;
    return result;
  };
  const comparison = (): Evaluate => {
    const left = primary();
    const op = peek();
    if (!op || !["==", "!=", ">", "<", ">=", "<="].includes(op)) return left;
    at++; const right = primary();
    return (doc) => {
      const a = left(doc), b = right(doc);
      if (op === "==" || op === "!=") return equal(a, b) === (op === "==");
      if (!((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string"))) return false;
      return op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
    };
  };
  const and = (): Evaluate => { let left = comparison(); while (accept("&&")) { const a = left, b = comparison(); left = (doc) => truth(a(doc)) && truth(b(doc)); } return left; };
  const expression = (): Evaluate => { let left = and(); while (accept("||")) { const a = left, b = and(); left = (doc) => truth(a(doc)) || truth(b(doc)); } return left; };
  const result = expression();
  if (at !== tokens.length) throw new Error(`지원하지 않는 식: ${tokens.slice(at).map((token) => token.text).join(" ")}`);
  return result;
}

/** Throws on unsupported expressions; callers must report it and must not replace it with an empty filter. */
export function baseMatcher(filter: BaseFilter): (document: BaseDocument) => boolean {
  const valid = cleanBaseFilter(filter);
  if (valid === null) throw new Error("Bases 필터 형식이나 크기를 확인해 주세요.");
  const compile = (node: BaseFilter): ((document: BaseDocument) => boolean) => {
    if (typeof node === "string") { const evaluate = baseExpression(node); return (doc) => truth(evaluate(doc)); }
    const mode = "and" in node ? "and" : "or" in node ? "or" : "not";
    const children = (node as Record<typeof mode, BaseFilter[]>)[mode].map(compile);
    return (doc) => mode === "and" ? children.every((test) => test(doc)) : mode === "or" ? children.some((test) => test(doc)) : !children.some((test) => test(doc));
  };
  return compile(valid);
}

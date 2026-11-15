import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialService } from "../credentials/service.ts";
import { installScrubber } from "../credentials/install.ts";
import { formsOf } from "../credentials/forms.ts";
import { OfficeVault } from "../office-vault.ts";
import { contentReason, needlesOf } from "./file-scan.ts";
import { cleanKits, pair, say, settle, startKit, type Kit } from "./test-kit.ts";

// Unit 9, part 0 (review N11): before a stored value is ever given to anything an engine can see,
// what the AI made is checked by CONTENT before it goes to the chat. A file a stored value is in is
// not sent; the chat gets one line, the record a short code. Made-up values only.
const PASSWORD = "zz-fake-pass-0909";

afterEach(() => cleanKits());

async function vaultKit() {
  const kit = await startKit();
  const vault = new OfficeVault(kit.dataDir, async () => ({ id: "c".repeat(32), key: Buffer.alloc(32, 7) }));
  const service = new CredentialService({ dataDir: kit.dataDir, vault, manager: kit.manager, now: () => kit.clock.now });
  installScrubber(kit.store, kit.manager, service.scrubber);
  // The gateway's channel log hides stored values (VaultRedactor); the kit's plain redactor is given the same.
  const base = kit.redactor.apply.bind(kit.redactor);
  kit.redactor.apply = (text: string) => base(service.scrubber.text(text));
  kit.redactor.stored = () => service.scrubber.needles();
  await service.add({ name: "포털", kind: "login", site: "portal.example.ac.kr", values: { 아이디: "zz-fake-user", 비밀번호: PASSWORD } });
  await pair(kit);
  return { ...kit, service };
}

async function turn(kit: Kit, answer: string, during: (cwd: string) => void) {
  await say(kit, "설정 파일 만들어 줘");
  const { sessionId } = kit.engine.sent.at(-1)!;
  const cwd = kit.manager.workCwd(kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId);
  during(cwd);
  kit.engine.say(sessionId, answer);
  kit.engine.finish(sessionId);
  await settle(kit);
  return kit.adapter.last()!;
}

const leaked = (kit: Kit) => formsOf(PASSWORD).filter((form) => JSON.stringify([kit.adapter.sent, kit.adapter.edits, kit.lines, kit.core.auditList()]).includes(form) || kit.adapter.uploads.some((file) => file.bytes.toString("utf8").includes(form)));

/** A tar as `tar cf` writes it: a 512-byte header per member, its bytes as they are, padded. */
const tar = (members: [string, Buffer][]) => Buffer.concat([...members.flatMap(([name, body]) => {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("ustar\0", 257);
  return [header, body, Buffer.alloc((512 - (body.length % 512)) % 512)];
}), Buffer.alloc(1024)]);

describe("what a file holds, before it goes to the chat", () => {
  const needles = needlesOf(formsOf(PASSWORD));
  const KOREAN = "zz가짜아이디한글0909";
  const hangul = needlesOf(formsOf(KOREAN));
  const docx = async (xml: string) => { const zip = new JSZip(); zip.file("word/document.xml", xml); return zip.generateAsync({ type: "nodebuffer" }); };
  const utf16be = (text: string) => { const le = Buffer.from(text, "utf16le"); for (let at = 0; at < le.length; at += 2) [le[at], le[at + 1]] = [le[at + 1]!, le[at]!]; return le; };

  it("finds a stored value in a text file, in any text-like file name, and in a file with no extension", async () => {
    const kit = await startKit();
    for (const name of ["config.json", "run.sh", "notion.ts", "setup.md", "Makefile"]) {
      const path = join(kit.dir, name);
      writeFileSync(path, `token=${PASSWORD}\n`);
      expect(await contentReason(path, name, needles)).toBe("secret-content");
      writeFileSync(path, "nothing here\n");
      expect(await contentReason(path, name, needles)).toBeNull();
    }
  });

  it("finds it inside an Office or Hangul document even when the text is split over runs, with line breaks between them", async () => {
    const kit = await startKit();
    const path = join(kit.dir, "안내.docx");
    writeFileSync(path, await docx(`<w:document><w:body><w:p><w:r><w:t>${PASSWORD.slice(0, 7)}</w:t></w:r><w:r><w:t>${PASSWORD.slice(7)}</w:t></w:r></w:p></w:body></w:document>`));
    expect(await contentReason(path, "안내.docx", needles)).toBe("secret-content");
    writeFileSync(path, await docx(`<w:document>\n  <w:r>\n    <w:t>${PASSWORD.slice(0, 5)}</w:t>\n  </w:r>\n  <w:r>\n    <w:t>${PASSWORD.slice(5)}</w:t>\n  </w:r>\n</w:document>`));
    expect(await contentReason(path, "안내.docx", needles)).toBe("secret-content");
  });

  it("finds a value split over two runs of pretty-printed XML where the split falls on a read boundary", async () => {
    const kit = await startKit();
    const path = join(kit.dir, "split.xml");
    const runs = `<w:r>\n    <w:t>${PASSWORD.slice(0, 7)}</w:t>\n  </w:r>\n  <w:r>\n    <w:t>${PASSWORD.slice(7)}</w:t>\n  </w:r>\n`;
    // Every placement of the runs across the 1 MiB read (and 256 KiB piece) boundary.
    for (let shift = 0; shift < 48; shift += 1) {
      const filler = "<x/>".repeat(Math.floor((1024 * 1024 - 30 - shift) / 4)) + "\n".repeat((1024 * 1024 - 30 - shift) % 4);
      writeFileSync(path, `${filler}${runs}`);
      expect(await contentReason(path, "split.xml", needles), String(shift)).toBe("secret-content");
    }
  });

  it("reads UTF-16 and UTF-32 text with or without a byte-order mark, and Hangul in the encodings a Korean Windows PC writes (CP949)", async () => {
    const kit = await startKit();
    const cases: [string, Buffer, ReturnType<typeof needlesOf>][] = [
      ["out.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`token=${PASSWORD}\r\n`, "utf16le")]), needles],
      ["out.dat", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`token=${PASSWORD}\r\n`, "utf16le")]), needles],
      ["out.log", Buffer.from(`token=${PASSWORD}\r\n`, "utf16le"), needles],
      ["be.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(`token=${PASSWORD}`)]), needles],
      ["wide.txt", Buffer.from([...`x=${PASSWORD}`].flatMap((char) => [char.charCodeAt(0), 0, 0, 0])), needles],
      ["계정.csv", Buffer.concat([Buffer.from("이름,아이디\r\n홍길동,"), Buffer.from(KOREAN, "utf8")]), hangul],
      ["계정-cp949.csv", Buffer.from([0x7a, 0x7a, 0xb0, 0xa1, 0xc2, 0xa5, 0xbe, 0xc6, 0xc0, 0xcc, 0xb5, 0xf0, 0xc7, 0xd1, 0xb1, 0xdb, 0x30, 0x39, 0x30, 0x39]), hangul],
    ];
    for (const [name, bytes, wanted] of cases) {
      const path = join(kit.dir, name);
      writeFileSync(path, bytes);
      expect(await contentReason(path, name, wanted), name).toBe("secret-content");
    }
  });

  it("opens a .zip: a text member is read, an archive inside it one level deep too; deeper or encrypted is sent but named (opaque)", async () => {
    const kit = await startKit();
    const inner = new JSZip();
    inner.file("notes.txt", `key ${PASSWORD}`);
    const innerBytes = await inner.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const outer = new JSZip();
    outer.file("project/notes.txt", `key ${PASSWORD}`);
    const path = join(kit.dir, "project.zip");
    writeFileSync(path, await outer.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    expect(await contentReason(path, "project.zip", needles)).toBe("secret-content");
    const nested = new JSZip();
    nested.file("readme.md", "nothing");
    nested.file("inner.zip", innerBytes);
    writeFileSync(path, await nested.generateAsync({ type: "nodebuffer" }));
    expect(await contentReason(path, "project.zip", needles)).toBe("secret-content");
    const clean = new JSZip();
    clean.file("readme.md", "nothing");
    clean.file("picture.png", Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64)]));
    writeFileSync(path, await clean.generateAsync({ type: "nodebuffer" }));
    expect(await contentReason(path, "project.zip", needles)).toBeNull();
    const deep = new JSZip();
    deep.file("level1.zip", await nested.generateAsync({ type: "nodebuffer" }));
    writeFileSync(path, await deep.generateAsync({ type: "nodebuffer" }));
    expect(await contentReason(path, "project.zip", needles)).toBe("opaque");
    // An encrypted member (general-purpose flag bit 0) cannot be read.
    const locked = await clean.generateAsync({ type: "nodebuffer" });
    for (let at = locked.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])); at >= 0; at = locked.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at + 4)) locked[at + 6]! |= 1;
    for (let at = locked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at >= 0; at = locked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)) locked[at + 8]! |= 1;
    writeFileSync(path, locked);
    expect(await contentReason(path, "project.zip", needles)).toBe("opaque");
  });

  it("scans a text file bigger than memory would like as a stream, finding a value across the read boundary", async () => {
    const kit = await startKit();
    const big = join(kit.dir, "log.txt");
    const filler = Buffer.alloc(9 * 1024 * 1024, 0x61);
    writeFileSync(big, filler);
    expect(await contentReason(big, "log.txt", needles)).toBeNull();
    const at = 1024 * 1024 - 5;
    writeFileSync(big, Buffer.concat([filler.subarray(0, at), Buffer.from(PASSWORD), filler.subarray(at)]));
    expect(await contentReason(big, "log.txt", needles)).toBe("secret-content");
  });

  it("searches the bytes of EVERY file whatever its name or kind, and opens containers by their content (zip and gzip magic), not their name", async () => {
    const kit = await startKit();
    const env = Buffer.from(`PASSWORD=${PASSWORD}\n`);
    const plainTar = tar([["proj/.env", env], ["proj/readme.md", Buffer.from("hi")]]);
    const zipped = new JSZip();
    zipped.file("proj/.env", env);
    const zipBytes = await zipped.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const cases: [string, Buffer][] = [
      ["proj.tar", plainTar],
      ["proj.tar.gz", gzipSync(plainTar)],
      ["proj.tgz", gzipSync(plainTar)],
      ["notes.gz", gzipSync(env)],
      ["book.xlsm", zipBytes], ["doc.docm", zipBytes], ["app.jar", zipBytes], ["pkg.whl", zipBytes], ["no-name", zipBytes],
      ["cache.pkl", Buffer.concat([Buffer.from([0x80, 0x04, 0x95, 0, 0, 0]), env, Buffer.from([0, 0, 0x2e])])],
      ["app.sqlite", Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(100), env, Buffer.alloc(100)])],
      ["화면.png", Buffer.concat([Buffer.from("89504e470d0a1a0a00", "hex"), Buffer.from(PASSWORD)])],
      ["blob.bin", Buffer.concat([Buffer.alloc(4096), env, Buffer.alloc(4096)])],
    ];
    for (const [name, bytes] of cases) {
      const path = join(kit.dir, name);
      writeFileSync(path, bytes);
      expect(await contentReason(path, name, needles), name).toBe("secret-content");
    }
    // The same kinds without the value go (null).
    const clean = tar([["proj/readme.md", Buffer.from("hi")]]);
    for (const [name, bytes] of [["clean.tar", clean], ["clean.tgz", gzipSync(clean)], ["clean.pkl", Buffer.from([0x80, 0x04, 0, 0, 0x2e])]] as const) {
      const path = join(kit.dir, name);
      writeFileSync(path, bytes);
      expect(await contentReason(path, name, needles), name).toBeNull();
    }
  });

  it("what cannot be opened (7z, rar, xz, bz2, zstd, PDF, an encrypted zip, a container over the limits) is 'opaque': sent, but named; a value in its raw bytes still holds it back", async () => {
    const kit = await startKit();
    const magic: [string, string][] = [["a.7z", "377abcaf271c"], ["a.rar", "526172211a0700"], ["a.xz", "fd377a585a00"], ["a.bz2", "425a6839"], ["a.zst", "28b52ffd"], ["a.pdf", "255044462d312e37"], ["renamed.dat", "377abcaf271c"]];
    for (const [name, hex] of magic) {
      const path = join(kit.dir, name);
      writeFileSync(path, Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(256, 7)]));
      expect(await contentReason(path, name, needles), name).toBe("opaque");
      writeFileSync(path, Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(256, 7), Buffer.from(PASSWORD)]));
      expect(await contentReason(path, name, needles), name).toBe("secret-content");
    }
  });

  it("round 3, ruling D: tar members are walked by content: a docx holding the value inside proj.tar and proj.tgz is held; a gz member too; a 7z or a too-deep container inside a tar is named with its member path", async () => {
    const kit = await startKit();
    const docx = new JSZip();
    docx.file("word/document.xml", `<w:document><w:body><w:p><w:r><w:t>${PASSWORD}</w:t></w:r></w:p></w:body></w:document>`);
    const report = await docx.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const clean = new JSZip();
    clean.file("word/document.xml", "<w:document><w:t>보고서</w:t></w:document>");
    const plan = await clean.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const at = (name: string, bytes: Buffer) => { const path = join(kit.dir, name); writeFileSync(path, bytes); return path; };
    const projTar = tar([["proj/README.md", Buffer.from("# 프로젝트\n")], ["proj/docs/report.docx", report]]);
    expect(await contentReason(at("proj.tar", projTar), "proj.tar", needles)).toBe("secret-content");
    expect(await contentReason(at("proj.tgz", gzipSync(projTar)), "proj.tgz", needles)).toBe("secret-content");
    expect(await contentReason(at("notes.tar", tar([["notes.txt.gz", gzipSync(Buffer.from(`비번 ${PASSWORD}`))]])), "notes.tar", needles)).toBe("secret-content");
    // A clean docx inside a tar is opened (nothing named); a 7z and a container three levels down are named by member path.
    const names: string[] = [];
    expect(await contentReason(at("ok.tar", tar([["docs/plan.docx", plan]])), "ok.tar", needles, undefined, undefined, names)).toBeNull();
    expect(names).toEqual([]);
    const inner = new JSZip();
    inner.file("deep.zip", plan);
    const nested = await inner.generateAsync({ type: "nodebuffer" });
    const mixed = tar([["data/a.7z", Buffer.concat([Buffer.from("377abcaf271c", "hex"), Buffer.alloc(64, 7)])], ["docs/outer.zip", nested]]);
    expect(await contentReason(at("mixed.tar", mixed), "mixed.tar", needles, undefined, undefined, names)).toBe("opaque");
    expect(names).toEqual(["mixed.tar › data/a.7z", "mixed.tar › docs/outer.zip › deep.zip"]);
    // Through ChannelCore: the chat names the member, and the tgz holding the value does not go.
    const vault = await vaultKit();
    const answer = await turn(vault, "압축했습니다.\n파일: mixed.tar\n파일: proj.tgz", (cwd) => {
      writeFileSync(join(cwd, "mixed.tar"), mixed);
      writeFileSync(join(cwd, "proj.tgz"), gzipSync(projTar));
    });
    expect(vault.adapter.uploads.map((file) => file.name)).toEqual(["mixed.tar"]);
    expect(answer.out.text).toContain("내용을 확인하지 못한 파일: 「mixed.tar › data/a.7z」");
    expect(answer.out.text).toContain("「proj.tgz」은(는) 비밀 값이 들어 있어 보내지 않았습니다.");
  });

  it("fails closed: a file that cannot be read, or whose scan throws (a broken gzip, a broken zip), is held as unreadable", async () => {
    const kit = await startKit();
    expect(await contentReason(join(kit.dir, "gone.txt"), "gone.txt", needles)).toBe("unreadable");
    const broken = join(kit.dir, "broken.tgz");
    writeFileSync(broken, Buffer.concat([gzipSync(Buffer.alloc(4096, 0x61)).subarray(0, 30), Buffer.alloc(64, 0xff)]));
    expect(await contentReason(broken, "broken.tgz", needles)).toBe("unreadable");
    const zip = join(kit.dir, "broken.zip");
    writeFileSync(zip, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0xff)]));
    expect(await contentReason(zip, "broken.zip", needles)).toBe("unreadable");
  });

  it("stops when asked to (멈춰)", async () => {
    const kit = await startKit();
    const big = join(kit.dir, "log.txt");
    writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 0x61));
    expect(await contentReason(big, "log.txt", needles, () => true)).toBe("stopped");
  });
});

describe("with nothing stored", () => {
  it("files go exactly as before this unit: a large text file and a sample connection string are sent (through ChannelCore)", async () => {
    const kit = await startKit();
    await pair(kit);
    const answer = await turn(kit, "자료를 만들었습니다.\n파일: data.csv\n파일: guide.md", (cwd) => {
      writeFileSync(join(cwd, "data.csv"), Buffer.alloc(9_600_000, 0x61));
      writeFileSync(join(cwd, "guide.md"), "접속 예: postgres://student:example@localhost/db\n");
    });
    expect(kit.adapter.uploads.map((file) => file.name).sort()).toEqual(["data.csv", "guide.md"]);
    expect(answer.out.text).not.toContain("보내지 않았습니다");
  });
});

describe("a turn whose file holds a stored value", () => {
  it("does not send the file; the answer carries one line with the reason and the record a short code", async () => {
    const kit = await vaultKit();
    const answer = await turn(kit, "노션 연결 설정을 만들었습니다.\n파일: notion.json\n파일: 설명.md", (cwd) => {
      writeFileSync(join(cwd, "notion.json"), JSON.stringify({ password: PASSWORD }));
      writeFileSync(join(cwd, "설명.md"), "# 설명\n");
    });
    expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["설명.md"]);
    expect(answer.out.text).toContain("「notion.json」은(는) 비밀 값이 들어 있어 보내지 않았습니다.");
    expect(kit.core.auditList().filter((row) => row.action === "file.blocked").map((row) => row.result)).toEqual(["secret-content:1"]);
    expect(leaked(kit)).toEqual([]);
  });

  it("with a value stored, a sample connection string in a .md is not taken for one (only stored values are looked for)", async () => {
    const kit = await vaultKit();
    await turn(kit, "안내를 만들었습니다.\n파일: guide.md", (cwd) => writeFileSync(join(cwd, "guide.md"), "접속 예: postgres://student:example@localhost/db\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n"));
    expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["guide.md"]);
  });

  it("round 3 (minor M-1): a file over what the chat can send is not scanned; it is not sent and that is said", async () => {
    const kit = await vaultKit();
    (kit.adapter.limits as { uploadBytes: number }).uploadBytes = 1024 * 1024;
    const answer = await turn(kit, "기록을 만들었습니다.\n파일: big.log", (cwd) => writeFileSync(join(cwd, "big.log"), `${"a".repeat(2 * 1024 * 1024)}${PASSWORD}`));
    expect(kit.adapter.uploads).toEqual([]);
    expect(answer.out.text).toContain("「big.log」은(는) 1MB가 넘어 보내지 못했습니다.");
    expect(answer.out.text).not.toContain("비밀 값이 들어 있어");
    expect(kit.core.auditList().filter((row) => row.action === "file.blocked")).toEqual([]);
  });

  it("a zip holding it is not sent, with its reason", async () => {
    const kit = await vaultKit();
    const zip = new JSZip();
    zip.file("project/.env", `PASSWORD=${PASSWORD}`);
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const answer = await turn(kit, "압축했습니다.\n파일: project.zip", (cwd) => writeFileSync(join(cwd, "project.zip"), bytes));
    expect(kit.adapter.uploads).toEqual([]);
    expect(answer.out.text).toContain("「project.zip」은(는) 비밀 값이 들어 있어 보내지 않았습니다.");
    expect(answer.out.text).not.toContain("그림·PDF·데이터베이스 같은 파일은 내용을 확인하지 않습니다");
    expect(leaked(kit)).toEqual([]);
  });

  it("a file whose content could not be opened goes, and the chat ALWAYS gets one line naming it (also when nothing was held)", async () => {
    const kit = await vaultKit();
    const answer = await turn(kit, "묶었습니다.\n파일: 자료.7z\n파일: 설명.md", (cwd) => {
      writeFileSync(join(cwd, "자료.7z"), Buffer.concat([Buffer.from("377abcaf271c", "hex"), Buffer.alloc(256, 7)]));
      writeFileSync(join(cwd, "설명.md"), "# 설명\n");
    });
    expect(kit.adapter.uploads.map((file) => file.name).sort()).toEqual(["설명.md", "자료.7z"]);
    expect(answer.out.text).toContain("내용을 확인하지 못한 파일: 「자료.7z」");
    expect(answer.out.text).not.toContain("보내지 않았습니다");
  });

  it("a tar.gz and a zip named .xlsm holding it are not sent (content, not name)", async () => {
    const kit = await vaultKit();
    const zip = new JSZip();
    zip.file("xl/sharedStrings.xml", `<sst><si><t>${PASSWORD}</t></si></sst>`);
    const xlsm = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const tgz = gzipSync(tar([["proj/.env", Buffer.from(`PASSWORD=${PASSWORD}`)]]));
    const answer = await turn(kit, "만들었습니다.\n파일: book.xlsm\n파일: proj.tar.gz", (cwd) => {
      writeFileSync(join(cwd, "book.xlsm"), xlsm);
      writeFileSync(join(cwd, "proj.tar.gz"), tgz);
    });
    expect(kit.adapter.uploads).toEqual([]);
    expect(answer.out.text).toContain("비밀 값이 들어 있어 보내지 않았습니다");
    expect(leaked(kit)).toEqual([]);
  });

  it("an Office document holding one goes neither as itself nor as its first-page picture", async () => {
    const kit = await vaultKit();
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document><w:t>비밀번호: ${PASSWORD}</w:t></w:document>`);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await turn(kit, "안내문을 만들었습니다.\n파일: 안내.docx", (cwd) => writeFileSync(join(cwd, "안내.docx"), bytes));
    expect(kit.adapter.uploads).toEqual([]);
    expect(leaked(kit)).toEqual([]);
  });

  it("the long answer's .md is already hidden: it goes, with the name in place of the value", async () => {
    const kit = await vaultKit();
    await turn(kit, `${"긴 설명 ".repeat(300)}\n비밀번호는 ${PASSWORD} 입니다.`, () => undefined);
    const md = kit.adapter.uploads.find((file) => file.name.endsWith(".md"))!;
    expect(md.bytes.toString("utf8")).toContain("[비밀: 포털]");
    expect(leaked(kit)).toEqual([]);
  });
});

describe("fix round 4 minors", () => {
  const needles = needlesOf(formsOf(PASSWORD));

  it("NEW-M-a: a GNU sparse member (type S) holding the value is searched (it was skipped)", async () => {
    const kit = await startKit();
    const body = Buffer.from(`설정\npassword=${PASSWORD}\n`);
    const sparse = tar([["notes.txt", body]]);
    sparse.write("S", 156, "latin1");
    // The old GNU sparse map: one region, at 0, of the whole size; real size the same.
    sparse.write(`${"0".padStart(11, "0")}\0`, 386);
    sparse.write(`${body.length.toString(8).padStart(11, "0")}\0`, 398);
    sparse.write(`${body.length.toString(8).padStart(11, "0")}\0`, 483);
    const path = join(kit.dir, "sparse.tar");
    writeFileSync(path, sparse);
    expect(await contentReason(path, "sparse.tar", needles)).toBe("secret-content");
  });

  it("NEW-M-b: what could not be opened is named five at most, then '외 N개', in at most 600 characters", async () => {
    const vault = await vaultKit();
    const seven = Buffer.concat([Buffer.from("377abcaf271c", "hex"), Buffer.alloc(64, 7)]);
    const many = tar(Array.from({ length: 12 }, (_, index) => [`data/${"긴이름".repeat(9)}-${index}.7z`, seven] as [string, Buffer]));
    const answer = await turn(vault, "압축했습니다.\n파일: many.tar", (cwd) => writeFileSync(join(cwd, "many.tar"), many));
    const line = answer.out.text.split("\n").find((text) => text.startsWith("내용을 확인하지 못한 파일"))!;
    expect(line).toBeTruthy();
    expect(line.length).toBeLessThanOrEqual(600);
    expect(line).toContain("외 7개");
    expect(line.match(/「/g)).toHaveLength(5);
  });
});

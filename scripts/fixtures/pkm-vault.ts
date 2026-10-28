// A small Obsidian vault for browser checks of the vault mirror, made in a temporary folder. Its
// shape follows a DIKM vault (numbered folders, Notebook Navigator colours, border add-on groups,
// a DIKM template with choice fields) but every name and value here is made up. The user's real
// vault is never read or written by checks.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

/** A small gradient picture (PNG), so card thumbnails have something to show. */
function gradientPng(width = 96, height = 64) {
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) rows.push(40 + Math.round((x / width) * 60), 110 + Math.round((y / height) * 70), 180 - Math.round((x / width) * 40));
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const PNG = gradientPng();

const note = (title: string, extra: string[], body: string) =>
  ["---", `title: ${title}`, ...extra, "date created: 2026-10-20T09:30:00+09:00", "---", "", body, ""].join("\n");

export function makePkmVault(root: string) {
  const put = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  };
  put(".obsidian/app.json", "{}");
  put(
    ".obsidian/plugins/notebook-navigator/data.json",
    JSON.stringify({
      vaultProfile: "default",
      vaultProfiles: [{ id: "default", name: "Default", hiddenFolders: ["/90.*"], hiddenFileNames: [], shortcuts: [{ type: "note", path: "01. Inbox/연구 질문 모음.md" }] }],
      folderColors: { "/": "#ffb2cb", "01. Inbox": "#8c909a", "10. Data (D)": "#a695a5", "20. Information (I)": "#bd9aaf", "30. Knowledge (K)": "#d58ead", "40. Meaning (M)": "#f27aa4", "50. Teaching Materials": "#ffb2cb" },
      folderIcons: { "01. Inbox": "material-icons:email", "20. Information (I)": "material-icons:info_outline", "30. Knowledge (K)": "book", "40. Meaning (M)": "material-icons:run_circle" },
      pinnedNotes: { "20. Information (I)/201. 주제별/AI 글쓰기 수업 설계.md": { folder: true, tag: false, property: false } },
      tagColors: { "AI_교육": "#4a70b7", "글쓰기": "#2cb3b3" },
      inheritFolderColors: true,
    }),
  );
  put(
    ".obsidian/plugins/achmage-nn-border-addon/data.json",
    JSON.stringify({
      version: 5,
      folderBorders: { "/": { startColor: "#4a70b7", endColor: "#2cb3b3", radius: 6, darkStartColor: "#ffb2cb", darkEndColor: "#005bac" } },
      borderGroups: [
        { id: "g1", name: "DIKM", folders: ["01. Inbox", "10. Data (D)", "20. Information (I)", "30. Knowledge (K)", "40. Meaning (M)"], style: { startColor: "#7abfc3", endColor: "#77a1d6", darkStartColor: "#d58ead", darkEndColor: null } },
        { id: "g2", name: "가르침", folders: ["50. Teaching Materials", "60. Research Questions"], style: { startColor: "#95a5c5", endColor: null, darkStartColor: "#b6a599", darkEndColor: null } },
      ],
      folderColorOverrides: {
        "/": { light: { color: "#002870" } },
        "01. Inbox": { light: { color: "#6c727b" } },
        "10. Data (D)": { light: { color: "#566670" } },
        "20. Information (I)": { light: { color: "#1c6c75" } },
        "30. Knowledge (K)": { light: { color: "#00698f" } },
        "40. Meaning (M)": { light: { color: "#005bac" } },
        "50. Teaching Materials": { light: { color: "#254582" } },
        "60. Research Questions": { light: { color: "#254582" } },
        References: { light: { color: "#5e6a7b" } },
      },
      showFolderBorders: true,
      showGroupBorders: true,
      showFolderColors: true,
      suppressNestedBorders: true,
    }),
  );
  // Settings of another plugin, as a real vault has them: never to be read by Workbench.
  put(".obsidian/plugins/cmds-example/data.json", JSON.stringify({ apiKey: "FIXTURE-SECRET-DO-NOT-READ" }));
  put("90. Settings/92. Attachments/표지.png", PNG);
  put(
    "90. Settings/91. Templates/New DIKM Note.md",
    [
      "---",
      "title: ",
      "aliases: ",
      '"DIKM_단계:":',
      "  - 🟢 D",
      "  - 🔵 I",
      "  - 🟣 K",
      "  - 🟠 M",
      "  - ⬜ 보류",
      '"종류:":',
      "  - 노트",
      "  - 아이디어",
      "  - 논문",
      "tags: ",
      '"저자:": ',
      '"관련문서:": ',
      "date created: ",
      "source:",
      "---",
      "",
      "## 📝 Summary or Key Trigger",
      "> 이 노트를 쓰게 된 계기 <% tp.date.now() %>",
      "",
    ].join("\n"),
  );
  put(
    "01. Inbox/연구 질문 모음.md",
    note("연구 질문 모음", ['"DIKM_단계:":', "  - ⬜ 보류", "tags:", "  - 연구"], "AI가 쓴 글을 학생이 어떻게 고쳐 쓰는지 살펴본다. 수업에서 바로 쓸 질문을 모은다.\n\n둘째 문단은 발췌에 나오지 않는다."),
  );
  put("01. Inbox/짧은 메모.md", "제목 줄 없는 메모입니다. 앞머리가 없어도 첫 두 줄이 발췌가 됩니다.\n둘째 줄.\n셋째 줄은 잘립니다.\n");
  put(
    "20. Information (I)/201. 주제별/AI 글쓰기 수업 설계.md",
    note("AI 글쓰기 수업 설계", ['"DIKM_단계:":', "  - 🔵 I", "tags:", "  - AI_교육", "  - 글쓰기"], "![[표지.png]]\n\n수업 첫 주에는 학생이 직접 쓴 글과 AI가 고친 글을 나란히 놓고 비교한다. 무엇이 바뀌었는지 말로 설명하게 한다."),
  );
  put(
    "20. Information (I)/201. 주제별/저널리즘과 PKM.md",
    note("저널리즘과 PKM", ['"DIKM_단계:":', "  - 🔵 I", "tags:", "  - 저널리즘"], "취재 메모를 옵시디언에 남기면 기사 사이의 연결이 보인다."),
  );
  put("20. Information (I)/용어 정리.md", note("용어 정리", ['"DIKM_단계:":', "  - 🟢 D", "tags: [용어, AI_교육]"], "DIKM: 데이터 · 정보 · 지식 · 의미."));
  put("30. Knowledge (K)/글쓰기 피드백 원칙.md", note("글쓰기 피드백 원칙", ['"DIKM_단계:":', "  - 🟣 K", "tags:", "  - 글쓰기"], "피드백은 문장 단위가 아니라 주장 단위로 준다."));
  put("40. Meaning (M)/가르치는 이유.md", note("가르치는 이유", ['"DIKM_단계:":', "  - 🟠 M"], "도구가 바뀌어도 질문하는 힘은 남는다."));
  put("10. Data (D)/101. 기록/2026-10-01 수업 기록.md", note("2026-10-01 수업 기록", ['"DIKM_단계:":'], "출석 24명. 과제 제출 20명."));
  put("50. Teaching Materials/AI영상제작실습/1주차 안내.md", note("1주차 안내", ['"DIKM_단계:":', "  - 🔵 I", "tags:", "  - AI_교육"], "실습 준비물과 평가 기준을 안내한다."));
  put("60. Research Questions/질문 목록.md", note("질문 목록", [], "연구 질문을 여기에 모은다."));
  put("References/참고 지도.canvas", "{}");
  put("홈.md", note("홈", [], "볼트 첫 화면."));
  return root;
}

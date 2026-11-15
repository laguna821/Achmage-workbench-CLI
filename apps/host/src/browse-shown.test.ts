// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { SHOWN } from "./browse-host.ts";

// Unit 9, fix round 1 (I9): what a picture of the agent page would show as text, read by the page
// script the gateway runs before any screenshot while a typed value is live. Frames and shadow roots
// it can read are walked; those it cannot are counted, so the caller can refuse (fail closed).

const shown = () => JSON.parse((0, eval)(SHOWN)()) as { values: string[]; text: string; blind: number };

afterEach(() => { document.body.innerHTML = ""; });

describe("what the page shows as text", () => {
  it("reads inputs inside open shadow roots and readable frames, never a password input's value", () => {
    document.body.innerHTML = '<p>로그인</p><input type="password" value="zz-pass"><input type="text" value="zz-top">';
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML = '<input type="text" value="zz-in-shadow"><span>그림자 글</span>';
    document.body.append(host);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    frame.contentDocument!.body.innerHTML = '<input type="text" value="zz-in-frame">';
    const out = shown();
    expect(out.values).toEqual(expect.arrayContaining(["zz-top", "zz-in-shadow", "zz-in-frame"]));
    expect(out.values).not.toContain("zz-pass");
    expect(out.text).toContain("그림자 글");
    expect(out.blind).toBe(0);
  });

  it("counts a frame it cannot read and a defined custom element whose shadow root is closed", () => {
    class Closed extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = '<input type="text" value="zz-hidden">'; } }
    if (!customElements.get("zz-closed")) customElements.define("zz-closed", Closed);
    document.body.innerHTML = "<zz-closed></zz-closed>";
    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "contentDocument", { get() { throw new DOMException("Blocked a frame", "SecurityError"); } });
    document.body.append(frame);
    expect(shown().blind).toBe(2);
  });
});

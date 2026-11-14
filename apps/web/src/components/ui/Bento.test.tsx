// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bento, BentoCell } from "./Bento.tsx";
import { Card } from "./Card.tsx";
import { SectionLabel, useSectionCollapsed } from "./SectionLabel.tsx";
import { Stat, StatRow } from "./Stat.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Bento", () => {
  it("lists every child as one cell of a named list, and a cell may span columns", () => {
    render(
      <Bento label="대화" max={3}>
        <Card title="하나" />
        <BentoCell span={2}><Card title="둘" /></BentoCell>
      </Bento>,
    );
    const list = screen.getByRole("list", { name: "대화" });
    const cells = within(list).getAllByRole("listitem");
    expect(cells).toHaveLength(2);
    expect(cells[1]!.dataset.span).toBe("2");
    expect(list.closest<HTMLElement>(".ui-bento")!.dataset.max).toBe("3");
  });

  it("draws nothing when it has no cells", () => {
    const { container } = render(<Bento label="웹">{[]}</Bento>);
    expect(container.innerHTML).toBe("");
  });

  it("takes its column count from its container's width, never from the window", () => {
    const css = readFileSync(resolve(process.cwd(), "apps/web/src/styles/bento.css"), "utf8");
    expect(css).toMatch(/container-type:\s*inline-size/);
    expect(css).toMatch(/@container[^{]*min-width/);
    expect(css).not.toMatch(/@media[^{]*width/);
    // Tokens only: no colour literal.
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

describe("Card", () => {
  it("reads in one fixed order: tags, title, description, hairline, footer start and end", () => {
    render(<Card tags={<span>승인 필요</span>} title="자료 조사" description="계획 확인 필요" footStart="Claude" footEnd="방금" />);
    const card = screen.getByText("자료 조사").closest<HTMLElement>(".ui-card")!;
    const parts = [...card.children].map((child) => child.className);
    expect(parts).toEqual(["ui-card-tags", "ui-card-title", "ui-card-text", "ui-card-foot"]);
    expect(within(card.querySelector<HTMLElement>(".ui-card-foot")!).getByText("Claude").className).toBe("ui-card-foot-start");
    expect(within(card.querySelector<HTMLElement>(".ui-card-foot")!).getByText("방금").className).toBe("ui-card-foot-end");
  });

  it("opens as one button when it leads somewhere, and is plain content otherwise", () => {
    const open = vi.fn();
    render(<><Card title="슬라이드 정리" onOpen={open} label="슬라이드 정리 대화 열기" /><Card title="읽기만" /></>);
    fireEvent.click(screen.getByRole("button", { name: "슬라이드 정리 대화 열기" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("읽기만").closest(".ui-card")!.tagName).toBe("ARTICLE");
  });

  it("leaves out the parts it was not given (no empty tag line, no footer hairline)", () => {
    render(<Card title="제목만" />);
    const card = screen.getByText("제목만").closest<HTMLElement>(".ui-card")!;
    expect(card.querySelector(".ui-card-tags, .ui-card-text, .ui-card-foot")).toBeNull();
  });
});

describe("Stat", () => {
  it("shows the label over the value inside a named group of stats", () => {
    render(<StatRow label="속성"><Stat label="마감일">11월 20일</Stat><Stat label="대화">3</Stat></StatRow>);
    const group = screen.getByRole("group", { name: "속성" });
    const terms = within(group).getAllByRole("term").map((term) => term.textContent);
    const values = within(group).getAllByRole("definition").map((value) => value.textContent);
    expect(terms).toEqual(["마감일", "대화"]);
    expect(values).toEqual(["11월 20일", "3"]);
    // Label first, value under it, in reading order.
    const first = group.querySelector(".ui-stat")!;
    expect(first.firstElementChild!.tagName).toBe("DT");
  });

  it("turns its value into a button when it can be acted on, named by label and value", () => {
    const act = vi.fn();
    render(<StatRow label="속성"><Stat label="중요도" onActivate={act} actionLabel="바꾸기" dataKey="중요도">높음</Stat></StatRow>);
    fireEvent.click(screen.getByRole("button", { name: "중요도: 높음 — 바꾸기" }));
    expect(act).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button").closest<HTMLElement>(".ui-stat")!.dataset.key).toBe("중요도");
  });

  it("marks a stat that asks for attention without colouring the row", () => {
    render(<StatRow label="상태"><Stat label="확인 필요" tone="attention">2</Stat><Stat label="문서">1</Stat></StatRow>);
    const stats = screen.getByRole("group", { name: "상태" }).querySelectorAll<HTMLElement>(".ui-stat");
    expect(stats[0]!.dataset.tone).toBe("attention");
    expect(stats[1]!.dataset.tone).toBeUndefined();
  });
});

describe("Stat status and grid", () => {
  it("puts a stat's status on a dot before its label; the value stays ink", () => {
    render(<StatRow label="상태"><Stat label="확인 필요" tone="attention">2</Stat></StatRow>);
    const label = screen.getByRole("term");
    expect(label.firstElementChild?.classList.contains("dot-attention")).toBe(true);
    expect(label.textContent).toBe("확인 필요");
    const css = readFileSync(resolve(process.cwd(), "apps/web/src/styles/bento.css"), "utf8");
    expect(css).not.toMatch(/data-tone[^{]*\{[^}]*color/);
  });

  it("lays the stats on equal columns per width, 8 or 4 + 4, never leaving one alone on a row", () => {
    const columns = (count: number) => {
      cleanup();
      render(<StatRow label="속성">{Array.from({ length: count }, (_, index) => <Stat key={index} label={`s${index}`}>{index}</Stat>)}</StatRow>);
      const row = screen.getByRole("group", { name: "속성" });
      return ["--stat-cols-wide", "--stat-cols"].map((name) => row.style.getPropertyValue(name));
    };
    expect(columns(8)).toEqual(["8", "4"]);
    expect(columns(9)).toEqual(["5", "3"]);
    expect(columns(6)).toEqual(["6", "3"]);
    expect(columns(5)).toEqual(["5", "3"]);
    expect(columns(12)).toEqual(["6", "4"]);
    expect(columns(3)).toEqual(["3", "3"]);
  });

  it("keeps what follows the stats (a kept draft) in the group but off the grid", () => {
    render(<StatRow label="속성" after={<p>쓰다 만 속성 · 메모</p>}>{Array.from({ length: 8 }, (_, index) => <Stat key={index} label={`s${index}`}>{index}</Stat>)}</StatRow>);
    const row = screen.getByRole("group", { name: "속성" });
    expect(row.style.getPropertyValue("--stat-cols-wide")).toBe("8");
    expect(within(row).getByText("쓰다 만 속성 · 메모").closest("dl")).toBeNull();
  });
});

describe("SectionLabel", () => {
  it("names a section with its count", () => {
    render(<SectionLabel count={3}>대화</SectionLabel>);
    expect(screen.getByRole("heading", { name: "대화 3" })).toBeTruthy();
  });

  it("folds its section when it has a toggle, and remembers the fold per key", () => {
    function Folding() {
      const [collapsed, toggle] = useSectionCollapsed("test.section");
      return <section><SectionLabel count={2} collapsed={collapsed} onToggle={toggle} controls="body">기록</SectionLabel>{collapsed ? null : <p id="body">내용</p>}</section>;
    }
    const { unmount } = render(<Folding />);
    const button = screen.getByRole("button", { name: "기록 2" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("내용")).toBeNull();
    unmount();
    render(<Folding />);
    expect(screen.getByRole("button", { name: "기록 2" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps an action at the end of the line, outside the heading", () => {
    function WithAction() {
      const [n, setN] = useState(0);
      return <SectionLabel action={<button type="button" onClick={() => setN(n + 1)}>+ 결정</button>}>{`결정 ${n}`}</SectionLabel>;
    }
    render(<WithAction />);
    fireEvent.click(screen.getByRole("button", { name: "+ 결정" }));
    expect(screen.getByRole("heading").textContent).toBe("결정 1");
  });
});

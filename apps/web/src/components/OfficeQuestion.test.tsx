// @vitest-environment jsdom
import { fireEvent, render, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { OfficeQuestion } from "./OfficeQuestion.tsx";
import { executionQuestionFields } from "../../../office/src/execution-question.ts";

afterEach(cleanup);
const item: Extract<TranscriptItem, { kind: "approval" }> = { kind: "approval", id: "office-question:run:clarify", at: 1,
  title: "원본 편집기 질문", detail: null, reason: null, decision: null, officeInteraction: {
    prompt: "원본 편집기 질문", fields: [
      { id: "style", prompt: "문체", options: [{ id: "brief", label: "간단히" }, { id: "formal", label: "격식 있게" }] },
      { id: "parts", prompt: "포함할 내용", options: [{ id: "table", label: "표" }, { id: "chart", label: "차트" }], multiple: true },
      { id: "note", prompt: "요청사항" },
    ],
  } };
it("collects original choice, multiple choice and text answers without accepting an empty form", () => {
  const answer = vi.fn(), view = render(<OfficeQuestion item={item} onAnswer={answer} />);
  expect(view.getByText("답변하고 계속").hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByLabelText("격식 있게"));
  fireEvent.click(view.getByLabelText("표")); fireEvent.click(view.getByLabelText("차트"));
  fireEvent.change(view.getByLabelText("요청사항"), { target: { value: "근거를 포함" } });
  fireEvent.click(view.getByText("답변하고 계속"));
  expect(answer).toHaveBeenCalledWith("accept", { style: "formal", parts: ["table", "chart"], note: "근거를 포함" });
});
it("uses the same answer values in a reopened original editor", () => {
  const container = document.createElement("div"), read = executionQuestionFields(container, item.officeInteraction!.fields);
  const fields = container.querySelectorAll("input"), text = container.querySelector("textarea")!;
  fields[1]!.checked = true; fields[2]!.checked = true; fields[3]!.checked = true; text.value = "근거를 포함";
  expect(read()).toEqual({ style: "formal", parts: ["table", "chart"], note: "근거를 포함" });
});

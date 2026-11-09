// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@workbench/contracts";
import { ModelPicker } from "./ModelPicker.tsx";

afterEach(cleanup);
const models: ModelOption[] = [
  { id: "alias", label: "사용 가능한 모델", resolvedModel: "canonical-model", description: null, efforts: ["low", "high"], defaultEffort: "high", isDefault: true },
];

describe("ModelPicker request identity", () => {
  it("refreshes each time the model chooser opens and preserves the saved selection", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined), onChange = vi.fn();
    const view = render(<ModelPicker models={models} value={{ model: "alias", effort: null }} onChange={onChange} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "사용 가능한 모델" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    view.rerender(<ModelPicker models={[...models, { ...models[0]!, id: "new-model", label: "새 모델" }]} value={{ model: "alias", effort: null }} onChange={onChange} onRefresh={onRefresh} />);
    expect(screen.getByRole("menuitemcheckbox", { name: /새 모델/ })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "사용 가능한 모델" }));
    fireEvent.click(screen.getByRole("button", { name: "사용 가능한 모델" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
  });
  it("shows a saved model missing from the list without replacing it or claiming the default", () => {
    const onChange = vi.fn();
    render(<ModelPicker models={models} value={{ model: "saved-custom-id", effort: "max" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "saved-custom-id" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "사용 가능한 모델" })).toBeNull();
    expect(screen.getByRole("button", { name: "최대" })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "saved-custom-id" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /엔진 기본값/ }));
    expect(onChange).toHaveBeenCalledWith({ model: null, effort: null });
  });

  it("keeps a saved id visible while the model list is unavailable", () => {
    render(<ModelPicker models={[]} value={{ model: "offline-model", effort: null }} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "offline-model" })).toBeTruthy();
  });

  it("switches to the chosen engine id and resets unsupported effort only on selection", () => {
    const onChange = vi.fn();
    render(<ModelPicker models={models} value={{ model: "old-model", effort: "max" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "old-model" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^사용 가능한 모델/ }));
    expect(onChange).toHaveBeenCalledWith({ model: "alias", effort: null });
  });

  it("exposes the resolved alias and can return an explicit effort to the engine default", () => {
    const onChange = vi.fn();
    render(<ModelPicker models={models} value={{ model: "alias", effort: "low" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "사용 가능한 모델" }).title).toContain("canonical-model");
    fireEvent.click(screen.getByRole("button", { name: "낮음" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "기본 강도" }));
    expect(onChange).toHaveBeenCalledWith({ model: "alias", effort: null });
  });

  it("accepts a direct ID even when discovery fails, and preserves it across refresh", async () => {
    const onChange = vi.fn(), onRefresh = vi.fn().mockRejectedValue(new Error("모델 목록을 확인할 수 없습니다."));
    const view = render(<ModelPicker models={[]} value={{ model: null, effort: null }} onChange={onChange} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "모델 선택" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "모델 목록을 확인할 수 없습니다.");
    fireEvent.click(screen.getByRole("menuitem", { name: "모델 ID 직접 입력…" }));
    expect(screen.getByRole("dialog", { name: "모델 ID 직접 입력" })).toBeTruthy();
    const input = screen.getByLabelText("모델 ID");
    fireEvent.change(input, { target: { value: " vendor/custom-id " } });
    fireEvent.compositionStart(input); fireEvent.submit(input.closest("form")!);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.click(screen.getByRole("button", { name: "이 ID 사용" }));
    expect(onChange).toHaveBeenCalledWith({ model: "vendor/custom-id", effort: null });
    view.rerender(<ModelPicker models={models} value={{ model: "vendor/custom-id", effort: null }} onChange={onChange} onRefresh={onRefresh} />);
    expect(screen.getByRole("button", { name: "vendor/custom-id" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "vendor/custom-id" })); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("shows role defaults while explicit model and effort choices take precedence", () => {
    const inherited = { name: "연구", model: "role-model", effort: "high" }, onChange = vi.fn();
    const view = render(<ModelPicker models={models} value={{ model: null, effort: null }} inherited={inherited} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "role-model · 역할" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "높음" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "role-model · 역할" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /역할 기본값/ }));
    expect(onChange).toHaveBeenCalledWith({ model: null, effort: null });
    view.rerender(<ModelPicker models={models} value={{ model: "alias", effort: "low" }} inherited={inherited} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "사용 가능한 모델" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "낮음" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^높음/ }));
    expect(onChange).toHaveBeenLastCalledWith({ model: "alias", effort: "high" });
  });
});

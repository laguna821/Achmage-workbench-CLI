// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@workbench/contracts";
import { ModelPicker } from "./ModelPicker.tsx";

afterEach(cleanup);
const models: ModelOption[] = [
  { id: "alias", label: "사용 가능한 모델", resolvedModel: "canonical-model", description: null, efforts: ["low", "high"], defaultEffort: "high", isDefault: true },
];

describe("ModelPicker request identity", () => {
  it("shows a saved model missing from the list without replacing it or claiming the default", () => {
    const onChange = vi.fn();
    render(<ModelPicker models={models} value={{ model: "saved-custom-id", effort: "max" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "saved-custom-id" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "사용 가능한 모델" })).toBeNull();
    expect(screen.getByRole("button", { name: "최대" })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "saved-custom-id" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /엔진 기본값/ }));
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
    fireEvent.click(screen.getByRole("menuitem", { name: /^사용 가능한 모델/ }));
    expect(onChange).toHaveBeenCalledWith({ model: "alias", effort: null });
  });

  it("exposes the resolved alias and can return an explicit effort to the engine default", () => {
    const onChange = vi.fn();
    render(<ModelPicker models={models} value={{ model: "alias", effort: "low" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "사용 가능한 모델" }).title).toContain("canonical-model");
    fireEvent.click(screen.getByRole("button", { name: "낮음" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "기본 강도" }));
    expect(onChange).toHaveBeenCalledWith({ model: "alias", effort: null });
  });
});

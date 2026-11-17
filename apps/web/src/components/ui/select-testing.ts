import { fireEvent, screen } from "@testing-library/react";

/**
 * Test steps for the shared Select (in place of `fireEvent.change(select, …)` on a native one).
 * `field` is the trigger itself or its accessible name.
 */
const triggerOf = (field: HTMLElement | string | RegExp) => typeof field === "string" || field instanceof RegExp ? screen.getByRole("button", { name: field }) : field;

/** Opens the list and clicks the option named `option`; the list closes as after a real choice. */
export function chooseOption(field: HTMLElement | string | RegExp, option: string | RegExp) {
  const trigger = triggerOf(field);
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: option }));
}

/** What the trigger shows as chosen (the option's label, or the placeholder). */
export function chosenLabel(field: HTMLElement | string | RegExp) {
  return triggerOf(field).querySelector(".ui-select-value")?.textContent ?? "";
}

// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "./api.ts";
import { useOfficeControl } from "./office-control.ts";

// 0.5.6 round 2: the office-control queue is the PC's editors' (a phone has none): a phone never asks for it.
afterEach(cleanup);
function Probe({ api }: { api: Api }) { useOfficeControl(api, true, async () => undefined, () => undefined); return null; }

it("a phone joined to the PC does not ask; the PC does", () => {
  const phone = { isRemote: true, officeControl: vi.fn(async () => ({ commands: [] })) };
  render(<Probe api={phone as unknown as Api} />);
  expect(phone.officeControl).not.toHaveBeenCalled();
  const pc = { isRemote: false, officeControl: vi.fn(async () => ({ commands: [] })) };
  render(<Probe api={pc as unknown as Api} />);
  expect(pc.officeControl).toHaveBeenCalled();
});

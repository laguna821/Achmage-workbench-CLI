import { expect, it } from "vitest";
import { admitHangulTicket } from "./hangul-convert.ts";

// Security review 2 (2026-11-20): Word → 한글 holds a converted file per ticket for 15 minutes; the PC has 20.
// A phone gets a small share of its own (3), never the PC's slots.
it("a phone's pending Word → 한글 tickets never take the PC's slots, and a phone has at most 3", () => {
  const now = 1_000_000, live = (owner?: string) => ({ owner, expires: now + 60_000 });
  const phoneFull = [live("device:a"), live("device:a"), live("device:a")];
  expect(() => admitHangulTicket(phoneFull, "device:a", now)).toThrow(expect.objectContaining({ status: 429 }));
  expect(() => admitHangulTicket(phoneFull, "device:b", now)).not.toThrow();
  expect(() => admitHangulTicket(phoneFull, undefined, now)).not.toThrow();
  const pcFull = Array.from({ length: 20 }, () => live());
  expect(() => admitHangulTicket(pcFull, undefined, now)).toThrow(expect.objectContaining({ status: 429 }));
  expect(() => admitHangulTicket([...pcFull, ...Array.from({ length: 40 }, () => live("device:z"))], "device:a", now)).not.toThrow();
  // A phone flooding (many devices' worth) leaves the PC its 20.
  expect(() => admitHangulTicket([...Array.from({ length: 19 }, () => live()), ...Array.from({ length: 50 }, () => live("device:x"))], undefined, now)).not.toThrow();
  // Expired ones do not count.
  expect(() => admitHangulTicket([{ owner: "device:a", expires: now - 1 }, ...phoneFull.slice(1)], "device:a", now)).not.toThrow();
});

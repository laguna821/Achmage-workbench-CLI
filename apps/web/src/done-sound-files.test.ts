import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { RATE, render } from "../../../scripts/sounds/make-done-sounds.mjs";

const dir = join(import.meta.dirname, "assets/sounds");

it("the committed 완료 소리 are exactly what the script makes: short 16-bit mono PCM WAVs of a few KB", () => {
  const made = render() as Record<string, Buffer>;
  expect(Object.keys(made).sort()).toEqual(["bell", "chime", "fall", "pop", "rise"]);
  for (const [name, bytes] of Object.entries(made)) {
    const file = readFileSync(join(dir, `${name}.wav`));
    expect(file.equals(bytes), `${name}.wav differs from the script's output`).toBe(true);
    expect(file.toString("ascii", 0, 4)).toBe("RIFF");
    expect(file.toString("ascii", 8, 12)).toBe("WAVE");
    expect(file.readUInt16LE(20)).toBe(1); // PCM
    expect(file.readUInt16LE(22)).toBe(1); // mono
    expect(file.readUInt32LE(24)).toBe(RATE);
    expect(file.readUInt16LE(34)).toBe(16);
    const seconds = file.readUInt32LE(40) / 2 / RATE;
    expect(seconds).toBeGreaterThan(0.08);
    expect(seconds).toBeLessThanOrEqual(0.6);
    expect(file.length).toBeLessThan(20_000);
    // Not silent and not clipped.
    let peak = 0;
    for (let i = 44; i < file.length; i += 2) peak = Math.max(peak, Math.abs(file.readInt16LE(i)));
    expect(peak).toBeGreaterThan(0.5 * 32767);
    expect(peak).toBeLessThan(0.75 * 32767);
  }
});

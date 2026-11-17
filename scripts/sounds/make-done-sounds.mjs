#!/usr/bin/env node
// Makes the app's own 완료 소리 (apps/web/src/assets/sounds/*.wav): plain sine tones with a soft
// attack and an exponential decay, computed here — no sample from any other product. Deterministic:
// running it again writes the same bytes (the test checks the committed files against it).
//   node scripts/sounds/make-done-sounds.mjs [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RATE = 16000;

/** One struck note: fundamental plus a few quiet partials, 6 ms attack, exponential decay. */
function note(out, start, freq, length, { gain = 0.5, decay = 6, partials = [[2, 0.18], [3, 0.06]] } = {}) {
  const from = Math.round(start * RATE), count = Math.round(length * RATE), attack = Math.round(0.006 * RATE);
  for (let i = 0; i < count && from + i < out.length; i++) {
    const t = i / RATE;
    const envelope = Math.min(1, i / attack) * Math.exp(-decay * t) * (i > count - 64 ? (count - i) / 64 : 1);
    let sample = Math.sin(2 * Math.PI * freq * t);
    for (const [ratio, level] of partials) sample += level * Math.sin(2 * Math.PI * freq * ratio * t);
    out[from + i] += gain * envelope * sample;
  }
}
/** A short tap whose pitch glides (for 톡). */
function glide(out, start, from, to, length, gain = 0.5) {
  const first = Math.round(start * RATE), count = Math.round(length * RATE);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const t = i / RATE, freq = from + (to - from) * (i / count);
    phase += 2 * Math.PI * freq / RATE;
    out[first + i] += gain * Math.min(1, i / 48) * Math.exp(-28 * t) * Math.sin(phase);
  }
}

export const SOUNDS = {
  // 맑은 두 음 (done): E5 → B5, a rising fifth.
  chime: { seconds: 0.5, draw: out => { note(out, 0, 659.25, 0.22, { gain: 0.42, decay: 9 }); note(out, 0.13, 987.77, 0.37, { gain: 0.42, decay: 8 }); } },
  // 작은 종: A5 with the inharmonic partials of a small bell.
  bell: { seconds: 0.6, draw: out => note(out, 0, 880, 0.6, { gain: 0.45, decay: 7, partials: [[2.76, 0.22], [5.4, 0.08]] }) },
  // 톡: a 90 ms tap.
  pop: { seconds: 0.12, draw: out => glide(out, 0, 520, 880, 0.12, 0.6) },
  // 올라가는 세 음 (needs the person): C5 E5 G5, quick.
  rise: { seconds: 0.55, draw: out => { note(out, 0, 523.25, 0.2, { gain: 0.4, decay: 10 }); note(out, 0.11, 659.25, 0.2, { gain: 0.4, decay: 10 }); note(out, 0.22, 783.99, 0.33, { gain: 0.42, decay: 8 }); } },
  // 내려가는 두 음 (failed): A4 → E4, lower and softer.
  fall: { seconds: 0.55, draw: out => { note(out, 0, 440, 0.24, { gain: 0.45, decay: 8 }); note(out, 0.16, 329.63, 0.39, { gain: 0.45, decay: 7 }); } },
};

/** 16-bit mono PCM WAV. */
export function wav(seconds, draw) {
  const samples = new Float64Array(Math.round(seconds * RATE));
  draw(samples);
  const peak = Math.max(...samples.map(Math.abs)) || 1, scale = Math.min(1, 0.7 / peak);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * scale)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function render() {
  return Object.fromEntries(Object.entries(SOUNDS).map(([name, { seconds, draw }]) => [name, wav(seconds, draw)]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../../apps/web/src/assets/sounds"));
  mkdirSync(outDir, { recursive: true });
  for (const [name, bytes] of Object.entries(render())) { writeFileSync(join(outDir, `${name}.wav`), bytes); console.log(`${name}.wav ${bytes.length} bytes`); }
}

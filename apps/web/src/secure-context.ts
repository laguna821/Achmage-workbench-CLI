// crypto.randomUUID exists only in secure contexts (https, localhost). A page opened over plain
// http — a phone reaching the PC by its network address — has none, and the app's modules call it
// while loading, so nothing rendered. crypto.getRandomValues exists there too: the same RFC 4122
// version 4 identifiers are made from it. No randomness is weakened; nothing here is a key.
function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Imported first by main.tsx, so it is in place before any other module loads.
if (typeof crypto.randomUUID !== "function") {
  Object.defineProperty(crypto, "randomUUID", { value: randomUUID, configurable: true, writable: true });
}

export {};

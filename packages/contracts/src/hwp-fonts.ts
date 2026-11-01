// rhwp v0.8.7 HostFontProvider contract. Metadata only: filesystem paths stay in the host.
export interface HostFontFace {
  id: string;
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  aliases?: readonly string[];
  weight?: number;
  slant?: "normal" | "italic" | "oblique";
}
export interface HostFontSnapshot { revision: string; faces: readonly HostFontFace[] }
export interface HostFontProvider {
  getSnapshot(signal: AbortSignal): Promise<HostFontSnapshot>;
  readFace(id: string, revision: string, signal: AbortSignal): Promise<{ bytes: ArrayBuffer; faceIndex?: number }>;
  subscribe(onChange: () => void): () => void;
}

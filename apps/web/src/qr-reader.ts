type QRSource = HTMLVideoElement | HTMLImageElement;
type Detector = { detect(source: QRSource): Promise<{ rawValue?: string }[]> };
type DetectorConstructor = { new(options: { formats: string[] }): Detector; getSupportedFormats?(): Promise<string[]> };

/** Web platform adapter. The original Paseo scanner only provides Expo Camera for native apps. */
export async function createQrReader() {
  const Constructor = (globalThis as typeof globalThis & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
  let detector: Detector | null = null;
  if (Constructor) {
    try {
      if (!Constructor.getSupportedFormats || (await Constructor.getSupportedFormats()).includes("qr_code")) detector = new Constructor({ formats: ["qr_code"] });
    } catch { /* The pure JS decoder also supports browsers without this optional API. */ }
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let decode: typeof import("jsqr").default | null = null;
  return {
    async read(source: QRSource): Promise<string | null> {
      if (detector) {
        try { return (await detector.detect(source)).find(code => code.rawValue)?.rawValue ?? null; }
        catch { detector = null; }
      }
      if (!context) throw new Error("이 브라우저에서 QR 그림을 읽을 수 없습니다. 연결 링크를 붙여넣어 주세요.");
      decode ??= (await import("jsqr")).default;
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
      if (!width || !height) return null;
      const scale = Math.min(1, 1600 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      return decode(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
    },
    close() { canvas.width = 0; canvas.height = 0; detector = null; decode = null; },
  };
}

export async function qrImage(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("QR이 들어 있는 그림 파일을 선택해 주세요.");
  if (file.size > 12 * 1024 * 1024) throw new Error("QR 그림은 12MB 이하로 선택해 주세요.");
  const url = URL.createObjectURL(file), image = new Image();
  image.src = url;
  try {
    await image.decode();
    return { image, close: () => { image.src = ""; URL.revokeObjectURL(url); } };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("이 그림 형식을 읽지 못했습니다. PNG·JPEG QR 그림이나 연결 링크를 사용해 주세요.");
  }
}

export function cameraProblem(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "카메라 권한을 허용하지 않았습니다. 브라우저 설정에서 허용한 뒤 다시 누르거나 QR 그림·연결 링크를 사용하세요.";
  if (name === "NotFoundError") return "사용할 카메라를 찾지 못했습니다. QR 그림이나 연결 링크를 사용하세요.";
  if (name === "NotReadableError") return "다른 앱이 카메라를 사용 중일 수 있습니다. 사용을 마친 뒤 다시 눌러 주세요.";
  return error instanceof Error ? error.message : "카메라를 열지 못했습니다. QR 그림이나 연결 링크를 사용하세요.";
}

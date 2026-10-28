// A small real PNG that looks like a web page (title bar, lines of text), for stand-in engines that
// "take screenshots": previews then have something to show.

import { crc32, deflateSync } from "node:zlib";

export function pagePng(width = 360, height = 220, accent = [47, 111, 223]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3;
      const line = y > 52 && y < height - 20 && (y - 52) % 26 < 12 && x > 24 && x < width - 24 - ((Math.floor((y - 52) / 26) * 47) % 130);
      const [r, g, b] = y < 30 ? accent : line ? [204, 211, 224] : [250, 250, 247];
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

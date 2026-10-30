import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

// The three nativeImage operations used by Ieum's PDF engine, implemented in Node.
// Its bitmap contract is premultiplied BGRA, including on little-endian Linux.
const MAX_PIXELS = 24_000_000;
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error('PDF image exceeds the 24 megapixel limit');
}
function bitmapImage(bitmap, width, height) {
  dimensions(width, height);
  if (bitmap.length !== width * height * 4) throw new Error('Invalid PDF image bitmap');
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.from(bitmap),
    toPNG: () => {
      const rgba = Buffer.alloc(bitmap.length);
      for (let i = 0; i < bitmap.length; i += 4) {
        const alpha = bitmap[i + 3];
        const straight = (value) => alpha ? Math.min(255, Math.round(value * 255 / alpha)) : 0;
        rgba[i] = straight(bitmap[i + 2]); rgba[i + 1] = straight(bitmap[i + 1]); rgba[i + 2] = straight(bitmap[i]); rgba[i + 3] = alpha;
      }
      return PNG.sync.write({ width, height, data: rgba });
    },
  };
}
export const nativeImage = {
  createFromBuffer(bytes) {
    if (bytes.length > 50 * 1024 * 1024) throw new Error('PDF image exceeds the 50 MB limit');
    let decoded;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG header');
      dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
      decoded = PNG.sync.read(bytes, { checkCRC: true });
    } else if (bytes[0] === 255 && bytes[1] === 216) {
      decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 24, maxMemoryUsageInMB: 256, tolerantDecoding: false });
    } else throw new Error('PDF images must be PNG or JPEG');
    const { width, height, data } = decoded;
    dimensions(width, height);
    const bgra = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      bgra[i] = Math.round(data[i + 2] * alpha / 255); bgra[i + 1] = Math.round(data[i + 1] * alpha / 255); bgra[i + 2] = Math.round(data[i] * alpha / 255); bgra[i + 3] = alpha;
    }
    return bitmapImage(bgra, width, height);
  },
  createFromBitmap(bytes, { width, height }) { return bitmapImage(bytes, width, height); },
};

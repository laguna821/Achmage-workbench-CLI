import { afterEach, expect, test, vi } from "vitest";
import { MediaCache } from "./media-cache.ts";
afterEach(() => vi.restoreAllMocks());
test("shares a visible image and evicts only released blobs within the byte budget", async () => {
  let n = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${++n}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const load = vi.fn(async () => new Blob(["123456"]));
  const cache = new MediaCache(load, 10, 2);
  const one = cache.retain("one"), gallery = cache.retain("one"), two = cache.retain("two");
  await Promise.all([one.promise, gallery.promise, two.promise]);
  expect(load).toHaveBeenCalledTimes(2);
  one.release(); expect(revoke).not.toHaveBeenCalled();
  gallery.release(); expect(revoke).toHaveBeenCalledWith("blob:1");
  one.release(); expect(revoke).toHaveBeenCalledTimes(1);
  two.release();
});
test("a failed fetch can be retried without caching the failure", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retry");
  const load = vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValue(new Blob(["image"]));
  const cache = new MediaCache(load);
  const first = cache.retain("image"); await expect(first.promise).rejects.toThrow("offline"); first.release();
  const retry = cache.retain("image"); await expect(retry.promise).resolves.toBe("blob:retry"); retry.release();
  expect(load).toHaveBeenCalledTimes(2);
});

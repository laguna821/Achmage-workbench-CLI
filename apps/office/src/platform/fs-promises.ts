// `node:fs/promises` for IeumOffice's editor code in the worker (see fs.ts).
import { promises } from "./fs.ts";

export const { readFile, writeFile, appendFile, mkdir, readdir, stat, lstat, unlink, rm, rename, copyFile, access, realpath, open } = promises;
export default promises;

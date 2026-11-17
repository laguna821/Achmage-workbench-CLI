import { appendFileSync, copyFileSync, existsSync, renameSync, statSync, truncateSync } from "node:fs";

/** The size a local log grows to before one previous file is kept beside it (0.5.3, B9). */
export const LOG_LIMIT = 5 * 1024 * 1024;

const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };

/** Append a line; when the file would pass `limit`, it becomes `<file>.1` (the previous one is replaced) first. */
export function appendLogLine(file: string, line: string, limit = LOG_LIMIT) {
  const text = line.endsWith("\n") ? line : `${line}\n`;
  if (size(file) > 0 && size(file) + Buffer.byteLength(text) > limit) renameSync(file, `${file}.1`);
  appendFileSync(file, text, { mode: 0o600 });
}

/** Before a process opens a log for its whole life (service.log): a full one becomes `<file>.1`. */
export function rotateLogAtStart(file: string, limit = LOG_LIMIT) {
  if (existsSync(file) && size(file) > limit) renameSync(file, `${file}.1`);
}

/**
 * A log a running process keeps open in append mode (the service's stdout and stderr): copied to `<file>.1`
 * and emptied in place; the writer's next line lands at the new end. Lines written between the copy and the
 * truncation (microseconds) are lost. True when it trimmed.
 */
export function trimOpenLog(file: string, limit = LOG_LIMIT) {
  if (size(file) <= limit) return false;
  copyFileSync(file, `${file}.1`);
  truncateSync(file, 0);
  return true;
}

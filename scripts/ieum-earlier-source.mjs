// The switches for the parts that still build from IeumOffice's earlier pin (unit ieum-pin, 2026-11-18).
// Every other part builds from vendor/ieumoffice (vendor/ieumoffice.PINNED, v0.13.0).
import { fileURLToPath } from 'node:url';

// THE HANGUL SWITCH. The Hangul page (apps/office hwp.html: upstream's apps/hwp renderer and its studio),
// the HWP build scripts and the gateway's HWP imports (packages/cli/src/formats/hwp-edit.ts through
// '@ieum-hwp/'). Moved to the main pin v0.13.0 by unit hwp13 (2026-11-18) once Workbench's Hangul engine
// (0.9.0-workbench.4) carried upstream's patches. Nothing Hangul reads vendor/ieumoffice-0127 any more.
export const IEUM_HWP_DIR = 'vendor/ieumoffice';
export const IEUM_HWP_PIN_FILE = 'vendor/ieumoffice.PINNED';

// THE GOOGLE DRIVE SWITCH. v0.13.0 narrowed Drive to the `drive.file` scope (774cb0e90, decision 0085: only
// files picked in Google's own picker; no folder browsing; an earlier `drive` grant counts as missing
// scope). Workbench's Drive (the gateway's apps/host/src/office-drive.mjs through '@ieum-drive/', the
// settings page's Drive card, panel and attach picker) stays on v0.12.7's Drive code until the owner
// decides and a unit ports it. To move: set both lines to 'vendor/ieumoffice' and 'vendor/ieumoffice.PINNED'.
export const IEUM_DRIVE_DIR = 'vendor/ieumoffice-0127';
export const IEUM_DRIVE_PIN_FILE = 'vendor/ieumoffice-0127.PINNED';

// The Drive switch above is the only one still naming vendor/ieumoffice-0127; when it moves, delete that
// checkout and its PINNED file.

const resolver = (prefix, dir) => (source) => {
  if (typeof source !== 'string' || !source.startsWith(prefix)) return null;
  return fileURLToPath(new URL(`../${dir}/${source.slice(prefix.length)}`, import.meta.url));
};
/** '@ieum-hwp/<path>' is <path> in the Hangul checkout (the gateway's HWP imports, its tests). */
export const ieumHwpResolve = resolver('@ieum-hwp/', IEUM_HWP_DIR);
/** '@ieum-drive/<path>' is <path> in the Drive checkout. */
export const ieumDriveResolve = resolver('@ieum-drive/', IEUM_DRIVE_DIR);
/** Both, for a bundler or a test runner. */
export const ieumEarlierResolve = (source) => ieumHwpResolve(source) ?? ieumDriveResolve(source);

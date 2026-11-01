// Keep the original PDF/EPUB store and its on-disk keys shared with the bundled CLI.
import { ResultStore } from "../../../vendor/ieumoffice/packages/pdf-structure/src/store/index.ts";

const stores = new Map();
export function officeResultStore(userDataDir) {
  let store = stores.get(userDataDir);
  if (!store) { store = new ResultStore(userDataDir); stores.set(userDataDir, store); }
  return store;
}

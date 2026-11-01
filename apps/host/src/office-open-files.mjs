import { AsyncLocalStorage } from "node:async_hooks";
import { setOpenFilesSource } from "../../../vendor/ieumoffice/packages/electron-utils/src/unsaved-files.ts";

const current = new AsyncLocalStorage();
setOpenFilesSource(() => {
  const documents = current.getStore();
  return documents ? documents.registry.list().map(view => ({ filePath: documents.get(view.artifactId).path, dirty: view.dirty })) : [];
});
export const withOfficeDocuments = (documents, action) => current.run(documents, action);

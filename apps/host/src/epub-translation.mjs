import { epubTranslationUnits } from "../../../vendor/ieumoffice/packages/epub-engine/src/translate/units.ts";
import { buildTranslatedEpub } from "../../../vendor/ieumoffice/packages/epub-engine/src/translate/output.ts";
import { createEpubStoreHandlers } from "../../../vendor/ieumoffice/apps/epub/src/main/store-handlers.ts";
import { migrateStoredResults } from "../../../vendor/ieumoffice/apps/epub/src/main/save-pipeline.ts";
import { migrateJobRecords } from "../../../vendor/ieumoffice/apps/shell/src/main/pdf-structure/job-migration.ts";
import { officeResultStore } from "./office-results.mjs";

const fail = (error, message) => ({ ok: false, error, message });
function chaptersOf(value, count) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > count || !value.every(i => Number.isSafeInteger(i) && i >= 0 && i < count)) return null;
  return value;
}

/** Original translation/store operations, without the Electron window or filesystem picker. */
export function epubTranslationStore(directory, knows) {
  const store = officeResultStore(directory);
  const handlers = createEpubStoreHandlers({ store: () => store, knows });
  return {
    async invoke(operation, owner, args) {
      switch (operation) {
        case "store-translations": return handlers.translations(owner, args.docHash);
        case "store-translation": return handlers.translation(owner, args.docHash, args.lang);
        case "store-jobs": return handlers.unfinishedJobs(owner, args.docHash);
        case "store-write": return handlers.write(owner, args);
        default: return fail("invalid-request", "unknown store operation");
      }
    },
    async units(session, args) {
      const chapters = chaptersOf(args.chapters, session.book.spine.items.length);
      if (chapters === null) return fail("invalid-request", "bad chapters");
      return { ok: true, docHash: session.docHash, ...await epubTranslationUnits(session.book, chapters ? { chapters } : {}) };
    },
    async build(session, args) {
      if (args.kind !== "translated" && args.kind !== "bilingual") return fail("invalid-request", "bad kind");
      if (typeof args.lang !== "string" || args.lang.length > 128 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(args.lang)) return fail("invalid-request", "bad language");
      const chapters = chaptersOf(args.chapters, session.book.spine.items.length);
      if (chapters === null) return fail("invalid-request", "bad chapters");
      if (args.docHash !== session.docHash) return fail("stale", "the book was saved since");
      const stored = await store.readTranslation(session.docHash, args.lang);
      const built = await buildTranslatedEpub(session.bytes, { kind: args.kind, lang: args.lang, ...(chapters ? { chapters } : {}), results: stored?.blocks ?? new Map() });
      return built.ok ? built : fail("refused", `${built.reason}: ${built.detail}`);
    },
    migrate(session, hashes) {
      return migrateStoredResults(session.book, hashes, { store: () => store, migrateJobRecords });
    },
    async interrupt(docHash, languages) {
      for (const lang of languages) {
        const job = await store.readJob(docHash, "translate", lang);
        if (job.state === "running") await store.writeJob(docHash, { ...job, state: "stopped", last_error: "interrupted" });
      }
    },
  };
}

// Reuse the reviewed original resolver, read-only index and one-shot fragment store.
export { resolveWikiLinks, SKIP_DIRS } from "../../../vendor/ieumoffice/apps/markdown/src/main/wiki-resolve.ts";
export { wikiBacklinks, wikiGraph } from "../../../vendor/ieumoffice/apps/markdown/src/main/wiki-index.ts";
export { rememberWikiFragment, takeWikiFragment } from "../../../vendor/ieumoffice/apps/markdown/src/main/wiki-fragment.ts";

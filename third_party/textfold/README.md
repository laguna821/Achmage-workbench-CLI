# textfold `fold.ts` (vendored, unmodified)

- Source: https://github.com/chenxiachan/textfold — `plugins/textfold/hooks/fold.ts`
- Commit: `16454f24671097033837e5a4292ea43b3bca34ce` (v0.10.39, 2026-10-28)
- License: Apache-2.0 (`LICENSE`), notice kept as `NOTICE`. Copyright 2026 Xia Chen.
- Use in Workbench: the conversation drawer under a document folds the last reply to its points
  (level 3) without calling a model. The file is kept as published; Workbench decides on its own
  when a Korean reply is worth folding (the upstream word count does not count Hangul).

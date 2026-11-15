# @resvg/resvg-wasm 2.6.2

Rasterizes the SVG first page of a Hangul document (drawn by rhwp) into the PNG the messenger
channel sends with an answer. Used only by `apps/host/src/hangul-picture-job.ts`, a short-lived
child process of the gateway; nothing else loads it.

| | |
|---|---|
| Package | `@resvg/resvg-wasm` |
| Version | `2.6.2` (pinned exactly in `apps/host/package.json`) |
| Licence | MPL-2.0 (text in `LICENSE`; the package ships none, the text is the standard MPL 2.0) |
| Integrity | `sha512-FqALmHI8D4o6lk/LRWDnhw95z5eO+eAa6ORjVg09YRR7BkcM6oPHU9uyC0gtQG5vpFLvgpeU4+zEAz2H8APHNw==` (as in `package-lock.json`) |
| Source | https://github.com/yisibl/resvg-js (resvg by Yevhenii Reizner and contributors) |
| Shipped as | its JavaScript bundled into `hangul-picture-job.mjs`; `index_bg.wasm` copied unchanged to `resvg_bg.wasm` beside it |

Unmodified. MPL-2.0 covers these files only; the source of the covered files is the package above.

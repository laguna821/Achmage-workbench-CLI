# OpenDataLoader PDF

Original upstream: https://github.com/opendataloader-project/opendataloader-pdf

Version **2.5.17**, source commit **8dfaad6843f0fb7d9717a42584e38889734169d6**. Apache-2.0; LICENSE and NOTICE are copied unchanged. The official CLI ZIP and Python wheel are downloaded intact and checked against the hashes in `manifest.json`. The release includes its third-party notices. Workbench does not fork the extraction, layout, table or OCR algorithms.

`apps/host/src/pdf-loader.ts` manages the original CLI and hybrid server in the app data directory. Temurin Java, uv, a dedicated Python environment, CPU packages and Korean/English models are installed only after the user presses Install. System Python/Java, shell profiles and user documents are unchanged. The original server listens on loopback and receives document bytes only. Its processes close with the app or after inactivity.

The PDF ribbon's **추출·OCR** opens setup, page-range extraction, preview and Markdown output with embedded pictures. The original Ieum OCR layer receives normalized boxes; its selection, search, highlighting and passage UI are reused. Passage context reads the OCR text when present. Existing Office-format conversions remain available.

Core extraction passes `--include-header-footer` because the reader needs all source text, including repeated lines. The upstream JSON exposes accepted text regions but no per-region calibrated OCR confidence; the adapter's confidence field only retains those accepted regions through the existing renderer filter. It is not a claim of recognition accuracy.

Observed Linux footprint with CPU OCR and Korean/English models: about **2.5 GiB**, downloaded separately from the installer. OCR is fallible: the first four-line Korean/English fixture produced three text regions with some Korean substitutions. The same omission exists in the original CLI JSON; the adapter did not discard the line. Do not claim perfect OCR or count this as an engine algorithm fixed by Workbench.

Validation: native Linux extraction/OCR UI 11/11, original reading/highlight/passage UI 12/12, full suite 1264/1264, original runtime install/extraction/OCR on Windows x64, macOS arm64 and Linux x64 each 8/8 ([CI](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41297351638)). These runtime checks do not replace final installer acceptance.

Exact research: `research:rr-62872cd0cb4e9182261b621185512b31:62e1ff62c417aa6f9ba7f45f5b586a9a8f58e0177af6f065950e30ca0604337b`.

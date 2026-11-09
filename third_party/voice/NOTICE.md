# Voice source and optional model notices

This integration imports Paseo source from `https://github.com/getpaseo/paseo`, commit
`1fff127f45b11c1c9c573fbbd12791673004c912` (Apache-2.0).
Copyright (c) 2025-present Mohamed Boudra. The full upstream license is retained as
`PASEO-LICENSE`. `paseo-source.json` records every original/current source SHA256 and
the exact local adaptations. Unmodified copies of adapted files are also retained
under `vendor/paseo/voice-server/upstream/`.

Workbench calls the original `DictationStreamManager`, `OpenAISTT`, `OpenAITTS`,
`LocalSpeechWorkerClient`, `WorkerBackedSpeechToTextProvider`, worker process,
Sherpa recognizer, archive downloader and process/Windows quoting helpers. The
whole Paseo server/SDK facade is not connected. The complete imported speech and
dictation directory source/test set is retained; only the executable dependency
closure is compiled. Upstream lifecycle scripts are not run.

OpenAI SDK 6.44.0 and uuid 9.0.1 license copies are listed in `licenses.json`.
Shared pino 10.3.1, zod 4.4.3 and their runtime dependency license copies are
preserved in `../paseo/dependencies.json`. The original Silero ONNX asset remains
in the source import with its MIT license (`SILERO-LICENSE`); it is not bundled into
the application and this capture path does not enable VAD or continuous listening.

Local adaptations add host cancellation signals and zero automatic retries for
paid requests, memory-only STT upload, disabled transcript/debug-audio persistence,
optional native runtime lookup, normal IPC worker shutdown, and pinned archive
verification. Workbench supplies capture/draft identity, bounded HTTP receipts,
explicit configuration/consent, and staged model activation. Audio and transcript
diagnostics are disabled. Captured audio is transient in memory and is cleared on
completion/cancellation; synthesized response receipts expire after 60 seconds.

`voice-models.json` pins the separate optional model/runtime sources. No model or
native Sherpa binary is included in the base application. Explicit installation
downloads only the Sherpa JavaScript package and the current platform package,
verifies their pinned npm SHA512 integrity, records archive/file SHA256 values,
and extracts them without npm installation or lifecycle scripts. Runtime package
sizes are publisher-reported unpacked bytes; compressed sizes were not supplied
by the registry HEAD response and remain unknown. The original loader's Linux
RUNPATH fallback applies only inside the explicitly installed owned runtime.

Whisper Base's multilingual model includes Korean. The optional archive is
207,557,382 bytes; its pinned SHA256 is
`911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de`, obtained from
the publisher's [checksum file](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/checksum.txt).
Whisper code/model terms are MIT (`WHISPER-LICENSE`, OpenAI's v20250625 license).
Sherpa code/runtime is Apache-2.0 (`SHERPA-LICENSE`, v1.12.28); native packages retain
their own bundled licenses when separately downloaded.

The pinned original local TTS catalog has no Korean model. Korean speech output
uses the original OpenAI TTS provider only after explicit online consent and API
key configuration. This is a paid remote service, not an offline model; audio/text
goes to `api.openai.com`. Provider-managed model aliases do not have downloadable
weights or client-verifiable model hashes. Korean is listed in the official
[speech-to-text](https://developers.openai.com/api/docs/guides/speech-to-text) and
[text-to-speech](https://developers.openai.com/api/docs/guides/text-to-speech)
language documentation. Output is identified as AI-generated speech.

This implementation has not executed a real microphone, paid API request, native
model, large model download, or mobile/native audio path. Loopback response
fixtures establish runtime wiring/cancellation only; they do not establish Korean
recognition accuracy, speaker quality, or performance. A local native decode may
finish before the owned worker processes its normal disconnect; cancelled results
cannot return to a capture.

# Native Windows Lightpanda

This directory contains the source patches and pinned-source build recipe for
the independently built [Windows x64 package](https://github.com/laguna821/Achmage-workbench-CLI/releases/tag/lightpanda-win-v1.0.2-r1).
It is not an official Lightpanda Windows release. Workbench 0.3.2 bundles it using
`packaging/lightpanda-windows.json`; Linux/macOS retain official Lightpanda 1.0.2.

Native build [41420847598](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41420847598)
passed 66/66 build steps, 8/8 installation checks and 15/15 real browser checks
on Windows x64, without WSL. ZIP: 32,502,775 bytes; expanded files: 86,822,489 bytes.
The executable and required runtime DLLs stay together. Run `lightpanda.exe mcp`
from any compatible MCP stdio client. CDP interoperability and broad performance
comparisons are outside this package's acceptance scope.

Sources are pinned in `source.json`: official Lightpanda 1.0.2 plus the unmerged
[Windows browser port](https://github.com/lightpanda-io/browser/pull/3753) and
[V8 build port](https://github.com/lightpanda-io/zig-v8-fork/pull/219). The pinned
official zenai dependency already supports Windows and is unchanged. The V8
patch additionally corrects a missing PATH separator in the contributed code.
The contributed precompiled `msvcrt.lib` and workflow are deliberately excluded;
the build uses the runner's installed Microsoft toolchain and records its hash.
The browser patch retains the upstream AGPL-3.0 license (`LICENSE`); the V8
binding patch retains its MIT license (`V8-LICENSE`).

## Build and acceptance

Run `.github/workflows/lightpanda-windows.yml` on Windows x64. It prepares exact
source revisions, checks tool archive hashes, builds V8, saves that intermediate
archive, then builds the browser and packages the runtime DLLs. V8 is cached
separately so browser fixes do not trigger another full V8 compilation.

Native link run [41410510469](https://github.com/laguna821/Achmage-workbench-CLI/actions/runs/41410510469)
found two duplicate CFG globals in MinGW and MSVC. The build now derives a copy
of the installed SDK's `msvcrt.lib`, removing `guard_support.obj` and `loadcfg.obj`
with Microsoft's librarian. Run 41413676880 identified the second member's
MSVC-only XFG dependencies. The original SDK and all TLS members remain untouched;
the member inventory and original/derived hashes are recorded in `crt-derivation.json`.
Zig 0.17.0 ships MinGW's CFG pointer declarations but omits `guard_dispatch.S`;
the unchanged public-domain implementation from the exact MinGW revision in
`source.json` supplies that missing definition. Windows BoringSSL uses its
[supported portable implementations](https://github.com/google/boringssl/blob/main/INCORPORATING.md)
(`OPENSSL_NO_ASM`) because the dependency's assembly list targets Unix platforms.
There is no automatic publication or installer switch in this workflow.

Acceptance performed for the standalone package:

- Successful source build, exact version, and recorded source/tool provenance.
- Native Windows execution without WSL: JavaScript/fetch, input/click/extraction,
  independent sessions, bounded output, permission checks, and EOF shutdown.
- HTTPS navigation and package dependency verification.
- Product engine installation with pinned artifact checksum and preservation of the previous install.
- Engine source/license/provenance supplied alongside the native package.

Research:
`research:rr-13db4ea9fd777aabed7c82207cfb1cda:8ac306f2cc62999eba32093c0e9a0d722bb0f1f1291a512ad45bc6cba31ac084`

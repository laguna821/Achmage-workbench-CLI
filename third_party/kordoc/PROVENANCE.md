# kordoc (bundled)

Hangul (HWPX/HWP) engine the gateway uses for the Markdown view, page previews and patching of
HWPX documents, and that engines use to make new HWPX files ("새 문서로 → 한글").

- Source: the user's installed skill `~/.claude/skills/hallym-kordoc/core/` (copied read-only on
  2026-10-29), plus the skill's top-level `LICENSE` and `LICENSE-HANMARK`.
- Package: kordoc-workbench 0.2.0, profile `core` (`PACKAGE-MANIFEST.json`); engine kordoc 4.18.13,
  commit `969526345dde7d6acd2f2bfd3c8e592069333355`. Every file the manifest lists matched its
  sha256 when copied (55 of 55).
- Licenses: kordoc-workbench MIT (`LICENSE`, `LICENSE-WORKBENCH`), HanMark MIT (`LICENSE-HANMARK`),
  kordoc MIT with Apache-2.0/MIT parts (`NOTICE-KORDOC`, `THIRD_PARTY/`), bundled npm packages
  (`THIRD-PARTY-LICENSES.txt`, `THIRD-PARTY-PACKAGES.json`).
- Unchanged: Workbench runs `scripts/run.mjs` on its own Node with `KORDOC_OFFLINE=1`. Do not edit;
  replace the folder from a newer release and regenerate this list.

## Left out

The skill's top level is the Hallym University layer (institution templates and routing), which a
public release must not carry and the gateway does not use:

- `catalog.json` (34 Hallym document families), `assets/templates.zip` (Hallym forms),
  `ASSETS.json`, `PACKAGE-MANIFEST.json`, `SKILL.md`, `setup.ps1` of that layer;
- `scripts/` of that layer: the Hallym runner (`run.mjs`) and its helpers (`catalog.mjs`,
  `common.mjs`, `engine.mjs`, `hallym-helpers.mjs`, `install.mjs`, `layout.mjs`, `library.mjs`,
  `xml.mjs`, `style-provenance.json`);
- `references/` of that layer (`optional.md`, `private-templates.md`, `requests.md`);
- `.achmage-managed.json` (a record of the user's own setup).

No fonts are shipped: the skill has none; previews use the fonts installed on the computer. The
two forms in `templates/` are the general official draft forms (간이기안문, 일반기안문) of the
generic core, used by `fill` with `builtin:gian`.

## Files

| file | bytes | sha256 |
| --- | ---: | --- |
| `ASSETS.json` | 1243 | `d2c16095fb89ae008589ee06d0b33e9d6d386dd7f3e56cac42ce65168e289c7a` |
| `LICENSE` | 1086 | `573c682d7b9a3640305cbe2dd62f2d30d2cffbb005c84d29de68d70b931d8cf4` |
| `LICENSE-HANMARK` | 1087 | `f19a76e7904e71b96de3ed03e36184489c58eb6437c8e2ea8d8beb7ea16ee627` |
| `LICENSE-WORKBENCH` | 1086 | `573c682d7b9a3640305cbe2dd62f2d30d2cffbb005c84d29de68d70b931d8cf4` |
| `NOTICE-KORDOC` | 6708 | `75bb97bd32e3ae1fba5c6a7d204bdf926e5db408369e926ac637b480db6ec607` |
| `PACKAGE-MANIFEST.json` | 9225 | `3cc899c2cdbf1d353bbec93d94d2009b6431f6801102e8bad66e719727789b19` |
| `SKILL.md` | 3023 | `109952f0a1bb941c08a1106ca3b6e93cee96fdf62ff0dba0abe81fda7419e9a1` |
| `THIRD-PARTY-LICENSES.txt` | 543446 | `ace64aed355d2d39aa50cbde7194f613782acc836b8923402cbf76854e77cd1b` |
| `THIRD-PARTY-PACKAGES.json` | 60144 | `df6b69d6466290edf1d666e8c3bbff7da632e52e3ee0b20e983efdb8002186d2` |
| `THIRD_PARTY/apache-2.0.LICENSE` | 11357 | `b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1` |
| `THIRD_PARTY/claw-hwp.LICENSE` | 1066 | `479bb036c12f061ebba4ce47ca19ad1e23deffbac6dee534c8afeb6691b670e7` |
| `THIRD_PARTY/hml-equation-parser.LICENSE` | 11357 | `b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1` |
| `THIRD_PARTY/hml-equation-parser.txt` | 1536 | `0c461b7f454f62b215e95cdea38ef39713a3c7b6dafe2abd008afbdce0605c71` |
| `THIRD_PARTY/opendataloader-pdf.txt` | 1258 | `ab7eb9a62db6aa7164eadace902eed97eceb0103ee6a6638720042b286df2d0b` |
| `THIRD_PARTY/pix2text.txt` | 814 | `bfb54ee17d23a5429fabbf568d5e12767b96c4428df8c11b250a4384ada217e4` |
| `THIRD_PARTY/rhwp-forms.txt` | 1841 | `1d7d83b98004a56ced6d8518f70785fa58066e7ca36b56c93384da636fb04395` |
| `extensions/formula/package-lock.json` | 36034 | `54983b56a5ee021a88c04da7e417e0316133e3be14e441ada42c2ea6f619fd0e` |
| `extensions/formula/package.json` | 147 | `8a02235a8b7b34fad551fde8d05f2edf20a21293ac991535b5cf7d6cfd0a8e4c` |
| `extensions/ocr/package-lock.json` | 8229 | `b9a2f5e2c6bded6e6f1ae2ab75bda1d1ae861feee958ae0a0d77c2d53ac7fa94` |
| `extensions/ocr/package.json` | 135 | `0e648214e7b5e713fc31e0595732df1a0a9f94ae62d8bc3e762f0acd14e4fb93` |
| `extensions/pdf/package-lock.json` | 9195 | `8320f80995ede06614b9a018c2e632b39c414acd668cf0b16f81ea3a75a69959` |
| `extensions/pdf/package.json` | 162 | `11da233047b3e7317145e9116eb1dcbcecba115a1f9f2467a1921778445900c3` |
| `extensions/print/package-lock.json` | 33230 | `0d43c27beb6e5cd77b9344e72fe28259de1ca4c095dea49ac9035e1d331a858e` |
| `extensions/print/package.json` | 136 | `6005cbbb7254f5d5c0c12ebd1f8e7830eb4939a0616484c8f89aa3718ba28a3b` |
| `extensions/raster/package-lock.json` | 20190 | `dd1ff108e12c895f22986b665aa2d4f09f3be34dd6f70c5c7e30e0f7ebe26ed9` |
| `extensions/raster/package.json` | 127 | `b5105428ba25b52dd0fe193c76651ed23f8c4e79160915b736cff785e7c20dc0` |
| `references/engine-api.d.ts` | 121514 | `99254e08f49934a4ca37f8e6fdcea5675f3c6dba8976177ac4798c3a57956a89` |
| `references/gongmunseo.md` | 2027 | `769b97a8a02aaed77202fe27f595aee7b18d00a56cf50fc53e13a9654d5ca8f3` |
| `references/hanmark.md` | 1351 | `25682f1ce3f0388939e02c06c07d226ae41dd91a2c4a2ca07684b18924f47b0b` |
| `references/operations.md` | 4122 | `21a3bf91de60aa2668b9180be80745ec6c564774f29aa845fc2124e9aa0e33f1` |
| `references/template-pack-v1.schema.json` | 3416 | `dbaff72594520a756a53cc18dc6eafed6f5cbdc2b42985dbfb63e235699e568b` |
| `references/templates.md` | 2270 | `8a13f5024b13b7f8ab866b9412fb51ee0fd69e914e04964e7ab5f99d56ea6568` |
| `scripts/chunk-3T6O35FL.mjs` | 2092 | `31c53fcbf0b4fe4b486bfbaa8dfd72c2ee679c1bc3114a3bcf1874fb0a54e9fb` |
| `scripts/chunk-4KEIBFBR.mjs` | 375774 | `67e95ed71e1b3fc4bff1e48ad0843c83b760f100c75fb57920be88f720b0b733` |
| `scripts/chunk-ACW76YWF.mjs` | 84857 | `066f3c6b7fe0f6336e5578d5c52da7d50e6a966bc575d32f3e8e3644e596a790` |
| `scripts/chunk-AN7BM5RT.mjs` | 427 | `764fbebcb55f713fd71072c61f76dec93459ff617a342e5bb3505a0c213b7415` |
| `scripts/chunk-HW7SKSEC.mjs` | 40128 | `47ebe8c5ce494b464d3a62c6280853bdf1c33937e37461c585655724f07f529e` |
| `scripts/chunk-IF2FUB7X.mjs` | 9776 | `1bad58282b74b993b1e21b393b22381b6f72056c1c38615c2ffe0fe76f6bf581` |
| `scripts/chunk-NVQKGGHQ.mjs` | 2163826 | `dfdc96506bc8b6c14aed84f60c50f7dab4561ab1f31741596255833a03a23e95` |
| `scripts/chunk-PZTNOUTU.mjs` | 8027 | `8d7903ec77d45edf16cc9aae97ff41fae42ba09aedcb7595688b7ff52e2d046e` |
| `scripts/chunk-VJBJ2GTC.mjs` | 5790 | `ffe4d498d812ecab2c7cacf694d3eb7b9f8055065a343da07e178de0de4b3341` |
| `scripts/chunk-WT3MK4B4.mjs` | 2025 | `7aa782ed6489af105a016fb762d0ce1420bf9ff264ef11396c198d8903e2e311` |
| `scripts/extensions.mjs` | 343124 | `5df956bc3be7979d4c7448c8c0777aa22860c83516c4cb1f8416fc08881e1a46` |
| `scripts/formula-DAMFHLQO-LDM2NI7S.mjs` | 26065 | `5f8b0f379116689acacf5f384e7a7f366b0f2761bb8ab9e3676fdba9cc4024a7` |
| `scripts/hanmark-FAJO3LAV.mjs` | 5207 | `a4a2d4a330c4e8fad206d4bdcf84041c7fcee6597e5926ad014b0ecd9ecf1b9d` |
| `scripts/image-ocr-VH54SDZ7-F4MAU2QI.mjs` | 5105 | `a0d77cb150e432893b175fd027c998e7e35f75cec6965c51acce63770c915d78` |
| `scripts/install.mjs` | 3384 | `ae771a4a7f88fa9f2aa3ec3a073b9fe41431efc10b3fb664bcfa0d5a8a44b29c` |
| `scripts/launch.py` | 2699 | `133ae67f5851c8db1ac5ec4a303dcbeb8c4500d0ce0e0f8a1666f5158b4f9691` |
| `scripts/model-prepare.mjs` | 15075 | `02ce88a80c0590e13d12ab9ce28a3185a7157dcffe2593769f0971ef7a19268b` |
| `scripts/page-range-M5SRB2WK-P7SYKK4R.mjs` | 385 | `a78ccaac53099fa5c26a398ac5581d57bdd5d504e0d0f23b3adbc2f7db164053` |
| `scripts/parser-Z6PHB54O-PKRA3MAX.mjs` | 155335 | `acb7e18a3126597c0d3253a5f6299b611980df016d81d63818be65821001a709` |
| `scripts/pdf-ocr-JI3K7JIN-FFRWHHTW.mjs` | 554 | `c4bb59ff5e2a31f8f9b251e6ad0d5cb3b95c91e2e7094614546e42dec9f1905b` |
| `scripts/run.mjs` | 23000 | `fe02a8815eb46d2d174870f4e24f4245b23578f961a4623e4edd6e043c5e9425` |
| `setup.ps1` | 1533 | `6ab9fb18761e8f4c8134a5f8932144dee0e16d36c8d8c1afb0a7686c42166e8a` |
| `setup.sh` | 1825 | `bbdd04bb84dc74d5a6eba070c6dad423b82d9a7bae1bd9d494462f05f5491163` |
| `templates/간이기안문_서식.hwpx` | 7261 | `2b58ef61f74a58126e125841d3850c5769bb642e29d3a2e9e3fb67cf5c58ee29` |
| `templates/간이기안문_예시값.json` | 542 | `8313e3a59c03ceaa1815313e992b0f2005abadb27e321fae7c43724e98971a61` |
| `templates/일반기안문_서식.hwpx` | 6871 | `7d40e770a018ae571ab10b5745376b03fd5ffa65fceaf5cce0d87cd0e4d4f437` |
| `templates/일반기안문_예시값.json` | 1149 | `883afe5af8d134731dbb5a276e0d263e6a511d6165d608c9faee8f5538d1f55f` |

# R17 readability implementation

The user approved the comparison's four priorities: restore semantic hierarchy,
give navigation names more room, separate neutral chrome from reading surfaces,
and restore concise context for resuming work. Pretendard Variable and current
project/browser/document functionality remain the baseline.

Evidence baseline:
`research:rr-cdbf7d528fbd60cc288d7dab7a3fdf20:dba1a9501bd023beaac36d1d86150df0c12f54c5fab6782bf84d0a0e7de61ac6`.
Implementation plan:
`research:rr-cdbf7d528fbd60cc288d7dab7a3fdf20:0a6bc9210fb643b3fe3451ff8cd3b096d4508d9a5a770336647dd28d520c4cc8`.

## Changes

- Upright emphasis remains visible in neutral palettes; H3 and H4 differ in
  size and spacing. Explicit heading colors and conversation preferences apply.
- Navigation names use 14px/500, project names 600, metadata 13px, and the window
  context title 15px/600. Splitting panes no longer shrinks conversation text.
- Grouped session rows omit repeated kind labels and empty disclosure slots.
  The accessible label still identifies chat, document AI or web AI. The parent
  project gets a location cue distinct from selected content.
- Document format badges and chat/web icons identify mixed tabs without an
  extra generic kind word. Project and child-agent distinctions remain.
- Light chrome is neutral #F3F5F8 with #202733 primary and #4E5968 secondary
  text; selection carries blue. Dark chrome retains its existing colors.
- Home and project overview display the existing session result/state and link
  directly to it. Running/approval/error context takes precedence over an older
  answer. No model summarization or extra transcript fetch is involved.

## Validation and installation

- Web TypeScript check passed; 34 existing/targeted tests passed, including the
  added stale-answer/current-status case. Frontend build passed.
- Actual Linux WebKitGTK: home, project, light/dark chat and 1000px-wide layout
  captured with isolated fixture data. A controlled HTML specimen checks semantic
  typography. No real model invocation or private transcript in these images.
- Selected session name width: **125 → 187px** in the same 288px sidebar.
  Main navigation now computes to 14px; primary text #202733, secondary #4E5968
  on #F3F5F8. Secondary contrast is **6.51:1**.
- H3 computes to 19.125px versus H4 17px; upright em is 550 versus body 400.
  Dense-pane selectors retain the 17px reading preference. Home's resume action
  opens the exact session; parent project location and selection remain distinct.
- Initial capture collection stopped because its helper assumed an expanded
  sidebar section on home. The corrected collector tolerates absent sections;
  product code/build were unchanged and the batch passed. This was a harness
  issue, not a product failure.
- Independent source review found two edge cases, both addressed: tab text and
  background now use paired chrome roles even under a bright custom reading
  palette in dark mode; coarse-pointer home/resume targets are at least 44px.
  Independent review of the six rendered screens found no blocking defects.

Screens and measurements:
[before/after viewer](previews/2026-11-11-readability-implementation/comparison.html).
Review uses the selected Impeccable typeset/manual and Hallmark existing-app
workflow; no automated whole-site score or all-OS execution claim.

Installed and launched on this laptop as **readability-context-20261111**, based
on 0.4.1, from commit `f1900a997580080b7c33eda2db22823d842c59f9`. The served
frontend matches SHA256
`69402eaca2cb6e02cabefbb78526b261ebb15b85357cd99b5119721d377cc004`.
All **9 sessions and 341 conversation items** remain; original item rows are
unchanged. Native/host binaries and the existing office/design resources were
preserved. The app is running in window 42.

Receipt: `~/.local/opt/achmage-workbench/WORKBENCH-INSTALL.json`.
Rollback: `~/.local/opt/achmage-workbench.previous-20261111-readability`.
The SQLite backup remains local in `.hallmark/readability-fix/install/`.
Final research:
`research:rr-cdbf7d528fbd60cc288d7dab7a3fdf20:fbfd14b83253e875762a71de4e6fdfecfa82b66289ef1cdf1c1ec0ffd623c83e`.

Windows/macOS and physical 125% rasterization are outside the Linux DPR1 fixture
check. Coarse-pointer CSS was exercised as a controlled rule/cascade probe, not
on touch hardware. This is a local patch, not a new published GitHub release.

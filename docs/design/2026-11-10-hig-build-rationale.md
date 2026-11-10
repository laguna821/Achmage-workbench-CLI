# HIG remake implementation rationale

Medium: React/Tauri desktop web on Linux, Windows and macOS; normal platform window controls remain. The user explicitly replaced the old branding contract and selected Pretendard Variable. Source revisions are pinned in DESIGN.md. No new installer is part of this visual implementation pass.

## Decisions

- Project ownership is the primary navigation axis. Mixed website/chat collections made ownership hard to recognize, so the single tree groups typed children and directly opens project YAML overview. [HIG transfer] `layout/visual-hierarchy/group-related-items-to-clearly-express`.
- Central Search/Ask reduces decisions needed before starting. Browser page chat opens as a full-height inspector. Native page control remains connected to the actual page. [HIG transfer] `design-principles/simplicity/include-just-whats-necessary`.
- Shared neutral controls leave room for documents and long answers. Engine identity remains in labels/icons. Existing default looks migrate; custom preferences survive. [HIG] `branding/best-practices/ensure-branding-always-defers-to-content`.
- 1/2/4/9 layout choices expose existing pane capability and preserve tab identities. Optional dense overview, enlargement and a real host-backed handoff form make parallel work discoverable. [House] exact grid sizes; [HIG transfer] progressive disclosure `layout/visual-hierarchy/use-progressive-disclosure-to-make-layouts`.
- Offline Pretendard, Lucide, 4px rhythm and 720px reading width follow the selected skill's House contract. Native Apple system typography is deliberately replaced by the user's font. React adapters use the HIG Kit CSS/behavior patterns; upstream imperative JS does not mutate React-owned nodes.

## Craft choice

Compared (1) old branded engine surfaces with new controls, (2) full floating/translucent chrome, and (3) neutral project navigation and solid reading surfaces with restrained controls. Chose 3: consistent orientation with less competition around the content; glass remains limited to transient navigation where appropriate. `materials/liquid-glass/dont-use-liquid-glass-in-the`.

## Check scope

The working UI now uses the shared foundation across home, project navigation, chat, browser chrome, settings/search and nine office format adapters. Web/root/office TypeScript checks passed; focused tests cover preserved layout/tab identities, appearance migration, conversation queue/stop, image loading/gallery focus, reading position and office chrome/content isolation. The root added one regression for an actual sticky-band resize feedback loop found in the integrated preview.

Chromium light/dark fixtures passed 50/50 integrated checks, including real host handoff submission/history and image file loading/enlargement. After text-size/context-toolbar polish, the affected preview passed 22/22 checks. The offline font loaded. At 200% root text size the context toolbar adds rows instead of overlapping; a 744px window uses the compact sidebar drawer. Visual comparison selected the simpler home with recent projects over the persistent overview toolbar.

The HIG audit was reviewed, not treated as an automatic accessibility certification. Its RGB-only background parser skips CSS `color(srgb ...)` returned by color-mix and can report the modal backdrop as the search text background; it also measures checkbox artwork instead of its clickable label and the intentionally narrow keyboard-resizable dividers. These results are distinguished from the actual layout, target and contrast corrections. Code remains monospace by design. This pass does not establish complete accessibility or native Windows/macOS acceptance.

The review artifact and exact final research revision are in `2026-11-10-hig-remake-result.md`. No installer was built or installed in this phase.

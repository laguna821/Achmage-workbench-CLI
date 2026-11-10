# Apple HIG product remake — current user correction

Authority: session 01a187dc-c850-7991-93c0-aa60b50f9a26, 2026-11-10. The user rejects retaining the old brand-led skin and asks for a complete Apple HIG component/UX remake before another installer build. Default typeface: Pretendard Variable. This explicitly supersedes the earlier plan's assumption that the old DESIGN.md visual tokens must be retained.

Baseline research: research:rr-da5ca50fa3e6593f1a243cce69cc5ed7:36aff60113a7574e1b41bb9ce53999de1ae9a325cde9fe73abf3304c122323f7. Browser corrections remain in the working tree; installer compilation was interrupted, and no installation, publication or cross-OS CI dispatch occurred.

## Design contract
- Apple HIG is the design authority; Aside and the user's screenshots specify desired flows. HIG transfer to Tauri/web on Linux/Windows; macOS keeps normal OS window controls. No fake Mac traffic lights.
- Neutral layered white/gray and dark surfaces, restrained system blue for actions. No provider-specific brand wash, pink/navy reading canvas, serif defaults or decorative glow. Content and edit canvases retain their own authored formatting.
- Pretendard Variable bundled offline. Desktop controls follow the macOS scale (13/15/17/22/26); long conversation reading uses 17px as an explicit readability choice. 4px spacing scale, 28px pointer targets, 44px coarse-pointer targets, readable light/dark/high contrast and reduced motion/transparency.
- One simple sidebar, predictable project/chat/document/web distinction; advanced navigator layouts remain available. Project selection directly opens overview. No duplicated permanent navigation columns by default.
- One centered Search/Ask starting surface; Ask uses main work session, Search opens a real web tab. A web page has a compact address toolbar and a collapsible full-height AI inspector. No manual control grant UI. Browser repair implementation must be preserved.
- Chat content first: neutral user message, continuous assistant reading, concise progress/tool disclosure, input at bottom; independent editor/page AI remains independent.
- Use the skill's HIG Kit source for reusable controls and surfaces; React owns state/events. Existing command/session/data handlers stay connected. No static facade or omitted functions.

## Ownership and execution
1. Root: DESIGN.md, foundation CSS/appearance migration, HIG Kit and fonts, reusable React controls/icons, home/Search/Ask, browser chrome, App integration, preview and one necessary integrated check.
2. Shell implementer: Sidebar/navigation, project overview and tab components; dedicated styles/hig-shell.css. No App.tsx, appearance.ts or styles.css edits.
3. Conversation implementer: Composer/Transcript/WorkView and shared dialog/settings chrome; dedicated styles/hig-chat.css. No root/agent-owned files.
4. Office implementer: apps/office UI chrome/adapters and shared editor UI skin only. Preserve document contents, engines, bridge and independent AI; no vendor source edits.

Each implementer fully reads apple-hig-design/SKILL.md and relevant references, implements real UI, and reports affected surfaces. No per-feature builds, releases or repeated broad reviews. Root integrates before final build. Use focused tests only for changed behavior; inspect actual rendered light/dark/compact layouts. Cross-OS native browser workflow is retained for the integrated implementation, not dispatched early.

## Completion
Reviewable working frontend (not only a plan): home, sidebar/project, chat, tabs, browser, dialogs/settings/search and embedded editor UI share the new system; live handlers intact. Design rationale cites existing HIG rules and names any House decisions. Record actual preview/check scope without claiming unrun OS acceptance. The next installer build waits for this integrated UI work.

## User clarification implemented

- Project YAML is the ownership level. Chat, web AI, document AI and files remain separate typed groups.
- 1/2/4/9-pane presets reuse the existing pane tree. Reducing the layout preserves tabs; each pane can enlarge and return. Dense panes keep the reply visible and disclose composer controls on input focus.
- Work connections use the existing request/reply handoff API. The new dialog selects the source and destination session and displays the resulting handoff history.
- Inline uploaded/tool/assistant images retain the existing captured-file pipeline and open a keyboard-accessible gallery. Long answers, code, tables, loading/error states and reader position are included in the conversation scope.
- The compact sidebar is a dismissible drawer without changing the user's desktop sidebar preference. Home shows a central entry and recent projects; the full work overview is disclosed on demand.

## Implementation status

All four ownership tasks are integrated in the working tree. Focused type/behavior checks and rendered evidence are listed in `docs/design/2026-11-10-hig-remake-result.md`. The implementation changed the product UI, not only the plan. No new installer, local application replacement, release upload or cross-OS native acceptance is claimed by this phase.

Current implementation evidence: `research:rr-3fd22e3257c5026ce96b909f97309c9d:be31f89e0d27742e2eac6018a832de9308fb39efbfc728ed563727e33ca4b29e`. Review captures: [light/dark gallery](../../design/previews/2026-11-10/index.html).

## Hallmark / Impeccable finish result

Current implementation and bounded OS acceptance: [design finish result](../../design/2026-11-10-design-finish.md). Exact R8/R9 revision: `research:rr-d444ad1fc3329b8db7a04a08c16d9489:4eb15dcba62ba1bdcf3021d233f0cf3da4fa537d0431cb166765efb5e05adaad`. The design-finish phase did not publish or install an installer; earlier plan statements above describe their original point in time.

# U07 role/profile UI

Implemented in the 0.4.0 worktree after the first candidate. Parent-owned host/contracts/API changes are separate; no additional agent, provider invocation or remote write was used.

## Product behavior

- Existing conversations have a named role selector in the composer. Built-in and custom choices come from `api.agentProfiles()`; incompatible engine profiles are hidden and a null provider follows the conversation. Selection writes only `updateSession(id, {profileId})` and normal session events supply the selected state.
- The small role editor creates/updates reusable name, optional engine, model ID, reasoning effort, access and instructions. Discovered IDs/efforts are suggestions, with direct text entry available. No model IDs are invented. Save uses the displayed profile revision; errors retain the draft. Delete asks in the editor and calls the revision-checked host API; the host clears all session references while admitted request snapshots remain unchanged.
- WorkView shows the role's effective model/effort/access unless the session has an explicit value. ModelPicker marks inherited model values with **역할** and offers return to role defaults. Choosing a model or effort is explicit. The current engine is not changed by choosing or editing a role.
- ModelPicker remains available with empty or failed discovery. **모델 ID 직접 입력…** opens a form dialog, preserves composition input and submits the exact trimmed ID. Refresh never replaces an existing custom ID. Discovered choices retain menu semantics; the direct-entry surface uses dialog semantics.

## Files and ownership

`components/AgentProfilePicker.tsx`, `WorkView.tsx`, `ModelPicker.tsx`, their two component test files and `styles/agent-profiles.css` / `styles/model-picker.css` are this task's product files. App, Transcript, attachments, API, contracts, host, workflow and version files are not changed by this UI task.

## Focused verification ledger

```sh
npm exec -- vitest run apps/web/src/components/AgentProfilePicker.test.tsx apps/web/src/components/ModelPicker.test.tsx --maxWorkers=2
```

First run: ten tests passed; two failed. Exact causes: placing datalist options inside their label polluted the accessible label of the profile model input; the inherited model suffix had no separating text space. Datalist options were moved outside labels, and a text space was added to the model suffix. Only those two cases ran again: profile creation passed; the inherited name still failed because the inline suffix's boundary space is trimmed in accessible-name computation. The model button now has an explicit accessible label including its role source. Only that remaining case is rerun; passing tests are not repeated.

Parent owns the final combined type check and build. No additional review, performance or browser matrix is started here.

The isolated role-default test then reached its explicit-effort action and exposed another whitespace assumption in its selector (`높음 기본` versus the existing MenuItem's flattened `높음기본`). That selector now identifies the actual option by its leading label; the production control is unchanged for this correction.

Final focused result: all 12 selected behaviors pass across the original run and failed-case-only corrections. The last command was `npm exec -- vitest run apps/web/src/components/ModelPicker.test.tsx --maxWorkers=2 -t 'shows role defaults'`: one passed, six skipped. No successful behavior was rerun after its passing result.

## Remaining UX scope

- Roles are selected for an existing session; pre-session defaults are unchanged.
- Saving a new role makes it reusable; the user selects it separately in the conversation. Editing a selected role updates its next-request defaults.
- A role for another engine can be saved, then selected from a compatible conversation; editing never switches the current conversation's engine.
- Native OS IME, real provider model discovery, concurrent windows and native screen rendering were not exercised here. Component tests cover failed discovery, stale revision errors, composition state, saved ID preservation and exact API calls.

Context: `context-d1077008653a4d619ef12bddaafefe79`.
Exact material revision read: `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:762b9d19046923479d7e3b10c61e85158e9e8bcf00de93504b81a78798f9d08e` (R24–R26). R25 implementation priority remains in force; original labels and previous conclusions are preserved.

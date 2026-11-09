# U20 workspace service UI

Date: 2026-11-09. Scope: the delegated workspace service UI and API client wiring. Host/contracts are root-owned (`2462057`). This report does not declare the entire U20, mobile, proxy, or release matrix complete.

## Implemented

- WorkspacePicker exposes **서버·실행 관리…** for the selected workspace. App and WorkActions open the real dialog and route service output through the existing TerminalView navigation.
- The user supplies an exact command, label and optional port. The dialog shows host and cwd, explains PORT versus a command's own port option, and prevents new starts in archived/removed workspaces or without the terminal runner.
- Starting/running/stopping/exited/interrupted/error records show their command, host, cwd, time, port and error. Browser links are constructed only from a valid running service port as `http://127.0.0.1:PORT`, using the existing external-browser helper. The arbitrary returned URL is not used.
- Stop sends the selected record's exact `{ownerId, terminalId, startedAt}`. Output fetches the recorded terminalId and verifies workspace and creation identity before using the existing terminal surface. An inactive record can be removed after an inline confirmation; its terminal/output is retained by the host contract.
- Drafts and in-flight request payloads persist per host/workspace in sessionStorage. Before POST, the pending request is stored. Lost responses trigger a list reconciliation by service id = requestId. If still unknown, fields remain bound to that request; explicit retry performs another read before sending the identical request. Reopening never starts a command automatically. Explicit 4xx rejections remain visible and unlock the draft for correction.
- List reads run serially at a 3-second interval, do not replace input drafts or action errors, and discard reads made before a later mutation. Modal focus uses the native dialog and existing surface-focus restoration.

## Focused evidence

Ran once:

`npx vitest run apps/web/src/components/WorkspaceServices.test.tsx`

Result: **4 tests passed**, 1 file passed, 894 ms. Covered exact command and port, duplicate-submit suppression, draft retained across polling, loopback link construction, stop/output identity, lost response reconciled without another POST, unresolved receipt retained across reopening and observed before same-ID retry, rejected port editing, and inactive record-only deletion confirmation. No failures or repeated runs.

No production build, installer CI, broad suite, additional typecheck, performance gate, or live user-data/process access was performed for this unit. Root's existing host evidence remains separate. User correction to integrate remaining requirements before a full build/release governs this work.

## Context and ownership

The current execution rule and U20 section were read from `docs/superpowers/plans/2026-11-09-workbench-integrated-release.md`. Context `context-65ba192699894102b0a03dbe6d3cefa0` lacked relevant U20 evidence; its missed outcome was recorded. Bounded research preparation supplied the exact revision read before implementation: `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:fb76a28f44c3dbf717a6aee28d89790d4677707904b2b9829dcd5edd1a4cb89c` (R24–R30 policy/evidence introduction). Current parent instructions and source contracts governed the concrete service flow.

Owned changes: WorkspaceServices component/test/style, four new Api methods/import, and minimal App/WorkActions/WorkspacePicker wiring. No host, contracts, plan, version, workflow, vendor, original vault, or live DB writes.

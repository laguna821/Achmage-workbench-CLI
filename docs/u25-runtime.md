# U25 runtime boundaries

The runtime uses the existing host.lock owner, SQLite Store, session/task journal, document
execution leases and owned PTY/service supervisor. It does not add another daemon or terminate
unowned processes.

The client sends `x-workbench-protocol` with major/minor and the supported additive wire-schema
range on every HTTP request. The authenticated host evaluates this handshake before dispatching
any write; `/api/protocol` also exposes the full negotiation result. An incompatible major, a
client minor newer than the daemon, or disjoint schema ranges rejects a write with
`protocol_incompatible`. The client remembers the returned descriptor and rejects known
incompatible writes locally too. The same descriptor is exchanged during protected device
authentication and checked again at DeviceGateway before both direct and HTTP-proxied writes.
This is compatibility checking, separate from device authorization.

Headerless 0.3.x/local IPC callers have an explicit legacy 1.0/schema0 descriptor. This release
retains their additive payload contract and existing smoke calls. Headerless traffic is not
silently assigned the newest protocol. Product schema0 and schema1 are both supported by 1.1;
the SQLite on-disk schema version is independently guarded by `PRAGMA user_version`.

`POST /api/host/update` with the exact current `instance` and `action: prepare` starts drain.
New work is refused; pending results, approvals, saves and lease completion may finish. The
status includes session/native tasks, queued work, unsaved document views, Office execution
leases and owned terminals (including workspace services). `action: cancel` resumes admission
and the existing scheduler. `POST /api/host/stop` supports `mode: drain` only when those blockers
are gone. Existing explicit stop-all IPC retains `mode: interrupt` and records interrupted or
unknown work before closing the existing providers. No request is automatically replayed.

Installer entry point is `workbench-service.mjs prepare-update`. It verifies the saved/live owner,
prepares drain, and stops the same host only if no blocker remains. Exit 0 means stopped and
ready; 20 means active work and installation must stop; 21 means ownership, compatibility or
shutdown could not be confirmed. A remaining host.lock is never treated as proof of shutdown.
The old host must support the preparation endpoint; otherwise the user closes its work and
host explicitly. There is no forced-PID or arbitrary-app termination fallback.

Before a Store schema or derived-search migration, SQLite `VACUUM INTO` creates a coherent
backup including committed WAL contents in the local data directory's `backups/` folder.
The folder is 0700, backup is 0600, and SQLite quick_check must succeed before migration starts.
A future `user_version` is rejected through a read-only connection before journal or table writes.
To restore, stop the exact owned host, preserve the failed database and its WAL/SHM together,
and replace the database using the recorded backup with a compatible binary. Restore is never
automatic and never runs over a live database. No human vault source is rewritten.

Implementation owner did not execute tests, builds, external providers or installer commands.
`apps/host/src/update-policy.test.ts` prepares the two new critical compatibility/backup scenarios
for the root's single integration check. Installed Windows/macOS and true upgrade/drain UX remain
integration acceptance work; preparing this code is not a claim those environments passed.

Source context `context-818fa6ccdb674d9ba0540c00a93f0f9e` and original plan research
`research:rr-0b42f53d2a049398bbf5a5c07c18266f:3c3cbe2fbb6979b57bafcbc9851e54112d02ea4662f7afc6c9fc48b81c2335b0`
were read as evidence. Current implementation-first/no-repeated-check user instructions govern
this owner pass.

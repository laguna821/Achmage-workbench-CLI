# Provider child task reuse

Paseo source from https://github.com/getpaseo/paseo at
`1fff127f45b11c1c9c573fbbd12791673004c912` is Apache-2.0 licensed.
The accompanying LICENSE preserves the original license. Exact original files are retained
under `vendor/paseo/server/upstream/provider-children/`. `source.json` records original and
adapted hashes. Only type import ports change in the selected upstream runtime files.

The original ClaudeTaskProtocolSource owns task filtering, task/tool aliases, nesting and
presentation. The accompanying model manifest is used for original subtitle formatting;
it does not replace Workbench's live provider model catalog. Workbench supplies scope,
current provider generation, SDK run identity, command receipt, approval and lifetime ports.

Codex controls use the already integrated official app-server transport and generated
thread/turn schemas. Reads verify the original parent relationship and workspace. Steer
uses expectedTurnId, interrupt uses the exact child turn, and an explicit new message uses
thread/resume and turn/start with the existing Workbench PKM/write guard at the child's cwd.
The child keeps its own original model settings. No parent-model message simulates control.

Claude controls call the installed official SDK's stopTask and targeted backgroundTasks.
The SDK does not expose a direct send/steer call to a selected child; those capabilities
are not advertised. Local SDK subagent transcripts and verified live sidechain frames are
shown separately from the parent response. An engine exit leaves uncertain work unknown;
replayed history is not live authority or a new completion notification.

No new suite, provider call, review, build or installer was run by this owner for this change.

# Hallmark finish review — app polish

Fresh-context reviewer: `hallmark_finish_review`. Locked contract: `docs/design/DESIGN.md`.

Initial response was `recapture` because current 1440px/375px captures were missing. Supplied both widths, light/dark, with the compact sidebar closed. The actual review returned **fix**, three findings, no redesign request.

| Finding | Change | Recapture disposition |
| --- | --- | --- |
| Compact toolbar clipped settings at the edge | Secondary controls moved into existing overflow. Layout choices use inline disclosure to respect the one-popover rule. | Resolved: all essential actions and overflow fit in 375px. |
| Compact composer consumed four control rows | Access/model/target settings join the existing Tools disclosure; attachment/voice/send/stop keep one row. | Resolved: composer takes about 140px instead of about 250px in the approval fixture. |
| Approval decisions split across unrelated controls | Trust setting gets its own row; Decline and Allow stay in one group. | Resolved: grouped decisions in light and dark. |

Final reviewed artifacts: `.hallmark/finish-final-375/chromium-{light,dark}-{01-home,03-work-codex}.png`.
Desktop scenes and actual Markdown editor: `.hallmark/finish-confirm-desktop/` plus `.hallmark/finish-final-editor/` for the corrected dark-editor selector.

Hallmark source/render output is retained raw locally. Curated `.hallmark/triage.json` explains parser false positives and explicit product-contract exceptions; no fabricated zero-FAIL result. Impeccable automatic context engine was not run; its OS-documented direct-context fallback was used.

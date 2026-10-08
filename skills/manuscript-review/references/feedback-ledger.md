# Feedback ledger

Use a CSV when an external review has enough distinct requests that discussion alone makes coverage hard to follow. Keep it in the manuscript project beside the review materials, outside the app library. Reuse the project's existing ledger and columns when they serve this purpose. The agent maintains the file; the app continues to hold only source comparisons, decisions, and discussion.

For a new ledger, this header is sufficient:

```csv
id,source,feedback,status,response,review_id,discussion_ids
```

Give each actionable request a stable ID, such as `R1-M03`, and identify its source by review file, reviewer, and page or section. Preserve enough of the request in `feedback` to judge whether it was handled. Split independently actionable requests into separate rows; a later clarification keeps the original ID.

Use these statuses:

| Status | Meaning |
| --- | --- |
| open | No proposal or disposition yet |
| proposed | A reviewable change or response has been prepared |
| accepted | The author accepted all changes or responses needed to resolve the request |
| deferred | Left for a later pass, with the reason in `response` |
| declined | Deliberately left unchanged, with the reason in `response` |

The `response` field records what changed, why the existing text was retained, or what remains to be done. `review_id` and `discussion_ids` link to the app round and its discussion entries. When an item spans several passages or rounds, retain the earlier links and append new ones; use semicolons within a field for multiple IDs. A single passage explanation can cite several feedback IDs.

Before editing, read the review and reconcile its actionable requests with the ledger. After preparing a comparison, record the relevant discussion IDs from the agent command output and mark the affected ledger rows proposed. Deferred or declined requests need no artificial manuscript edit. During later iterations, read the saved decisions and replies before updating those rows. Acceptance refers to the author's review decision; applying the selected wording to files remains a separate app action. Partial acceptance leaves the row proposed, with the remaining work in `response`. If rejection or a manual revision leaves no proposal that resolves the request, return the row to open or record an explicit deferral.

Write valid UTF-8 CSV using a CSV writer so commas, quotation marks, and line breaks remain intact. Verify that every actionable review item has a row and that each proposed row points to its change or response. Do not manufacture reasons for old changes whose provenance is unclear, or mark a proposed change accepted on the author's behalf.

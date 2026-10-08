# Advanced usage

## Exports and imports

**Review tools → Export feedback** saves the decisions, current comments, and discussion as JSON. **Export selected patch** saves the selected source changes as a Git patch. An agent with the installed skill can read the library directly; exports also provide a record to inspect outside the app.

To add responses manually, choose **Review tools → Import responses** and select a JSON array:

```json
[
  {"id": "discussion-…", "text": "Response text", "title": "Optional title"}
]
```

Use `discussion_id` for a current comment or `id` for a saved discussion in the feedback export. Importing a response retains the original comment, appends the reply, and clears a current comment's field for a follow-up. Reimporting the same response does not duplicate it.

**Library → Import review** copies a saved review folder. It requires the original manuscript repository at its saved absolute path, with the review's pinned Git versions available. A review folder alone does not transfer a manuscript to another person's computer. To share proposed wording, send a patch or push the manuscript revision for them to compare in their own library.

## Source writes and recovery

Applying choices writes the selected source as unstaged changes. Saving source writes only your manual changes, preserving unedited working text exactly. Review decisions elsewhere take effect when you apply the review. Source writes check the working contents, HEAD, and staging so that outside edits are not overwritten. If a write is refused, inspect the working changes before preparing another comparison.

Earlier source and review records are retained, and a durable journal records interrupted manuscript writes. Recovery proceeds only when each affected file still matches its previous or intended contents and there are no staged changes. External conflicts leave the journal available for inspection.

If an agent or another window updates the review, the open window offers **Reload review**. It retains conflicting local input under the review folder's `conflicting-drafts/` before reloading. The current record keeps the other window's saved work; the retained files make the local input available for manual reconciliation.

The runtime reads one current record format. The explicit migration command and scripts in `migrations/` upgrade older libraries while retaining their original records. Quit the app before running a migration; release notes identify any required upgrade.

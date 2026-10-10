# Parallel proposals

Use this workflow for requested revisions while the author keeps working. It needs no completed decisions, applied selection, or saved author draft.

Read the assigned discussion and current source before editing:

```sh
"/path/to/skill/scripts/review-agent" feedback --review REVIEW_ID --thread THREAD_ID
"/path/to/skill/scripts/review-agent" begin --review REVIEW_ID --parallel
```

Begin returns `revision`, `starting_version`, and a unique `workspace`. That detached checkout contains the selected wording, including the author's rejections. It shares the manuscript's Git objects but leaves the author's checkout, index, and buffers untouched. Retain the returned values; edit and build only in this workspace. Respect repository instructions and stage any new source files. Unsaved author text is context, not source for this proposal.

After checking the changes, publish them into the current review:

```sh
"/path/to/skill/scripts/review-agent" finish --review REVIEW_ID --revision STARTING_REVISION --from STARTING_VERSION --workspace PROPOSAL_CHECKOUT
```

Finish merges your word changes with the current selected result, then updates the proposal against its fixed base. Different words in the same paragraph can merge. Unaffected decisions and discussion remain; new or changed edits are undecided. The same review ID is returned, and earlier source versions remain available. Verify its proposed version and diff, then reread scoped feedback and append the final response using the latest saved revision.

If finish reports overlapping changes, your checkout remains available and the review stays unchanged. Begin a fresh parallel proposal on the latest selected result, use the earlier checkout as a reference, reconcile the requested wording there, and finish with the new starting version. Do not retry against the old starting version or overwrite the author's source. A proposal containing changed binary or unsupported files is refused rather than silently omitting them; arrange those changes through the manuscript's Git workflow.

Apply remains the author's action. Agent results do not write into open source buffers or resolve discussion threads. A no-change proposal, including a repeated finish of an already incorporated result, is refused; use the existing review for a reply without source changes.

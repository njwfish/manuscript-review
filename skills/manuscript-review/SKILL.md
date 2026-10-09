---
name: manuscript-review
description: Open and annotate manuscripts in Manuscript Review for VS Code or the standalone app, prepare comparisons, integrate external reviewer feedback, read saved decisions and comments, and create follow-up revisions with responses. Use when the user asks to review manuscript changes in either interface or work through its saved feedback.
metadata:
  short-description: Work through saved manuscript review feedback
---

# Manuscript Review

VS Code is the primary interface. Its extension includes the review engine and agent commands; the standalone app is optional and uses the same records. Use these commands to preserve the author's decisions, source drafts, and discussion. Saved reviews live in `~/Library/Application Support/Manuscript Review` on macOS, or `~/.local/share/manuscript-review` on Linux unless `XDG_DATA_HOME` is set. The [README](../../README.md) describes the interfaces; read the [architecture](../../ARCHITECTURE.md) when changing the implementation.

## Find and read the review

Use the command launcher named in a copied agent request, or `scripts/review-agent` beside this skill, resolving its absolute path from the loaded `SKILL.md`. The launcher works from any directory. The extension retains its engine and Python path in VS Code storage; the standalone launcher uses its bundled runtime. A source checkout uses its `.venv`, or `MANUSCRIPT_REVIEW_PYTHON` when supplied. In the examples, replace `/path/to/skill` with this skill's actual directory:

```sh
"/path/to/skill/scripts/review-agent" list --repo /absolute/path/to/manuscript
"/path/to/skill/scripts/review-agent" feedback --review REVIEW_ID
```

Use the review ID named by the user or identify it from its repository and baseline/proposal labels. If several rounds fit, ask which round they mean. The output contains the saved revision number, Git source versions, edits and decisions, and discussion with replies. Each comment has a `thread_id` and `resolved` status. Address unresolved threads within the requested scope; resolved threads remain context unless the author selects one explicitly. Read the original feedback and earlier responses before editing, and respect rejected wording even when no comment explains it.

## Address feedback

Follow the manuscript repository's writing instructions and the user's requested editing scope. Treat existing prose as settled wording. A writing guide alone does not authorize rewriting it. Change only what the author’s feedback requires, preserving surrounding words and sentence structure wherever possible; broader rewriting requires explicit scope from the author. Let the user save or discard any active file draft before making changes to its working file. A request to inspect feedback does not authorize manuscript revisions or review decisions.

When first integrating external feedback, such as a referee report, read [Initial feedback](references/initial-feedback.md). Anchor each actionable point to a relevant manuscript quote before editing. Use the existing comment and response pattern: preserve the feedback in the comment, then reply after revising to explain what changed or why the wording was retained. Group requests that share a passage and reason; keep independent requests separate. Later iterations respond to these comments without importing the same feedback again.

For an external review with enough issues to need an inventory, read [Feedback ledger](references/feedback-ledger.md). Maintain that CSV beside the manuscript's review materials, reusing an existing ledger. A short review or a few app comments can stay entirely in the discussion.

If no review exists yet, use `open --repo /absolute/path/to/manuscript` before annotating or editing. For a comparison of changes already made outside the app, read [First comparison](references/first-comparison.md). Pin the actual working input before editing:

```sh
"/path/to/skill/scripts/review-agent" begin --review REVIEW_ID
```

Keep the returned `revision` and `starting_version`. Begin checks that reviewed files match the saved choices and that no file draft remains unsaved. If begin reports a mismatch, inspect the working changes and the review before proceeding. When the author authorizes applying saved choices, including through the app’s completed-review request, use:

```sh
"/path/to/skill/scripts/review-agent" apply --review REVIEW_ID --revision SAVED_REVISION
```

Reread feedback after applying and run begin with the current review. Otherwise, use **Compare saved changes** in VS Code, or **New round** in the standalone app, to compare the saved selection against the working files, then read that round’s feedback and begin with its review ID. Never bypass the check or overwrite outside edits. A copied request from an unfinished review asks for responses while the author continues deciding; defer source revisions until they finish.

Edit within the requested scope, run the manuscript’s build checks, and follow the repository’s branch and commit conventions. The app preserves source versions without changing Git HEAD or the index; it also works with ordinary commits on a local branch or PR. Stage new source files before finishing, since snapshots include tracked files and staged new files. Publish the revision using the values from begin:

```sh
"/path/to/skill/scripts/review-agent" finish --review REVIEW_ID --revision STARTING_REVISION --from STARTING_VERSION
"/path/to/skill/scripts/review-agent" feedback --review NEW_REVIEW_ID
```

Finish returns the new review ID, record path, edit count, and exact `starting_version` and `proposed_version`. Verify the diff between these versions contains the intended changes. The new round preserves the original baseline, earlier review, discussion, and resolution states; Git commits during the pass do not move its endpoints. A source-changing pass with no reviewable edits is refused. For replies without source changes, keep the existing round. Finish queues LaTeX previews for the interface to build when opened. Applying choices, pushing a branch, and merging a PR follow the author’s authorization and repository workflow.

Write replies as a JSON array in a temporary file:

```json
[
  {"id": "discussion-…", "text": "What changed, or why the wording was retained.", "title": "Optional short title"}
]
```

For a current comment in `comments`, use its `discussion_id`; for an entry in `history`, use its `id`. Source comments may refer to unchanged text or an author draft; read their original quote and context as well as the current file. After revising, reply in the new round using its feedback output and saved revision number. Identify the published source revision in the response and explain the change or why wording was retained. For replies without source changes, use the existing round and its latest revision. Keep working transcripts in the agent interface and append only the final response to the thread.

```sh
"/path/to/skill/scripts/review-agent" respond --review NEW_REVIEW_ID --revision NEW_SAVED_REVISION --responses /absolute/path/to/replies.json
```

Responding records the original note and appends the reply; a current note moves into discussion history and its comment field clears for a follow-up. Other comments and decisions stay intact, and repeated imports of the same reply do not duplicate it. A stale revision is refused: reread feedback and reconcile the intervening changes before retrying. Verify the command output contains the original comment and new reply. Do not edit `review.json`, infer IDs from file offsets, or bypass the revision check.

The author owns thread resolution independently of wording decisions. Replies, accepted changes, and new revisions do not resolve a thread. Change its status only when the author explicitly requests it, using the latest saved revision and `thread_id` from feedback. Each status change advances the saved revision; reread feedback before another write:

```sh
"/path/to/skill/scripts/review-agent" resolve --review REVIEW_ID --revision SAVED_REVISION --thread THREAD_ID
"/path/to/skill/scripts/review-agent" reopen --review REVIEW_ID --revision SAVED_REVISION --thread THREAD_ID
```

If a feedback ledger exists, update its affected rows after the pass using the status rules in its reference.

## Show the result

Return a VS Code link of the form `vscode://njwfish.manuscript-review/review/REVIEW_ID` with the actual new ID, or use **Manuscript Review: Open manuscript review** to select the round. **Reload review** refreshes an already-open round after importing comments or replies. Keep the same configured library when opening a result. **This round** shows the latest pass and **Since baseline** shows accumulated selected changes; **T** switches between them in focused review. **C** opens attached discussion and **Q** searches comments and saved exchanges, including notes whose edits disappeared. **Copy agent request**, or **R** in focused review, gives the author a prompt for their agent's chat. The interface retains only comments and responses.

When the author uses the standalone interface, open **Manuscript Review.app** with the available app tool, or run the source checkout's `.venv/bin/manuscript-review --review REVIEW_ID`. Its Library opens new rounds and retains the same discussion and baseline.

The standalone comment field can send a scoped request through an installed Codex or Claude Code CLI; VS Code sends it through the native provider extension. Use the exact library and command launcher named in that request. Keep the working transcript in the provider session and append only the final response with `respond`. Replies stay in the current round; source revisions must return the new round from `finish`. The author's active review remains open until they reload or select the new round.

To read and comment without requiring changes, use **Open manuscript review** in VS Code, **Library → Open manuscript** in the standalone app, or:

```sh
"/path/to/skill/scripts/review-agent" open --repo /absolute/path/to/manuscript
```

Opening resumes the latest review for that repository; a new manuscript starts with matching comparison endpoints and a pinned baseline. In VS Code, the author edits native source documents, selects text and presses **⌘/Ctrl+Shift+M** to comment, then saves and uses **Compare saved changes** before copying an agent request. **⌘/Ctrl+Alt+[ / ]** steps through unresolved native threads; **Manuscript Review: Comment navigation → All** in the Command Palette also includes resolved threads. **Resolve comment** and **Reopen comment** use the native thread toolbar. **View change** opens the attached diff. The standalone app’s editor uses **⌘/Ctrl+Shift+[ / ]** for comment navigation, with the same **Unresolved / All** filter and **Resolve / Reopen** controls. Source comments use the same begin, finish, and respond operations above.

To start a comparison in VS Code, use **Compare manuscript versions** and pick commits or saved checkpoints. **Clone manuscript from GitHub** opens the cloned folder; **Fetch manuscript history** updates remote history without merging. The standalone app provides these operations through **Library → Compare versions**.

For a library outside the default location, put `--home /absolute/path/to/library` before the subcommand. A copied request includes the review’s saved path; derive the library directory from that path when necessary. Test write operations in an isolated library rather than on the user's live review.

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

Use the review ID named by the user or identify it from its repository and baseline/proposal labels. If several rounds fit, ask which round they mean. The output includes `workspace`, the actual source checkout to edit, the saved revision number, Git source versions, edits and decisions, and discussion with replies. Each comment has a `thread_id` and `resolved` status. Address unresolved threads within the requested scope; resolved threads remain context unless the author selects one explicitly. Read the original feedback and earlier responses before editing, and respect rejected wording even when no comment explains it.

## Address feedback

Follow the manuscript repository's writing instructions and the user's requested editing scope. Treat existing prose as settled wording. A writing guide alone does not authorize rewriting it. Change only what the author’s feedback requires, preserving surrounding words and sentence structure wherever possible; broader rewriting requires explicit scope from the author. A request to inspect feedback does not authorize manuscript revisions or review decisions.

When first integrating external feedback, such as a referee report, read [Initial feedback](references/initial-feedback.md). Anchor each actionable point to a relevant manuscript quote before editing. Use the existing comment and response pattern: preserve the feedback in the comment, then reply after revising to explain what changed or why the wording was retained. Group requests that share a passage and reason; keep independent requests separate. Later iterations respond to these comments without importing the same feedback again.

For an external review with enough issues to need an inventory, read [Feedback ledger](references/feedback-ledger.md). Maintain that CSV beside the manuscript's review materials, reusing an existing ledger. A short review or a few app comments can stay entirely in the discussion.

If no review exists yet, use `open --repo /absolute/path/to/manuscript` before annotating or editing. For a comparison of changes already made outside the app, read [First comparison](references/first-comparison.md).

For requested source revisions, read [Parallel proposals](references/parallel-proposals.md). This is the default for comment dispatch and copied requests: pin the selected source in an isolated checkout, make the requested changes there, and finish into the same review. The author can keep reviewing or editing, including with unsaved drafts. Begin returns the exact `starting_version` and `workspace`:

```sh
"/path/to/skill/scripts/review-agent" begin --review REVIEW_ID --parallel
```

Edit only in that returned workspace. Keep the canonical repository path for library identity. Follow its Git workflow and build checks; stage new source files before finishing. Publish using the values from begin:

```sh
"/path/to/skill/scripts/review-agent" finish --review REVIEW_ID --revision STARTING_REVISION --from STARTING_VERSION --workspace PROPOSAL_CHECKOUT
"/path/to/skill/scripts/review-agent" feedback --review REVIEW_ID
```

Clean changes accumulate as undecided edits in the current review against its fixed base. Finish preserves existing decisions, comments, drafts, earlier source versions, and other agent results; overlapping changes are refused for reconciliation in a fresh proposal checkout. The author's working files and buffers remain untouched until Apply. Replies without source changes use the same review. For an explicitly requested separate revision round after a settled review, read [Revision rounds](references/revision-rounds.md). Applying choices, pushing a branch, and merging a PR follow the author's authorization and repository workflow.

Write replies as a JSON array in a temporary file:

```json
[
  {"id": "discussion-…", "text": "What changed, or why the wording was retained.", "title": "Optional short title"}
]
```

For a current comment in `comments`, use its `discussion_id`; for an entry in `history`, use its `id`. Source comments may refer to unchanged text or an author draft; read their original quote and context as well as the current file. After revising, reread feedback for the latest saved revision. Identify the published source revision in the response and explain the change or why wording was retained. Keep working transcripts in the provider session and append only the final response to the thread.

```sh
"/path/to/skill/scripts/review-agent" respond --review REVIEW_ID --revision SAVED_REVISION --responses /absolute/path/to/replies.json
```

Responding records the original note and appends the reply; a current note moves into discussion history and its comment field clears for a follow-up. Other comments and decisions stay intact, and repeated imports of the same reply do not duplicate it. A stale revision is refused: reread feedback and reconcile the intervening changes before retrying. Verify the command output contains the original comment and new reply. Do not edit `review.json`, infer IDs from file offsets, or bypass the revision check.

The author owns thread resolution independently of wording decisions. Replies, accepted changes, and new revisions do not resolve a thread. Change its status only when the author explicitly requests it, using the latest saved revision and `thread_id` from feedback. Each status change advances the saved revision; reread feedback before another write:

```sh
"/path/to/skill/scripts/review-agent" resolve --review REVIEW_ID --revision SAVED_REVISION --thread THREAD_ID
"/path/to/skill/scripts/review-agent" reopen --review REVIEW_ID --revision SAVED_REVISION --thread THREAD_ID
```

If a feedback ledger exists, update its affected rows after the pass using the status rules in its reference.

## Show the result

Return the review ID and published source version. Clean agent results refresh an idle review automatically; **Reload review** is available while the author has active input. A VS Code link of the form `vscode://njwfish.manuscript-review/review/REVIEW_ID` opens that review. Keep the same configured library. **This round** shows changes against the round's fixed base and **Since baseline** shows accumulated selected changes; **T** switches between them in focused review. **C** opens attached discussion and **Q** searches comments and saved exchanges, including notes whose edits disappeared. **Copy agent request**, or **R** in focused review, gives the author a prompt for their agent's chat. The interface retains only comments and responses.

When the author uses the standalone interface, open **Manuscript Review.app** with the available app tool, or run the source checkout's `.venv/bin/manuscript-review --review REVIEW_ID`. Its Library opens new rounds and retains the same discussion and baseline. Manual saves update the current proposal against the fixed starting draft. **Review tools → Open editing folder** opens the bound source checkout; the browser interface copies its path.

Both interfaces dispatch comments through an installed Codex or Claude Code CLI. Use the exact library and command launcher named in that request, and `feedback --review REVIEW_ID --thread THREAD_ID` to read only the assigned discussion and its file edits. The app launches no provider tabs. Source revisions accumulate in the current review through `begin --parallel` and `finish --workspace`; final responses use `respond`.

To read and comment without requiring changes, use **Open manuscript review** in VS Code, **Library → Open manuscript** in the standalone app, or:

```sh
"/path/to/skill/scripts/review-agent" open --repo /absolute/path/to/manuscript
```

Opening resumes the latest review for that repository; a new manuscript starts with matching comparison endpoints and a pinned baseline. In VS Code, the author edits native source documents, selects text and presses **⌘/Ctrl+Shift+M** to comment, then sends a comment or copies an agent request while continuing their work. Native saves refresh the same comparison against its fixed starting version, retaining unrelated choices and discussion. **Open editing folder** opens its source checkout for normal Git and LaTeX work. **Compare saved changes** captures external revisions as a new round. **⌘/Ctrl+Alt+[ / ]** steps through unresolved native threads; **Manuscript Review: Comment navigation → All** in the Command Palette also includes resolved threads. **Resolve comment** and **Reopen comment** use the native thread toolbar. **View change** opens the attached diff. The standalone app’s editor uses **⌘/Ctrl+Shift+[ / ]** for comment navigation, with the same **Unresolved / All** filter and **Resolve / Reopen** controls. Source comments use the same begin, finish, and respond operations above.

To start a comparison in VS Code, use **Compare manuscript versions** and pick commits or saved checkpoints. **Clone manuscript from GitHub** opens the cloned folder; **Fetch manuscript history** updates remote history without merging. The standalone app provides these operations through **Library → Compare versions**.

For a library outside the default location, put `--home /absolute/path/to/library` before the subcommand. A copied request includes the review’s saved path; derive the library directory from that path when necessary. Test write operations in an isolated library rather than on the user's live review.

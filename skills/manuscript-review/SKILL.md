---
name: manuscript-review
description: Open and annotate manuscripts, prepare comparisons in the Manuscript Review app, integrate external reviewer feedback, read saved decisions and comments, and create follow-up revisions with responses. Use when the user asks to review manuscript changes in this app or work through its saved feedback.
metadata:
  short-description: Work through saved manuscript review feedback
---

# Manuscript Review

The app and its agent commands share the review library, so use them to preserve the author's decisions, source drafts, and discussion. Saved reviews live in `~/Library/Application Support/Manuscript Review` on macOS, or `~/.local/share/manuscript-review` on Linux unless `XDG_DATA_HOME` is set. The app's [README](../../README.md) describes the interface; read its [architecture](../../ARCHITECTURE.md) when changing the implementation.

## Find and read the review

Use the executable at `scripts/review-agent` beside this skill, resolving its absolute path from the loaded `SKILL.md`. The launcher works from any directory and uses the app's bundled runtime or the source checkout's `.venv`. In the examples, replace `/path/to/skill` with this skill's actual directory:

```sh
"/path/to/skill/scripts/review-agent" list --repo /absolute/path/to/manuscript
"/path/to/skill/scripts/review-agent" feedback --review REVIEW_ID
```

Use the review ID named by the user or identify it from its repository and baseline/proposal labels. If several rounds fit, ask which round they mean. The output contains the saved revision number, Git source versions, edits with their source context and decisions, current comments with source context, and earlier discussion with replies. Read both current notes and earlier exchanges before editing; a decision to reject an edit also matters when no comment explains it.

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

Reread feedback after applying and run begin with the current review. Otherwise, use the app’s **New round** to compare the saved selection against the working files, then read that round’s feedback and begin with its review ID. Never bypass the check or overwrite outside edits. A copied request from an unfinished review asks for responses while the author continues deciding; defer source revisions until they finish.

Edit the working files within the requested scope and run the manuscript’s relevant build checks. Stage any newly created source files before finishing; snapshots include tracked files and staged new files. Save the pass as a new review round using the values from begin:

```sh
"/path/to/skill/scripts/review-agent" finish --review REVIEW_ID --revision STARTING_REVISION --from STARTING_VERSION
"/path/to/skill/scripts/review-agent" feedback --review NEW_REVIEW_ID
```

Finish returns the new review ID, record path, and edit count. Verify that the new round contains the intended changes. It compares the pinned starting draft to your revised working files, preserves the original baseline and earlier round, and attaches earlier discussion where possible. Git commits during the pass do not move these endpoints. A source-changing pass with no reviewable edits is refused; investigate the comparison rather than treating it as complete. For replies without source changes, keep the existing round. Finish queues LaTeX previews for the app to build when opened. Do not apply pending choices unless the user asks for that.

Write replies as a JSON array in a temporary file:

```json
[
  {"id": "discussion-…", "text": "What changed, or why the wording was retained.", "title": "Optional short title"}
]
```

For a current comment in `comments`, use its `discussion_id`; for an entry in `history`, use its `id`. Source comments may refer to unchanged text or an author draft; read their original quote and context as well as the current file. After a revision pass, reply in the new round using its feedback output and saved revision number. For replies without source changes, use the existing round and its latest revision. Keep each reply specific to the comment and distinguish completed changes from unresolved points.

```sh
"/path/to/skill/scripts/review-agent" respond --review NEW_REVIEW_ID --revision NEW_SAVED_REVISION --responses /absolute/path/to/replies.json
```

Responding records the original note and appends the reply; a current note moves into discussion history and its comment field clears for a follow-up. Other comments and decisions stay intact, and repeated imports of the same reply do not duplicate it. A stale revision is refused: reread feedback and reconcile the intervening changes before retrying. Verify the command output contains the original comment and new reply. Do not edit `review.json`, infer IDs from file offsets, or bypass the revision check.

If a feedback ledger exists, update its affected rows after the pass using the status rules in its reference.

## Show the result

Open the installed **Manuscript Review.app** with the available app tool, or run the source checkout's `.venv/bin/manuscript-review --review REVIEW_ID`. Use the Library to open a new round; **This round** shows the latest pass and **Since baseline** shows accumulated selected changes. **T** switches between them. Reload an already-open review after importing comments or replies. Use **C** for the attached discussion and **Q** to search current comments and saved exchanges, including notes whose edits disappeared. **Copy agent request**, or **R**, gives the author a prompt to paste into their agent’s chat; the app itself retains only comments and responses. The README lists editing and decision shortcuts.

To read and comment on an entire manuscript without requiring changes, use **Library → Open manuscript**, or:

```sh
"/path/to/skill/scripts/review-agent" open --repo /absolute/path/to/manuscript
```

Opening resumes the latest review for that repository; a new manuscript starts with matching comparison endpoints and a pinned baseline. **Manuscript** in the comparison selector opens all supported text sources. The author selects text and presses **⌘/Ctrl+Shift+M** to comment, saves manual edits, then uses **Copy agent request** or **⌘/Ctrl+Shift+R** from the editor. Use the discussion arrows or **⌘/Ctrl+Shift+[ / ]** to step through comments across files. **View change** opens the attached diff. Source comments use the same begin, finish, and respond operations above.

To start a comparison, use **Library → Compare versions**: choose a local folder or clone a GitHub repository into a chosen folder, then select commits or saved checkpoints from the two version dropdowns. **Fetch latest commits** updates remote history without changing working files.

For a library outside the default location, put `--home /absolute/path/to/library` before the subcommand. A copied request includes the review’s saved path; derive the library directory from that path when necessary. Test write operations in an isolated library rather than on the user's live review.

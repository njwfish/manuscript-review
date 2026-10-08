# Manuscript Review architecture

The native app hosts one Python service and one web interface. All application code lives in `manuscript_review/`; there are no repository-specific wrappers or alternate implementations. The runtime uses Python's standard library.

## The review record

Each library entry owns one `review.json` with schema version 5. It contains the original baseline, round comparison, selected result version, conceptual decisions, current notes, discussion history, expected working-file hashes, metadata, source drafts, and navigation preferences. Files under `renders/`, `baseline-renders/`, and `comparisons/` are disposable caches; `versions/` holds records preceding source changes. Patch and feedback exports are generated from the current record.

| Primitive | Meaning |
| --- | --- |
| Source version | A reachable Git commit created without changing HEAD or the index |
| Round | A starting draft, proposed draft, and selected result, linked to the preceding review |
| Baseline | The fixed source version from the first round of a comparison |
| Edit | A continuous replacement, with spans in the starting draft and proposal |
| Passage | The complete source context enclosing one or more edits |
| Decision | Accept or reject one edit; absence means undecided |
| Discussion | A user or agent note, its original context and source versions, and append-only replies |
| Source draft | Retained passage text, patched independently with the content revision |
| Source span | A character interval mapped conservatively between source versions |

Diff opcodes describe exact source reconstruction; they are internal to a comparison. Decisions use visible edit IDs. An edit's ID depends on its file, baseline span, and proposed text, so changing another passage does not renumber it. A passage ID depends on its file and baseline span. Neither is a substitute for a persistent discussion ID.

Current notes remain editable. Replying to a current note records it in discussion history and clears its input for a follow-up. When a new round or a passage revision supersedes their edit, they become discussion records. Their text, context, and replies remain intact even when there is no corresponding new edit. Responses address exact discussion IDs and append replies; importing the same reply again does not duplicate it. Attachments are derived from source spans and can change without changing the message.

Agents can also create a discussion entry directly against a passage or edit. Initial explanations of external feedback use this operation; iterative review uses replies. The same record fields hold both, with explicit `author` attribution. Explanation imports preserve editable user notes and decisions, use the same revision check, and deduplicate by author, round, target, and text. The UI displays relevant agent notes from the current proposal beside the diff, and keeps earlier notes in discussion. External feedback inventories belong in agent-maintained project files, not the app record.

## Source changes

`editing.py` projects decisions onto source. The Python service and the small, pure `review_model.js` client module implement the same selection rule, checked against shared fixtures. Undecided edits keep proposed wording; rejected edits keep the round’s starting wording. A missing file is distinct from an empty file.

Saving a passage replaces that passage in the proposal, creates a pinned Git version, and recomputes its file's comparison against the round’s fixed starting draft. The author's new changes are accepted. Decisions elsewhere survive; affected notes become discussion. There is no manual-replacement overlay or separate revision ledger. Ordered edit segments locate the passage in the validated working file even when text repeats or earlier choices have been applied. Only that span is replaced. Other passages retain their exact working source, even when their review decisions select different wording. Applying the review writes the full selected result explicitly. Typeset previews are regenerated from the new source version.

## Transactions

`ReviewSession` coordinates operations; HTTP handlers route requests. `ReviewStore` owns persistence. Follow-up rounds compare the previous selected draft to a new proposal, keeping the original baseline separately pinned. Their identity includes both endpoints, the original baseline, the previous review ID, and its saved revision. The previous record remains unchanged. `result` is a reachable Git version of the projected decisions; note-only saves reuse it. **Since baseline** derives a read-only comparison from the original baseline to that result.

`repositories.py` owns repository discovery, readable Git history, cloning, fetching, and working-copy capture. Agent **begin** pins the actual working input, validating reviewed files against the saved selection. **Finish** requires that input checkpoint and the unchanged review revision, then rejects an empty source-changing pass. Commits made between these operations do not change their comparison endpoints.

Derived cumulative comparisons cache immutable version pairs and mapped discussion separately from the canonical record. Their computations release the record lock so reviewing can continue. Word diffs, source mapping, and LaTeX highlights share exact token alignment. It preserves identical prefixes and suffixes and anchors long changed interiors with unique shared tokens before aligning the gaps.

Every mutation of review content requires the expected revision while holding a process and thread lock. Passage draft saves patch one draft; navigation saves cannot replace drafts. A passage revision refuses to invalidate another saved draft’s location. A stale request is retained under `conflicting-drafts/` and refused. Reloading or quitting a stale window retains its latest local input there before continuing. UI preferences save independently from the content revision. The client serializes content writes and blocks navigation or source application while any draft patch remains unsaved.

Record replacement uses a unique temporary file, `fsync`, atomic rename, and directory synchronization. A manuscript write also holds a repository lock and checks HEAD, staging, safe paths, and expected contents before writing anything. The previous record and source contents are retained. A durable transaction journal records all intended file writes and the resulting review record before the first manuscript write. Startup and subsequent operations finish an interrupted transaction only when each file still matches its old or intended new contents. Intervening external changes leave the journal and draft available for recovery.

`application.py` owns these file checks, `versions.py` creates pinned source commits, and `previews.py` serializes background compilation. Requests arriving during compilation cause the worker to render the latest source next. A renderer publishes its manifest only if both comparison endpoints are still current; round and cumulative previews have separate manifests. Preview failures leave source review available. Render context uses exact source spans to distinguish repeated equations or algorithms.

`setup.py` reports local prerequisites and installs the bundled skill by linking it into the selected agent’s personal skills directory. Existing paths are never replaced. This setup stays separate from manuscript and review persistence.

Library cards group records by manuscript repository and show rounds in chronological history. Applied status is derived from the saved source hashes and selected wording; notes and replies do not reset it.

The app reads only schema 5. The explicit migrations in `migrations/` port retired records and preserve byte-exact originals. The v2 upgrade retains selected manuscript content and leaves the checkout and Git index unchanged. The v3 upgrade adds user attribution to existing discussion; the v4 upgrade moves source drafts out of navigation preferences. These preserve discussion IDs, notes, replies, decisions, and review revisions, and validate the library before replacing canonical files. Migrations are never imported by the service.

## Verification

Run `python3 -m unittest discover -s tests -v` from this directory. Tests cover exact reconstruction, absent and empty files, passage regeneration, retained notes and replies, stale writes, interrupted transactions, external edits, source anchors, client projection, modifier shortcuts, library operations, and LaTeX highlighting. Verify actual compilation and packaged startup when changing those boundaries.

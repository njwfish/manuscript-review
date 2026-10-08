# Manuscript Review architecture

VS Code is the primary interface. Its extension bundles and starts the Python review service, hosts focused comparisons and PDF review, and uses the native editor and comments for manuscript work. The standalone app remains another interface to the same service and review records. Shared review operations live in `manuscript_review/`; VS Code adapters live in `vscode/`. The Python runtime uses its standard library.

## The review record

Each library entry owns one `review.json` with schema version 6. It contains the original baseline, round comparison, selected result version, conceptual decisions, current notes, discussion history, expected working-file hashes, metadata, source drafts, and navigation preferences. Files under `renders/`, `baseline-renders/`, and `comparisons/` are disposable caches; `versions/` holds records preceding source changes. Patch and feedback exports are generated from the current record.

| Primitive | Meaning |
| --- | --- |
| Source version | A reachable Git commit created without changing HEAD or the index |
| Round | A starting draft, proposed draft, and selected result, linked to the preceding review |
| Baseline | The fixed source version from the first round of a comparison |
| Edit | A continuous replacement, with spans in the starting draft and proposal |
| Passage | The complete source context enclosing one or more edits |
| Decision | Accept or reject one edit; absence means undecided |
| Discussion | A user or agent note, its original context and source versions, and append-only replies |
| Source draft | Retained file text and its pinned selected source version |
| Source span | A character interval mapped conservatively between source versions |

Diff opcodes describe exact source reconstruction; they are internal to a comparison. Decisions use visible edit IDs. An edit's ID depends on its file, baseline span, and proposed text, so changing another passage does not renumber it. A passage ID depends on its file and baseline span. Neither is a substitute for a persistent discussion ID.

Current notes remain editable. Replying to a current note records it in discussion history and clears its input for a follow-up. When a new round or a passage revision supersedes their edit, they become discussion records. Their text, context, and replies remain intact even when there is no corresponding new edit. Responses address exact discussion IDs and append replies; importing the same reply again does not duplicate it. Attachments are derived from source spans and can change without changing the message.

Comments on arbitrary source selections use the same discussion records, with `kind: source`. Their anchors pin the exact captured editor text, including an unsaved draft, without writing manuscript files. The original anchor and context remain immutable; attachment to later edits is derived separately. A user-written root comment is editable until a response arrives; imported feedback retains its original wording. A follow-up is another ordinary discussion entry with the same origin ID, preserving the preceding exchange.

Agents can also create a discussion entry directly against a passage or edit. Existing diff explanations use this operation. Initial external feedback imports exact source quotes through the same source-comment operation as the editor; revision passes append replies to those comments. The same record fields hold both, with explicit `author` attribution. Explanation imports preserve editable user notes and decisions, use the same revision check, and deduplicate by author, round, target, and text. The UI displays relevant agent notes from the current proposal beside the diff, and keeps earlier notes in discussion. External feedback inventories belong in agent-maintained project files, not the app record.

## Source changes

`editing.py` projects decisions onto source. The Python service and the small, pure `review_model.js` client module implement the same selection rule, checked against shared fixtures. Undecided edits keep proposed wording; rejected edits keep the round’s starting wording. A missing file is distinct from an empty file.

`documents.py` derives the supported text files from the selected Git version. **Manuscript** presents this inventory through the existing editor, including unchanged files; the round comparison remains canonical. Opening a new manuscript pins the working version as both comparison endpoints, creating no artificial edits. Opening an existing repository resumes its latest saved record.

The file is the editing unit; passages and edits remain the review units; discussions can attach to them or any source selection. The editor starts from selected wording and retains a draft against a pinned source version. Saving compares that source with the edited file, expands manual changes that touch an existing replacement, and maps those intervals back to the proposal. If a manual change merges neighboring edits, their selected wording travels into the merged replacement. The updated proposal remains separate from unrelated rejected wording. New manual changes are accepted; unaffected decisions survive, and affected notes become discussion. The selected result must reproduce the editor text exactly before any manuscript write.

Source segments locate manual intervals in the validated working projection, including repeated text and choices applied earlier. Saving writes only those intervals. Unedited working text retains its exact contents even when the current review selects different wording. Applying the review writes the full selected result explicitly. Every source save creates a pinned Git version and refreshes the comparison against the round’s fixed starting draft; typeset previews follow that version.

CodeMirror owns text input, selection, undo, search, scrolling, and editor highlights. The small adapter in `frontend/editor.js` connects document changes to the existing review client. It owns no review persistence or manuscript writes. The bundle and dependency licenses are checked in; `npm run build` regenerates them without adding a runtime network dependency.

The VS Code preview uses its native source editor and CommentController. The same
`ReviewSession.editor` operation projects spans onto an exact external buffer without
saving it; offsets use UTF-16 for both editors. VS Code owns source saves, and the
existing library operation compares saved files as a new round. Decisions and comments
use the same record transactions as the standalone app. The extension host keeps service
tokens private, pins queued operations to their intended review, and passes requests
through `host.js` to the shared focused-review client. Navigation stays in webview state.
Apply checks unsaved repository buffers immediately before sending its queued transaction;
the review engine retains its source, revision, and Git checks. Comparing saved source
checks buffers both before flushing the focused panel and before creating the new round.

The extension's setup, repository comparison, library, Apply, response imports, and
agent workflow use the shared operations directly. Git comparisons select commits or
checkpoints through native pickers. Source drafts from the shared library can open as
untitled editor copies or be explicitly discarded; opening a copy leaves its saved
record and the working file intact. New editor drafts use VS Code's own buffer and
recovery behavior. Saved edits become a new round through the shared update operation.

The agent skill, command engine, and referenced guides ship in the VSIX. Setup reports
prerequisites without opening a review library, so its commands remain available for
explicit migrations. On setup or opening a review,
the extension copies its engine into a versioned directory in VS Code global storage
and refreshes one stable skill directory there. The skill launcher captures that engine
path and its Python interpreter and is published by atomic rename. Installed agent links target the stable directory;
earlier engine copies remain available through extension upgrades. Review data lives
in the review library, independently of extension storage. Agent result links select
an exact round through the extension's URI handler.

The extension discovers Python 3.12 or newer before importing the engine, skipping older
environments on the path. An explicit interpreter setting is validated and respected.
The engine service and agent commands use the resolved executable.

The extension bundles a pinned adaptation of LaTeX Workshop's PDF viewer. A separate
loopback server serves only its bundled static assets, with bounded paths and a restricted
content policy. VS Code resolves the client-facing URI before the webview pins its frame
origin. Manuscript PDFs remain on the private host bridge; the viewer cannot access the
review document or its controls. The server closes with the extension. Its parent
bridge supplies immutable comparison PDF bytes and the existing normalized change
bounds. An overlay maps those bounds through PDF.js viewports as zoom and rotation
change. The installed Workshop extension retains live compilation and SyncTeX; the
adapted viewer owns neither. Viewer sources, provenance, and notices live in `vscode/`.

## Transactions

`ReviewSession` coordinates operations; HTTP handlers route requests. `ReviewStore` owns persistence. Follow-up rounds compare the previous selected draft to a new proposal, keeping the original baseline separately pinned. Their identity includes both endpoints, the original baseline, the previous review ID, and its saved revision. The previous record remains unchanged. `result` is a reachable Git version of the projected decisions; note-only saves reuse it. **Since baseline** derives a read-only comparison from the original baseline to that result.

`repositories.py` owns repository discovery, readable Git history, cloning, fetching, and working-copy capture. Agent **begin** pins the actual working input, validating reviewed files against the saved selection. **Finish** requires that input checkpoint and the unchanged review revision, then rejects an empty source-changing pass. Commits made between these operations do not change their comparison endpoints.

Derived cumulative comparisons cache immutable version pairs and mapped discussion separately from the canonical record. Their computations release the record lock so reviewing can continue. Word diffs, source mapping, and LaTeX highlights share exact token alignment. It preserves identical prefixes and suffixes and anchors long changed interiors with unique shared tokens before aligning the gaps.

Every mutation of review content requires the expected revision while holding a process and thread lock. File draft saves patch one draft; navigation saves cannot replace drafts. Decisions in a drafted file cannot change its selected wording until the draft is saved or discarded. Drafts in other files remain independent. A stale request is retained under `conflicting-drafts/` and refused. Reloading or quitting a stale window retains its latest local input there before continuing. UI preferences save independently from the content revision. The client serializes content writes and blocks navigation or source application while any draft patch remains unsaved.

Record replacement uses a unique temporary file, `fsync`, atomic rename, and directory synchronization. A manuscript write also holds a repository lock and checks HEAD, staging, safe paths, and expected contents before writing anything. The previous record and source contents are retained. A durable transaction journal records all intended file writes and the resulting review record before the first manuscript write. Startup and subsequent operations finish an interrupted transaction only when each file still matches its old or intended new contents. Intervening external changes leave the journal and draft available for recovery.

`pdf_preview.py` reads the compiled PDF’s word bounds and the generated SyncTeX horizontal line boxes. Source spans select these regions, including repeated inputs on multiple pages; multiline math uses its enclosing equation. Matching source paragraphs to PDF words refines prose highlights; ambiguous macro output retains a region rather than assigning the wrong word. Empty spans use source-linked regions. The PDFs retain their original layout, with highlights drawn over vector page images in the interface. Rotated pages use their rendered dimensions and require unique literal text to refine a location; otherwise they show the source-linked page without a highlight. Full pages and excerpts publish independently, so a failed excerpt or source map leaves a successfully compiled PDF available. The renderer version invalidates only disposable caches.

`application.py` owns these file checks, `versions.py` creates pinned source commits, and `previews.py` serializes background compilation. Requests arriving during compilation cause the worker to render the latest source next. A renderer publishes its manifest only if both comparison endpoints are still current; round and cumulative previews have separate manifests. Preview failures leave source review available. Render context uses exact source spans to distinguish repeated equations or algorithms.

`setup.py` reports local prerequisites and installs the bundled skill by linking it into the selected agent’s personal skills directory. Existing paths are never replaced. This setup stays separate from manuscript and review persistence.

Library cards group records by manuscript repository and show rounds in chronological history. Applied status is derived from the saved source hashes and selected wording; notes and replies do not reset it.

The app reads only schema 6. The explicit migrations in `migrations/` port retired records and preserve byte-exact originals. The v2 upgrade retains selected manuscript content and leaves the checkout and Git index unchanged. The v3 upgrade adds user attribution to existing discussion; the v4 upgrade moves source drafts out of navigation preferences. These preserve discussion IDs, notes, replies, decisions, and review revisions, and validate the library before replacing canonical files. The v5 migration combines located passage drafts into full-file drafts against the same selected version and retains detached source drafts. The explicit agent `migrate` command validates the whole library before replacing records and archives their original bytes. Migrations are never imported by the service.

## Verification

Run `python3 -m unittest discover -s tests -v` from this directory. Tests cover exact reconstruction, absent and empty files, passage regeneration, retained notes and replies, stale writes, interrupted transactions, external edits, source anchors, client projection, modifier shortcuts, library operations, and LaTeX highlighting. Verify actual compilation and packaged startup when changing those boundaries.

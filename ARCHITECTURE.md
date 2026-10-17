# Manuscript Review architecture

VS Code is the primary interface. Its extension bundles and starts the Python review service, uses the native editor for focused source review and comments, with an optional synchronized PDF. The standalone app remains another interface to the same service and review records. Shared review operations live in `manuscript_review/`; VS Code adapters live in `vscode/`. The Python runtime uses its standard library.

## The review record

Each library entry owns one `review.json` with schema version 7. It contains the original baseline, round comparison, selected result version, conceptual decisions, current notes, discussion history, resolved thread origins, expected working-file hashes, metadata, source drafts, and navigation preferences. Files under `renders/`, `baseline-renders/`, and `comparisons/` are disposable caches; `versions/` holds records preceding source changes. Patch and feedback exports are generated from the current record.

| Primitive | Meaning |
| --- | --- |
| Source version | A pinned Git commit from repository history or a checkpoint captured without changing HEAD or the index |
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

Resolution belongs to the discussion origin. A current note’s origin combines its review ID and target ID, so a new round’s comment cannot inherit status from an earlier comment on the same passage. Sealed messages and explicit follow-ups retain their origin. The record stores its resolved origins once;
view and feedback operations derive status for every message in the thread. Replies,
wording decisions, source edits, and new rounds preserve that status. Resolve/reopen
uses the same revision-checked transaction as other content changes and does not write
source or create a source version. Earlier rounds retain their status at that point.

## Component ownership

| Component | Owns |
| --- | --- |
| Git and repository workflow | Source history, branches, commits, PR publication and merging |
| `ReviewSession` and `ReviewStore` | Author decisions, discussion status, validated writes and record transactions |
| `history.py` and `feedback.py` | Anchored messages, responses and exports of thread identity and status |
| `review_model.js` | Shared thread grouping and source selection rules |
| Native comments, source decisions and focused review | Rendering, navigation, filters and author actions through the session API |
| `dispatch.py` | One comment's canonical task and detached CLI handoff for both interfaces |
| VS Code dispatch adapter | Flush saved input, choose provider, dispatch through the shared service |
| `merging.py` and proposal operations | Merge disjoint source changes into one current proposal against its fixed base |
| Agent skill and commands | Reading feedback, making authorized revisions, publishing their diff and appending final responses |

The author selects wording and resolves issues. Agent providers retain working
transcripts; the review stores comments and final responses. The UI can navigate
unresolved threads independently of undecided source edits. Native comments use
VS Code’s resolved/unresolved state and display filters; source navigation has an
Unresolved/All picker. The standalone interface keeps the same filter beside its
comment arrows. Resolved discussions collapse and remain available to reopen.

Agents can also create a discussion entry directly against a passage or edit. Existing diff explanations use this operation. Initial external feedback imports exact source quotes through the same source-comment operation as the editor; revision passes append replies to those comments. The same record fields hold both, with explicit `author` attribution. Explanation imports preserve editable user notes and decisions, use the same revision check, and deduplicate by author, round, target, and text. The UI displays relevant agent notes from the current proposal beside the diff, and keeps earlier notes in discussion. External feedback inventories belong in agent-maintained project files, not the app record.

## Source changes

[Editing model](docs/EDITING.md) defines the source versions, transitions, save ownership, and delivery rules. `source_editing.py` is the pure saved-edit planner; `ReviewSession.capture_save` applies its plan.

`editing.py` projects decisions onto source. The Python service and the small, pure `review_model.js` client module implement the same selection rule, checked against shared fixtures. Undecided edits keep proposed wording; rejected edits keep the round’s starting wording. A missing file is distinct from an empty file.

`documents.py` derives the supported text files from the selected Git version. **Manuscript** presents this inventory through the existing editor, including unchanged files; the round comparison remains canonical. Opening a new manuscript pins the working version as both comparison endpoints, creating no artificial edits. Opening an existing repository resumes its latest saved record.

The file is the editing unit; passages and edits remain the review units; discussions can attach to them or any source selection. The editor starts from selected wording and retains a draft against a pinned source version. Saving compares that source with the edited file, expands manual changes that touch an existing replacement, and maps those intervals back to the proposal. If a manual change merges neighboring edits, their selected wording travels into the merged replacement. The updated proposal remains separate from unrelated rejected wording. New manual changes are accepted; unaffected decisions survive, and affected notes become discussion. The selected result must reproduce the editor text exactly before any manuscript write.

Source segments locate manual intervals in the validated working projection, including repeated text and choices applied earlier. The standalone editor writes only those intervals, preserving unedited working text even when the current review selects different wording. Native Save already writes the buffer; capture records it without another source write. Apply writes the full selected result explicitly. Every captured save pins its version and refreshes the comparison according to its intent. Standalone before/after previews follow the proposal; the native PDF follows selected wording.

CodeMirror owns text input, selection, undo, search, scrolling, and editor highlights.
The adapter in `frontend/editor.js` connects document changes to the review client;
it owns no review persistence or manuscript writes. The standalone client calls the
service’s HTTP endpoints directly. Its macOS wrapper provides clipboard and folder
actions and flushes saved input before reload or quit. The bundle and dependency
licenses are checked in; `npm run build` regenerates them without a runtime network
dependency.

The VS Code preview uses its native source editor and CommentController. The comment controller is registered on activation, independently of a comparison.
Its range provider stays empty to avoid a full-file gutter stripe; a sidebar preference disables
new-comment controls without disposing threads or replies. The service restores saved
comments for the active source checkout. A first annotation lazily opens the working
manuscript through the existing prepare operation, without a round picker or focused
review tab. The controller reads the current runtime through a getter so failed service
startup and review switches retain its native editors. Native thread identity includes
the review ID, source URI and discussion origin; carried discussion does not move an
unfinished reply into another round. Successful comment saves publish their wording
and revision locally before refreshing source anchors. The same
`ReviewSession.editor` operation projects spans onto an exact external buffer without
saving it; offsets use UTF-16 for both editors. VS Code owns source saves.
Native threads display a point marker at an adjacent paragraph break when available,
preferring the following break. The exact projected range remains separate for
navigation and replies; saved source anchors are unchanged. Navigation places the
caret at the original start without selecting the quoted passage. Native commenting
ranges stay empty to avoid a persistent stripe down the file; source annotation uses
the selection action, keyboard shortcut, and context menu. Without an adjacent break,
VS Code can still repeat its native glyph on wrapped rows.
Opening a discussion creates or resumes its draft in the existing sidebar. Saved
messages and margin markers remain native, read-only comment threads. `comments.mjs`
owns draft text and identity; `sidebar.js` owns input sizing, focus and keyboard handling.
Typing stays local and does not mutate saved messages. Submission uses the existing
note operation; failed writes retain the same input and anchor. A successful write
closes that input before background refresh, so a refresh failure cannot duplicate it.
Stale input IDs and comments from another review cannot submit into the current draft.
A focused review pauses for its comment input and resumes at the same edit on completion.
The return is pinned to that thread and input generation; reopening input, moving the
source cursor or editing cancels an older return before it can take focus.
`source-edits.mjs` captures ordered native saves through `ReviewSession.capture_file`
and refreshes the same comparison without replacing the buffer or taking focus.
Unsaved typing stays in VS Code. Decisions and comments use the same transactions
as the standalone app. The extension host keeps service tokens private and pins
queued operations to their intended review.

`native-review.mjs` owns source selection, keyboard focus, CodeLens decisions and
navigation. The source editor is the only text review surface. Native decisions use
the existing session save and delivery operations. Same-file navigation uses cached
exact projections and an index of edit IDs. Text validation follows the native document
version, including failed matches; projection updates invalidate the review index.
Cursor movement within an edit does not rebuild its CodeLens controls. Background
editor events cannot change the active source review. Review selection drains delivery
and saved source, invalidates queued native actions, then selects the next record. An interrupted mutation is never
replayed automatically.
Focused controls display the decision, navigation, comment and editing shortcuts.
An exact active span is outlined while surrounding source is dimmed. Native typing
leaves keyboard review; delivery-owned changes are identified by their exact expected
text while applying the WorkspaceEdit. Decisions retain their records but clear source
and PDF markup by default; reviewed highlights are an independent display preference.

`source-review.mjs` owns the native inline source diff. Its original document is a
read-only display copy that reverses undecided edits in an exact current projection;
the modified document is the real manuscript. Decisions make the corresponding
original and modified text agree. View transitions are serialized and invalidated by
ending review or changing comparisons. Native diff preferences are retained while
these views are open and restored when review ends without replacing later author preferences.

`pdf-panel.mjs` owns one optional webview with original and selected PDFs, stacked
in narrow panes and side by side in wide panes. Both retain round edit IDs. Each side
loads its PDF independently; selection repaints cached marks without compilation or
asset reads. Deleted and added words use red and green, with an outline on the
selected edit and subdued text outside its passage. Unmapped edits do not navigate
to another edit. A failed viewer load invalidates that side’s bytes for retry.
The selected preview cache compiles both immutable versions without page-to-SVG
conversion. Root discovery reads the selected Git tree, follows explicit root hints
and source includes, and falls back to a picker when inclusion cannot be resolved.
`/pdf-entry` changes only the rendering root; preview identities include it in every
scope. An already open matching Workshop PDF follows saved source through SyncTeX.

Apply checks unsaved repository buffers immediately before sending its queued
transaction; the engine retains source, revision and Git checks. Comparing saved
source checks buffers before creating the next round.

The extension's setup, repository comparison, library, Apply, response imports, and
agent workflow use the shared operations directly. Git comparisons show both endpoints,
repository, and PDF entry in the review sidebar. `sidebar.mjs` owns the view lifecycle
and derives display state; `comparison.mjs` owns staged version choices and request
construction. A field opens one native picker, and preparing that pair is explicit. Comparison
initialization has one owner; late sidebar reads cannot replace staged choices.
The open review remains intact while another pair is staged.
Native source highlights clear while that pair is staged, so they cannot depict a
different comparison from the sidebar controls.
An inspected checkpoint includes
its review ID and content revision; using it as the starting draft creates a checked
follow-up round through the existing prepare operation. Other Git starting versions
establish a new baseline. The focused view displays the actual pinned endpoints for
its current comparison scope. Source drafts from the shared library can open as
untitled editor copies or be explicitly discarded; opening a copy leaves its saved
record and the working file intact. New editor drafts use VS Code's own buffer and
recovery behavior. Write is the default window activity; Review explicitly enables its comparison surface.
`extension.mjs` owns that activity and derives the save intent from it. Activity requests
are pinned before setup starts; later requests cancel pending review navigation and PDF startup. Review refinements
keep the base fixed; ordinary authoring in Write advances the author base. There is no
separate intent picker. Returning to Write restores the source selection, closes the paired
PDF, and retains comments and decisions. The sidebar lists open threads from the comments
owner; both list selection and comment stepping use its existing source navigation. `source-edits.mjs` pins this intent
on the first dirty change and persists ordered saved points. Capture cursors acknowledge each file’s prefix without replaying committed saves. `native-review.mjs`
owns current-edit CodeLens controls and selection, while `delivery.mjs` owns every
native WorkspaceEdit, provenance stage, Save and Undo boundary. Explicit decisions
use that same delivery path; external revision
passes use the shared proposal operations to accumulate changes; separate rounds remain explicit.

`source-documents.mjs` opens native files for both comment navigation and focused
review. Missing files open through a read-only text content provider, with their
review ID, file path, and exact Git version in the document URI. The library's
`/source` operation reads that immutable text without changing the selected review
or its record. Existing native buffers take precedence, preserving unsaved work.
An open saved-source document retains its identity across decisions and file
restoration, keeping saved threads and sidebar drafts intact. Saved-source documents never
recreate files or enter source-save capture. Historical projection and follow-up
notes use the discussion's pinned context even when both current versions lack its file.

The agent skill, command engine, and referenced guides ship in the VSIX. Setup reports
prerequisites without opening a review library, so its commands remain available for
explicit migrations. On setup or opening a review,
the extension copies its engine into a versioned directory in VS Code global storage
and refreshes one stable skill directory there. The skill launcher captures that engine
path and its Python interpreter and is published by atomic rename. Installed agent links target the stable directory;
earlier engine copies remain available through extension upgrades. Review data lives
in the review library, independently of extension storage. Agent result links select
an exact round through the extension's URI handler.

Enter saves a comment and dispatches a task for the remembered Codex or Claude Code
provider; Shift+Enter inserts a newline. Both interfaces call the same revision-checked
`ReviewSession.agent_request` and `dispatch.py`. The process is detached immediately:
Codex uses `exec` with file-backed prompt stdin; Claude uses its native `--bg` command.
The library and common Git directory are supplied as writable directories. Provider
startup, login, and execution do not block the editor. Launch output is retained in
`agent-output/`; working transcripts belong to the provider. Launch receipts retain provider session handles; the app manages no conversations.

`Library.begin(parallel=True)` pins the selected result and creates a unique detached
proposal checkout. Pending decisions and retained author drafts do not block it.
`finish_parallel` captures that checkout and calls `ReviewSession.merge_proposal`.
Under the review and repository locks, `merging.py` merges incoming word changes
against the current selected result, then projects that delta into the raw proposal.
This preserves rejected changes elsewhere. New groups remain undecided, the review
ID stays the same, and earlier source versions are archived. Explicit version reviews
keep their base; source authoring carries saved author wording into its comparison base. Overlaps
and unsupported binary changes are refused before committing the record; the proposal
checkout remains available for reconciliation. Publication identity pins the starting commit and captured tree; repeating an
incorporated proposal preserves later author decisions. Publishing never writes author source;
native authoring delivery and explicit Apply own those writes. The existing explicit begin/finish workflow creates a
separate round when requested.

Native source saves and retained file drafts can continue from a source version that
predates an agent result. The same word merge preserves disjoint changes. Physical
source writes use exact review segments where available and verify mapped text for
older buffers, refusing ambiguous writes while retaining the draft. Source comments,
final responses, and thread resolution use the existing discussion operations.

The shared interface polls small status and preview endpoints. An idle view refreshes
an external result in place; dirty input, open dialogs, source editing, or intervening
navigation retain their state and offer a reload notice. Only the selected file and
files with current comments carry full source in interactive data; other files retain
edit identities and counts and load on demand. Record and library caches invalidate
on file metadata changes, and PDF/SVG transport caches include the source version.
These caches and response projections never replace the canonical record.

State-only saves patch explicit fields without copying the source comparison. The
store reuses its serialized snapshot while streaming one complete `review.json`
through the same durable atomic replacement. External record replacements invalidate
both caches. Archives remain complete records, and manuscript writes retain their
recovery journal. Comments whose captured text matches the selected source pin that
existing commit directly; unsaved and historical source still creates an exact checkpoint.

Native comment submission promotes the saved thread immediately and refreshes its
source and sidebar in the background. One `/agent` request checks the saved discussion,
enters authoring when requested, and returns a task for the committed revision. CLI
handoff follows that transaction; provider execution remains detached.

Interactive reads select their needed fields before copying the record. The sidebar
reads counts and comparison metadata; source projections read one file and its anchors.
Pinned Git sources have bounded session caches. Native typing reuses review data and
unchanged document projections, coalescing overlapping refreshes. Document versions
validate unchanged projections without rereading the buffer. `decorations.mjs` caches
word highlights per exact projection; navigation updates only focus shading,
using at most two continuous ranges at each opacity. Split editors share those values.
Native inline diff renders deleted source without adding it to the manuscript buffer
or Undo history. Focus and change marks use the same validated spans; empty deletions
use an adjacent visible glyph only for display.
A changed document version, review revision or loaded file invalidates the cache. Background reads wait
for prior writes without joining the write queue; review epochs and monotonic revisions
reject obsolete results. Record watchers read the small status endpoint rather than
parsing source records in the extension host. Git pickers open with cached choices and
refresh history in place. The standalone client builds collapsed context on demand and combines queued decisions
into the latest save. Native review serializes decisions and uses cached source spans
for navigation. Manuscript writes retain the same locks, revision
checks, durable record replacement, and recovery journal.

Comparison construction reads Git trees and blobs in bulk. Source enumeration
respects ignore rules, hidden and temporary directories, and nested Git boundaries
without filtering by file extension. Existing snapshots remain intact. Preview source
extraction and successful reference compilation are cached by exact source and renderer
versions. A malformed excerpt is isolated from other excerpts; a preamble failure
stops the batch without repeated compiler attempts. Native focus dims distant source; clicking source returns to typing. Standalone
focus collapses surrounding context; clicking the passage expands it. Write retains comments while clearing review display; Review keeps its deleted-text
and reviewed-change preferences.

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

`workspace.py` owns the source checkout used for editing. The record binds its
absolute `workspace` path and pinned `workspace_version` together. The latter records
physical source wording, which can differ from the proposal after choices are applied.
A matching checkout is reused; otherwise a detached Git worktree in the review’s
`source/` directory starts from its selected draft. The canonical repository remains
the library identity and Git object store. Imports discard local checkout bindings.
Source writes and their recovery journal use the bound checkout. Native captures read
saved bytes without writing source. Explicit version reviews keep their comparison
base; authoring comparisons carry new author wording into it. Captures map the
physical delta back into the proposal through the same manual-edit projection as the
standalone editor. Managed checkouts remain available for ordinary Git work; the app
does not delete an author’s files or commits.

`repositories.py` owns repository discovery, readable Git history, cloning, fetching, and working-copy capture. For a separate round, agent **begin** pins the actual working input and validates reviewed files against the saved selection; **finish** requires that checkpoint and the unchanged review revision. Parallel proposals instead pin the selected result and merge it against the locked current state, allowing intervening author and agent changes. Both refuse empty source passes. Commits made between begin and finish do not move the pinned input.

Derived cumulative comparisons cache immutable version pairs and mapped discussion separately from the canonical record. Their computations release the record lock so reviewing can continue. Word diffs, source mapping, and LaTeX highlights share exact token alignment. It preserves identical prefixes and suffixes and anchors long changed interiors with unique shared tokens before aligning the gaps.

Author content writes require the expected revision while holding a process and thread lock. Parallel proposal accumulation uses its immutable starting version and the locked current record. File draft saves patch one draft; navigation saves cannot replace drafts. Decisions in a drafted file cannot change its selected wording until the draft is saved or discarded. Drafts in other files remain independent. A stale author request is retained under `conflicting-drafts/` and refused. Reloading or quitting a stale window retains its latest local input there before continuing. UI preferences save independently from the content revision. The client serializes content writes and blocks navigation or source application while any draft patch remains unsaved.

Record replacement uses a unique temporary file, `fsync`, atomic rename, and directory synchronization. A manuscript write also holds a repository lock and checks HEAD, staging, safe paths, and expected contents before writing anything. The previous record and source contents are retained. A durable transaction journal records all intended file writes and the resulting review record before the first manuscript write. Startup and subsequent operations finish an interrupted transaction only when each file still matches its old or intended new contents. Intervening external changes leave the journal and draft available for recovery.

`pdf_preview.py` reads the compiled PDF’s word bounds and the generated SyncTeX horizontal line boxes. Source spans select these regions, including repeated inputs on multiple pages; multiline math uses its enclosing equation. Matching source paragraphs to PDF words refines prose highlights; ambiguous macro output retains a region rather than assigning the wrong word. Empty spans use source-linked regions. The PDFs retain their original layout, with highlights drawn over vector page images in the interface. Rotated pages use their rendered dimensions and require unique literal text to refine a location; otherwise they show the source-linked page without a highlight. Full pages and excerpts publish independently, so a failed excerpt or source map leaves a successfully compiled PDF available. The renderer version invalidates only disposable caches.

`application.py` owns these file checks, `versions.py` creates pinned source commits, and `previews.py` serializes background compilation. Requests arriving during compilation cause the worker to render the latest source next. A renderer publishes its manifest only if both comparison endpoints are still current; round and cumulative previews have separate manifests. Preview failures leave source review available. Render context uses exact source spans to distinguish repeated equations or algorithms.

`setup.py` reports local prerequisites and installs the bundled skill by linking it into the selected agent’s personal skills directory. Existing paths are never replaced. This setup stays separate from manuscript and review persistence.

Library cards group records by manuscript repository and show rounds in chronological history. Applied status is derived from the saved source hashes and selected wording; notes and replies do not reset it.

The app reads only schema 7. The explicit migrations in `migrations/` port retired records and preserve byte-exact originals. The v2 upgrade retains selected manuscript content and leaves the checkout and Git index unchanged. The v3 upgrade adds user attribution to existing discussion; the v4 upgrade moves source drafts out of navigation preferences. These preserve discussion IDs, notes, replies, decisions, and review revisions, and validate the library before replacing canonical files. The v5 migration combines located passage drafts into full-file drafts against the same selected version and retains detached source drafts. The v6 migration starts existing threads unresolved and qualifies legacy origins with saved current follow-ups to keep their exchanges together. Message IDs, source context, replies, choices, and drafts remain intact. The explicit agent `migrate` command validates the whole library before replacing records and archives their original bytes. Migrations are never imported by the service.

## Verification

Run `python3 -m unittest discover -s tests -v` from this directory. Tests cover exact reconstruction, absent and empty files, passage regeneration, retained notes and replies, stale writes, interrupted transactions, external edits, source anchors, client projection, modifier shortcuts, library operations, and LaTeX highlighting. Verify actual compilation and packaged startup when changing those boundaries.

## Source authoring

Sending a native source comment from Write uses the existing review for one author-versus-agent comparison. `authoring.py` moves
the comparison base to captured author wording and carries ordinary drafting saves
into that base. Review-mode refinements keep the base fixed. The original baseline and archived records retain earlier comparisons,
choices and discussion. Proposals still merge through the same session operations.
The dispatch boundary uses the comment's source URI to retain its manuscript context.
A source dispatch clears earlier staged version choices before refreshing the sidebar;
choices made during the handoff stay staged.

`delivery.mjs` requests exact replacements from the session, checks every participating
native buffer is saved and unchanged, then uses a native WorkspaceEdit and Save. It
never overwrites a dirty buffer. Explicit source decisions and Review in editor use
the same checked delivery operation; native focus does not pause clean delivery. Delivery stages all source checkpoints before exposing edits and gates native
capture until the workspace edit succeeds or rolls back. Source capture
receives the delivered source checkpoint, distinguishing agent delivery from subsequent
author edits; VS Code workspace storage retains that checkpoint until capture succeeds.
New results that arrive during delivery merge into the next update. Overlapping edits
remain in their original source versions for reconciliation. Delivery does not decide
edits or resolve comments. It refreshes comments and the pending-change count without changing the activity or editor focus.
Review refreshes its existing diff in place; Write keeps the ordinary editor.

The sidebar chooses provider and model independently. `dispatch.py` retains only launch
receipts and logs outside the review record, with handles to provider-owned sessions.
Codex runs with JSON events and a CLI thread source; Claude uses its native background
agent service. Open agent session uses those handles to resume in a native terminal or
desktop app. No working transcript is added to a comment or managed by the review.

# Editing model

The editor owns its buffer and Save. The review owns a proposal and the author's
wording decisions. Saving captures an edit; delivering a result writes selected
wording into a clean native buffer. These are separate operations.

## Source versions

| Name | Stored value | Meaning |
| --- | --- | --- |
| Original baseline | `baseline` | The manuscript at the beginning of this review history |
| Comparison base | `snapshot.base` | What rejection restores; fixed in a version comparison, advancing with author drafting in an agent comparison |
| Proposal | `snapshot.proposed` | The accumulated revisions, including manually refined proposal text |
| Selected result | `result` | Proposal wording with rejected edits restored from the comparison base |
| Captured source | `metadata.workspace_version` | The last acknowledged saved text of each file in the editing checkout |
| Live buffer | VS Code or CodeMirror | What the author is currently reading and typing |

Undecided and accepted edits select proposal wording. Rejected edits select base
wording. Decisions do not change the raw proposal. The selected result is derived;
it never becomes a second independently editable manuscript.

The captured source can lag the selected result while agent revisions or decisions
await delivery. A live buffer can also contain newer unsaved or unacknowledged text.
Highlights describe only exact matching text in that buffer. Opening a PDF or browsing
comparison endpoints does not transfer source ownership or save anything.

## Editing transitions

`source_editing.py` plans the change from an exact origin to saved text. It reads plain
file comparisons and decisions and performs no source or record writes.
`ReviewSession.capture_save` applies one plan under the existing transaction, updates
source versions, and retains discussion. Both interfaces use the same proposal
replacement and selected-source primitives.

| Action | Changes | Preserves |
| --- | --- | --- |
| Refine a proposal | Apply the manual delta to the proposal; select newly edited wording | Comparison base, original baseline, unrelated decisions and discussion |
| Draft as the author | Advance the author base with the manual delta and rebase pending proposals | Original baseline and undelivered agent wording, including contested wording |
| Acknowledge delivered text | Advance the captured source to what the editor saved | Base, proposal and decisions when there is no additional manual delta |
| Accept or reject | Change a decision and derive the selected result | Base, raw proposal, original baseline and discussion status |
| Publish an agent result | Merge its delta from its pinned starting result into the current proposal | Author source, original baseline and unaffected author choices |

Manual refinement updates the words the author edits. Unrelated rejected wording
stays rejected. Editing across neighboring replacements carries their selected
wording into the resulting conceptual edit. An older source that is no longer a
projection of the current comparison is merged conservatively; an overlapping
revision is refused, leaving the saved file and review intact.
Rebasing the author side must also preserve the selected manuscript exactly. If
repeated wording changes how edits align, rejection choices are recovered from that
selected text. An unrepresentable selection is refused atomically; the saved draft
and every previous choice remain intact. VS Code offers **Review as proposal** to
retry that saved point as a refinement with the author base fixed. Cancelling keeps
the saved queue for later; it does not discard any point or change its intent.

Ordinary author drafting updates only the author's delta, rather than incorporating
all delivered agent words into the base. If an undelivered agent revision contests
that delta, both versions remain available and delivery pauses for that file.
Rejecting or explicitly reconciling the contested wording releases the pause.
An insertion beside a replacement is adjacent, not contested. Two different
insertions at the same point contest each other. Source anchors may include shared
endpoints when grouping one conceptual edit; concurrent content changes use these
stricter overlap rules.

In VS Code, **Edit** selects **Your draft** or **Proposal** in an agent comparison.
Opening focused review selects Proposal. **Review highlights** controls display;
automatic delivery can reveal changes without changing the editing intent. A fixed
commit comparison always retains its base. Intent is pinned when manual typing starts.
Focused review changes keyboard behavior and display; it does not pause clean source
delivery or create another editable buffer.

## Save ownership and retries

`source-edits.mjs` retains ordered saved points, each with an identity, text and intent.
The ledger is persisted in VS Code workspace storage before capture. A delivered
point also pins the exact result inserted into the editor. A matching staged change
has provisional typing intent: cancellation promotes it to manual input; successful
delivery clears a purely synthetic episode. Further typing retains its pinned intent.

The engine captures an ordered prefix in one record transaction. It checks the latest
saved disk text but never rewrites it. Large bursts can be captured in bounded prefixes;
remaining saved points continue from the acknowledged checkpoint. Intermediate
captured text can therefore lag the file on disk until the ledger drains.

Each file has one capture cursor. A retry containing that cursor consumes the already
acknowledged prefix and applies only the remaining points. This also handles a response
lost after the transaction committed. An unrelated editor's capture or changed disk
text is refused. Standalone source writes replace affected file cursors, so an old
native retry cannot cross that ownership boundary, even if the text later repeats.
No prior point is silently replayed over a newer source owner.

Review switching drains saved input before transferring ownership. A pending ledger
belongs to its original review and file, survives service or extension restarts, and
cannot migrate into another comparison. Unsaved buffers stay entirely in the editor.

## Delivering source

`delivery.mjs` owns native source writes, provenance, Save and Undo. It plans against
the captured source and rechecks the review revision and exact buffer before applying.
A dirty or closed file waits; it does not block independent clean files. A changed
plan is recalculated. Save acknowledges the delivered origin, rather than treating
agent text as new author drafting.

An interrupted stage has uncertain provenance until application is confirmed. Its
saved points retain their individual origins. Before capture resumes, the author
confirms whether delivery occurred; cancelling retains the ledger for retry. A new
delivery cannot overwrite an unresolved stage. Confirmed delivery survives restarts
without another choice.

Automatic delivery runs for agent comparisons whenever the participating source is saved.
Explicit native decisions use the same checked delivery path. The standalone interface
writes manual intervals through its source journal; Apply writes the complete selected
result. File creation and deletion require explicit Apply. Neither interface replaces
a dirty native buffer.

Discussion anchors retain their original context. Replies and resolution do not select
wording, and accepting wording does not resolve its comment. Agents work in separate
proposal checkouts and publish through the review; they never write the author's
checkout directly.

## Verification

`tests/test_editing_model.py` checks complete source outcomes across mixed save intents,
acknowledgement retries, ordered prefixes, contested edits, author saves, two concurrent
agent proposals, delivery and rejection. Every transition preserves the original
baseline and reconstructs the selected result from the proposal and decisions.

Native adapter tests cover persistence, ownership, staging, and concurrent typing.
The real VS Code fixture exercises dirty-buffer delivery, manual refinement, inline
rejection, Undo and native review navigation. All write tests use synthetic repositories
and isolated libraries.


## Native review and PDF ownership

`native-review.mjs` owns the current source selection, focused keyboard mode, navigation
and inline decisions. It uses the exact editor projection for that saved revision.
Same-file navigation uses cached spans; cross-file navigation opens the corresponding
native document. Decisions use the existing session transaction and delivery owner.
Queued actions retain their review identity and are cancelled when that review closes.
Mouse editing, E/Escape and Undo leave focused mode; unrelated tabs keep normal typing.

`pdf-panel.mjs` is an optional read-only view of the selected result. It retains PDF
bytes and locations between selections and delegates actions to native review. A
selection token prevents a decision on an obsolete displayed change. The selected PDF
cache includes the result, raw proposal, entry file and renderer version, so locations
retain the round's edit identities even when rejections restore earlier wording.
PDF compilation never blocks native navigation or transfers Save ownership.

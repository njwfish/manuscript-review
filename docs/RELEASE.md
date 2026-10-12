Manuscript Review 0.17.0 includes VS Code extension 0.3.1 and the standalone macOS app.

The editing model now gives saved source, the proposal, selected wording and the
comparison base distinct ownership. In agent comparisons, Edit chooses Your draft
or Proposal. Review highlights controls display independently; automatic delivery
reveals changes without changing the meaning of your next edit. Opening focused
review selects Proposal. Commit comparisons retain their fixed From version.

Native Saves retain their order and editing intent through delayed capture and
extension restarts. Lost acknowledgements replay only uncaptured saves. Standalone
source writes transfer ownership, so a stale native retry cannot cross a later Apply.
Dirty files wait without blocking delivery to independent clean files.

Rebasing preserves selected wording exactly; an ambiguous alignment retains the
saved draft and prior choices. Author insertions beside agent words survive rejection.
Interrupted delivery requires its origin to be confirmed before capture resumes;
recorded save origins are preserved, and cancelled recovery retains the saved queue.

The documented editing model and regression tests cover mixed save intents,
parallel agents, delivery, rejection, Undo, failed Saves and restart recovery.
Saved discussion, decisions, original baselines and earlier comparisons are retained.
See docs/EDITING.md and the VS Code guide for source versions and editing controls.
